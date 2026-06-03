# WebSocket 流式消息存储与任务分组机制分析

## 一、全局架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                     单条 Socket.IO 连接                             │
│  useSocket.ts → io(API_URL)                                        │
│    │                                                                │
│    ├── socket.on('agent_message', msg)                              │
│    │     │                                                          │
│    │     ▼                                                          │
│    │   routeAgentMessage(msg)  ← 双指针守卫 + threadId 路由         │
│    │     │                                                          │
│    │     ├── isActiveThreadMessage?                                 │
│    │     │     ├── YES → callbacksRef.current.onMessage(msg)        │
│    │     │     │           → useChatSocketCallbacks.onMessage       │
│    │     │     │             → handleAgentMessage(msg)              │
│    │     │     │               → chatStore.addMessage / appendTo…   │
│    │     │     │                                                    │
│    │     │     └── NO  → handleBackgroundAgentMessage(msg)         │
│    │     │               → chatStore.addMessageToThread /           │
│    │     │                 batchStreamChunkUpdate                   │
│    │     │                                                          │
│    │     └── !threadId? → 缓冲 / 丢弃 + 触发 live-refresh          │
│    │                                                                │
│    ├── socket.on('intent_mode')                                     │
│    ├── socket.on('task_created')  → taskStore.addTask               │
│    ├── socket.on('task_updated')  → taskStore.updateTask            │
│    └── socket.on('thread_updated') → chatStore.updateThreadTitle    │
└─────────────────────────────────────────────────────────────────────┘
```

## 二、WebSocket 连接建立

**文件**：`hooks/useSocket.ts`

```typescript
const socket = io(API_URL, {
  transports: ['websocket', 'polling'],
  auth: { userId: userIdRef.current },
});
```

- 使用 **Socket.IO** 客户端，优先 WebSocket 传输，降级为 polling
- 全局只建立 **一条连接**，所有 thread 的消息共用
- 连接时自动 `join_room` 所有已跟踪的 thread 房间（`thread:{threadId}`）
- 重连时执行 `reconcileInvocationStateOnReconnect()` 与服务端对齐状态

---

## 三、消息路由：从 WebSocket 到 Store 的第一道关卡

### 3.1 `socket.on('agent_message')` 入口

```typescript
socket.on('agent_message', (msg: AgentMessage) => {
  // 1. threadId 恢复：如果 msg 缺少 threadId 但有 invocationId，
  //    从 invocationThreadMapRef 查找之前记录的 threadId
  let resolvedThreadId = msg.threadId;
  if (!resolvedThreadId && msg.invocationId) {
    resolvedThreadId = invocationThreadMapRef.current.get(msg.invocationId);
  }
  const routedMsg = resolvedThreadId && resolvedThreadId !== msg.threadId
    ? { ...msg, threadId: resolvedThreadId }
    : msg;
  routeAgentMessage(routedMsg, msg);
});
```

### 3.2 `routeAgentMessage` — 双指针守卫

这是防止切换会话时消息串台的核心逻辑：

```typescript
const routeAgentMessage = (routedMsg, originalMsg) => {
  const routeThread = threadIdRef.current;        // 路由层 threadId
  const storeThread = useChatStore.getState().currentThreadId;  // Store 层 threadId

  // 双指针守卫：路由层 AND Store层 必须同时一致
  const isActiveThreadMessage = Boolean(
    routedMsg.threadId &&
    routeThread &&
    storeThread &&
    routedMsg.threadId === routeThread &&
    routedMsg.threadId === storeThread,
  );

  // 无 threadId → 缓冲或丢弃
  if (!routedMsg.threadId) {
    // 有 invocationId → 缓冲到 missingThreadBufferRef，等待后续消息补全
    // 无 invocationId → 丢弃 + 触发 live-refresh 兜底
    return;
  }

  // 活跃线程 → 完整处理（流式、工具事件等）
  if (isActiveThreadMessage) {
    callbacksRef.current.onMessage(routedMsg);  // → handleAgentMessage
    return;
  }

  // 非活跃线程 → 后台处理
  handleBackgroundAgentMessage(routedMsg, { store, bgStreamRefs, ... });
};
```

**关键设计**：

| 守卫层 | 作用 | 防御场景 |
|--------|------|---------|
| `routeThread` (路由层) | URL/组件层当前 threadId | 路由已切到 B 但 Store 还在 A |
| `storeThread` (Store 层) | Zustand flat state 的 currentThreadId | Store 已切到 B 但路由还在 A |
| **双指针 AND** | 两者必须一致才走活跃路径 | 任何一方的切换中间态都不会污染 |

---

## 四、活跃线程消息处理：`handleAgentMessage`

**文件**：`hooks/useAgentMessages.ts`

这是消息从 WebSocket 进入 Zustand Store 的核心枢纽。

### 4.1 入口守卫

```typescript
const handleAgentMessage = useCallback((msg: AgentMsg) => {
  // 1. 跨线程守卫：额外安全网
  if (msg.threadId && currentThreadId && msg.threadId !== currentThreadId) return;

  // 2. activeRef 线程不匹配 → 失效旧引用
  const activeRef = activeRefs.current.get(msg.agentId);
  if (activeRef && currentThreadId && activeRef.threadId !== currentThreadId) {
    activeRefs.current.delete(msg.agentId);
  }

  // 3. 已取消的 invocationId → 丢弃（防止旧事件污染新 bubble）
  if (msg.invocationId && cancelledInvocationsRef.current.has(msg.invocationId) && msg.type !== 'done') {
    return;
  }

  // 4. 调度器占位消息 → 丢弃
  if (isSchedulerPlaceholderMessage(msg)) return;

  // ... 按 msg.type 分发
}, [...]);
```

### 4.2 按 `msg.type` 分发

#### `msg.type === 'text'` — 文本消息

分两种来源：

| 来源 | `msg.origin` | 处理方式 |
|------|-------------|---------|
| CLI 流式输出（thinking） | `'stream'` | 追加到已有 bubble 或创建新 bubble |
| MCP post_message（speech） | `'callback'` | 替换已有 stream bubble 或创建新 bubble |

**Stream 路径（逐 token 推送）**：

```typescript
if (msg.origin !== 'callback') {
  // 查找该 agentId 的活跃流式 bubble
  const messageId = getOrRecoverActiveAssistantMessageId(msg.agentId, ...);

  if (messageId) {
    // 已有 bubble → 追加内容
    const acc = getTaskRunAccum(messageId);
    const shell = agentMsgTaskShell(msg);
    if (acc.isTaskScopedText(shell)) {
      // 任务域文本 → 写入 TaskRunAccumulator（按任务分组）
      acc.appendText(shell, msg.content);
      flushTaskRunsToMessage(messageId);
    } else {
      // 普通文本 → 直接追加到 message.content
      appendToMessage(messageId, msg.content);
    }
  } else {
    // 无已有 bubble → 创建新的流式 assistant 消息
    const id = `msg-${Date.now()}-${msg.agentId}`;
    activeRefs.current.set(msg.agentId, { id, agentId, threadId });
    addMessage({
      id, type: 'assistant', agentId, content: msg.content,
      origin: 'stream', isStreaming: true,
      ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
    });
  }
}
```

**Callback 路径（一次性完整消息）**：

```typescript
if (msg.origin === 'callback') {
  // 查找可替换的 stream bubble（同一 invocationId）
  const replacementTarget = findCallbackReplacementTarget(msg.agentId, invocationId);

  if (replacementTarget) {
    // 替换已有 stream bubble 的内容
    replaceMessageId(replacementTarget.id, finalId);
    patchMessage(finalId, { content: msg.content, origin: 'callback', isStreaming: false });
    activeRefs.current.delete(msg.agentId);
  } else {
    // 无可替换 → 创建新的 callback 消息
    addMessage({ id, type: 'assistant', content: msg.content, origin: 'callback' });
  }
}
```

#### `msg.type === 'tool_use'` — 工具调用事件

```typescript
const messageId = ensureActiveAssistantMessage(msg.agentId, ...);
appendToolEvent(messageId, {
  id: toolUseId, type: 'tool_use',
  label: `${msg.agentId} → ${toolName}`,
  detail: toolUseDetail(toolName, msg.toolInput),
  timestamp: toolUseTs,
});
// 同时写入 TaskRunAccumulator
getTaskRunAccum(messageId).appendTool(agentMsgTaskShell(msg), tu);
flushTaskRunsToMessage(messageId);
```

#### `msg.type === 'tool_result'` — 工具返回事件

```typescript
const messageId = ensureActiveAssistantMessage(msg.agentId, ...);
appendToolEvent(messageId, {
  id: toolResId, type: 'tool_result',
  label: `${msg.agentId} ← ${msg.toolName}`,
  detail: msg.content,
});
getTaskRunAccum(messageId).appendTool(agentMsgTaskShell(msg), tr);
flushTaskRunsToMessage(messageId);
```

#### `msg.type === 'done'` — 流式结束

```typescript
setAgentStatus(msg.agentId, hasErrorFallback ? 'error' : 'done');
setStreaming(activeRef.id, false);  // 标记 bubble 不再流式
clearDoneTimeout();                 // 清除超时守卫
// ... 清理 activeRefs、activeInvocations 等
```

---

## 五、后台线程消息处理：`handleBackgroundAgentMessage`

**文件**：`hooks/useSocket-background.ts`

当消息属于非当前活跃线程时，走后台路径。核心差异：

| 维度 | 活跃线程 | 后台线程 |
|------|---------|---------|
| Store 写入 | `chatStore.addMessage` (flat state) | `chatStore.addMessageToThread` (threadStates map) |
| 流式追加 | `appendToMessage` | `batchStreamChunkUpdate` (批量合并，防 React 更新溢出) |
| 流式引用 | `activeRefs` (Map) | `bgStreamRefs` (Map) |
| 未读计数 | 无（始终为 0） | `incrementUnread` |
| 通知 | 无 | Toast + 桌面通知 |

**后台流式追加的关键优化**：

```typescript
// HOT PATH: 批量合并 content + metadata + streaming + agentStatus 到一次 set()
// 防止高频流式推送时 React 更新深度溢出
options.store.batchStreamChunkUpdate({
  threadId: msg.threadId,
  messageId,
  agentId: msg.agentId,
  content: msg.content,
  metadata: msg.metadata,
  streaming: !msg.isFinal,
  nextAgentStatus: errorFallback ? 'error' : msg.isFinal ? 'done' : 'streaming',
});
```

**后台 bubble 恢复**（活跃→后台切换时）：

```typescript
function recoverStreamingMessage(msg, streamKey, options) {
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  // 从后往前找该 agentId 的 isStreaming bubble
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const m = threadMessages[i];
    if (m.type === 'assistant' && m.agentId === msg.agentId && m.isStreaming) {
      options.bgStreamRefs.set(streamKey, { id: m.id, threadId, agentId });
      return m.id;
    }
  }
  return undefined;
}
```

---

## 六、Zustand Store 数据结构

**文件**：`stores/chatStore.ts`

### 6.1 双层存储模型

```typescript
interface ChatState {
  // ── 活跃线程：扁平状态（直接渲染） ──
  messages: ChatMessage[];           // 当前线程的消息列表
  isLoading: boolean;
  hasActiveInvocation: boolean;
  activeInvocations: Record<string, { agentId: string; mode: string; startedAt?: number }>;
  intentMode: 'execute' | 'ideate' | null;
  targetAgents: string[];
  agentStatuses: Record<string, AgentStatusType>;
  agentInvocations: Record<string, AgentInvocationInfo>;

  // ── 多线程：Map 存储（切换时快照/恢复） ──
  threadStates: Record<string, ThreadState>;
  currentThreadId: string;
  threads: Thread[];

  // ... 其他全局状态
}

interface ThreadState {
  messages: ChatMessage[];
  isLoading: boolean;
  hasActiveInvocation: boolean;
  activeInvocations: Record<string, { agentId: string; mode: string; startedAt?: number }>;
  intentMode: 'execute' | 'ideate' | null;
  targetAgents: string[];
  agentStatuses: Record<string, AgentStatusType>;
  agentInvocations: Record<string, AgentInvocationInfo>;
  unreadCount: number;
  hasUserMention: boolean;
  lastActivity: number;
  // ...
}
```

### 6.2 线程切换机制

```typescript
// 切出：快照活跃线程到 threadStates
function snapshotActive(s: ChatState): ThreadState {
  return {
    messages: s.messages,
    isLoading: s.isLoading,
    hasActiveInvocation: s.hasActiveInvocation,
    // ... 所有扁平字段
  };
}

// 切入：从 threadStates 恢复到扁平状态
function flattenThread(ts: ThreadState): Partial<ChatState> {
  return {
    messages: ts.messages,
    isLoading: ts.isLoading,
    // ...
  };
}
```

**切换流程**：`setCurrentThread(newId)` → `snapshotActive(旧)` → `flattenThread(新)` → 更新 `currentThreadId`

### 6.3 消息写入方法

| 方法 | 作用 | 写入位置 |
|------|------|---------|
| `addMessage(msg)` | 新增消息到活跃线程 | `state.messages` |
| `addMessageToThread(threadId, msg)` | 新增消息到指定线程 | `state.messages` 或 `state.threadStates[threadId].messages` |
| `appendToMessage(id, content)` | 追加内容到指定消息 | `state.messages[id].content += content` |
| `appendToolEvent(id, event)` | 追加工具事件 | `state.messages[id].toolEvents.push(event)` |
| `patchMessage(id, patch)` | 部分更新消息 | 浅合并 patch |
| `replaceMessageId(fromId, toId)` | 替换消息 ID（callback 替换 stream） | 去重 + ID 替换 |
| `setStreaming(id, streaming)` | 设置流式状态 | `state.messages[id].isStreaming` |
| `batchStreamChunkUpdate(params)` | 批量更新（后台高频流式） | 一次 `set()` 合并多字段 |

### 6.4 `addMessage` 去重与排序

```typescript
addMessage: (msg) => set((state) => {
  // 去重：同 ID 消息不重复添加
  if (state.messages.some((m) => m.id === msg.id)) return state;
  // 追加 + 排序（保证消息顺序正确）
  const messages = [...state.messages, msg].sort(compareMessagesByOrder);
  return { messages };
}),
```

### 6.5 `addMessageToThread` — 多线程写入

```typescript
addMessageToThread: (threadId, msg) => set((state) => {
  // 活跃线程 → 委托给扁平状态
  if (threadId === state.currentThreadId) {
    if (state.messages.some((m) => m.id === msg.id)) return state;
    const messages = [...state.messages, msg].sort(compareMessagesByOrder);
    return { messages };
  }

  // 后台线程 → 更新 threadStates map + 递增未读
  const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
  if (existing.messages.some((m) => m.id === msg.id)) return state;
  return {
    threadStates: {
      ...state.threadStates,
      [threadId]: {
        ...existing,
        messages: [...existing.messages, msg].sort(compareMessagesByOrder),
        unreadCount: existing.unreadCount + (isReplayOrAlreadyViewed ? 0 : 1),
        hasUserMention: existing.hasUserMention || (!!msg.mentionsUser && !isReplayOrAlreadyViewed),
        lastActivity: Date.now(),
      },
    },
  };
}),
```

---

## 七、消息按任务分组机制

### 7.1 任务域标识

每条 WebSocket 消息携带任务上下文：

```typescript
interface AgentMessage {
  // ...
  taskContext?: { id: string; title?: string; index?: number; total?: number };
  taskPhase?: 'start' | 'complete';
  invocationId?: string;  // 调用 ID，区分并发调用
}
```

- `taskContext.id`：任务唯一标识
- `taskContext.title`：任务标题
- `taskContext.index / total`：任务序号（第几个/共几个）
- `taskPhase`：任务阶段（start / complete）
- `invocationId`：调用 ID，同一 invocation 下的所有消息属于同一轮对话

### 7.2 TaskRunAccumulator — 任务分组累加器

**来源**：`@openjiuwen/relay-shared` 包

```typescript
// 每个 assistant bubble 关联一个 TaskRunAccumulator
const taskRunAccumulatorsRef = useRef(new Map<string, TaskRunAccumulator>());

const getTaskRunAccum = useCallback((messageId: string) => {
  const existing = taskRunAccumulatorsRef.current.get(messageId);
  if (existing) return existing;
  const acc = new TaskRunAccumulator();
  // 从已有消息的 extra.taskRuns 恢复
  const msg = useChatStore.getState().messages.find((m) => m.id === messageId);
  const taskRuns = msg?.extra?.taskRuns;
  if (taskRuns?.v === 1 && taskRuns.segments.length > 0) {
    acc.loadFromExtra(taskRuns);
  }
  taskRunAccumulatorsRef.current.set(messageId, acc);
  return acc;
}, []);
```

### 7.3 分组判定：`isTaskScopedText`

```typescript
// 在 handleAgentMessage 中，text 消息进入时：
const acc = getTaskRunAccum(messageId);
const shell = agentMsgTaskShell(msg);  // 提取 taskContext/taskPhase 等字段

if (acc.isTaskScopedText(shell)) {
  // 任务域文本 → 写入 TaskRunAccumulator（按任务分组）
  acc.appendText(shell, msg.content);
  flushTaskRunsToMessage(messageId);
} else {
  // 普通文本 → 直接追加到 message.content
  appendToMessage(messageId, msg.content);
}
```

**判定逻辑**：消息携带 `taskContext` 且 `taskContext.id` 非空 → 视为任务域文本。

### 7.4 分组数据结构

```typescript
// ChatMessage.extra.taskRuns 存储分组结果
interface ChatMessage {
  extra?: {
    taskRuns?: {
      v: 1;
      segments: TaskRunSegment[];  // 按任务分组的段落
    };
    stream?: { invocationId: string };
    rich?: { v: 1; blocks: RichBlock[] };
    // ...
  };
}
```

每个 `TaskRunSegment` 代表一个任务的文本段落，包含：
- 任务 ID、标题、序号
- 该任务下的文本内容
- 该任务下的工具事件（tool_use / tool_result）
- 任务阶段（start / complete）

### 7.5 刷新到 Store

```typescript
const flushTaskRunsToMessage = useCallback((messageId: string) => {
  const acc = taskRunAccumulatorsRef.current.get(messageId);
  const tr = acc?.toExtra();
  if (!tr) return;
  const existing = useChatStore.getState().messages.find((m) => m.id === messageId);
  // 合并：保留已有 segment 的元数据
  const mergedTr = mergeTaskRunsPreserveSegmentMeta(tr, existing?.extra?.taskRuns);
  patchMessage(messageId, { extra: { ...existing?.extra, taskRuns: mergedTr } });
}, [patchMessage]);
```

### 7.6 TaskStore — 独立的任务状态管理

**文件**：`stores/taskStore.ts`

```typescript
interface TaskItem {
  id: string;
  threadId: string;
  title: string;
  ownerAgentId: string | null;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  why: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
```

通过 `socket.on('task_created')` 和 `socket.on('task_updated')` 事件驱动：

```typescript
// useChatSocketCallbacks.ts
onTaskCreated: (task) => addTask(task as TaskItem),
onTaskUpdated: (task) => updateTask(task as TaskItem),
```

---

## 八、完整数据流图

```
WebSocket (单连接)
  │
  │  agent_message 事件
  │  { type, agentId, threadId, content, invocationId, taskContext, taskPhase, ... }
  │
  ▼
useSocket.ts: socket.on('agent_message')
  │
  │  1. threadId 恢复（从 invocationThreadMapRef）
  │  2. routeAgentMessage()
  │
  ├─── isActiveThreadMessage? (双指针守卫)
  │
  ├── YES (活跃线程) ──────────────────────────────────────────────┐
  │    │                                                            │
  │    ▼                                                            │
  │  useChatSocketCallbacks.onMessage(msg)                          │
  │    │                                                            │
  │    ▼                                                            │
  │  useAgentMessages.handleAgentMessage(msg)                       │
  │    │                                                            │
  │    ├── type='text' + origin='stream'                            │
  │    │     ├── isTaskScopedText?                                  │
  │    │     │     ├── YES → TaskRunAccumulator.appendText()        │
  │    │     │     │         → flushTaskRunsToMessage()             │
  │    │     │     │         → chatStore.patchMessage(extra.taskRuns)│
  │    │     │     └── NO  → chatStore.appendToMessage(content)    │
  │    │     └── 无已有 bubble → chatStore.addMessage(isStreaming)  │
  │    │                                                            │
  │    ├── type='text' + origin='callback'                          │
  │    │     ├── 有 stream bubble → replaceMessageId + patchMessage │
  │    │     └── 无 stream bubble → chatStore.addMessage()         │
  │    │                                                            │
  │    ├── type='tool_use'                                          │
  │    │     → chatStore.appendToolEvent()                          │
  │    │     → TaskRunAccumulator.appendTool()                      │
  │    │     → flushTaskRunsToMessage()                             │
  │    │                                                            │
  │    ├── type='tool_result'                                       │
  │    │     → chatStore.appendToolEvent()                          │
  │    │     → TaskRunAccumulator.appendTool()                      │
  │    │     → flushTaskRunsToMessage()                             │
  │    │                                                            │
  │    └── type='done'                                              │
  │          → chatStore.setStreaming(false)                        │
  │          → 清理 activeRefs / activeInvocations                  │
  │                                                                 │
  ├── NO (后台线程) ────────────────────────────────────────────────┤
  │    │                                                            │
  │    ▼                                                            │
  │  handleBackgroundAgentMessage(msg)                              │
  │    │                                                            │
  │    ├── type='text' + origin='stream'                            │
  │    │     → chatStore.batchStreamChunkUpdate()  ← 批量合并优化   │
  │    │     → chatStore.addMessageToThread() (新 bubble)           │
  │    │     → incrementUnread()                                    │
  │    │                                                            │
  │    ├── type='text' + origin='callback'                          │
  │    │     → chatStore.patchThreadMessage() / addMessageToThread()│
  │    │                                                            │
  │    └── type='done'                                              │
  │          → markThreadInvocationComplete()                       │
  │          → Toast + 桌面通知                                     │
  │                                                                 │
  └── !threadId (无归属) ───────────────────────────────────────────┤
       │                                                            │
       ├── 有 invocationId → 缓冲到 missingThreadBufferRef          │
       │                    等待后续消息补全 threadId               │
       └── 无 invocationId → 丢弃 + requestThreadLiveRefresh()     │
                                                                    │
  ──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Zustand chatStore
                    ┌─────────────────────────────────┐
                    │ 活跃线程 (flat state)            │
                    │   messages: ChatMessage[]        │
                    │   activeInvocations: Record      │
                    │   agentStatuses: Record          │
                    ├─────────────────────────────────┤
                    │ 多线程 (threadStates map)        │
                    │   [threadId]: ThreadState        │
                    │     messages: ChatMessage[]      │
                    │     unreadCount: number          │
                    └─────────────────────────────────┘
```

---

## 九、关键防乱机制总结

### 9.1 切换会话不乱

| 机制 | 实现位置 | 原理 |
|------|---------|------|
| **双指针守卫** | `useSocket.routeAgentMessage` | 路由层 threadId AND Store层 threadId 必须一致 |
| **activeRef 线程校验** | `useAgentMessages.handleAgentMessage` | activeRef.threadId !== currentThreadId → 失效旧引用 |
| **跨线程丢弃** | `useAgentMessages.handleAgentMessage` | msg.threadId !== currentThreadId → 直接丢弃 |
| **快照/恢复** | `chatStore.snapshotActive / flattenThread` | 切出时保存，切入时恢复，数据天然隔离 |
| **后台独立存储** | `chatStore.threadStates[threadId]` | 非活跃线程数据存在独立 Map 中 |

### 9.2 刷新页面不丢

| 机制 | 实现位置 | 原理 |
|------|---------|------|
| **HTTP 历史拉取** | `useChatHistory` | 页面加载时从 `/api/threads/{id}/messages` 拉取 |
| **重连续推** | `reconcileInvocationStateOnReconnect` | 重连后从服务端 queue 端点对齐状态 |
| **Live Refresh** | `requestThreadLiveRefresh` | 轻量级消息刷新，补全断连期间丢失的消息 |
| **Stream Catch-Up** | `chatStore.requestStreamCatchUp` | 请求服务端重推流式消息的缺失部分 |

### 9.3 流式消息不串

| 机制 | 实现位置 | 原理 |
|------|---------|------|
| **activeRefs** | `useAgentMessages` | Map<agentId, {id, threadId}> — 每个 agent 最多一个活跃流 |
| **invocationId** | `AgentMessage.invocationId` | 区分并发调用，同一 invocation 的消息归入同一 bubble |
| **callback 替换** | `findCallbackReplacementTarget` | callback 消息替换同 invocationId 的 stream bubble |
| **已取消过滤** | `cancelledInvocationsRef` | 用户点停止后，旧 invocationId 的事件被丢弃 |
| **终端错误抑制** | `terminalStreamSuppressionRef` | 终端错误后抑制后续流式片段，防止幽灵 bubble |
| **ID 去重** | `chatStore.addMessage` | 同 ID 消息不重复添加 |

---

## 十、核心文件索引

| 文件 | 职责 |
|------|------|
| `hooks/useSocket.ts` | WebSocket 连接管理、消息路由、双指针守卫、重连对齐 |
| `hooks/useChatSocketCallbacks.ts` | Socket 事件回调桥接（onMessage → handleAgentMessage） |
| `hooks/useAgentMessages.ts` | 活跃线程消息处理核心（流式追加、工具事件、任务分组） |
| `hooks/useSocket-background.ts` | 后台线程消息处理（批量更新、bubble 恢复、通知） |
| `hooks/useChatHistory.ts` | 历史消息加载、线程切换、scroll 恢复 |
| `stores/chatStore.ts` | Zustand 全局 Store（双层存储、消息写入、线程管理） |
| `stores/chat-types.ts` | 类型定义（ChatMessage、ThreadState、ToolEvent 等） |
| `stores/taskStore.ts` | 任务状态管理（task_created/updated 事件驱动） |
| `@openjiuwen/relay-shared` | TaskRunAccumulator（任务分组累加器） |

本文写于：2026年6月3日

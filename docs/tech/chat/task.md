# WebSocket 消息按任务分组机制深度分析

散乱的 WebSocket 消息数据如何被按任务（Task）分组，形成连贯的消息气泡和任务进度面板？

## 1. 全局架构概览

WebSocket 消息从后端到达前端后，经过 **五层分组** 才最终呈现为用户可见的任务分组消息气泡：

```
后端 WS 事件 (agent_message)
  │
  ▼
┌─────────────────────────────────┐
│  Layer 1: useSocket             │  线程级路由：active vs background
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  Layer 2: useAgentMessages      │  气泡级归属：activeRefs → messageId
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  Layer 3: chatStore             │  调用级槽位：invocationId → agentInvocations
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  Layer 4: TaskRunAccumulator    │  任务段分组：taskId → segments[]
└─────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────┐
│  Layer 5: task-run-stream-sync  │  桥接层：flush → message.extra.taskRuns
└─────────────────────────────────┘
  │
  ▼
UI 渲染（消息气泡 + 任务进度面板）
```

---

## 2. 五层分组模型

| 层级 | 模块 | 分组键 | 职责 |
|------|------|--------|------|
| **L1** | `useSocket.ts` | `threadId` | 将 WS 事件路由到当前活跃线程或后台线程 |
| **L2** | `useAgentMessages.ts` | `agentId` + `invocationId` | 将事件归属到正确的消息气泡（ChatMessage） |
| **L3** | `chatStore.ts` | `agentId` | 维护每个 agent 的调用状态（invocationId、taskProgress） |
| **L4** | `TaskRunAccumulator` | `taskId` / `stream_source_id` | 将 thinking/text/tool 按任务段分组 |
| **L5** | `task-run-stream-sync.ts` | `threadId:messageId` | 桥接 accumulator 与 store，flush 到 message.extra.taskRuns |

---

## 3. 第一层：Socket 事件路由（useSocket）

**文件**：`src/hooks/useSocket.ts`（~53KB）

### 3.1 核心路由逻辑

当 `socket.on('agent_message', msg)` 触发时，执行以下路由流程：

```typescript
socket.on('agent_message', (msg: AgentMessage) => {
  // Step 1: 解析 threadId（可能缺失，需从 invocationThreadMap 恢复）
  let resolvedThreadId = msg.threadId;
  if (!resolvedThreadId && msg.invocationId) {
    resolvedThreadId = invocationThreadMapRef.current.get(msg.invocationId);
  }
  
  // Step 2: 路由到 routeAgentMessage
  routeAgentMessage(routedMsg, msg);
});
```

### 3.2 双指针守卫（Dual-Pointer Guard）

`routeAgentMessage` 使用 **路由层 + Store 层双指针** 判断消息是否属于当前活跃线程：

```typescript
const isActiveThreadMessage = Boolean(
  routedMsg.threadId &&
  routeThread &&          // URL 路由层的 threadId
  storeThread &&          // Zustand store 的 currentThreadId
  routedMsg.threadId === routeThread &&
  routedMsg.threadId === storeThread
);
```

**为什么需要双指针？** 在快速切换线程时，URL 路由可能已指向线程 B，但 Store 扁平状态仍属于线程 A。仅用单指针会导致线程 A 的消息泄漏到线程 B 的 UI。

### 3.3 三条路由路径

```
agent_message 事件
  │
  ├─ threadId 缺失 → 缓冲到 missingThreadBuffer（按 invocationId）
  │                    └─ 超时后丢弃 + 请求 history catch-up
  │
  ├─ isActiveThreadMessage = true → callbacksRef.current.onMessage(routedMsg)
  │                                    └─ 调用 handleAgentMessage（Layer 2）
  │
  └─ isActiveThreadMessage = false → handleBackgroundAgentMessage(routedMsg)
                                       └─ 后台线程：静默更新 threadStates
```

### 3.4 invocationThreadMap

```typescript
// Map<invocationId, threadId> — 从事件中学习 invocation→thread 映射
const invocationThreadMapRef = useRef<Map<string, string>>(new Map());
```

当事件携带 `invocationId + threadId` 时，记录映射关系。后续同一 `invocationId` 的事件即使缺少 `threadId`，也能通过此映射恢复。这解决了后端某些事件（如 `done`）不携带 `threadId` 的问题。

### 3.5 缺失 threadId 的缓冲机制

```typescript
missingThreadBufferRef: Map<invocationId, AgentMessage[]>
missingThreadBufferTimerRef: Map<invocationId, timeoutId>
```

- 当事件缺少 `threadId` 但有 `invocationId` 时，暂存到缓冲区
- 当同一 `invocationId` 的后续事件携带 `threadId` 时，`flushBufferedInvocationMessages` 批量回放
- 超时（`MISSING_THREAD_ID_BUFFER_TIMEOUT_MS`）后丢弃并请求 history catch-up

---

## 4. 第二层：气泡归属与生命周期（useAgentMessages）

**文件**：`src/hooks/useAgentMessages.ts`（~95KB）

这是最核心的消息处理层，负责将每个 WS 事件路由到正确的 **消息气泡**（ChatMessage）。

### 4.1 activeRefs — 活跃流式气泡映射

```typescript
// Map<agentId, { id: messageId, agentId, threadId }>
const activeRefs = useRef<Map<string, { id: string; agentId: string; threadId: string }>>(new Map());
```

**语义**：每个 agent 在同一时刻最多只有一个活跃的流式气泡。`activeRefs` 记录了这个映射。

**threadId 的作用**：防止快速切换线程时，旧线程的 `activeRef` 污染新线程。在 `handleAgentMessage` 入口处检查：

```typescript
const activeRef = activeRefs.current.get(msg.agentId);
if (activeRef && currentThreadId && activeRef.threadId !== currentThreadId) {
  activeRefs.current.delete(msg.agentId);  // 无效化跨线程的旧引用
}
```

### 4.2 气泡生命周期

一个消息气泡经历以下状态：

```
[创建] ──→ [流式追加] ──→ [完成(done)] ──→ [回调替换(callback)] ──→ [持久化]
```

#### 4.2.1 创建：ensureActiveAssistantMessage

```typescript
const ensureActiveAssistantMessage = useCallback(
  (agentId, metadata?, preferredInvocationId?) => {
    // 1. 尝试从 activeRefs 恢复已有气泡
    const existingId = getOrRecoverActiveAssistantMessageId(agentId, metadata, ...);
    if (existingId) return existingId;
    
    // 2. 无法恢复 → 创建新气泡
    const id = `msg-${Date.now()}-${agentId}`;
    const invocationId = getCurrentInvocationStateForAgent(agentId).invocationId;
    activeRefs.current.set(agentId, { id, agentId, threadId: currentThreadId });
    addMessage({
      id,
      type: 'assistant',
      agentId,
      content: '',
      origin: 'stream',
      isStreaming: true,
      ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
    });
    return id;
  }
);
```

#### 4.2.2 恢复：findRecoverableAssistantMessage

按优先级尝试恢复已有气泡：

1. **正在流式的气泡**：`msg.isStreaming === true` 且 `msg.agentId` 匹配
2. **指定 invocationId 的气泡**：`msg.extra.stream.invocationId === preferredInvocationId`
3. **当前 agent 调用槽位的气泡**：从 `agentInvocations[agentId].invocationId` 查找
4. **活跃流式气泡回退**：`origin === 'stream'` 且 `isActiveStreamBubble(msg, store)`

#### 4.2.3 完成：done 事件处理

```typescript
// done 事件处理核心逻辑
const messageId = getOrRecoverActiveAssistantMessageId(failedAgentId);
if (messageId) {
  setStreaming(messageId, false);                    // 停止流式标记
  stampAssistantMessageCompletedAt(messageId);       // 记录完成时间
  stampMessageTaskProgress(failedAgentId, messageId, hasErrorFallback); // 冻结任务进度
  finalizedStreamRef.current.set(failedAgentId, messageId);  // 记录刚完成的气泡
  activeRefs.current.delete(failedAgentId);          // 清除活跃引用
  flushTaskRunsToMessage(messageId);                 // 刷新任务段到消息
  clearTaskRunAccumulator(activeThreadId(), messageId); // 清除累加器
}
```

#### 4.2.4 回调替换：callback 消息

当 `msg.origin === 'callback'` 时，MCP post_message 回调会 **替换** 流式气泡：

```typescript
// 查找替换目标
const replacementTarget = invocationId
  ? findCallbackReplacementTarget(agentId, invocationId)  // 精确匹配 invocationId
  : findInvocationlessStreamPlaceholder(agentId);          // 匹配无 invocationId 的流式气泡

if (replacementTarget) {
  // 替换：用回调内容覆盖流式气泡
  patchMessage(finalId, {
    content: msg.content,
    origin: 'callback',
    isStreaming: false,
  });
  replacedInvocationsRef.current.set(agentId, invocationId);  // 标记已替换
} else {
  // 无替换目标 → 创建新的回调气泡
  addMessage({ type: 'assistant', origin: 'callback', content: msg.content, ... });
}
```

### 4.3 handleAgentMessage — 事件类型分发

`handleAgentMessage` 是核心回调，按 `msg.type` 分发到不同处理路径：

| 事件类型 | 处理方式 | 分组机制 |
|----------|----------|----------|
| `text` (origin=stream) | 追加到活跃气泡的 `content` 或 taskRuns | `isTaskScopedText` 决定 |
| `text` (origin=callback) | 替换或创建回调气泡 | `findCallbackReplacementTarget` |
| `tool_use` | 追加 ToolEvent + 写入 taskRuns | `appendToolEvent` + `appendTool` |
| `tool_result` | 追加 ToolEvent + 写入 taskRuns | `appendToolEvent` + `appendTool` |
| `done` | 结束流式、冻结进度、清理状态 | `stampMessageTaskProgress` |
| `system` | 创建系统消息气泡 | `addMessage` |
| `system_info` | 解析 JSON 子类型，静默或展示 | 见下表 |
| `error` | 设置错误状态、抑制后续流式片段 | `terminalStreamSuppressionRef` |

### 4.4 system_info 子类型处理

`system_info` 事件携带 JSON 内容，解析后按 `parsed.type` 分发：

| 子类型 | 处理 | 对分组的影响 |
|--------|------|-------------|
| `invocation_created` | 注册新调用槽位，清除旧状态 | **关键**：设置 `agentInvocations[agentId].invocationId` |
| `task_boundary` | 调用 `acc.onBoundary()` | **关键**：推进 TaskRunAccumulator 的任务栈 |
| `task_progress` | 更新 `agentInvocations[agentId].taskProgress` | 更新任务进度面板 |
| `thinking` | 追加思考内容到气泡 + taskRuns | 双写：bubble-level + task-segment |
| `invocation_metrics` | 静默存储指标 | 无 UI 影响 |
| `invocation_usage` | 静默存储 token 用量 | 写入 `message.metadata.usage` |
| `rich_block` | 追加富文本块到气泡 | `appendRichBlock` |
| `send_file_ready` | 追加文件就绪事件 | `appendSendFileReadyEvent` |
| `artifact_generated` | 追加产物生成事件 | `appendArtifactGeneratedEvent` |
| `liveness_warning` | 更新 agent 存活状态 | UI 状态更新 |
| `recoverable_pause` | 标记任务中断 | `taskProgress.snapshotStatus = 'interrupted'` |

### 4.5 辅助引用集合

```typescript
// 已替换的调用 — 防止延迟流式片段创建幽灵气泡
replacedInvocationsRef: Map<agentId, invocationId>

// 终端错误后抑制流式片段
terminalStreamSuppressionRef: Map<agentId, invocationId | null>

// 刚完成的流式气泡 — 供回调替换精确匹配
finalizedStreamRef: Map<agentId, messageId>

// 已取消的调用黑名单 — 丢弃旧 invocationId 的事件
cancelledInvocationsRef: Set<invocationId>

// 是否收到过流式数据 — 避免回调流程误触发 catch-up
sawStreamDataRef: Set<agentId>

// 待刷新的思考文本（防抖）
pendingThinkingRef: Map<messageId, thinkingText>
```

---

## 5. 第三层：invocationId 调用槽位（chatStore）

**文件**：`src/stores/chatStore.ts`（~87KB）

### 5.1 agentInvocations

```typescript
agentInvocations: Record<string, AgentInvocationInfo>;
```

`AgentInvocationInfo` 类型定义（`chat-types.ts`）：

```typescript
interface AgentInvocationInfo {
  invocationId?: string;           // 当前活跃的调用 ID
  startedAt?: number;              // 调用开始时间
  durationMs?: number;             // 调用耗时
  sessionId?: string;              // 会话 ID
  sessionSeq?: number;             // 会话序号
  sessionSealed?: boolean;         // 会话是否已封存
  taskProgress?: TaskProgressSnapshot;  // 任务进度快照
  usage?: TokenUsage;              // Token 用量
  contextHealth?: ContextHealth;   // 上下文健康度
  livenessWarning?: LivenessWarning; // 存活警告
  rateLimit?: RateLimitInfo;       // 限速信息
}
```

**关键操作**：

```typescript
// 设置/合并 agent 调用信息
setAgentInvocation: (agentId, info) => set(state => ({
  agentInvocations: {
    ...state.agentInvocations,
    [agentId]: { ...state.agentInvocations[agentId], ...info },
  },
}))
```

### 5.2 activeInvocations

```typescript
activeInvocations: Record<string, { agentId: string; mode: string; startedAt?: number }>;
```

**语义**：全局活跃调用注册表，key 为 `invocationId`。用于：
- 判断 `hasActiveInvocation`（全局是否有调用在执行）
- `done` 事件时清理对应槽位
- 并发多 agent 执行时，只当所有槽位清空才重置全局状态

```typescript
addActiveInvocation: (invocationId, agentId, mode) => ...
removeActiveInvocation: (invocationId) => ...
clearAllActiveInvocations: () => ...
```

### 5.3 invocation_created 事件的处理

当 `system_info` 解析为 `invocation_created` 时：

```typescript
if (parsed?.type === 'invocation_created') {
  const targetCatId = parsed.agentId ?? msg.agentId;
  const invocationId = parsed.invocationId;
  
  // 清除旧状态
  finalizedStreamRef.current.delete(targetCatId);
  cancelledInvocationsRef.current.delete(invocationId);  // 自愈：从黑名单移除
  
  // 注册新调用
  setLoading(true);
  setAgentStatus(targetCatId, 'streaming');
  addActiveInvocation(invocationId, targetCatId, 'execute');
  setAgentInvocation(targetCatId, {
    invocationId,
    startedAt: Date.now(),
    taskProgress: {
      tasks: [],
      lastUpdate: Date.now(),
      snapshotStatus: 'running',
      lastInvocationId: invocationId,
    },
  });
  
  // 将 invocationId 关联到已有气泡
  const targetId = getOrRecoverActiveAssistantMessageId(targetCatId, undefined, {
    preferredInvocationId: invocationId,
  });
  if (targetId) {
    setMessageStreamInvocation(targetId, invocationId);
  }
}
```

### 5.4 taskProgress 快照

```typescript
interface TaskProgressSnapshot {
  tasks: TaskProgressItem[];
  lastUpdate: number;
  snapshotStatus: 'running' | 'completed' | 'interrupted';
  lastInvocationId?: string;
  interruptReason?: string;
}
```

- `tasks`：从 `system_info.task_progress` 事件更新，包含任务列表及状态
- `snapshotStatus`：`running` → `completed`/`interrupted`，在 `done` 或 `clearAgentStatuses` 时转换
- `lastInvocationId`：用于关联到具体的调用

---

## 6. 第四层：TaskRunAccumulator 任务段分组（relay-shared）

**文件**：`@openjiuwen/relay-shared/src/task-run-accumulator.ts`

这是 **最核心的分组算法**，将散乱的 thinking/text/tool 事件按 `taskId` 分组到段（Segment）中。

### 6.1 数据结构

```typescript
class TaskRunAccumulator {
  private readonly segments: TaskRunSegmentPersisted[] = [];     // 任务段列表
  private readonly indexByTaskId = new Map<string, number>();    // taskId → segments 索引
  private stack: string[] = [];                                  // 任务嵌套栈
}
```

#### TaskRunSegmentPersisted

```typescript
interface TaskRunSegmentPersisted {
  taskId: string;                    // 任务 ID（或 '__ungrouped__'）
  title?: string;                   // 任务标题
  taskIndex?: number;               // 任务序号
  totalTasks?: number;              // 总任务数
  isSubagent?: boolean;             // 是否子智能体
  thinking: string;                 // 聚合的思考文本
  thinkingChunks?: ThinkingChunk[]; // 思考文本时间线
  textChunks?: ThinkingChunk[];     // 流式文本时间线
  toolEvents: TaskRunToolEvent[];   // 工具事件列表
  text: string;                     // 聚合的流式文本
  subagentRuns?: TaskRunSubagentPersisted[];  // 子智能体运行
}
```

#### TaskRunSubagentPersisted

```typescript
interface TaskRunSubagentPersisted {
  subagentId: string;               // 子智能体 ID（来自 stream_source_id）
  title?: string;
  thinking: string;
  thinkingChunks?: ThinkingChunk[];
  textChunks?: ThinkingChunk[];
  toolEvents: TaskRunToolEvent[];
  text: string;
}
```

### 6.2 任务栈（Stack）机制

`stack` 是一个字符串数组，模拟任务嵌套：

```
时间线：
  task_boundary(start, taskId='A')  → stack = ['A']
  task_boundary(start, taskId='B')  → stack = ['A', 'B']
  ... B 的内容归入 segment B ...
  task_boundary(complete, taskId='B') → stack = ['A']  (splice from index 1)
  ... A 的内容归入 segment A ...
  task_boundary(complete, taskId='A') → stack = []
```

### 6.3 resolveParentKey — 确定当前归属任务

```typescript
private resolveParentKey(msg: AgentLikeTaskMessage): string {
  return msg.taskContext?.id            // 1. 事件显式携带的 taskId
    ?? this.stack[this.stack.length - 1]  // 2. 栈顶的当前任务
    ?? TASK_RUN_UNGROUPED;               // 3. 兜底：'__ungrouped__'
}
```

**优先级**：
1. 事件自身携带 `taskContext.id` → 使用它
2. 事件无 taskId → 使用栈顶（当前活跃任务）
3. 栈为空 → 归入 `__ungrouped__` 段

### 6.4 resolveContentBucket — 确定写入桶

```typescript
private resolveContentBucket(msg: AgentLikeTaskMessage): TaskRunContentBucket {
  const parentKey = this.resolveParentKey(msg);
  const seg = this.ensureSegmentByKey(parentKey, msg.taskContext);
  const subagentId = this.resolveSubagentStreamId(msg);
  if (subagentId) {
    return this.ensureSubagentRun(seg, subagentId, subagentId);  // 子智能体桶
  }
  return seg;  // 主任务段桶
}
```

**子智能体判定**：`stream_source_id` 存在且不等于 `'main'` 时，事件归入父任务段下的 `subagentRuns` 子桶。

### 6.5 onBoundary — 任务边界处理

```typescript
onBoundary(msg: AgentLikeTaskMessage): void {
  if (msg.taskPhase === 'start' && msg.taskContext?.id) {
    this.stack.push(msg.taskContext.id);              // 入栈
    this.ensureSegmentByKey(msg.taskContext.id, msg.taskContext);  // 确保段存在
    return;
  }
  if (msg.taskPhase === 'complete' && msg.taskContext?.id) {
    const i = this.stack.lastIndexOf(msg.taskContext.id);
    if (i >= 0) this.stack.splice(i);                // 出栈（含上方所有嵌套）
  }
}
```

**注意**：`splice(i)` 会移除从索引 `i` 开始的所有元素，这意味着如果内层任务未正常 complete，外层 complete 会一并清理。

### 6.6 appendText — 任务作用域文本

```typescript
appendText(msg: AgentLikeTaskMessage, text: string): void {
  const bucket = this.resolveContentBucket(msg);
  bucket.text += text;                    // 追加聚合文本
  bucket.textChunks.push({ timestamp: ts, text });  // 追加时间线条目
}
```

**关键判断**：在 `handleAgentMessage` 中，先调用 `acc.isTaskScopedText(shell)` 判断文本是否应归入 taskRuns：

```typescript
isTaskScopedText(msg: AgentLikeTaskMessage): boolean {
  return this.resolveParentKey(msg) !== TASK_RUN_UNGROUPED;
}
```

- 如果当前有活跃任务（栈非空）或事件携带 taskId → `true` → 文本写入 taskRuns
- 如果无活跃任务 → `false` → 文本直接追加到气泡 `content`（正式回复）

### 6.7 appendThinking — 思考内容

```typescript
appendThinking(msg, text, strategy): void {
  const bucket = this.resolveContentBucket(msg);
  bucket.thinking = appendThinkingChunk(bucket.thinking, text, strategy);
  bucket.thinkingChunks.push({ timestamp: ts, text });
}
```

`strategy` 控制合并方式：
- `'append'`：直接拼接
- `'paragraph'`：用 `\n\n` 分隔

### 6.8 appendTool — 工具事件

```typescript
appendTool(msg: AgentLikeTaskMessage, ev: TaskRunToolEvent): void {
  // tool_result 优先路由到已持有对应 tool_use 的桶
  if (ev.type === 'tool_result' && ev.toolCallId) {
    const target = this.findBucketForToolResult(ev.toolCallId);
    if (target) { target.toolEvents.push(ev); return; }
  }
  // 兜底：路由到当前内容桶
  const bucket = this.resolveContentBucket(msg);
  bucket.toolEvents.push(ev);
}
```

**findBucketForToolResult** 的精确定位逻辑：

1. 遍历所有段和子智能体，找到持有匹配 `toolCallId` 的 `tool_use` 且 `tool_result` 数量少于 `tool_use` 数量的桶
2. 如果没找到（所有 result 已配对），回退到任意持有该 `toolCallId` 的 `tool_use` 的桶
3. 最终兜底：使用 `resolveContentBucket` 的当前桶

### 6.9 toExtra — 输出持久化格式

```typescript
toExtra(): TaskRunPersistExtra {
  return {
    v: 1,
    segments: this.segments.map(s => ({
      taskId: s.taskId,
      title: s.title,
      thinking: s.thinking,
      thinkingChunks: s.thinkingChunks,
      textChunks: s.textChunks,
      toolEvents: s.toolEvents,
      text: s.text,
      subagentRuns: s.subagentRuns,
      ...
    })),
  };
}
```

### 6.10 loadFromExtra — 从持久化恢复

线程切换后，accumulator 可能被清除。`loadFromExtra` 从 `message.extra.taskRuns` 重建状态：

```typescript
loadFromExtra(extra: TaskRunPersistExtra): void {
  this.reset();
  for (const seg of extra.segments) {
    const cloned = cloneSegment(seg);
    const idx = this.segments.length;
    this.indexByTaskId.set(cloned.taskId, idx);
    this.segments.push(cloned);
    if (cloned.taskId !== TASK_RUN_UNGROUPED) {
      this.stack.push(cloned.taskId);
    }
  }
}
```

---

## 7. 第五层：task-run-stream-sync 桥接层

**文件**：`src/hooks/task-run-stream-sync.ts`

### 7.1 模块级累加器注册表

```typescript
// 模块级 Map — 跨组件共享
const accumulators = new Map<string, TaskRunAccumulator>();

// key 格式：`${threadId}:${messageId}`
export function taskRunAccumKey(threadId: string, messageId: string): string {
  return `${threadId}:${messageId}`;
}
```

**为什么是模块级而非组件级？** 因为 `useAgentMessages` 可能因组件卸载而丢失 ref，但 accumulator 需要在线程切换后仍可恢复。

### 7.2 getTaskRunAccumulator — 获取或创建

```typescript
export function getTaskRunAccumulator(threadId: string, messageId: string): TaskRunAccumulator {
  const key = taskRunAccumKey(threadId, messageId);
  const existing = accumulators.get(key);
  if (existing) return existing;

  const acc = new TaskRunAccumulator();
  // 从已有消息的 extra.taskRuns 恢复
  const msg = findThreadMessage(threadId, messageId);
  const taskRuns = msg?.extra?.taskRuns;
  if (taskRuns?.v === 1 && taskRuns.segments.length > 0) {
    acc.loadFromExtra(taskRuns);
  }
  accumulators.set(key, acc);
  return acc;
}
```

### 7.3 flushTaskRunsToMessage — 刷新到 Store

```typescript
export function flushTaskRunsToMessage(threadId: string, messageId: string): void {
  const key = taskRunAccumKey(threadId, messageId);
  const acc = accumulators.get(key);
  const tr = acc?.toExtra();
  if (!tr) return;

  const existing = findThreadMessage(threadId, messageId);
  // 合并：保留旧段的元数据（标题、序号等）
  const mergedTr = mergeTaskRunsPreserveSegmentMeta(tr, existing?.extra?.taskRuns);
  
  const patch = { extra: { ...existing?.extra, taskRuns: mergedTr } };
  
  // 根据是否为当前线程选择不同的 patch 方法
  if (state.currentThreadId === threadId) {
    state.patchMessage(messageId, patch);
  } else {
    state.patchThreadMessage(threadId, messageId, patch);
  }
}
```

### 7.4 便捷函数

```typescript
// 判断文本是否为任务作用域
isTaskScopedStreamText(msg, threadId, messageId): boolean

// 追加任务作用域文本
appendTaskScopedStreamText(threadId, messageId, msg, text): void

// 追加任务作用域思考
appendTaskScopedThinking(threadId, messageId, msg, thinkingText, mergeStrategy): void

// 应用任务边界
applyTaskBoundary(threadId, messageId, msg): void

// 追加任务作用域工具
appendTaskScopedTool(threadId, messageId, msg, tool): void
```

每个便捷函数的模式相同：
1. 获取/创建 accumulator
2. 调用 accumulator 的对应方法
3. `flushTaskRunsToMessage` 刷新到 Store

---

## 8. 完整数据流图

```
后端发出 WS 事件
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  useSocket: socket.on('agent_message')                       │
│                                                              │
│  1. 解析 threadId（invocationThreadMap 回退）                 │
│  2. 双指针守卫判断 active/background                         │
│  3. 缺失 threadId → 缓冲或丢弃                              │
│  4. active → onMessage → handleAgentMessage                  │
│  5. background → handleBackgroundAgentMessage                │
└──────────────────────────────────────────────────────────────┘
  │ (active thread)
  ▼
┌──────────────────────────────────────────────────────────────┐
│  useAgentMessages: handleAgentMessage(msg)                   │
│                                                              │
│  1. 跨线程守卫：activeRef.threadId !== currentThreadId → 清除│
│  2. 取消黑名单：cancelledInvocationsRef.has(invocationId) → 丢弃│
│  3. 按 msg.type 分发：                                       │
│     ├─ text (stream)                                         │
│     │   ├─ ensureActiveAssistantMessage → 获取/创建气泡      │
│     │   ├─ isTaskScopedText?                                │
│     │   │   ├─ true → acc.appendText + flush                │
│     │   │   └─ false → appendToMessage (气泡 content)       │
│     │   └─ 无活跃气泡 → 创建新气泡 + activeRefs.set         │
│     ├─ text (callback)                                       │
│     │   ├─ findCallbackReplacementTarget → 替换流式气泡      │
│     │   └─ 无替换目标 → 创建回调气泡                        │
│     ├─ tool_use                                              │
│     │   ├─ ensureActiveAssistantMessage                     │
│     │   ├─ appendToolEvent (气泡级，非子智能体)              │
│     │   └─ acc.appendTool + flush (任务段级)                │
│     ├─ tool_result                                           │
│     │   ├─ ensureActiveAssistantMessage                     │
│     │   ├─ appendToolEvent (气泡级，非子智能体)              │
│     │   └─ acc.appendTool + flush (任务段级)                │
│     ├─ done                                                  │
│     │   ├─ setStreaming(false) + stampCompletedAt            │
│     │   ├─ stampMessageTaskProgress (冻结进度)               │
│     │   ├─ flushTaskRunsToMessage (最终刷新)                 │
│     │   ├─ clearTaskRunAccumulator (清除累加器)              │
│     │   └─ removeActiveInvocation (清理槽位)                │
│     └─ system_info                                           │
│         ├─ invocation_created → 注册调用槽位                 │
│         ├─ task_boundary → acc.onBoundary + flush            │
│         ├─ task_progress → setAgentInvocation.taskProgress   │
│         ├─ thinking → acc.appendThinking + flush             │
│         └─ ...其他子类型                                     │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  TaskRunAccumulator (relay-shared)                           │
│                                                              │
│  segments[] ← 按 taskId 分组                                 │
│  stack ← 任务嵌套栈                                          │
│  subagentRuns[] ← 按 stream_source_id 嵌套                  │
│                                                              │
│  resolveParentKey: taskContext.id ?? stack.top ?? '__ungrouped__' │
│  resolveContentBucket: segment + subagentRun                 │
│  findBucketForToolResult: toolCallId 精确配对                │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  task-run-stream-sync                                        │
│                                                              │
│  accumulators: Map<threadId:messageId, TaskRunAccumulator>   │
│  flushTaskRunsToMessage → patchMessage({ extra.taskRuns })   │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
┌──────────────────────────────────────────────────────────────┐
│  chatStore                                                   │
│                                                              │
│  messages[].extra.taskRuns: { v:1, segments[] }              │
│  agentInvocations[agentId].taskProgress                      │
└──────────────────────────────────────────────────────────────┘
  │
  ▼
UI 渲染
```

---

## 9. 各事件类型的分组路径

### 9.1 文本事件（text, origin=stream）

```
WS: { type: 'text', content: '...', agentId, invocationId, taskContext?, stream_source_id? }
  │
  ├─ 无活跃任务 (stack=[], 无 taskContext)
  │   └─ appendToMessage(messageId, content)  →  气泡 content 字段（正式回复）
  │
  └─ 有活跃任务 (stack 非空 或 taskContext 存在)
      └─ acc.appendText(shell, content)  →  segment.text / subagentRun.text
         └─ flushTaskRunsToMessage  →  message.extra.taskRuns.segments[n].text
```

### 9.2 思考事件（system_info.type=thinking）

```
WS: { type: 'system_info', content: '{"type":"thinking","text":"..."}', agentId, invocationId }
  │
  ├─ 非子智能体
  │   ├─ pendingThinkingRef.set(messageId, text)  →  防抖写入气泡 thinking 字段
  │   └─ acc.appendThinking(shell, text)  →  segment.thinking
  │
  └─ 子智能体
      └─ acc.appendThinking(shell, text)  →  subagentRun.thinking
         └─ flushTaskRunsToMessage  →  message.extra.taskRuns.segments[n].thinking
```

### 9.3 工具事件（tool_use / tool_result）

```
WS: { type: 'tool_use', toolName, toolInput, toolCallId, agentId, invocationId, taskContext? }
  │
  ├─ 非子智能体
  │   └─ appendToolEvent(messageId, { type: 'tool_use', label, detail, toolCallId })
  │      →  气泡 toolEvents[] 字段（气泡级工具时间线）
  │
  ├─ acc.appendTool(shell, toolEvent)
  │   ├─ tool_result + toolCallId → findBucketForToolResult 精确配对
  │   └─ 兜底 → resolveContentBucket → segment/subagentRun.toolEvents
  │
  └─ flushTaskRunsToMessage  →  message.extra.taskRuns.segments[n].toolEvents
```

**双写设计**：工具事件同时写入气泡级 `toolEvents[]` 和任务段级 `taskRuns.segments[].toolEvents`。前者用于气泡内工具时间线渲染，后者用于任务进度面板。

### 9.4 任务边界事件（system_info.type=task_boundary）

```
WS: { type: 'system_info', content: '{"type":"task_boundary","taskId":"...","phase":"start"}' }
  │
  └─ acc.onBoundary({ taskPhase: 'start', taskContext: { id: taskId, title, index, total } })
     ├─ phase='start' → stack.push(taskId) + ensureSegmentByKey
     └─ phase='complete' → stack.splice(lastIndexOf(taskId))
  │
  └─ flushTaskRunsToMessage  →  message.extra.taskRuns 更新
```

### 9.5 调用创建事件（system_info.type=invocation_created）

```
WS: { type: 'system_info', content: '{"type":"invocation_created","invocationId":"...","agentId":"..."}' }
  │
  ├─ cancelledInvocationsRef.delete(invocationId)  // 自愈
  ├─ addActiveInvocation(invocationId, agentId, 'execute')
  ├─ setAgentInvocation(agentId, { invocationId, startedAt, taskProgress: { tasks: [], snapshotStatus: 'running' } })
  └─ setMessageStreamInvocation(messageId, invocationId)  // 关联到气泡
```

### 9.6 完成事件（done）

```
WS: { type: 'done', agentId, invocationId, isFinal }
  │
  ├─ setStreaming(messageId, false)
  ├─ stampAssistantMessageCompletedAt(messageId)
  ├─ stampMessageTaskProgress(agentId, messageId, hasErrorFallback)
  │   └─ 将 agentInvocations[agentId].taskProgress 冻结到 message.extra.taskProgress
  ├─ finalizedStreamRef.set(agentId, messageId)  // 供回调替换
  ├─ activeRefs.delete(agentId)
  ├─ flushTaskRunsToMessage(messageId)  // 最终刷新
  ├─ clearTaskRunAccumulator(threadId, messageId)  // 清除累加器
  ├─ setAgentInvocation(agentId, { invocationId: undefined })  // 清除调用 ID
  ├─ removeActiveInvocation(invocationId)  // 清除槽位
  │
  └─ isFinal=true 且无剩余调用
      ├─ clearDoneTimeout()
      ├─ setLoading(false)
      ├─ setIntentMode(null)
      └─ clearAgentStatuses()
```

---

## 10. 并发与竞态防护

### 10.1 跨线程污染防护

| 机制 | 位置 | 防护场景 |
|------|------|----------|
| 双指针守卫 | `useSocket.routeAgentMessage` | URL 路由与 Store 状态不一致 |
| activeRef.threadId 检查 | `handleAgentMessage` 入口 | 旧线程的 activeRef 污染新线程 |
| threadId 缺失丢弃 | `routeAgentMessage` | 无线程归属的事件泄漏 |

### 10.2 调用竞态防护

| 机制 | 位置 | 防护场景 |
|------|------|----------|
| cancelledInvocationsRef | `handleAgentMessage` 入口 | 用户点停止后旧事件污染新气泡 |
| replacedInvocationsRef | `text(callback)` 处理 | 回调替换后延迟流式片段创建幽灵气泡 |
| terminalStreamSuppressionRef | `text/tool` 处理 | 终端错误后抑制后续流式片段 |
| finalizedStreamRef | `done` + `callback` | 精确匹配刚完成的气泡，避免贪婪扫描 |

### 10.3 并发多 Agent 执行

- `activeRefs`：每个 agent 独立条目，互不干扰
- `activeInvocations`：每个 invocationId 独立槽位
- `done(isFinal)` 只在所有槽位清空时才重置全局状态
- `TaskRunAccumulator` 按 `threadId:messageId` 隔离

### 10.4 线程切换恢复

- `setCurrentThread`：快照当前扁平状态到 `threadStates[oldId]`，恢复目标线程状态
- `getTaskRunAccumulator`：从 `message.extra.taskRuns` 重建 accumulator
- `findRecoverableAssistantMessage`：多级回退查找可恢复的流式气泡
- 重连协调：`reconcileInvocationStateOnReconnect` 获取 `/api/threads/{id}/queue` 同步状态

---

## 11. 关键数据结构汇总

### 11.1 消息气泡（ChatMessage）

```typescript
interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  agentId?: string;
  content: string;                    // 正式回复文本（非任务作用域）
  thinking?: string;                  // 气泡级思考文本
  origin?: 'stream' | 'callback';     // 来源
  isStreaming?: boolean;              // 是否正在流式
  metadata?: ChatMessageMetadata;     // 模型/用量信息
  toolEvents?: ToolEvent[];           // 气泡级工具事件时间线
  extra?: {
    stream?: {
      invocationId?: string;          // 关联的调用 ID
      completedAt?: number;           // 完成时间
      durationMs?: number;            // 执行耗时
    };
    taskRuns?: TaskRunPersistExtra;   // ★ 任务段分组数据
    taskProgress?: TaskProgressPersistExtra;  // 冻结的任务进度
    crossPost?: { sourceThreadId, sourceInvocationId };
    errorFallback?: { kind, rawError, timestamp };
  };
}
```

### 11.2 任务段分组数据（TaskRunPersistExtra）

```typescript
interface TaskRunPersistExtra {
  v: 1;
  segments: TaskRunSegmentPersisted[];
}

interface TaskRunSegmentPersisted {
  taskId: string;                    // '__ungrouped__' 或具体任务 ID
  title?: string;
  taskIndex?: number;
  totalTasks?: number;
  thinking: string;                  // 聚合思考文本
  thinkingChunks?: { timestamp, text }[];  // 思考时间线
  text: string;                      // 聚合流式文本
  textChunks?: { timestamp, text }[];     // 文本时间线
  toolEvents: TaskRunToolEvent[];    // 工具事件
  subagentRuns?: TaskRunSubagentPersisted[];  // 子智能体
}
```

### 11.3 Agent 调用信息（AgentInvocationInfo）

```typescript
interface AgentInvocationInfo {
  invocationId?: string;
  startedAt?: number;
  durationMs?: number;
  sessionId?: string;
  taskProgress?: {
    tasks: TaskProgressItem[];
    lastUpdate: number;
    snapshotStatus: 'running' | 'completed' | 'interrupted';
    lastInvocationId?: string;
  };
  usage?: TokenUsage;
  contextHealth?: ContextHealth;
  livenessWarning?: LivenessWarning;
}
```

---

## 12. 总结

### 核心分组机制

WebSocket 消息按任务分组的本质是一个 **从粗到细的四级归属解析**：

1. **线程归属**（threadId）：`useSocket` 通过双指针守卫将事件路由到活跃线程或后台线程
2. **气泡归属**（agentId + invocationId）：`useAgentMessages` 通过 `activeRefs` 将事件路由到正确的 ChatMessage
3. **调用归属**（invocationId）：`chatStore.agentInvocations` 维护每个 agent 的调用状态和任务进度
4. **任务段归属**（taskId + stream_source_id）：`TaskRunAccumulator` 通过任务栈和内容桶将 thinking/text/tool 分组到段

### 关键设计决策

| 决策 | 原因 |
|------|------|
| **双写 toolEvents** | 气泡级时间线 + 任务段级分组，满足两种 UI 渲染需求 |
| **isTaskScopedText 判断** | 无任务上下文的文本是正式回复（气泡 content），有任务上下文的文本是过程输出（taskRuns） |
| **模块级 accumulator Map** | 跨组件生命周期共享，线程切换后可从 message.extra 恢复 |
| **任务栈（stack）** | 支持任务嵌套，内层任务的输出自动归入外层任务的段 |
| **stream_source_id 子智能体** | 子智能体输出嵌套在父任务段的 subagentRuns 下，不污染顶层任务列表 |
| **findBucketForToolResult** | tool_result 通过 toolCallId 精确配对到持有 tool_use 的桶，避免错位 |
| **防抖 thinking + 立即 flush taskRuns** | 气泡级思考文本防抖减少渲染，任务段思考立即刷新保证面板实时性 |
| **cancelledInvocationsRef 黑名单** | 用户取消后旧 invocationId 的事件仍会到达，入口丢弃防止污染新气泡 |
| **finalizedStreamRef** | done 后记录刚完成的气泡 ID，callback 替换时精确匹配而非贪婪扫描 |

### 文件依赖关系

```
useSocket.ts
  └─ routeAgentMessage → callbacks.onMessage
       └─ useChatSocketCallbacks.ts
            └─ handleAgentMessage (from useAgentMessages.ts)
                 ├─ chatStore.ts (addMessage, patchMessage, setAgentInvocation, ...)
                 └─ task-run-stream-sync.ts
                      └─ TaskRunAccumulator (from @openjiuwen/relay-shared)
```

本文写于：2026年6月3日

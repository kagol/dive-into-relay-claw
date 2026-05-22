# 对话数据流

对话流程始于一个问题。

## 一、全局数据流概览

```
用户键盘输入
    │
    ▼ ① 文本规范化
string (raw input)
    │
    ▼ ② 乐观更新
ChatMessage { type:'user', content, id:'user-uuid' }
    │
    ▼ ③ HTTP POST
JSON { content, threadId, idempotencyKey, mentionRefs, deliveryMode }
    │
    ▼ ④ Socket 连接 + 事件监听
AgentMessage { type, agentId, content, taskContext, taskPhase, invocationId, ... }
    │
    ▼ ⑤ 双指针路由
AgentMessage → active | background
    │
    ▼ ⑥ 流式消息分发处理
ChatMessage { type:'assistant', content, isStreaming:true, extra:{taskRuns} }
    │
    ▼ ⑦ TaskRun 累积
TaskRunPersistExtra { v:1, segments:[{taskId, thinking, text, toolEvents}] }
    │
    ▼ ⑧ React 渲染
TaskSegmentTimelineEntry[] → ThinkingContent + MarkdownContent + CliOutputBlock
```

---

## 二、逐阶段数据形态详解

### 阶段 ① 文本规范化

**输入：** 用户在 `RichTextarea` 中键入的原始字符串

**处理函数：** `useChatInputSendFlow.handleSend()`

**数据转换链：**
```
rawInput: string
  → normalizeQuickActionsForSend(trimmed)   // 替换快捷操作 token 为发送格式
  → normalizeSkillsForSend(...)             // 替换 [[skill:xxx]] token
  → normalizeMentionsForSend(..., agentOptions)  // 替换 @mention 为发送格式
  → payload: string                         // 最终发送文本
```

**同时产出：**
```typescript
sendOptions: SendMessageOptions = {
  interactiveAsk?: boolean,      // 引导模式
  pptTemplateId?: string,        // PPT 模板 ID
  mentionRefs?: MentionRef[],    // [{ catId, mention }] @mention 引用
}
```

**关键文件：** `chat-input/hooks/useChatInputSendFlow.ts` → `chat-input/utils/helpers.ts`

---

### 阶段 ② 乐观更新（Optimistic Update）

**输入：** `payload: string` + `images?: File[]`

**处理函数：** `useSendMessage.handleSend()`

**数据转换：**
```typescript
// 1. 生成客户端 ID
clientMessageId = crypto.randomUUID()
optimisticMessageId = `user-${clientMessageId}`

// 2. 构造乐观用户消息
userMsg: ChatMessage = {
  id: optimisticMessageId,    // 'user-xxxx-xxxx-xxxx'
  type: 'user',
  content: payload,           // 规范化后的文本
  timestamp: Date.now(),
  // 如有附件：
  contentBlocks: [
    { type: 'text', text: payload },
    { type: 'image', url: URL.createObjectURL(file) },  // blob URL 预览
    // 或 { type: 'file', url, fileName, mimeType, fileSize }
  ],
  // 如有 whisper：
  visibility: 'whisper',
  whisperTo: ['agent-id-1'],
}
```

**Store 状态变更：**
```typescript
chatStore.addMessage(userMsg)                    // 插入 messages[]
chatStore.setLoading(true)                       // isLoading = true
chatStore.setHasActiveInvocation(true)           // hasActiveInvocation = true
```

> **Queue 模式跳过乐观插入**：`deliveryMode === 'queue'` 时不调用 addMessage，等 `messages_delivered` 事件再插入。

**关键文件：** `hooks/useSendMessage.ts` L58-L120

---

### 阶段 ③ HTTP POST 请求

**输入：** `userMsg` + `threadId` + `sendOptions`

**数据转换 — JSON 模式（无附件）：**
```typescript
POST /api/messages
Body: JSON.stringify({
  content: string,              // 用户消息文本
  threadId: string,             // 当前线程 ID
  idempotencyKey: string,       // 客户端生成的幂等键
  deliveryMode?: 'queue',      // 投递模式
  resumeAgentId?: string,      // 恢复指定智能体
  interactive_ask?: boolean,   // 引导模式标记
  pptContext?: object,         // PPT 上下文
  pptTemplateId?: string,      // PPT 模板
  mentionRefs?: MentionRef[],  // @mention 引用列表
  visibility?: 'whisper',      // 可见性
  whisperTo?: string[],        // whisper 接收者
})
```

**数据转换 — FormData 模式（有附件）：**
```typescript
POST /api/messages
Body: FormData {
  content: string,
  threadId: string,
  idempotencyKey: string,
  images: File[],              // 图片文件
  attachments: File[],         // 非图片附件
  // ...其他字段同 JSON 模式
}
```

**响应数据：**
```typescript
{
  status?: 'queued' | 'game_started' | 'duplicate',
  userMessageId?: string,      // 后端持久化后的真实消息 ID
  entryId?: string,            // 队列条目 ID
  gameThreadId?: string,       // 游戏线程 ID
  merged?: boolean,            // 队列合并标记
}
```

**后处理：**
- `replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId)` — 用后端真实 ID 替换乐观 ID
- `reconcileQueuedResponse()` — queue 模式下移除乐观消息
- `reconcileQueueFallbackToImmediate()` — queue 降级为 immediate 时补插消息

**关键文件：** `hooks/useSendMessage.ts` L240-L360

---

### 阶段 ④ Socket 连接 + 事件监听

**连接建立：**
```typescript
socket = io(API_URL)
socket.emit('join_room', `thread:${threadId}`)
```

**监听的核心事件及数据结构：**

| 事件名 | 数据结构 | 触发时机 |
|--------|---------|---------|
| `agent_message` | `AgentMessage` | 每个流式 chunk（text/thinking/tool_use/tool_result/done） |
| `intent_mode` | `{ threadId, mode, targetAgents, invocationId }` | 智能体开始执行 |
| `task_created` | `TaskItem` | 后端创建新任务 |
| `task_updated` | `TaskItem` | 后端更新任务状态 |
| `done` | `AgentMessage { type:'done', isFinal:true }` | 流式输出结束 |
| `connector_message` | `ConnectorMessageEvent` | 外部渠道消息 |
| `thread_updated` | `{ threadId, title }` | 线程标题更新 |
| `heartbeat` | `{ threadId }` | 心跳保活 |

**AgentMessage 完整数据结构：**
```typescript
interface AgentMessage {
  type: string;              // 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error' | 'callback' | 'heartbeat'
  agentId: string;           // 智能体 ID
  threadId?: string;         // 线程 ID
  content?: string;          // 文本内容（text/thinking 的增量 chunk）
  sessionId?: string;        // 会话 ID
  toolName?: string;         // 工具名称（tool_use/tool_result）
  toolInput?: Record<string, unknown>;  // 工具输入参数
  error?: string;            // 错误信息
  errorCode?: string;        // 错误码
  isFinal?: boolean;         // 是否最终消息（done 时为 true）
  metadata?: {               // 模型元数据
    provider: string;
    model: string;
    sessionId?: string;
    usage?: TokenUsage;      // { inputTokens, outputTokens, totalTokens, costUsd, durationMs }
  };
  origin?: 'stream' | 'callback';  // 消息来源
  invocationId?: string;     // 调用 ID（区分并发调用）
  timestamp: number;         // 时间戳
  taskContext?: {            // 任务上下文
    id: string;
    title?: string;
    index?: number;          // 任务序号
    total?: number;          // 总任务数
  };
  taskPhase?: 'start' | 'complete';  // 任务阶段
  replyTo?: string;          // 回复目标消息 ID
  replyPreview?: { senderAgentId, content, deleted? };
}
```

**关键文件：** `hooks/useSocket.ts` L35-L58, L611-L680

---

### 阶段 ⑤ 双指针路由（Dual-Pointer Guard）

**输入：** `AgentMessage`（从 Socket 事件收到）

**路由逻辑：**
```typescript
routeAgentMessage(routedMsg, originalMsg) {
  // 双指针守卫：比较 Socket 路由线程 vs Store 当前线程
  const routeThread = routedMsg.threadId;
  const storeThread = useChatStore.getState().currentThreadId;

  if (routeThread === storeThread) {
    // → Active 路径：消息属于当前活跃线程
    callbacks.onMessage(routedMsg);  // → handleAgentMessage
  } else {
    // → Background 路径：消息属于后台线程
    handleBackgroundAgentMessage(routedMsg);
  }
}
```

**数据流分叉：**
```
AgentMessage
  ├─ active  → handleAgentMessage(msg)    // 实时流式处理
  └─ background → handleBackgroundAgentMessage(msg)  // 后台线程静默累积
```

> **为什么需要双指针？** 用户在 A 线程发送消息后切到 B 线程，A 的流式响应仍在到达。双指针确保 A 的消息不会渲染到 B 的 UI 中。

**关键文件：** `hooks/useSocket.ts` L487-L580

---

### 阶段 ⑥ 流式消息分发处理

**输入：** `AgentMessage`（经路由后到达 active 路径）

**处理函数：** `handleAgentMessage(msg)` — 按 `msg.type` 分发

#### 6a. type === 'text'（流式文本 chunk）

```
AgentMessage { type:'text', content:'chunk...', origin, taskContext }
```

**分支 A — 任务作用域文本（task-scoped）：**
```typescript
// 判断是否属于某个任务的流式文本
if (acc.isTaskScopedText(shell)) {
  acc.appendText(shell, msg.content);     // → TaskRunAccumulator 累积
  flushTaskRunsToMessage(messageId);      // → 写回 chatStore
}
```

**分支 B — 助手正式正文（非任务作用域）：**
```typescript
else {
  appendToMessage(messageId, msg.content);  // → chatStore: message.content += chunk
}
```

**如果是新消息（无已有 assistant 消息）：**
```typescript
addMessage({
  id: `msg-${Date.now()}-${msg.agentId}`,
  type: 'assistant',
  agentId: msg.agentId,
  content: taskOnly ? '' : msg.content,  // task-scoped 时不写入 content
  origin: 'stream',
  isStreaming: true,
  extra: { stream: { invocationId } },
  timestamp: ...,
});
```

#### 6b. type === 'thinking'（思考过程）

```typescript
// 写入 message.thinking 字段
setMessageThinking(messageId, msg.content);  // → chatStore: message.thinking += chunk
// 或通过 TaskRunAccumulator:
acc.appendThinking(shell, msg.content);
flushTaskRunsToMessage(messageId);
```

#### 6c. type === 'tool_use' / 'tool_result'（工具调用）

```typescript
// 构造 ToolEvent
const toolEvent: ToolEvent = {
  id: `tool-${Date.now()}-${idx}`,
  type: msg.type,           // 'tool_use' | 'tool_result'
  label: msg.toolName,
  detail: JSON.stringify(msg.toolInput),
  timestamp: msg.timestamp,
  toolCallId: msg.toolCallId,
};

// 双写：chatStore.toolEvents + TaskRunAccumulator
appendToolEvent(messageId, toolEvent);        // → message.toolEvents.push(event)
getTaskRunAccum(messageId).appendTool(shell, toolEvent);  // → segment.toolEvents.push(event)
flushTaskRunsToMessage(messageId);
```

#### 6d. type === 'done'（流式结束）

```typescript
patchMessage(messageId, {
  isStreaming: false,
  metadata: msg.metadata,     // { provider, model, usage }
});
removeActiveInvocation(invocationId, msg.agentId);
setLoading(false);
setHasActiveInvocation(false);
```

#### 6e. type === 'callback'（MCP post_message，如语音合成）

```typescript
// 替换流式占位气泡为最终内容
patchMessage(finalId, {
  content: msg.content,
  origin: 'callback',
  isStreaming: false,
  metadata: msg.metadata,
});
```

**关键文件：** `hooks/useAgentMessages.ts` L780-L940

---

### 阶段 ⑦ TaskRun 累积（核心数据转换器）

**这是整个数据流中最复杂的转换环节**，将零散的流式 chunk 组织成按任务分组的结构化数据。

#### TaskRunAccumulator 工作原理

```
流式 chunk 到达
    │
    ▼ onBoundary(msg)
判断 taskPhase ('start'/'complete') → 推入/弹出 task stack
    │
    ▼ appendText / appendThinking / appendTool
按当前 stack 顶的 taskId 写入对应 segment
    │
    ▼ toExtra()
输出 TaskRunPersistExtra
```

#### TaskRunPersistExtra 数据结构

```typescript
interface TaskRunPersistExtra {
  v: 1;
  segments: TaskRunSegmentPersisted[];
}

interface TaskRunSegmentPersisted {
  taskId: string;           // 任务 ID（'__ungrouped__' 表示未分组）
  title?: string;           // 任务标题
  taskIndex?: number;       // 任务序号
  totalTasks?: number;      // 总任务数
  thinking: string;         // 思考过程全文（累积拼接）
  thinkingChunks?: TaskRunThinkingChunkPersisted[];  // 思考过程时间线（按 chunk 记录）
  text: string;             // 任务作用域流式文本全文
  textChunks?: TaskRunThinkingChunkPersisted[];      // 流式文本时间线
  toolEvents: TaskRunToolEvent[];  // 工具事件列表
}

interface TaskRunThinkingChunkPersisted {
  timestamp: number;
  text: string;
}

interface TaskRunToolEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  timestamp: number;
  toolCallId?: string;
}
```

#### flushTaskRunsToMessage 数据转换

```typescript
flushTaskRunsToMessage(messageId) {
  const acc = taskRunAccumulatorsRef.current.get(messageId);
  const tr = acc?.toExtra();                    // TaskRunAccumulator → TaskRunPersistExtra
  const existing = chatStore.messages.find(m => m.id === messageId);
  const mergedTr = mergeTaskRunsPreserveSegmentMeta(tr, existing?.extra?.taskRuns);
  patchMessage(messageId, {
    extra: {
      ...existing?.extra,
      taskRuns: mergedTr,                       // 写入 message.extra.taskRuns
    },
  });
}
```

> **mergeTaskRunsPreserveSegmentMeta**：合并新旧 taskRuns，处理线程切换后 accumulator 丢失的恢复场景。thinkingChunks/textChunks 使用 `mergeThinkingChunksTimeline` 去重（避免 "TheTheThe…" 重复）。

**关键文件：** `hooks/useAgentMessages.ts` L256-L284, `@openjiuwen/relay-shared` 的 `task-run-accumulator.ts`

---

### 阶段 ⑧ React 渲染（数据 → UI）

#### 8a. ChatMessage 渲染决策

```typescript
// ChatMessage.tsx
const taskRuns = message.extra?.taskRuns;
const showTaskGrouped = taskRuns?.v === 1 && (taskRuns.segments?.length ?? 0) > 0;
```

**渲染路径分叉：**
```
message.type === 'assistant'
  ├─ showTaskGrouped === true
  │   → <TaskGroupedStreamBody taskRuns={taskRuns} />
  │     + <MarkdownContent content={message.content} />   // 非任务作用域的正式正文
  │
  ├─ showTaskGrouped === false
  │   → <ThinkingContent content={message.thinking} />
  │     + <CliOutputBlock events={toCliEvents(message.toolEvents)} />
  │     + <MarkdownContent content={message.content} />
  │
  └─ message.thinking (无 taskRuns)
      → <ThinkingContent /> + <MarkdownContent />
```

#### 8b. TaskGroupedStreamBody 渲染流程

**输入：** `taskRuns: TaskRunPersistExtra`

**Step 1 — 过滤可见 segments：**
```typescript
visibleSegments = taskRuns.segments.filter(seg => {
  const hasTools = toCliEvents(seg.toolEvents).length > 0;
  const hasThinking = seg.thinking?.trim() || seg.thinkingChunks?.length > 0;
  const hasStreamText = seg.text?.trim() || seg.textChunks?.length > 0;
  const noTaskId = !seg.taskId || seg.taskId === '__ungrouped__';
  if (noTaskId) return hasThinking || hasTools || hasStreamText;
  return hasThinking || hasTools || hasStreamText || seg.title?.trim();
});
```

**Step 2 — 为每个 segment 构建 timeline：**
```typescript
// 对每个 visibleSegment:
const cliEvents = toCliEvents(seg.toolEvents);  // ToolEvent[] → CliEvent[]
const timeline = buildTaskSegmentTimeline(seg, cliEvents, message.timestamp);
```

**Step 3 — buildTaskSegmentTimeline 数据转换：**

```
TaskRunSegmentPersisted
    │
    ├─ thinkingChunks? → [{ kind:'thinking', key, ts, content }]
    │  或 thinking → [{ kind:'thinking', key, ts, content }]  (fallback timestamp)
    │
    ├─ textChunks? → [{ kind:'streamText', key, ts, content }]
    │  或 text → [{ kind:'streamText', key, ts, content }]
    │
    └─ toolEvents → toCliEvents → splitCliEventsIntoToolRuns
                     → [{ kind:'tools', key, ts, events: CliEvent[] }]
    │
    ▼ 合并 + 按 timestamp 排序
[...thinkingEntries, ...streamTextEntries, ...toolEntries].sort(by ts)
    │
    ▼ 合并相邻同类 entry
mergeConsecutiveThinkingEntries()    // 相邻 thinking → 合并为一段
mergeConsecutiveStreamTextEntries()  // 相邻 streamText → 合并为一段
mergeConsecutiveToolEntries()        // 相邻 tools → 合并为一组
    │
    ▼
TaskSegmentTimelineEntry[]  // 最终渲染数据
```

**TaskSegmentTimelineEntry 类型：**
```typescript
type TaskSegmentTimelineEntry =
  | { kind: 'thinking';  key: string; ts: number; content: string }
  | { kind: 'streamText'; key: string; ts: number; content: string }
  | { kind: 'tools';      key: string; ts: number; events: CliEvent[] }
```

**Step 4 — 遍历 timeline 渲染：**
```tsx
timeline.map(entry =>
  entry.kind === 'thinking'
    ? <ThinkingContent content={entry.content} />
  : entry.kind === 'streamText'
    ? <MarkdownContent content={entry.content} />
  : entry.kind === 'tools'
    ? <CliOutputBlock events={entry.events} />
)
```

#### 8c. 任务列表侧边栏（taskStore 渲染）

**数据来源：** Socket 事件 `task_created` / `task_updated`

```
Socket event → useChatSocketCallbacks
  → onTaskCreated: taskStore.addTask(task)     // TaskItem
  → onTaskUpdated: taskStore.updateTask(task)  // TaskItem
```

**TaskItem 数据结构：**
```typescript
interface TaskItem {
  id: string;
  threadId: string;
  title: string;
  ownerAgentId: string | null;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  why: string;           // 任务原因/描述
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
```

> **注意：taskStore 的 TaskItem 和 TaskRunAccumulator 的 segment 是两套独立数据**。TaskItem 用于侧边栏任务列表展示，segment 用于消息气泡内的任务分组渲染。两者通过 `taskId` 关联但数据流独立。

---

## 三、完整数据流时序图

```
时间 ──────────────────────────────────────────────────────────────►

[用户输入]     [乐观更新]      [HTTP]        [Socket 流式]           [渲染]
    │              │             │                │                    │
    ▼              ▼             ▼                ▼                    ▼
"帮我分析"   ChatMessage    POST /api/msg    intent_mode          setLoading
  ┌─norm─┐   type:'user'    ──────────►      ─────────►           │
  │trim  │   content:       {content,        {mode,               ▼
  │mention│  "帮我分析"      threadId,        targetAgents}     ChatMessage
  │skill │   id:'user-xxx'   idempotencyKey}                     type:'assistant'
  └──────┘                                                        isStreaming:true
                                                                  content:''

                                                              agent_message
                                                              type:'thinking'
                                                              ──────────────►
                                                              message.thinking += chunk
                                                              (或 acc.appendThinking)

                                                              agent_message
                                                              type:'text'
                                                              taskPhase:'start'
                                                              taskContext:{id:'t1'}
                                                              ──────────────►
                                                              acc.appendText(shell, chunk)
                                                              flushTaskRunsToMessage()
                                                              → message.extra.taskRuns
                                                                .segments[0].text += chunk

                                                              agent_message
                                                              type:'tool_use'
                                                              ──────────────►
                                                              appendToolEvent()
                                                              acc.appendTool()
                                                              → message.toolEvents.push(e)
                                                              → segment.toolEvents.push(e)

                                                              agent_message
                                                              type:'tool_result'
                                                              ──────────────►
                                                              (同 tool_use 处理)

                                                              agent_message
                                                              type:'text'
                                                              (非 task-scoped)
                                                              ──────────────►
                                                              appendToMessage()
                                                              → message.content += chunk

                                                              agent_message
                                                              type:'done'
                                                              isFinal:true
                                                              ──────────────►
                                                              patchMessage({
                                                                isStreaming:false,
                                                                metadata:{usage}
                                                              })
                                                              removeActiveInvocation()
                                                              setLoading(false)

                                                              ─── React 渲染 ───►
                                                              ChatMessage 读取:
                                                                message.extra.taskRuns
                                                                  → TaskGroupedStreamBody
                                                                    → buildTaskSegmentTimeline()
                                                                      → ThinkingContent
                                                                      → MarkdownContent
                                                                      → CliOutputBlock
                                                                message.content
                                                                  → MarkdownContent (正式正文)
```

---

## 四、关键数据结构汇总

### 4.1 ChatMessage（chatStore 核心实体）

```typescript
interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'summary' | 'connector';
  variant?: 'error' | 'info' | 'warning' | 'tool' | 'evidence' | ...;
  agentId?: string;
  content: string;                    // 助手正式正文（非 task-scoped 的流式文本）
  contentBlocks?: MessageContent[];   // 附件 [{type:'text'|'image'|'file', ...}]
  toolEvents?: ToolEvent[];           // 工具事件列表
  metadata?: ChatMessageMetadata;     // { provider, model, usage }
  timestamp: number;
  isStreaming?: boolean;              // 是否正在流式输出
  thinking?: string;                  // 思考过程全文
  origin?: 'stream' | 'callback';    // 消息来源
  extra?: {
    rich?: { v:1; blocks: RichBlock[] };           // 富内容块
    taskRuns?: TaskRunPersistExtra;                 // ★ 任务分组数据
    stream?: { invocationId, durationMs, userStopped };
    crossPost?: { sourceThreadId };
    targetAgents?: string[];
    timeoutDiagnostics?: TimeoutDiagnostics;
    governanceBlocked?: { ... };
    errorFallback?: ErrorFallbackMetadata;
  };
  a2aGroupId?: string;
  visibility?: 'public' | 'whisper';
  whisperTo?: string[];
  replyTo?: string;
  replyPreview?: { senderAgentId, content };
}
```

### 4.2 数据写入 chatStore 的所有路径

| 写入方法 | 触发场景 | 修改字段 |
|---------|---------|---------|
| `addMessage(msg)` | 新 assistant 消息 / summary / connector | 整条消息插入 |
| `appendToMessage(id, content)` | 非任务作用域流式 text | `content += chunk` |
| `patchMessage(id, patch)` | done / callback / flushTaskRuns | 任意字段部分更新 |
| `appendToolEvent(id, event)` | tool_use / tool_result | `toolEvents.push(event)` |
| `setMessageThinking(id, text)` | thinking chunk | `thinking += chunk` |
| `appendRichBlock(id, block)` | rich_block 事件 | `extra.rich.blocks.push(block)` |

### 4.3 两条独立的数据流

```
┌─────────────────────────────────────────────────────┐
│  数据流 A：消息气泡内容                               │
│  Socket agent_message → handleAgentMessage           │
│    → chatStore (content/thinking/toolEvents/taskRuns) │
│    → ChatMessage → TaskGroupedStreamBody              │
│    → ThinkingContent + MarkdownContent + CliOutputBlock│
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  数据流 B：任务列表侧边栏                             │
│  Socket task_created/task_updated                    │
│    → useChatSocketCallbacks                          │
│    → taskStore (addTask/updateTask)                  │
│    → TaskListPanel → TaskItem[] 渲染                 │
└─────────────────────────────────────────────────────┘

关联：TaskItem.id === TaskRunSegmentPersisted.taskId
（但数据流独立，taskStore 不依赖 TaskRunAccumulator）
```

---

## 五、关键设计决策的数据流影响

| 设计决策 | 数据流影响 |
|---------|-----------|
| **乐观更新** | userMsg 先于 HTTP 响应插入 chatStore，UI 立即可见；后端响应后 replaceMessageId 替换 ID |
| **双指针守卫** | routeAgentMessage 比较 routeThread vs storeThread，防止切窗口后消息串线程 |
| **TaskRunAccumulator** | 流式 chunk 先累积在内存 Map<messageId, TaskRunAccumulator>，每次 append 后 flushTaskRunsToMessage 写回 chatStore |
| **task-scoped vs formal text** | `acc.isTaskScopedText(shell)` 判断：task-scoped → segment.text；否则 → message.content（正式正文） |
| **thinkingChunks 时间线** | 每个 thinking chunk 带 timestamp，buildTaskSegmentTimeline 按 ts 排序后与 tool 事件交错展示 |
| **mergeConsecutive 合并** | 相邻同类 timeline entry 合并，避免流式逐字渲染产生大量碎片 DOM 节点 |
| **Queue 模式** | 跳过乐观插入 + 不设 loading，等 messages_delivered 事件再显示 |
| **callback 替换 stream** | MCP post_message (callback) 替换流式占位气泡的 content，实现"先思考后说话" |

---

## 六、数据流中的 Store 状态快照

### 发送前
```typescript
chatStore = {
  messages: [...历史消息],
  isLoading: false,
  hasActiveInvocation: false,
  activeInvocations: [],
}
```

### 发送后（乐观更新）
```typescript
chatStore = {
  messages: [...历史消息, { id:'user-xxx', type:'user', content:'帮我分析' }],
  isLoading: true,
  hasActiveInvocation: true,
  activeInvocations: [],
}
```

### intent_mode 到达后
```typescript
chatStore = {
  messages: [..., userMsg],
  isLoading: true,
  hasActiveInvocation: true,
  activeInvocations: [{ invocationId, agentId, mode:'execute' }],
  intentMode: 'execute',
  targetAgents: ['agent-1'],
}
```

### 第一个 text chunk 到达后
```typescript
chatStore = {
  messages: [
    ...,
    userMsg,
    { id:'msg-xxx', type:'assistant', agentId:'agent-1', content:'', isStreaming:true,
      extra:{ taskRuns:{ v:1, segments:[{ taskId:'t1', text:'chunk1', thinking:'', toolEvents:[] }] } } }
  ],
  isLoading: true,
  hasActiveInvocation: true,
}
```

### done 到达后
```typescript
chatStore = {
  messages: [
    ...,
    userMsg,
    { id:'msg-xxx', type:'assistant', content:'最终正文', isStreaming:false,
      metadata:{ provider:'openai', model:'gpt-4', usage:{ inputTokens:100, outputTokens:500 } },
      extra:{ taskRuns:{ v:1, segments:[...] } } }
  ],
  isLoading: false,
  hasActiveInvocation: false,
  activeInvocations: [],
}
```

本文写于：2026年5月22日

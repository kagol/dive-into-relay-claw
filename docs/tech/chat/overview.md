# 对话整体流程

从输入框输入问题 → 流式渲染任务列表 + AI 正文 的完整流程

## 一、整体架构概览

```
用户输入 → ChatInput → useSendMessage → HTTP POST /api/messages
                                              ↓
                                         后端处理
                                              ↓
                                    Socket.IO 推送事件流
                                              ↓
                              useSocket → useChatSocketCallbacks
                                              ↓
                              useAgentMessages (handleAgentMessage)
                                              ↓
                              chatStore (Zustand) 状态更新
                                              ↓
                              React 响应式渲染
                              ├── TaskGroupedStreamBody (任务列表)
                              └── MarkdownContent (AI 正文)
```

## 二、阶段 1：用户输入 & 发送

涉及文件：
- `ChatInput.tsx` — 输入框主组件
- `useChatInputSendFlow.ts` — 发送流程 hook
- `useSendMessage.ts` — 消息发送核心 hook

流程：

1. 用户在 ChatInput 输入文本，支持 `@mention`、`[[skill:xxx]]` 快捷技能、附件上传等
2. 用户按 Enter 或点击发送，触发 `useChatInputSendFlow.handleSend()`
3. `handleSend()` 内部：
   - 对输入文本做标准化处理：`normalizeMentionsForSend()` → `normalizeSkillsForSend()` → `normalizeQuickActionsForSend()`
   - 组装 `sendOptions`（`interactiveAsk`、`pptTemplateId`、`mentionRefs` 等）
   - 调用 `onSend(payload, images, undefined, deliveryMode, sendOptions)`
4. `onSend` 即 `useSendMessage` 返回的 `handleSend`，进入消息发送核心流程：

## 三、阶段 2：乐观更新 & HTTP 请求

涉及文件： `useSendMessage.ts`

流程：

1. 生成乐观用户消息：创建 `userMsg = { id: "user-{uuid}", type: "user", content, timestamp }`
2. 乐观插入到 chatStore：`addMessage(userMsg)` — 用户消息立即出现在聊天界面
3. 设置加载状态：`setLoading(true)` + `setHasActiveInvocation(true)` — 显示"正在回复"
4. 发送 HTTP 请求：
   - 有附件 → `FormData + POST /api/messages`
   - 无附件 → `JSON + POST /api/messages`
   - 请求体包含：`content`、`threadId`、`idempotencyKey`、`deliveryMode`、`interactive_ask`、`mentionRefs` 等
5. HTTP 响应处理：
   - 收到 `userMessageId` → 用服务端 ID 替换乐观 ID：`replaceMessageId()`
   - 队列模式 → 特殊处理（跳过乐观插入，等 `messages_delivered` 事件）
   - 自动标题 → `maybeAutoTitleThread()`

## 四、阶段 3：Socket.IO 连接 & 事件监听

涉及文件： `useSocket.ts`

流程：

1. Socket 连接建立：`io(API_URL, { transports: ['websocket', 'polling'] })`
2. 加入房间：`socket.emit('join_room', 'thread:{threadId}')`
3. 监听关键事件：

| Socket 事件 | 触发时机 | 处理逻辑 |
|---|---|---|
| intent_mode | 后端开始处理，告知模式(ideate/execute)和目标智能体 | setLoading(true), setHasActiveInvocation(true), setIntentMode(), addActiveInvocation() |
| agent_message | 流式文本/thinking/tool_use/done 等所有 AI 输出 | → routeAgentMessage() → callbacks.onMessage() |
| task_created | 新任务创建 | → taskStore.addTask() |
| task_updated | 任务状态更新 | → taskStore.updateTask() |
| messages_delivered | 消息投递确认 | → markMessagesDelivered() |
| queue_updated | 队列状态变化 | → setQueue() |

4. 消息路由 `routeAgentMessage()`：
   - 双指针守卫：同时检查 `routeThread`（URL）和 `storeThread`（Zustand），两者一致才路由到活跃线程
   - 活跃线程 → `callbacks.onMessage(msg)` → 完整流式处理
   - 后台线程 → `handleBackgroundAgentMessage()` → 后台线程状态更新
   - 无 threadId → 缓冲或丢弃，触发 `requestThreadLiveRefresh` 恢复

## 五、阶段 4：流式消息处理（核心）

涉及文件： `useAgentMessages.ts`、`chatStore.ts`

`handleAgentMessage(msg)` 根据消息类型分发处理：

### 5.1 msg.type === 'text'（流式文本）

- origin === 'stream'（CLI 流式输出 / thinking）：
  1. 查找或创建该 agentId 的活跃流式气泡 activeRefs.get(agentId)
  2. 已有气泡 → 追加内容：
     - 检查 TaskRunAccumulator.isTaskScopedText() — 如果是任务作用域文本，走 acc.appendText() + flushTaskRunsToMessage() 更新 message.extra.taskRuns
     - 否则 → appendToMessage(messageId, content) 直接追加到消息 content
  3. 无气泡 → 创建新的 assistant 消息：addMessage({ type: 'assistant', origin: 'stream', isStreaming: true })

- origin === 'callback'（MCP post_message / 最终回复）：
  1. 查找可替换的流式气泡 findCallbackReplacementTarget()
  2. 找到 → patchMessage() 替换内容，标记 isStreaming: false
  3. 未找到 → addMessage() 创建新的 callback 消息

### 5.2 msg.type === 'tool_use'（工具调用）

1. 查找活跃气泡 → appendToolEvent(messageId, toolEvent) 追加工具事件
2. 工具事件包含：toolName、toolInput、toolCallId、timestamp

### 5.3 msg.type === 'thinking'（思考过程）

1. 查找活跃气泡 → setMessageThinking(messageId, thinking) 设置思考内容
2. 支持分块：thinkingChunks 数组逐步追加

### 5.4 msg.type === 'done'（流式结束）

1. isFinal === true → 清理流式状态：
   - setStreaming(messageId, false)
   - removeActiveInvocation(invocationId)
   - setLoading(false) + setHasActiveInvocation(false)
   - clearDoneTimeout()
2. 设置最终 metadata（provider、model、usage）

### 5.5 任务作用域消息（taskContext + taskPhase）

- taskPhase === 'start' → TaskRunAccumulator 开始新 segment
- taskPhase === 'complete' → 完成当前 segment
- 每次文本追加都通过 acc.appendText(shell, content) 累积到对应 task segment
- flushTaskRunsToMessage() 将累积结果写入 message.extra.taskRuns

## 六、阶段 5：React 渲染

涉及文件：

- `ChatContainer.tsx` — 聊天容器，遍历 messages 渲染
- `ChatMessage.tsx` — 单条消息组件
- `TaskGroupedStreamBody.tsx` — 任务分组流式渲染
- `MarkdownContent.tsx` — Markdown 正文渲染
- `taskStore.ts` — 任务列表 store

### 6.1 ChatContainer 渲染循环

ChatContainer
  ├── ThreadExecutionBar (执行状态条)
  ├── messages.map(msg => `<ChatMessage message={msg} />`)
  ├── ThinkingIndicator (思考中指示器)
  └── ChatInput (输入框)

### 6.2 ChatMessage 渲染逻辑

对于 type === 'assistant' 的消息：

1. 提取 taskRuns：const taskRuns = message.extra?.taskRuns
2. 判断是否显示任务分组：showTaskGrouped = taskRuns?.v === 1 && segments.length > 0
3. 渲染分支：

ChatMessage (assistant)
  ├── showTaskGrouped === true ?
  │ ├── `<TaskGroupedStreamBody>` ← 任务列表（思考执行过程）
  │ ├── `<MarkdownContent>` ← AI 正文内容
  │ └── `<CliOutputBlockAttachments>` ← 工具产出附件
  │
  └── showTaskGrouped === false ?
      ├── `<ThinkingContent>` ← 思考过程（旧模式）
      ├── `<CliOutputBlock>` ← 工具调用展示
      └── `<MarkdownContent>` ← AI 正文内容

### 6.3 TaskGroupedStreamBody 渲染（任务列表）

核心数据结构：TaskRunPersistExtra = { v: 1, segments: TaskRunSegment[] }

每个 segment 包含：
- taskId — 任务 ID
- title — 任务标题
- thinking / thinkingChunks — 思考内容
- text / textChunks — 任务内流式文本
- toolEvents — 工具调用事件

渲染流程：

1. 过滤可见 segments：visibleSegments — 只保留有实际内容的 segment
2. 外层折叠按钮：「思考执行中」+ LoadingPointStyle 动画
3. 遍历 visibleSegments，每个 segment 渲染为一个任务行：
   - 状态图标：TaskRowStatusIcon — streaming=加载动画, done=✓, failed=!, interrupted=停止
   - 任务标题：segmentTitle(seg) — 有 taskId 显示 title，无则显示"分析检索"
   - 展开内容（buildTaskSegmentTimeline）：
     - kind === 'thinking' → `<ThinkingContent>` 思考过程
     - kind === 'streamText' → `<MarkdownContent>` 任务内流式文本
     - kind === 'tools' → `<CliOutputBlock>` 工具调用展示

4. 时间线竖线：展开时在任务行之间画连接线

### 6.4 MarkdownContent 渲染（AI 正文）

- message.content — 累积的完整正文内容
- 流式期间：isStreaming: true，每次 appendToMessage 追加增量文本
- 流式结束后：isStreaming: false，callback 替换或 done 事件标记完成
- MarkdownContent 组件负责将 markdown 文本渲染为富文本（代码高亮、链接、列表等）

## 七、完整时序图

```
用户输入 "帮我分析这个项目"
        │
        ▼
ChatInput.handleSend()
        │
        ▼
useChatInputSendFlow.doSend()
  ├── normalizeMentions/Skills/QuickActions
  └── onSend(payload)
        │
        ▼
useSendMessage.handleSend()
  ├── addMessage(userMsg) ← 乐观插入用户消息
  ├── setLoading(true) ← 显示加载状态
  └── POST /api/messages ← HTTP 请求
        │
        ▼
    后端处理
        │
        ├── Socket: intent_mode → setLoading(true), addActiveInvocation()
        │
        ├── Socket: agent_message (type=thinking)
        │ └── setMessageThinking() ← 思考内容更新
        │
        ├── Socket: agent_message (type=text, taskPhase=start)
        │ └── TaskRunAccumulator 开始新 segment
        │
        ├── Socket: agent_message (type=text, origin=stream)
        │ ├── isTaskScopedText? → acc.appendText() + flushTaskRunsToMessage()
        │ └── 否则 → appendToMessage() ← 正文流式追加
        │
        ├── Socket: agent_message (type=tool_use)
        │ └── appendToolEvent() ← 工具调用追加
        │
        ├── Socket: task_created → taskStore.addTask()
        ├── Socket: task_updated → taskStore.updateTask()
        │
        ├── Socket: agent_message (type=text, origin=callback)
        │ └── patchMessage() ← 最终回复替换流式气泡
        │
        └── Socket: agent_message (type=done, isFinal=true)
                ├── setStreaming(false)
                ├── removeActiveInvocation()
                ├── setLoading(false)
                └── clearDoneTimeout()
        │
        ▼
    React 响应式渲染
        │
        ├── ChatMessage 检测 message.extra.taskRuns
        │ │
        │ ├── showTaskGrouped=true
        │ │ ├── TaskGroupedStreamBody
        │ │ │ ├── segment 1: "搜索资料" → ThinkingContent + CliOutputBlock
        │ │ │ ├── segment 2: "分析代码" → ThinkingContent + streamText + CliOutputBlock
        │ │ │ └── segment 3: "撰写报告" → streamText (MarkdownContent)
        │ │ └── MarkdownContent (message.content) ← AI 最终正文
        │ │
        │ └── showTaskGrouped=false
        │ ├── ThinkingContent
        │ ├── CliOutputBlock
        │ └── MarkdownContent
        │
        └── taskStore.tasks → ThreadExecutionBar / 任务面板
```

## 八、关键数据流总结

| 数据 | 来源 | Store 位置 | 渲染组件 |
|---|---|---|---|
| 用户消息 | useSendMessage 乐观插入 | chatStore.messages | ChatMessage (type=user) |
| AI 流式正文 | Socket agent_message(type=text) | chatStore.messages[].content (appendToMessage) | MarkdownContent |
| 思考过程 | Socket agent_message(type=thinking) | chatStore.messages[].thinking | ThinkingContent |
| 工具调用 | Socket agent_message(type=tool_use) | chatStore.messages[].toolEvents | CliOutputBlock |
| 任务分段 | Socket agent_message + taskContext | chatStore.messages[].extra.taskRuns | TaskGroupedStreamBody |
| 任务列表 | Socket task_created/updated | taskStore.tasks | ThreadExecutionBar |
| 加载状态 | useSendMessage + Socket intent_mode/done | chatStore.isLoading/hasActiveInvocation | ThinkingIndicator |

以上就是从输入框输入问题到流式渲染任务列表和 AI 正文的完整流程梳理。核心链路是：

`ChatInput` → `useSendMessage` (HTTP POST) → 后端 → Socket.IO 推送 → `useSocket` → `useAgentMessages` → `chatStore` 状态更新 → React 渲染 (`TaskGroupedStreamBody` + `MarkdownContent`)

本文写于：2026年5月20日

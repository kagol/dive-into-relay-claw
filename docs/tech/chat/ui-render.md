# 对话 UI 渲染

Zustand 中的 messages 消息如何渲染成流式 UI。

## 一、渲染架构总览

```
Zustand chatStore.messages[]
  │
  │  每个 ChatMessage 对象
  │
  ▼
ChatMessageList (虚拟滚动容器)
  │  useVirtualizer — @tanstack/react-virtual
  │  overscan=8, estimateSize=180px
  │
  ├── virtualItems.map → renderMessage(message)
  │
  ▼
ChatMessageRow = memo(ChatMessageRowInner)
  │  浅比较: prev.message === next.message (引用相等)
  │
  ▼
ChatMessage = memo(ChatMessageInner)
  │  浅比较: prev.message === next.message
  │
  ├── message.type === 'user'     → 用户气泡
  ├── message.type === 'system'   → 系统消息 / 错误面板
  ├── message.type === 'connector' → 连接器气泡
  └── message.type === 'assistant' → 助手气泡 ← 本文重点
```

---

## 二、助手气泡的流式渲染

### 2.1 ChatMessage 组件的助手分支

当 `message.type === 'assistant'` 时，组件进入助手气泡渲染路径：

```tsx
// ChatMessage.tsx — 助手气泡结构
<div className="answer-group group flex gap-3 mb-[8px] items-start">
  {/* 左侧：智能体头像 */}
  <AgentAvatar
    agentId={effectiveAgentId}
    size={32}
    status={effectiveIsStreaming ? 'streaming' : undefined}  // ← 流式时头像有动画
    showRing={false}
  />

  <div className="answer-container max-w-[calc(100%-44px)]">
    {/* 头部：智能体名称 + 方向标签 + 回复标签 */}
    <div className="answer-header">
      <span className="text-xs">{agentStyle.label}</span>
      {direction && <DirectionPill />}
      {message.replyTo && <ReplyPill />}
    </div>

    {/* 主体：流式内容渲染 */}
    <div className="answer-body overflow-hidden">
      {showTaskGrouped ? (
        /* ── 任务分组模式 ── */
        <TaskGroupedStreamBody ... />
      ) : (
        /* ── 普通模式 ── */
        <>
          {thinking && <ThinkingContent ... />}
          {hasCliBlock && <CliOutputBlock ... />}
        </>
      )}
      {/* 流式文本内容 */}
      {isStreamOrigin && hasTextContent ? (
        <MarkdownContent content={`${message.content.trimEnd()}${suffix}`} />
      ) : ...}
      {/* Rich blocks (文件、PPT 等) */}
      {filteredRichBlocks && <RichBlocks ... />}
      {/* 非流式 callback 的打字光标 */}
      {effectiveIsStreaming && !isStreamOrigin && <span className="animate-pulse" />}
    </div>
  </div>
</div>
```

### 2.2 `effectiveIsStreaming` — 流式状态的真实判定

```tsx
const effectiveIsStreaming = Boolean(
  message.isStreaming &&
    message.agentId &&
    (Boolean(catInvocationId) || (hasActiveInvocation && targetAgents.includes(message.agentId))),
);
```

**关键**：不是简单读 `message.isStreaming`，而是额外校验：
- 该 agentId 在 `agentInvocations` 中有活跃 invocationId，**或**
- 全局 `hasActiveInvocation` 且该 agent 在 `targetAgents` 列表中

**目的**：避免历史残留的 `isStreaming=true`（如 F5 刷新后从草稿恢复）在无活跃 invocation 时仍驱动 CLI/工具 loading 闪动。

### 2.3 `cliStatus` — 驱动所有子组件的流式状态

```tsx
const cliStatus: CliStatus = effectiveIsStreaming
  ? 'streaming'
  : message.variant === 'error'
    ? 'failed'
    : userStopped
      ? 'interrupted'
      : 'done';
```

| cliStatus | 含义 | 视觉效果 |
|-----------|------|---------|
| `'streaming'` | 正在流式输出 | 头像旋转、LoadingPointStyle 动画、ThinkingContent 自动展开 |
| `'done'` | 正常完成 | 勾号图标、ThinkingContent 自动折叠 |
| `'failed'` | 出错 | 红色感叹号、错误面板 |
| `'interrupted'` | 用户停止 | InterruptedStopIcon、"(用户停止)" 后缀 |

### 2.4 流式文本渲染：`MarkdownContent`

```tsx
// 流式来源的文本
isStreamOrigin && hasTextContent ? (
  <MarkdownContent
    content={`${message.content.trimEnd()}${assistantStreamDisplaySuffix}`}
    className={agentStyle?.font}
    enableSkillAndQuickActionTokens={false}
  />
) : null
```

**MarkdownContent** 使用 `react-markdown` + `remark-gfm` + `remark-breaks` 渲染：
- 每次 `message.content` 变化（`appendToMessage` 追加新 token），React 重新渲染
- `ChatMessage` 是 `memo` 组件，但 `prev.message !== next.message`（引用变了）所以会更新
- `ChatMessageRow` 同理，`prev.message === next.message` 引用比较

**流式追加的 React 更新链**：

```
socket.on('agent_message', {type:'text', content:'新token'})
  → handleAgentMessage(msg)
    → appendToMessage(messageId, '新token')
      → chatStore.set(state => {
           messages: state.messages.map(m =>
             m.id === messageId ? { ...m, content: m.content + '新token' } : m
           )
         })
        → Zustand 触发订阅者重渲染
          → ChatMessageList 重渲染
            → virtualizer 计算可见项
              → ChatMessageRow 重渲染 (message 引用变了)
                → ChatMessage 重渲染
                  → MarkdownContent 重渲染 (content 变了)
                    → react-markdown 重新解析 + 渲染
```

### 2.5 ThinkingContent — 深度思考面板

```tsx
<ThinkingContent
  status={cliStatus}           // 'streaming' | 'done' | 'failed' | 'interrupted'
  events={cliEvents}           // 工具事件列表
  content={message.thinking}   // 思考文本
  label={thinkingLabel}        // "深度思考中" / "思考执行中"
  defaultExpanded={uiThinkingExpandedByDefault}
  forceExpanded={hasPendingAuthorization}
  persistExpandKey={bubbleExpandStorageKey(threadId, message.id, 'thinking-standalone')}
/>
```

**流式渲染优化**：

```tsx
const STREAMING_THINKING_RENDER_LIMIT = 120_000;

// 流式时：如果内容超过 120K 字符，只渲染最后 120K（防止超长思考内容卡顿）
const isStreamingContentTrimmed = isStreaming && normalizedContent.length > STREAMING_THINKING_RENDER_LIMIT;
const streamingContent = isStreamingContentTrimmed
  ? normalizedContent.slice(-STREAMING_THINKING_RENDER_LIMIT)
  : normalizedContent;
```

**展开/折叠行为**：

| 状态 | 行为 |
|------|------|
| `status === 'streaming'` | 自动展开（`setExpanded(true)`） |
| `streaming → done/failed/interrupted` | 自动折叠（除非用户手动操作过） |
| 用户手动点击 | 记录 `userTouchedRef`，后续不再自动折叠 |
| 持久化 | `persistExpandKey` → localStorage，刷新后恢复 |

### 2.6 TaskGroupedStreamBody — 任务分组模式

当 `shouldShowTaskGrouped({ taskRuns, taskProgressTasks })` 为 true 时启用：

```tsx
<TaskGroupedStreamBody
  threadId={threadIdForPrefs}
  taskRuns={taskRunsForBody}        // message.extra.taskRuns
  taskProgressTasks={taskProgressTasks}  // 从 agentInvocations 提取
  message={message}
  cliStatus={cliStatus}             // 'streaming' | 'done' | ...
  thinkingLabel={thinkingLabel}
  ...
/>
```

**内部渲染逻辑**：

1. `normalizeLegacySubagentSegments(taskRuns)` — 兼容旧版子智能体段
2. `buildUnifiedTaskRows({ tasks, segments })` — 合并 taskProgressTasks 和 taskRuns.segments 为统一行
3. 每行渲染：
   - 左侧：`TaskRowStatusIcon`（✓ / LoadingSmall / InterruptedStopIcon / !）
   - 右侧：任务标题 + 可展开的 `TaskSegmentTimelineEntries`
4. 外层：可折叠的"思考执行中"面板，`cliStatus === 'streaming'` 时自动展开

### 2.7 CliOutputBlock — 工具调用时间线

```tsx
<CliOutputBlock
  events={cliEvents}          // buildMessageCliEvents(message) 转换
  status={cliStatus}          // 'streaming' | 'done' | 'failed' | 'interrupted'
  message={message}
  threadId={threadIdForPrefs}
  defaultExpanded={uiThinkingExpandedByDefault}
  ...
/>
```

`cliEvents` 由 `buildMessageCliEvents(message, { padUnmatchedToolResults })` 从 `message.toolEvents[]` 转换而来，每个事件包含 `kind: 'tool_use' | 'tool_result'`、`label`、`detail` 等。

---

## 三、切换会话时流式数据的续接

### 3.1 切换流程

```
用户点击侧边栏另一个 thread
  │
  ▼
路由变化: /thread/A → /thread/B
  │
  ▼
ChatContainer 检测到 threadId 变化
  │
  ├── 1. chatStore.setCurrentThread(threadB)
  │     ├── snapshotActive(旧状态) → threadStates[threadA] = { messages, ... }
  │     ├── flattenThread(threadStates[threadB]) → 恢复到扁平状态
  │     └── currentThreadId = threadB
  │
  ├── 2. resetRefsForThreadSwitch(threadB)
  │     ├── flushAllTaskRunAccumulators()     // 刷出所有待写任务分组
  │     ├── activeRefs.current.clear()        // 清空流式引用
  │     ├── clearAllTaskRunAccumulators()      // 清空累加器
  │     ├── replacedInvocationsRef.clear()    // 清空 callback 替换记录
  │     ├── finalizedStreamRef.clear()        // 清空已完成引用
  │     ├── sawStreamDataRef.clear()          // 清空流式数据标记
  │     ├── terminalStreamSuppressionRef.clear() // 清空终端错误抑制
  │     ├── pendingTimeoutDiagRef.clear()     // 清空超时诊断
  │     ├── clearDoneTimeout()                // 清除超时守卫
  │     └── rehydrateStreamingRefs(threadB)   // ★ 关键：重新绑定流式引用
  │
  └── 3. useChatHistory 加载 threadB 的历史消息
```

### 3.2 `rehydrateStreamingRefs` — 流式引用恢复

```typescript
const rehydrateStreamingRefs = useCallback((threadId: string) => {
  const state = useChatStore.getState();
  if (state.currentThreadId !== threadId) return;  // 防御：线程已再次切换

  // 从后往前扫描，每个 agentId 取最后一个活跃流式 bubble
  const pickedByAgent = new Map<string, ChatMessage>();
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (!msg || msg.type !== 'assistant' || !msg.agentId || msg.origin !== 'stream') continue;
    if (!isActiveStreamBubble(msg, state)) continue;  // 必须是活跃流式 bubble
    if (!pickedByAgent.has(msg.agentId)) {
      pickedByAgent.set(msg.agentId, msg);
    }
  }

  // 恢复 activeRefs + TaskRunAccumulator + isStreaming 标记
  for (const [agentId, msg] of pickedByAgent) {
    if (!activeRefs.current.has(agentId)) {
      activeRefs.current.set(agentId, { id: msg.id, agentId, threadId });
    }
    // 恢复 TaskRunAccumulator
    const taskRuns = msg.extra?.taskRuns;
    if (taskRuns?.v === 1 && taskRuns.segments.length > 0) {
      getTaskRunAccumulator(threadId, msg.id);
    }
    // 如果 bubble 的 isStreaming 被清了（如 fetchQueue 清标志），恢复它
    if (!msg.isStreaming) {
      setStreaming(msg.id, true);
    }
  }
}, [setStreaming]);
```

**`isActiveStreamBubble` 判定**：

```typescript
function isActiveStreamBubble(msg: ChatMessage, state): boolean {
  if (msg.type !== 'assistant' || msg.origin !== 'stream' || !msg.agentId) return false;
  if (msg.isStreaming) return true;  // 最直接：isStreaming 标记
  // 兜底：invocationId 仍关联活跃 invocation
  const invId = streamBubbleInvocationId(msg);
  if (!invId) return false;
  if (state.activeInvocations?.[invId]) return true;
  return state.hasActiveInvocation && state.agentInvocations[msg.agentId]?.invocationId === invId;
}
```

### 3.3 切换后新消息到达

切换到 threadB 后，如果 threadB 仍有智能体在运行：

```
socket.on('agent_message', { threadId: 'B', type: 'text', content: '...' })
  │
  ▼
routeAgentMessage:
  routeThread = 'B'  (路由层已更新)
  storeThread = 'B'  (Store 层已更新)
  → isActiveThreadMessage = true
  │
  ▼
handleAgentMessage(msg):
  currentThreadId = 'B'  ✓
  activeRef = activeRefs.get(agentId)  ← rehydrateStreamingRefs 已恢复
  │
  ├── 有 activeRef → appendToMessage(activeRef.id, content)  // 继续追加到已有 bubble
  └── 无 activeRef → addMessage(...) 创建新 bubble
```

### 3.4 切换回原线程

```
用户从 threadB 切回 threadA
  │
  ├── setCurrentThread(threadA)
  │     ├── snapshotActive(threadB) → threadStates[threadB]
  │     └── flattenThread(threadStates[threadA]) → 恢复 threadA 的 messages
  │
  ├── resetRefsForThreadSwitch(threadA)
  │     └── rehydrateStreamingRefs(threadA)  // 恢复 threadA 的流式引用
  │
  └── threadA 的流式 bubble 继续接收消息
```

**关键**：`threadStates[threadA]` 保存了切换前的完整状态（messages、activeInvocations、agentStatuses 等），切回时 `flattenThread` 原样恢复，流式 bubble 的 `content` 和 `isStreaming` 都保留。

---

## 四、刷新页面时流式数据的续接

### 4.1 刷新后的数据来源

页面刷新后，所有内存状态丢失。数据恢复依赖三个机制：

| 机制 | 触发时机 | 数据来源 | 覆盖范围 |
|------|---------|---------|---------|
| **HTTP 历史拉取** | 页面加载 | `/api/threads/{id}/messages` | 完整历史消息 |
| **WebSocket 重连续推** | socket reconnect | 服务端 queue 端点 | 活跃 invocation 状态 |
| **Live Refresh** | 各种事件触发 | `/api/threads/{id}/messages` (增量) | 补丢消息 |

### 4.2 HTTP 历史拉取

`useChatHistory` hook 在组件挂载时：

```typescript
// 加载第一页消息
const res = await apiFetch(`/api/threads/${threadId}/messages?limit=${HISTORY_PAGE_SIZE}`);
const data = await res.json();
// data.messages: ChatMessage[] — 服务端持久化的消息列表
```

**服务端返回的消息已包含**：
- `content`：完整的文本内容（包括流式过程中已追加的部分）
- `isStreaming`：如果 invocation 仍在运行，为 `true`
- `extra.taskRuns`：任务分组数据
- `extra.stream.invocationId`：关联的 invocation ID
- `toolEvents[]`：工具事件列表
- `thinking`：思考内容

**关键**：服务端在流式过程中会实时持久化（Redis 草稿），所以刷新后拉取到的消息包含截至断连前的所有内容。

### 4.3 WebSocket 重连 + `reconcileInvocationStateOnReconnect`

```typescript
socket.on('connect', () => {
  // ... join rooms
  // 延迟 2s 后执行对齐
  reconcileInvocationStateOnReconnect(activeThreadId);
});
```

**对齐逻辑**：

```
reconcileInvocationStateOnReconnect(activeThreadId)
  │
  ├── 收集需要检查的线程：
  │     ├── activeThreadId（当前活跃线程）
  │     └── threadStates 中 hasActiveInvocation 或有 isStreaming bubble 的线程
  │
  └── 对每个线程：
        fetch /api/threads/{threadId}/queue
        │
        ├── 服务端仍有活跃 invocation (data.activeInvocations.length > 0)
        │     ├── clearThreadActiveInvocation(threadId)
        │     ├── replaceThreadTargetAgents(threadId, serverActiveAgentIds)
        │     ├── 对每个 agentId:
        │     │     updateThreadAgentStatus(threadId, agentId, 'streaming')
        │     │     addActiveInvocation(syntheticId, agentId, 'execute')
        │     │     // syntheticId = `hydrated-${threadId}-${agentId}`
        │     └── 同步 queue 状态
        │
        └── 服务端无活跃 invocation
              ├── clearAllActiveInvocations()
              ├── setLoading(false)
              ├── clearAgentStatuses()
              └── 对所有 isStreaming 的消息: setStreaming(msg.id, false)
                 // 清除残留的流式标记，防止 UI 卡在 "回复中"
```

### 4.4 Live Refresh — 轻量级增量刷新

```typescript
// thread-live-refresh.ts
export function requestThreadLiveRefresh(
  threadId: string,
  scope: ThreadLiveRefreshScope = 'all',  // 'all' | 'messages' | 'panels'
  reason?: string,
) {
  window.dispatchEvent(
    new CustomEvent('office-claw:thread-live-refresh', {
      detail: { threadId, scope, reason },
    }),
  );
}
```

`useChatHistory` 监听此事件，按 scope 重新拉取对应数据：

| scope | 拉取内容 | 触发场景 |
|-------|---------|---------|
| `'all'` | 消息 + 线程元数据 | 重连后、跨线程消息 |
| `'messages'` | 仅消息 | callback 消息到达、工具事件 |
| `'panels'` | 仅线程元数据 | 线程标题更新 |

### 4.5 Stream Catch-Up — 流式续推

```typescript
// chatStore.ts
requestStreamCatchUp: (threadId: string) =>
  set(state => ({
    streamCatchUpVersion: state.streamCatchUpVersion + 1,
    streamCatchUpThreadId: threadId,
  })),
```

当检测到流式 bubble 存在但可能缺失内容时（如重连后），通过递增 `streamCatchUpVersion` 触发 `useChatHistory` 中的 `useEffect` 重新拉取最新消息并合并。

### 4.6 刷新续接的完整时序

```
F5 刷新
  │
  ├── 1. React 重新挂载
  │     ├── useSocket: 建立 WebSocket 连接
  │     ├── useChatHistory: fetch /api/threads/{id}/messages
  │     │     → 恢复 messages[] (含 isStreaming、content、taskRuns 等)
  │     └── useAgentMessages: activeRefs 为空 (新实例)
  │
  ├── 2. WebSocket connect 事件
  │     ├── join room: thread:{threadId}
  │     └── 延迟 2s → reconcileInvocationStateOnReconnect
  │
  ├── 3. reconcileInvocationStateOnReconnect
  │     ├── fetch /api/threads/{id}/queue
  │     ├── 服务端仍在运行 → rehydrate invocation slots
  │     │     ├── addActiveInvocation(syntheticId, agentId, 'execute')
  │     │     └── 后续 socket 事件会路由到正确的 bubble
  │     └── 服务端已完成 → clear stale state + setStreaming(false)
  │
  ├── 4. 后续 socket 事件到达
  │     ├── type='text' → handleAgentMessage
  │     │     ├── getOrRecoverActiveAssistantMessageId(agentId)
  │     │     │     → 从 messages[] 中找 isStreaming 的 assistant bubble
  │     │     │     → 恢复 activeRefs[agentId] = { id, agentId, threadId }
  │     │     └── appendToMessage(id, content)  // 继续追加
  │     │
  │     └── type='done' → setStreaming(false) + 清理
  │
  └── 5. 如果重连期间有消息丢失
        ├── requestThreadLiveRefresh → 增量拉取
        └── requestStreamCatchUp → 重新拉取并合并
```

---

## 五、流式渲染的性能优化

### 5.1 虚拟滚动

```tsx
// ChatMessageList.tsx
const messageVirtualizer = useVirtualizer({
  count: visibleMessages.length,
  getScrollElement: () => scrollContainerRef.current,
  estimateSize: () => 180,       // 预估高度
  overscan: 8,                   // 上下各多渲染 8 个
  getItemKey: (index) => visibleMessages[index]?.id ?? index,
});
```

- 只有视口内 + overscan 范围内的消息会渲染 DOM
- 流式追加时，如果 bubble 在视口内，直接更新；不在视口内则不渲染

### 5.2 memo 浅比较

```tsx
// ChatMessageRow
function areChatMessageRowPropsEqual(prev, next): boolean {
  return prev.message === next.message && ...;  // 引用相等
}
export const ChatMessageRow = memo(ChatMessageRowInner, areChatMessageRowPropsEqual);

// ChatMessage
function areChatMessagePropsEqual(prev, next): boolean {
  return prev.message === next.message && ...;
}
export const ChatMessage = memo(ChatMessageInner, areChatMessagePropsEqual);
```

**注意**：`appendToMessage` 每次创建新的 message 对象（`{ ...m, content: m.content + delta }`），所以引用会变，memo 不会阻止流式 bubble 的重渲染。但**其他非流式 bubble** 的 message 引用不变，memo 会跳过它们。

### 5.3 Thinking 文本防抖

```typescript
// useAgentMessages.ts
// 思考文本 50ms 防抖，减少 React 更新频率
const scheduleThinkingTextFlush = useCallback(() => {
  if (thinkingFlushTimerRef.current !== null) return;
  thinkingFlushTimerRef.current = setTimeout(() => {
    thinkingFlushTimerRef.current = null;
    pendingThinking.forEach((text, msgId) => {
      useChatStore.getState().setMessageThinking(msgId, text);
    });
  }, 50);
}, []);
```

### 5.4 后台线程批量更新

```typescript
// useSocket-background.ts
// HOT PATH: 批量合并 content + metadata + streaming + agentStatus 到一次 set()
// 防止高频流式推送时 React 更新深度溢出
options.store.batchStreamChunkUpdate({
  threadId, messageId, agentId, content, metadata, streaming, nextAgentStatus,
});
```

### 5.5 流式思考内容截断

```typescript
// ThinkingContent.tsx
const STREAMING_THINKING_RENDER_LIMIT = 120_000;
// 流式时只渲染最后 120K 字符，防止超长思考内容卡顿
const streamingContent = isStreamingContentTrimmed
  ? normalizedContent.slice(-STREAMING_THINKING_RENDER_LIMIT)
  : normalizedContent;
```

---

## 六、防乱机制汇总

### 6.1 切换会话不乱

| 机制 | 位置 | 原理 |
|------|------|------|
| **双指针守卫** | `useSocket.routeAgentMessage` | 路由层 threadId AND Store 层 threadId 必须一致 |
| **activeRef 线程校验** | `handleAgentMessage` 入口 | `activeRef.threadId !== currentThreadId` → 失效旧引用 |
| **跨线程丢弃** | `handleAgentMessage` 入口 | `msg.threadId !== currentThreadId` → 直接丢弃 |
| **快照/恢复** | `chatStore.setCurrentThread` | 切出 snapshotActive，切入 flattenThread |
| **resetRefsForThreadSwitch** | `useAgentMessages` | 清空所有 ephemeral map + rehydrateStreamingRefs |
| **rehydrateStreamingRefs** | `useAgentMessages` | 从 messages[] 恢复 activeRefs + TaskRunAccumulator |

### 6.2 刷新页面不丢

| 机制 | 位置 | 原理 |
|------|------|------|
| **HTTP 历史拉取** | `useChatHistory` | 从 `/api/threads/{id}/messages` 拉取完整消息 |
| **重连对齐** | `reconcileInvocationStateOnReconnect` | 从 `/api/threads/{id}/queue` 对齐 invocation 状态 |
| **Live Refresh** | `requestThreadLiveRefresh` | CustomEvent → 增量拉取 |
| **Stream Catch-Up** | `requestStreamCatchUp` | 递增 version → 触发重新拉取合并 |
| **getOrRecoverActiveAssistantMessageId** | `useAgentMessages` | 从 messages[] 找回可恢复的流式 bubble |

### 6.3 流式消息不串

| 机制 | 位置 | 原理 |
|------|------|------|
| **activeRefs** | `useAgentMessages` | Map<agentId, {id, threadId}> — 每个 agent 最多一个活跃流 |
| **invocationId** | `AgentMessage.invocationId` | 区分并发调用，同 invocation 归入同 bubble |
| **callback 替换** | `findCallbackReplacementTarget` | callback 消息替换同 invocationId 的 stream bubble |
| **已取消过滤** | `cancelledInvocationsRef` | 用户点停止后，旧 invocationId 事件被丢弃 |
| **终端错误抑制** | `terminalStreamSuppressionRef` | 终端错误后抑制后续流式片段 |
| **ID 去重** | `chatStore.addMessage` | 同 ID 消息不重复添加 |
| **effectiveIsStreaming** | `ChatMessage` 组件 | 额外校验活跃 invocation，防止历史残留 isStreaming 驱动动画 |

---

## 七、核心文件索引

| 文件 | 职责 |
|------|------|
| `components/chat-message-list/ChatMessageList.tsx` | 虚拟滚动容器，驱动消息渲染 |
| `components/chat-message-list/ChatMessageRow.tsx` | memo 包装行，浅比较优化 |
| `components/chat-message/components/ChatMessage.tsx` | 消息气泡核心，按 type 分发渲染 |
| `components/chat-message/components/ThinkingContent.tsx` | 深度思考面板，流式截断 + 自动展开/折叠 |
| `components/chat-message/components/TaskGroupedStreamBody.tsx` | 任务分组模式，统一任务行 + 时间线 |
| `components/chat-message/components/ContentBlocks.tsx` | 内容块（图片、文件等） |
| `components/MarkdownContent.tsx` | Markdown 渲染（react-markdown + remark-gfm） |
| `components/cli-output/cli-output-block/` | CLI 工具调用时间线 |
| `hooks/useAgentMessages.ts` | 流式消息处理核心（handleAgentMessage、resetRefsForThreadSwitch、rehydrateStreamingRefs） |
| `hooks/useSocket.ts` | WebSocket 连接 + 路由 + 重连对齐（reconcileInvocationStateOnReconnect） |
| `hooks/useSocket-background.ts` | 后台线程消息处理（batchStreamChunkUpdate） |
| `hooks/useChatHistory.ts` | 历史消息加载 + Live Refresh 监听 + Stream Catch-Up |
| `hooks/thread-live-refresh.ts` | Live Refresh 事件定义 |
| `stores/chatStore.ts` | Zustand 全局 Store（双层存储、消息写入、线程切换） |
| `stores/chat-types.ts` | 类型定义（ChatMessage、CliStatus、ToolEvent 等） |

本文写于：2026年6月3日

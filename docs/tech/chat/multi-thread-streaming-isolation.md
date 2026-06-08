# 多线程并发流式输出隔离机制深度分析

核心问题：当会话 A 和 B 都在流式输出时，来回切换如何保证内容不错乱、A 的消息不会串到 B？

## 一、核心结论

> **六层隔离机制协同工作，确保多线程并发流式输出不会串数据：**

| 层级 | 机制 | 核心思想 |
|------|------|---------|
| **L1** | 双层状态结构 | 前台 flat state + 后台 threadStates Map，物理隔离 |
| **L2** | 双指针守卫 | 消息 threadId === 路由 threadId === store threadId，三重一致才放行到前台 |
| **L3** | 前台跨线程安全网 | handleAgentMessage 入口二次校验 threadId，不匹配直接丢弃 |
| **L4** | 后台直接写入 threadStates | 非当前线程的消息写入 threadStates[threadId]，不碰 flat state |
| **L5** | 切换时清理+恢复 | resetRefsForThreadSwitch 清理所有 ref + rehydrateStreamingRefs 恢复新线程的流式状态 |
| **L6** | 缺失 threadId 缓冲 | 无 threadId 的消息暂存等待补全，超时丢弃+live refresh 兜底 |

---

## 二、整体架构：双层状态 + 双通道路由

```
                    Socket.IO agent_message 事件
                               │
                               ▼
                    ┌─────────────────────┐
                    │   useSocket.ts      │
                    │   routeAgentMessage │
                    │                     │
                    │  三重指针检查：      │
                    │  msg.threadId       │
                    │  === routeThread    │
                    │  === storeThread    │
                    └──────┬──────┬──────┘
                           │      │
                    一致 ✅ │      │ 不一致 ❌
                           │      │
                           ▼      ▼
              ┌──────────────┐  ┌──────────────────────┐
              │  前台通道     │  │  后台通道             │
              │  onMessage   │  │  handleBackground    │
              │  → useAgent  │  │  AgentMessage        │
              │  Messages    │  │                      │
              └──────┬───────┘  └──────────┬───────────┘
                     │                     │
                     ▼                     ▼
              ┌──────────────┐  ┌──────────────────────┐
              │  chatStore   │  │  chatStore            │
              │  flat state  │  │  threadStates[B]     │
              │  (当前线程A) │  │  (后台线程B)          │
              │  messages    │  │  .messages           │
              │  isLoading   │  │  .isLoading          │
              │  ...         │  │  ...                 │
              └──────────────┘  └──────────────────────┘
                     │                     │
                     ▼                     ▼
              ┌──────────────┐  ┌──────────────────────┐
              │  UI 渲染     │  │  未读计数 / Toast    │
              │  (用户可见)  │  │  (后台通知)          │
              └──────────────┘  └──────────────────────┘
```

---

## 三、机制 1：双层状态结构（前台/后台分离）

### 3.1 核心设计

chatStore 采用**"前台 flat state + 后台 threadStates Map"**的双层结构：

| 层 | 存储位置 | 内容 | 用途 |
|----|---------|------|------|
| **前台** | `state.messages`、`state.isLoading`、`state.queue` 等 | 当前活跃线程的完整状态 | UI 直接渲染，Zustand selector 订阅 |
| **后台** | `state.threadStates[threadId]` | 每个非活跃线程的 `ThreadState` | 后台线程的消息累积、未读计数 |

### 3.2 代码位置与注释

```
src/stores/chatStore.ts:769-783
```

```typescript
/**
 * 所有后台会话，切换会话时，会将上一个会话快照到 threadStates 对应的会话里，
 * 然后将下一个会话从 threadStates 复制到 messages
 *
 * 顶层 messages 与 threadStates[id].messages 不是两份独立业务数据，
 * 而是 同一会话在「前台 / 后台」两种存放位置；
 * 切换会话时会在两者之间 快照 ↔ 恢复。
 *
 * 离开会话 A：
 * snapshotActive → threadStates[A] = { messages, queue, isLoading, ... }
 * 进入会话 B：
 * flattenThread(threadStates[B]) → 顶层 messages / queue / isLoading / ...
 */
threadStates: Record<string, ThreadState>;
```

### 3.3 切换线程的原子操作

```
src/stores/chatStore.ts:1721-1751
```

```typescript
setCurrentThread: (threadId) =>
  set((state) => {
    if (threadId === state.currentThreadId) return state; // 同线程不操作

    // ① 保存当前 flat state 到 map
    const saved = snapshotActive(state);
    // ② 加载目标线程状态（或默认值）
    const loaded = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };

    return {
      currentThreadId: threadId,
      // ③ 将旧线程状态存入 threadStates
      threadStates: {
        ...state.threadStates,
        [state.currentThreadId]: saved,
      },
      // ④ 将目标线程状态展平到顶层
      ...flattenThread(loaded),
    };
  }, 'setCurrentThread'),
```

**关键**：`setCurrentThread` 在**单次 `set()` 调用**中完成保存+恢复，是原子操作，不会出现"旧线程已保存但新线程未恢复"的中间状态。

### 3.4 写入时的线程判断

所有 per-thread 操作（如 `addMessageToThread`、`appendToThreadMessage`、`setQueue` 等）都遵循同一模式：

```typescript
// 当前线程 → 写 flat state
if (threadId === state.currentThreadId) {
  return { messages: [...state.messages, msg] };
}
// 后台线程 → 写 threadStates
const existing = state.threadStates[threadId] ?? { ...DEFAULT_THREAD_STATE };
return {
  threadStates: {
    ...state.threadStates,
    [threadId]: { ...existing, messages: [...existing.messages, msg] },
  },
};
```

---

## 四、机制 2：双指针守卫（三重一致才放行）

### 4.1 三个指针

| 指针 | 来源 | 含义 |
|------|------|------|
| **`routedMsg.threadId`** | Socket.IO 消息载荷 | 这条消息属于哪个线程 |
| **`routeThread`** | `threadIdRef.current`（来自 URL） | UI/路由层当前正在看的线程 |
| **`storeThread`** | `useChatStore.getState().currentThreadId` | Store flat state 对应的线程 |

### 4.2 三重一致判断

```
src/hooks/useSocket.ts:605-647
```

```typescript
const routeThread = threadIdRef.current;
const storeThread = useChatStore.getState().currentThreadId;

const isActiveThreadMessage = Boolean(
  routedMsg.threadId &&
    routeThread &&
    storeThread &&
    routedMsg.threadId === routeThread &&
    routedMsg.threadId === storeThread,
);
```

**只有三个指针完全一致**，消息才被路由到前台通道（`callbacksRef.current.onMessage`）。

### 4.3 为什么需要双指针？

单指针（只检查 `routeThread`）不够，因为存在**切换窗口竞态**：

```
时间线：
t1: 用户点击切换到线程B → routeThread 立即变为 B
t2: 但 store 的 setCurrentThread 还没执行 → storeThread 仍然是 A
t3: 此时线程A的 chunk 到达 → routedMsg.threadId = A, routeThread = B
    → 单指针会错误地路由到后台（因为 A !== B）
    → 但 flat state 还是 A 的数据！→ chunk 丢失

双指针解决了这个问题：
t3: routedMsg.threadId(A) !== storeThread(A) ✅ 但 routeThread(B) !== storeThread(A)
    → isActiveThreadMessage = false → 路由到后台 → 写入 threadStates[A] ✅ 正确！
```

### 4.4 路由分支

```
src/hooks/useSocket.ts:608-620
```

```typescript
// 无 threadId → 缓冲等待补全（机制6）
if (!routedMsg.threadId) { ... }

// 三重一致 → 前台通道
if (isActiveThreadMessage) {
  callbacksRef.current.onMessage(routedMsg);
  clearBackgroundStreamRefForActiveEvent(routedMsg, bgStreamRefsRef.current);
  return;
}

// 不一致 → 后台通道
handleBackgroundAgentMessage(routedMsg, { store, bgStreamRefs, ... });
```

---

## 五、机制 3：前台跨线程安全网

### 5.1 handleAgentMessage 入口校验

即使消息已经通过了双指针守卫进入前台通道，`handleAgentMessage` 仍有**二次校验**：

```
src/hooks/useAgentMessages.ts:757-758
```

```typescript
const currentThreadId = useChatStore.getState().currentThreadId;

// Cross-thread guard: useSocket already routes via dual-pointer check,
// but this is an extra safety net for any edge cases.
if (msg.threadId && currentThreadId && msg.threadId !== currentThreadId) {
  recordDebugEvent({ action: 'ignored_cross_thread', ... });
  return; // 直接丢弃
}
```

### 5.2 activeRefs 线程不匹配恢复

即使消息的 threadId 匹配，`activeRefs` 中记录的流式气泡可能属于旧线程：

```
src/hooks/useAgentMessages.ts:771-779
```

```typescript
// Thread mismatch recovery: invalidate stale activeRefs entries that belong
// to a different thread. This handles the race where resetRefs() hasn't run
// yet (useEffect is async) but a new thread's message arrives.
const activeRef = activeRefs.current.get(msg.agentId);
if (activeRef && currentThreadId && activeRef.threadId !== currentThreadId) {
  activeRefs.current.delete(msg.agentId);
  recordDebugEvent({ action: 'invalidate', reason: 'active_ref_thread_mismatch' });
}
```

**关键**：`activeRefs` 的每个条目都捕获了创建时的 `threadId`，切换线程后如果旧条目还在，会被立即失效。

---

## 六、机制 4：后台线程直接写入 threadStates

### 6.1 handleBackgroundAgentMessage

非当前线程的消息通过 `handleBackgroundAgentMessage` 处理，直接写入 `threadStates[threadId]`：

```
src/hooks/useSocket-background.ts:373-550
```

| 操作 | 调用的 store 方法 | 写入位置 |
|------|-------------------|---------|
| 添加消息 | `store.addMessageToThread(threadId, msg)` | `threadStates[threadId].messages` |
| 追加内容 | `store.appendToThreadMessage(threadId, msgId, content)` | `threadStates[threadId].messages[i].content` |
| 批量更新 | `store.batchStreamChunkUpdate({ threadId, ... })` | `threadStates[threadId]` 的多个字段 |
| 设置流状态 | `store.setThreadMessageStreaming(threadId, msgId, false)` | `threadStates[threadId].messages[i].isStreaming` |
| 设置元数据 | `store.setThreadMessageMetadata(threadId, msgId, metadata)` | `threadStates[threadId].messages[i].metadata` |

### 6.2 bgStreamRefs — 后台流式引用跟踪

```
src/hooks/useSocket-background.ts:44-46
```

```typescript
function getStreamKey(msg: Pick<BackgroundAgentMessage, 'threadId' | 'agentId'>): string {
  return `${msg.threadId}::${msg.agentId}`;
}
```

`bgStreamRefs: Map<streamKey, BackgroundStreamRef>` 跟踪每个后台线程的活跃流，确保后续 chunk 能找到正确的消息进行追加。

**streamKey 包含 threadId**，所以不同线程的同名 Agent 不会混淆：

```
线程A的流: bgStreamRefs["threadA::agent1"] = { id: "msgA1", threadId: "threadA", agentId: "agent1" }
线程B的流: bgStreamRefs["threadB::agent1"] = { id: "msgB1", threadId: "threadB", agentId: "agent1" }
```

---

## 七、机制 5：线程切换时的清理与恢复

### 7.1 resetRefsForThreadSwitch

当用户切换线程时，`ChatContainer` 的 `useEffect` 检测到 `threadId` 变化，调用 `resetRefsForThreadSwitch`：

```
src/hooks/useAgentMessages.ts:1888-1901
```

```typescript
const resetRefsForThreadSwitch = useCallback(
  (threadId: string) => {
    flushAllTaskRunAccumulators();        // ① 刷新所有待写入的 taskRun
    activeRefs.current.clear();           // ② 清空所有流式气泡引用
    clearAllTaskRunAccumulators();        // ③ 清空 taskRun 累加器
    replacedInvocationsRef.current.clear(); // ④ 清空替换记录
    finalizedStreamRef.current.clear();   // ⑤ 清空已完成流记录
    sawStreamDataRef.current.clear();     // ⑥ 清空流数据标记
    terminalStreamSuppressionRef.current.clear(); // ⑦ 清空终端抑制
    pendingTimeoutDiagRef.current.clear(); // ⑧ 清空超时诊断
    clearDoneTimeout();                   // ⑨ 清除 done 超时定时器
    rehydrateStreamingRefs(threadId);     // ⑩ 恢复新线程的流式状态
  },
  [clearDoneTimeout, rehydrateStreamingRefs],
);
```

### 7.2 rehydrateStreamingRefs — 流式状态恢复

切换到新线程后，需要恢复该线程中仍在流式输出的气泡引用：

```
src/hooks/useAgentMessages.ts:1845-1880
```

```typescript
const rehydrateStreamingRefs = useCallback(
  (threadId: string) => {
    const state = useChatStore.getState();
    if (state.currentThreadId !== threadId) return; // 安全检查

    const pickedByAgent = new Map<string, ChatMessage>();
    // 从后往前扫描，找到每个 Agent 最后一个活跃的流式气泡
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (!msg || msg.type !== 'assistant' || !msg.agentId || msg.origin !== 'stream') continue;
      if (!isActiveStreamBubble(msg, state)) continue;
      if (!pickedByAgent.has(msg.agentId)) {
        pickedByAgent.set(msg.agentId, msg);
      }
    }

    // 将找到的流式气泡重新注册到 activeRefs
    for (const [agentId, msg] of pickedByAgent) {
      if (!activeRefs.current.has(agentId)) {
        activeRefs.current.set(agentId, { id: msg.id, agentId, threadId });
      }
      // 如果气泡的 isStreaming 被意外设为 false，恢复为 true
      if (!msg.isStreaming) {
        setStreaming(msg.id, true);
      }
    }
  },
  [setStreaming],
);
```

**关键**：`rehydrateStreamingRefs` 确保切换到新线程后，该线程中正在流式输出的气泡能继续接收后续 chunk。

### 7.3 切换流程完整时序

```
用户点击切换到线程B
    │
    ▼
① URL 变化 → routeThread = B
    │
    ▼
② ChatContainer useEffect 检测 threadId 变化
    │
    ▼
③ chatStore.setCurrentThread(B)
    │  ├─ snapshotActive → threadStates[A] = { messages_A, ... }
    │  ├─ flattenThread(threadStates[B]) → 顶层 messages = messages_B
    │  └─ currentThreadId = B
    │
    ▼
④ resetRefsForThreadSwitch(B)
    │  ├─ activeRefs.clear()
    │  ├─ 清理所有临时状态
    │  └─ rehydrateStreamingRefs(B)
    │      └─ 扫描 messages_B，找到 isStreaming 的气泡
    │          └─ activeRefs.set(agentId, { id, agentId, threadId: B })
    │
    ▼
⑤ UI 渲染线程B的消息（从 flat state messages 读取）
    │
    ▼
⑥ 后续 Socket 事件到达：
    ├─ 线程A的 chunk → threadId(A) !== storeThread(B) → 后台通道 → threadStates[A]
    └─ 线程B的 chunk → threadId(B) === storeThread(B) === routeThread(B) → 前台通道 → flat state
```

---

## 八、机制 6：缺失 threadId 的缓冲与兜底

### 8.1 问题场景

某些 Socket 事件（如 `intent_mode`）可能先于带 threadId 的消息到达，导致早期 chunk 缺少 threadId。

### 8.2 缓冲机制

```
src/hooks/useSocket.ts:661-690
```

```typescript
// 无 threadId：禁止写入当前 flat store，避免切线程时串会话
if (!routedMsg.threadId) {
  if (routedMsg.invocationId) {
    // 有 invocationId → 暂存等待后续事件补全 threadId
    const existing = missingThreadBufferRef.current.get(invocationId);
    if (existing) {
      existing.push(routedMsg);
    } else {
      missingThreadBufferRef.current.set(invocationId, [routedMsg]);
      // 超时后丢弃并触发 live refresh
      const timeoutId = setTimeout(() => {
        const pending = missingThreadBufferRef.current.get(invocationId);
        missingThreadBufferRef.current.delete(invocationId);
        for (const pendingMsg of pending) {
          requestMissingThreadCatchUp('drop_missing_thread_id_timeout', pendingMsg);
        }
      }, MISSING_THREAD_ID_BUFFER_TIMEOUT_MS);
    }
    return;
  }
  // 无 invocationId 也无 threadId → 直接丢弃 + live refresh
  requestMissingThreadCatchUp('drop_missing_thread_id', routedMsg);
  return;
}
```

### 8.3 补全触发

当后续事件（如 `intent_mode`）携带了 threadId 和 invocationId 时：

```typescript
if (routedMsg.threadId && routedMsg.invocationId) {
  invocationThreadMapRef.current.set(routedMsg.invocationId, routedMsg.threadId);
  flushBufferedInvocationMessages(routedMsg.invocationId, routedMsg.threadId);
}
```

`flushBufferedInvocationMessages` 将缓冲中的消息重新路由，此时已有 threadId，可以正确分发到前台或后台通道。

---

## 九、完整时序图：A/B 切换场景

### 场景：A 和 B 都在流式输出，用户在 A 和 B 之间来回切换

```
时间    用户操作        Socket事件        路由决策              写入位置              UI显示
─────────────────────────────────────────────────────────────────────────────────────────────
t0      在A             A:chunk1         A===A===A ✅         flat state            A的内容
t1      在A             B:chunk1         B!==A ❌            threadStates[B]      A的内容
t2      在A             A:chunk2         A===A===A ✅         flat state            A的内容
t3      切到B           ─                ─                   setCurrentThread(B)   B的内容
                        ─                ─                   snapshotActive→ts[A]  B的内容
                        ─                ─                   flattenThread(ts[B])  B的内容
                        ─                ─                   resetRefs+rehydrate   B的内容
t4      在B             A:chunk3         A!==B ❌            threadStates[A]      B的内容
t5      在B             B:chunk2         B===B===B ✅         flat state            B的内容
t6      在B             A:chunk4         A!==B ❌            threadStates[A]      B的内容
t7      在B             B:chunk3         B===B===B ✅         flat state            B的内容
t8      切回A           ─                ─                   setCurrentThread(A)   A的内容
                        ─                ─                   snapshotActive→ts[B]  A的内容
                        ─                ─                   flattenThread(ts[A])  A的内容
                        ─                ─                   resetRefs+rehydrate   A的内容
                        ─                ─                   (A的chunk3,4已在ts[A]) A完整内容✅
t9      在A             A:chunk5         A===A===A ✅         flat state            A的内容
t10     在A             B:chunk4         B!==A ❌            threadStates[B]      A的内容
```

**关键观察**：
- 线程A的 chunk 在用户看B时，全部写入 `threadStates[A]`，不碰 flat state
- 切回A时，`flattenThread(threadStates[A])` 将A的完整状态（包括后台累积的 chunk3、chunk4）恢复到 flat state
- 用户看到的是A的完整内容，没有任何丢失或串线

---

## 十、竞态条件分析与防护

### 10.1 竞态 1：切换窗口中的 chunk

| 场景 | 风险 | 防护 |
|------|------|------|
| routeThread 已变但 storeThread 未变 | chunk 可能写入错误的 flat state | **双指针守卫**：只有两者一致才路由到前台，否则走后台 |
| storeThread 已变但 activeRefs 未清理 | 旧线程的 activeRef 可能导致 chunk 追加到错误消息 | **activeRefs 线程不匹配恢复**：`activeRef.threadId !== currentThreadId` 时立即失效 |

### 10.2 竞态 2：useEffect 异步延迟

| 场景 | 风险 | 防护 |
|------|------|------|
| `resetRefsForThreadSwitch` 的 useEffect 还没执行，新线程的 chunk 已到达 | activeRefs 为空，chunk 可能创建新气泡而非追加到已有气泡 | **rehydrateStreamingRefs**：从 messages 中恢复流式气泡引用；**activeRefs 线程不匹配恢复**：旧条目被失效 |

### 10.3 竞态 3：setCurrentThread 非原子

| 场景 | 风险 | 防护 |
|------|------|------|
| 理论上 setCurrentThread 不是原子的 | 中间状态可能被 React 读取 | **Zustand 的 set() 是同步的**：`setCurrentThread` 在单次 `set()` 中完成保存+恢复，React 读取到的始终是完整状态 |

### 10.4 竞态 4：后台 chunk 与线程切换并发

| 场景 | 风险 | 防护 |
|------|------|------|
| 后台线程A的 chunk 正在写入 threadStates[A]，同时用户切到A | 切换时 snapshotActive 可能读到不完整的 threadStates[A] | **Zustand set() 是同步的**：`setCurrentThread` 和 `addMessageToThread` 都是同步操作，JavaScript 单线程保证不会并发执行 |

### 10.5 竞态 5：缺失 threadId 的消息

| 场景 | 风险 | 防护 |
|------|------|------|
| 消息没有 threadId，被错误路由到当前线程 | 串线程 | **缺失 threadId 缓冲**：无 threadId 的消息不直接写入 store，而是缓冲等待补全；超时后丢弃并触发 live refresh 兜底 |

---

> **总结**：OfficeClaw Web 前端通过**六层隔离机制**确保多线程并发流式输出不会串数据。核心是**双层状态结构**（前台 flat state + 后台 threadStates Map）实现物理隔离，**双指针守卫**（消息 threadId === 路由 threadId === store threadId）实现路由隔离，**activeRefs 线程标记**实现流式气泡引用隔离，**resetRefsForThreadSwitch + rehydrateStreamingRefs** 实现切换时的清理与恢复。这些机制协同工作，即使在 A/B 之间快速来回切换，每个线程的流式内容都能正确累积在各自的状态空间中，不会出现串线或丢失。

本文写于：2026年6月8日

# 双指针守卫策略

双指针守卫策略如何保证消息不串？

## 双指针是什么

在 routeAgentMessage 里同时看两个「当前会话」：

|指针	|来源	|更新时机|
|--|--|--|
|routeThread|useSocket 的 threadIdRef.current（来自路由 / ChatContainer 的 threadId prop）|每次 render 同步赋值：threadIdRef.current = threadId|
|storeThread|useChatStore.getState().currentThreadId|setCurrentThread 在 useEffect 里切换 flat messages|

只有三者一致，才当作「当前前台线程」走 onMessage → handleAgentMessage，直接改 flat 的 messages（你正在看的那条时间线）：

useSocket.ts Lines 495-504
```
// Active thread requires BOTH route-level and store-level agreement.
// This blocks a switch-window race where route already points to thread-B
// but flat store still belongs to thread-A.
const isActiveThreadMessage = Boolean(
  routedMsg.threadId &&
    routeThread &&
    storeThread &&
    routedMsg.threadId === routeThread &&
    routedMsg.threadId === storeThread,
);
```

不一致时走 background：handleBackgroundAgentMessage / setThreadLoading 等，写入 `threadStates[threadId]`，不动当前 flat 列表。

## 为什么需要两个指针：切窗口竞态

前端是多线程 UI，但 Zustand 里只有一份「当前屏」flat 状态（messages、isLoading、intentMode…）。切会话时要 setCurrentThread：先把 A 存进 threadStates，再加载 B 的 flat。

这两步和路由更新 不在同一时刻：

ChatContainer.tsx Lines 313-332

```
useEffect(() => {
  if (prevThreadRef.current !== threadId) {
    setCurrentThread(threadId);  // store 切换 — 在 effect 里，晚于本次 paint
    resetRefsForThreadSwitch(threadId);
    // ...
  }
  setCurrentThread(threadId);
}, [threadId, ...]);
```

useSocket.ts Lines 339-339

```
threadIdRef.current = threadId;  // route 指针 — render 阶段就已是 B
```

典型 switch-window（测试里专门模拟）：

- 路由 / threadIdRef 已是 thread-B
- currentThreadId 和 flat messages 仍是 thread-A（effect 还没跑完）
- 此时若 thread-B 的 agent_message 到达，只信 route 会把它 append 到 A 的 messages → 串线程、重复气泡、错误 loading

测试注释写得很直白：「route 已是 B，store 仍是 A → 不能 forward 到 callback，否则会写进 A 的 flat state」（useSocket-thread-guard.test.ts）。

反过来，若 只信 store、route 已变，也可能在切换未完成时误判「不是当前线程」，但更严重的是 route 领先时误写 flat；所以采用 双同意 才进前台路径。

## 实际好处

### 1. 防止流式内容写错会话（P1 级）

历史 bug：从 A 切到 B 后，A 的晚到 intent_mode / agent_message 仍进 B 的 callback，出现「duplicate cat」、B 界面里冒出 A 的回复。双指针把这类包挡在 background，直到 route 与 store 对齐。

### 2. 切换瞬间「宁可保守」

routeThread、storeThread 任一为空或不一致 → 不碰 flat，走 background 或 thread-scoped API。注释：切换过程中若指针暂时不可用，带 threadId 的事件也走 background，避免污染过期的 flat state。

### 3. 后台会话仍可收流（分屏 / 切走仍在跑）

用户切到 B，A 仍在流式：消息 threadId === A，不满足 isActiveThreadMessage，进入 handleBackgroundAgentMessage，更新 threadStates['A']。切回 A 时 setCurrentThread 恢复缓存，不丢流、不污染 B 的 UI。

### 4. 与 store 架构一致

- 前台：flat messages = 当前路由正在看的 thread
- 后台：threadStates[threadId] = 每个 thread 独立快照

双指针是「谁有资格改 flat」的门闩；没有它，WS 层无法区分「路由已切换但 store 未切换」的中间态。

### 5. 同一模式覆盖多种事件

intent_mode、agent_message、thread_summary 等都用同一套 guard，避免有的走 socket 校验、有的只靠 ChatContainer callback 校验（chat-container-intent-loading.test.ts 注明 guard 已上移到 useSocket）。

## 决策示意

![双指针守卫](/images/chat/双指针守卫策略.png)

## 和 handleAgentMessage 里二次校验的关系

useAgentMessages 里还有 msg.threadId !== currentThreadId 的丢弃逻辑，那是 第二道网；双指针在 更早的 socket 路由层 就把包分到 background，避免在 switch-window 里用错误的 flat 列表去 appendToMessage / ensureActiveAssistantMessage。

## 一句话

routeThread 表示「用户界面已经切到哪条会话」；storeThread 表示「聊天 store 的 flat 数据是否也已切过去」。两者在 React 切换里会短暂不一致；双指针要求 必须同时一致 才把 WS 流式写进当前屏，否则写入 per-thread 缓存。好处是：切会话不串消息、后台流式不丢、切换中间态不写坏 flat state——这是多 thread 聊天在前端 store 设计下的必要守卫，而不是重复校验。

本文写于：2026年5月22日

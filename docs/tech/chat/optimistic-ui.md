# 乐观 UI 策略

什么是乐观 UI？发送消息的流程，为什么要用乐观 UI（Optimistic UI）+ 事后 ID 对齐的策略？

## 发送消息的流程

useSendMessage.ts Lines 169-223

```
const clientMessageId = createClientId();
const optimisticMessageId = `user-${clientMessageId}`;
const sentAt = Date.now();
// ...
const userMsg: ChatMessageData = {
  id: optimisticMessageId,
  type: 'user',
  content,
  timestamp: sentAt,
  // ...
};
if (!isQueueSend) {
  addMessage(userMsg);  // 或 addMessageToThread
}
// 之后才 await apiFetch('/api/messages', ...)
```

HTTP 返回后，若 body 带 userMessageId，把临时 id 换成服务端 id：


useSendMessage.ts Lines 369-370

```
if (!queueFallbackHandled && !reconcileQueuedResponse(body) && body?.userMessageId) {
  replaceThreadMessageId(threadId, optimisticMessageId, body.userMessageId);
}
```

replaceMessageIdInList 是原地改 id，内容、时间戳、附件 blob 都保留；若服务端 id 已存在（例如历史拉取先到），会删掉乐观那条，避免重复。

## 为什么要「先插入、后换 ID」？

### 1. 用户消息的最终 ID 只能由服务端决定

后端在 messageStore.append() 时生成持久化 id（UUID 等），并写进数据库。前端在发请求之前不可能知道「这条消息在服务器上的 canonical id」。

若等 HTTP 返回再 addMessage，从点击发送到气泡出现要等一整段网络 + 后端处理（往往几百毫秒到数秒），体验会像「点了发送但界面没反应」。

所以折中是：

- 立刻用客户端临时 id（user-${clientMessageId}）插入 store → UI 马上有气泡
- 稍后用 userMessageId 替换 → 与历史、删除、已读、去重等以服务端为准的逻辑对齐

### 2. clientMessageId 同时作为幂等键

请求里会带 idempotencyKey: clientMessageId。重试、重复提交时，服务端可以识别同一条用户消息，避免写两条；前端临时 id 与这次发送一一对应，替换时不会搞混别的消息。

### 3. 与「发送后立刻出现的 UI 状态」绑定

乐观插入之后马上会：

- setLoading(true) / setHasActiveInvocation(true)
- ChatContainer 根据最后一条 user 消息算 pendingIntentRecognitionTimestamp（「正在识别你的需求」占位）

若 user 气泡晚到，会出现：loading/占位已出现，但时间线上还看不到自己刚发的话，逻辑和观感都不一致。

### 4. 带图/附件时必须立刻展示

有 images 时会在乐观消息里塞 contentBlocks 和 blob: 预览 URL。这些 URL 是本地的，只有先插入 store，用户才能马上看到缩略图；不能等上传 + POST 完成再渲染。

### 5. 侧边栏「刚发就置顶」

updateThreadLastActive(threadId, sentAt) 在 HTTP 之前就执行，会话列表立刻把该 thread 顶上去，不依赖列表接口刷新。

## 实际好处（可感知的）

|好处|	说明|
|--|--|
|低延迟反馈|发送 ≈ 即时出现在时间线，符合聊天产品预期|
|状态连贯|loading、意图识别占位、滚动到底等与「已有一条 user 消息」同步|
|ID 与后端一致|替换后，刷新历史、WS 补拉、删除/恢复、messages_delivered 等都用服务端 id，不会留一堆 user-xxx 孤儿|
|去重安全|若拉历史时已含 userMessageId，replaceMessageId 会丢掉乐观副本，避免双气泡|
|失败可回滚|请求失败时可 removeMessage(optimisticMessageId)，用户不会以为已发送成功|
|分线程发送|非当前 thread 用 addMessageToThread，乐观插入同样让分屏/后台会话立即可见|

## 对比：为什么队列发送不做乐观插入？

代码里 queue 模式故意跳过乐观插入（F117）：排队消息在真正投递前不应出现在主时间线，只出现在队列面板；等 messages_delivered 或等价事件再显示。说明「先插入」是产品选择，不是技术做不到——immediate 要即时反馈，queued 要「未投递不可见」。

## 小结

- 先插入：在服务端 id 未知、HTTP 未返回时，仍要给用户即时反馈，并驱动 loading/占位/附件预览/侧栏排序。
- 后换 ID：持久化与全链路（历史、幂等、去重、后续 API）以服务端 userMessageId 为准，临时 id 只是过渡。

这是 IM/协作类产品里很常见的模式：UI 乐观、数据最终以服务器为准，在「快」和「一致」之间各取一段。

本文写于：2026年5月22日

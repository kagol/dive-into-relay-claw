# WebSocket 流

WebSocket 流式消息时对话最重要的数据来源。

> WebSocket 流式消息可以通过 Chrome DevTools 中的 Network 面板进行查看。

## 创建 WebSocket 连接

### useSocket 创建 socket.io 连接

WebSocket 连接在 useSocket 这个 Hook 的 useEffect 里创建：组件首次挂载时执行 `io(API_URL, …)`，卸载时 `socket.disconnect()`。

useSocket.ts Lines 343-373
```typescript
  useEffect(() => {
    userIdRef.current = getUserId();
    joinedRoomsRef.current = loadJoinedRoomsFromSession(userIdRef.current);
    // ...
    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      auth: {
        userId: userIdRef.current,
      },
    });
```
useSocket.ts Lines 964-975
```typescript
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      socket.disconnect();
      joinedRoomsRef.current.clear();
      // ...
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks accessed via callbacksRef
  }, [persistJoinedRooms]);
```

要点：

|时机	|行为|
|--|--|
|调用 useSocket 的 React 组件 mount|新建一条 Socket.IO 连接（连到 API_URL，一般是前端端口 +1，如 3004）|
|该组件 unmount||disconnect()，连接关闭|
|connect 成功|从 sessionStorage 恢复已加入的 room，并 join_room 当前 threadId|
|路由切换（如 `/` ↔ `/thread/:id`）|旧页面卸载断连，新页面再建一条新连接|
|开发环境 React Strict Mode|可能 mount → unmount → 再 mount，出现短暂的「连上又断」|

这个 effect 的依赖只有 `[persistJoinedRooms]`，不会因为切换 threadId 而重建连接；换会话只是后续再 `join_room`，不是重连。

### 调用 useSocket 的组件

#### 1. 首页「新对话」——HomePage（路由 /）

HomePage.tsx Lines 62-63
```typescript
  const watchedThreadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  useSocket(socketCallbacks, undefined, watchedThreadIds);
```

- 打开首页就会建连接。
- 第二个参数 threadId 为 undefined（没有「当前会话」），但会为 侧边栏里所有 thread 的 watchedThreadIds 加入 thread:{id} room，用于后台未读、队列等推送。

#### 2. 会话页——ChatContainer（路由 /thread/:threadId）

ChatContainer.tsx Lines 679-683

```typescript
  const { cancelInvocation, awaitThreadRoom = async () => 'timed_out' as const } = useSocket(
    socketCallbacks,
    threadId,
    watchedThreadIds,
  );
```

- 进入任意会话页会建连接（同时 HomePage 已卸载，通常同时只有一条前台连接）。
- threadId 为当前会话；watchedThreadIds 还包含分屏会话等，用于多会话并行收消息。
- 这里挂的是完整 socketCallbacks（useChatSocketCallbacks）：流式回复、done、队列、授权、语音等。

不会因为发消息、读大文件、打开预览而单独再建 WebSocket；发消息主要是 `HTTP POST /api/messages`，智能体输出通过已有这条 Socket 推 agent_message 等事件。

同一次对话里：发消息走 `HTTP POST /api/messages`，看回复主要靠 `WebSocket agent_message`。所以你会看到握手和 join_room 在前，用户消息触发的 intent_mode / agent_message 在后。

## WebSocket 消息解析

我们通过 `/socket.io` 接口的 messages 看到的是 Socket.IO 在 WebSocket 传输层上的原始帧，分两层：

- Engine.IO / Socket.IO 协议帧（0、40、42 开头）
- OfficeClaw 应用事件名（join_room、agent_message、intent_mode 等）

### WebSocket 帧前缀

|原始 data 前缀	|含义|
|--|--|
|`0{...}` | Engine.IO OPEN：连接建立，下发 sid、pingInterval(25s)、pingTimeout(20s) 等|
|`40{...}` | Socket.IO CONNECT（默认命名空间 `/`）：握手/连上命名空间|
|`42[...]` | Socket.IO EVENT：应用层事件，`["事件名", 载荷]`|

- opcode: 1 表示 WebSocket 文本帧。
- upgrades: [] 表示已经直接用 WebSocket，没有再从 polling 升级。

```
① receive  0{"sid":"phZMeMbG...","pingInterval":25000,"pingTimeout":20000,...}
           → 传输层会话建立
② send     40{"userId":"05329881d88025750f08c00ccf3a00e0:..."}
           → 客户端连上 Socket.IO 命名空间，带上 auth（与 useSocket 里 io(..., { auth: { userId } }) 一致）
③ receive  40{"sid":"Zmx3ztnSQHLc6GbCAAAI"}
           → 服务端确认该命名空间连接成功（新的 socket sid）
```

之后所有 `42[...]` 才是 真正的业务消息。

### 整体时间线

```
WebSocket 连接 + Socket.IO 握手 (0 → 40 → 40)
    ↓
批量 join_room（侧边栏所有 thread + 当前 thread，有重复）
    ↓
thread_updated（自动标题「你好」）
    ↓
intent_mode（office 开始 execute）
    ↓
agent_message：创建 invocation → 启 session → thinking 流式…
    ↓
text / tool / done …
```

### 业务消息阶段分析

#### 阶段 A：进房（~0.67s，大量 send）

```
42["join_room","thread:thread_mpv5h6b0bd8cp2nm"]
42["join_room","thread:thread_mpv22gs0zfce821p"]
…（侧边栏里很多历史会话）
42["join_room","thread:default"]
42["join_room","thread:thread_mpv603tedrdq1q87"]  ← 当前会话
42["join_room","thread:thread_mpv603tedrdq1q87"]  ← 重复 2 次
```

为什么有： 前端 useSocket 在 connect 时会从 sessionStorage 恢复曾经加入过的 room，并对 watchedThreadIds（侧边栏所有 thread）和当前 threadId 调用 joinRoom，这样后台会话的未读、队列、流式消息也能收到。

为什么重复 `thread_mpv603tedrdq1q87`：

- connect 回调里对当前 thread 再 join_room 一次
- useEffect([threadId, watchedThreadIds]) 里 joinRoom(threadId) 又一次
- 可能还有 awaitThreadRoom（发首条消息前确认进房）

服务端对同一 room 多次 join 是幂等的，无害，只是日志里显得啰嗦。

顺序： 必须先完成上面的 40 握手，客户端才能 `emit('join_room')`；所以所有 join_room 都紧挨在握手之后。

#### 阶段 B：会话元数据（~0.84s）

```
receive 42["thread_updated",{"threadId":"thread_mpv603tedrdq1q87","title":"你好"}]
```

为什么有： 你发了「你好」之类内容后，后端会做 自动会话标题（messages.ts 里 `broadcastToRoom(..., 'thread_updated', ...)`），侧边栏标题变成「你好」。

顺序： 在 join_room 之后；且你已加入 `thread:thread_mpv603tedrdq1q87`，所以能收到该 room 的广播。

#### 阶段 C：开始执行智能体（~1.46s）

```
receive 42["intent_mode",{
  "threadId":"thread_mpv603tedrdq1q87",
  "mode":"execute",
  "targetAgents":["office"],
  "invocationId":"6272a893-3384-4e32-9e91-7a12316d50b1"
}]
```

为什么有： 用户消息触发路由后，等到 CLI/智能体真正产出第一个事件 才广播 intent_mode（#768：避免 CLI 没起来 UI 却显示「回复中」）。
前端据此：锁定输入、hasActiveInvocation、登记 invocation 槽位。

顺序： 在 thread_updated 之后、在大量 agent_message 之前 —— 表示「执行已开始，目标 agent 是 office」。

#### 阶段 D：agent_message 流（~1.50s 起）

下面都是同一个 Socket 事件名 agent_message，载荷里的 type 字段 不同：

|顺序	|agent_message.type / content	|含义|
|--|--|--|
|1|system_info + invocation_created|本轮 invocation 在系统侧创建|
|2|system_info + invocation_metrics / session_started|会话指标：session 已启动|
|3|session_init|绑定 sessionId（如 officeclaw_b23cf725...）|
|4+|system_info + thinking 多段 append|思考流式片段（The / user / said / 你好 …）|

为什么有这么多条 thinking： 模型/CLI 按 小块 推送 thinking，每条 mergeStrategy: "append"，前端拼成完整思考区。

为什么顺序是这样：
```
intent_mode（UI：开始回复）
  → invocation_created（槽位/ID）
  → session_started / session_init（会话就绪）
  → thinking 流（模型内部推理，先于正式正文）
  →（之后通常还有 text / tool_use / done 等）
```

关于两个 invocationId：

intent_mode 里是 `6272a893-...`，invocation_created 里是 `2c5c5529-...` —— 前者多是 路由/队列层 的 invocation，后者是 provider 会话内 创建的子 invocation；前端主要用 intent_mode 带的 ID 做 UI 槽位，具体以代码里 invocationThreadMap / store 逻辑为准。

### 消息类型详解

消息分成三层：

#### 1）传输层（Engine.IO）

- 0 OPEN
- 1 CLOSE
- 2 PING / 3 PONG（保活）
- 4 MESSAGE（里面再包 Socket.IO 子类型）

#### 2）Socket.IO 命名空间层

- 40 CONNECT / 41 DISCONNECT（若出现）
- 42 EVENT（业务事件都在这）
- 还有 ACK、ERROR 等

#### 3）OfficeClaw 应用事件（`42["事件名", payload]`）

发送的消息：客户端 → 服务端（你会 send 的）

|事件|	作用|
|--|--|
|join_room|加入 thread:xxx 等 room|
|leave_room|离开 room|
|cancel_invocation|停止当前会话上的智能体|

接收的消息：服务端 → 客户端（useSocket 里注册的，你会 receive 的）

|事件	|作用|
|--|--|
|agent_message|流式回复主体（见下表子类型）|
|intent_mode|进入 execute/ideate、目标 agents|
|thread_updated / thread_created|会话标题/新建|
|queue_updated / queue_paused / queue_full_warning|队列|
|heartbeat|长任务心跳|
|authorization:request / authorization:response|工具审批|
|ask_user_question:request / response|向用户提问|
|message_deleted / message_hard_deleted / message_restored|消息删改|
|thread_branched|分支会话|
|connector_message|连接器消息|
|task_created / task_updated|任务|
|voice_stream_start / voice_chunk / voice_stream_end|语音流|
|skill_options_changed|技能列表变更|
|game:state_update / game:thread_created|游戏相关|
|messages_delivered|队列投递完成等（部分走 emitToUser）|

agent_message 载荷里的 type：

|type	|含义|
|--|--|
|system_info|JSON 字符串 content（thinking、invocation_created、metrics…）|
|session_init|会话 ID|
|text|正文流|
|tool_use / tool_result|工具调用|
|done|结束（常带 isFinal）|
|error|错误|
|等|还有 callback、stream 等，由路由/Provider 产生|

## 各类 ID 详解

在 WebSocket 消息中我们会看到各种各样的 ID：userId / threadId / invocationId...

这些 ID 标识处在不同层级，生命周期和用途都不一样。可以记成：`userId` 是谁 → `threadId` 在哪个对话 → `invocationId` 是哪一轮执行 → `sessionId` 智能体进程会话 → `sid` 只是这条 WebSocket 连线。

### 层级关系

```
userId（谁）
  └── threadId（哪个对话 / WS room / 消息列表）
        └── invocationId 父（本轮用户消息触发的执行，intent_mode + 气泡槽位）
        │     └── invocationId 子（registry，MCP/CLI 单次调用 + invocation_created）
        └── sessionId（office 在该 thread 的 CLI 会话，可跨多轮 invocation）
              └── sid（仅当前浏览器这条 WebSocket，重连即换）
```

![websocket各种id](/images/chat/websocket各种id.png)

### 总览对照

|标识	|层级	|谁生成	|典型寿命|	主要用途|
|--|--|--|--|--|
|userId|用户/租户|登录或前端 getUserId()|长期（账号级）|鉴权、数据隔离、Socket 用户房间|
|threadId|对话|创建会话 API|长期（会话级）|消息存储分区、WS room、路由上下文|
|invocationId|一次「用户发问→智能体跑完」|服务端（有两层，见下）|单次执行（分钟级）|流式气泡归属、取消、草稿、回调鉴权|
|sessionId|智能体 CLI/ACP 会话|Provider（如 office）|同 thread 内多轮复用|多轮记忆、续跑、transcript|
|sid|传输连接|Socket.IO / Engine.IO|一次连接（秒～小时）|仅标识这条 WS，与业务无关|

### 1. userId —「是谁在用」

作用： 标识当前操作者，做权限、隔离和路由。

- 前端：写入 `X-Office-Claw-User`，Socket 握手 `auth: { userId }`（格式：`05329881...:05329882..`，由 `domainId` 和 `userId` 拼接起来的）。
- 后端：resolveUserId / guardThreadOwnership 判断能否访问某 threadId；SessionManager 的 key 是 `userId:agentId:threadId`。
- WebSocket：连接后自动进 `user:{userId}`，用于 emitToUser（队列更新、跨 tab 通知等）。

场景： 多用户部署、线程归属校验、按用户存 session、连接器消息投递。

不是： 某一条消息、某一次回复、某条 WebSocket 的 ID。

### 2. threadId —「在哪个对话里」

作用： OfficeClaw 的**会话（茶话会/线程）**主键，例如 `thread_mpv603tedrdq1q87`、`default`。

- 消息库：messageStore 按 thread 存历史。
- WebSocket：必须 `join_room("thread:{threadId}")` 才能收到该会话的 agent_message、intent_mode 等。
- 路由：发消息、取消、队列都带 threadId。
- Session：同一用户 + 同一 agent 在不同 thread 用不同 session（避免跨会话串上下文）。

场景： 侧边栏选会话、分屏多会话、thread_updated 改标题、停止回答 `cancel_invocation({ threadId })`。

不是： 单次智能体运行 ID（那是 invocationId）；也不是 CLI 里的 sessionId。

### 3. invocationId —「这一轮执行」

OfficeClaw 里实际有两层，容易在抓包里看到两个 UUID：

#### 3a. 外层：InvocationRecord（用户消息级）
- 何时创建： `POST /api/messages` 受理时，`invocationRecordStore.create(...)`。
- 出现在： HTTP 响应、`intent_mode.invocationId`、广播时给每条 agent_message 包一层的 invocationId 字段（见 messages.ts 里 `broadcastAgentMessage({ ...msg, invocationId: createResult.invocationId })`）。
- 作用：
  - 前端 activeInvocations、停止/对账、流式气泡归属；
  - 持久化这次执行的 status（processing/succeeded/canceled）；
  - 作为 parentInvocationId 传给下层。

#### 3b. 内层：InvocationRegistry（单次调 agent / MCP 回调）

- 何时创建： invokeSingleCat → registry.create(..., parentInvocationId)，再 yield system_info 的 invocation_created。
- 出现在： content JSON 里的 invocationId，环境变量 OFFICE_CLAW_INVOCATION_ID，MCP callback 鉴权。
- 作用：
  - 回调 API 校验 token；
  - 草稿 flush、APM trace；
  - 同 thread 多 agent 并行时区分「最新回调」防串台。

关系： 一次用户发问通常 = 1 个 Record invocationId（父） + 每个被调用的 agent 可能 1 个 Registry invocationId（子）。前端 UI 槽位主要看 父 ID；invocation_created 里的子 ID 多用于任务进度重置、回调。

场景： 停止回答、抑制旧流事件、队列续跑、多 @ 并行、stream-stopped 持久化。

不是： threadId（对话不变，可多轮 invocation）；也不是 sessionId（可跨多次 invocation 复用）。

### 4. sessionId —「智能体后端会话」

作用： 绑定到 Provider/CLI（如 officeclaw_b23cf72596b8433087a63831），表示「这个 agent 在这一 thread 里接着哪段 CLI/ACP 会话」。

- SessionManager 按 userId + agentId + threadId 读写（见注释：按 thread 隔离，防夺魂串上下文）。
- session_init 事件把 sessionId 告诉前端；transcript 目录也按 session 落盘。
- 多轮对话： 同 thread 里连续 @office，往往复用同一 sessionId，模型侧有连续上下文。

新会话： 取消中断运行、换配置等场景会 session/new，产生新 sessionId。
场景： ACP/relay 续跑、历史导入、session 封存、metrics 里 session_started。

不是：

- threadId（一个 thread 里可有 session 切换）；
- invocationId（一次 invocation 可能用已有 session，也可能新建）；
- sid（完全无关）。

### 5. sid —「这条 Socket.IO 连接」

作用： Engine.IO / Socket.IO 传输层会话 ID，例如：
- phZMeMbG0j3HAzS7AAAH — OPEN 包里的 engine sid；
- Zmx3ztnSQHLc6GbCAAAI — 命名空间 CONNECT 后的 socket sid。

特点：
- 每次 io(API_URL) 新建连接都会变；刷新、断网重连 → 新 sid。
- 服务端日志里 socketId 同义，用于 debug「哪条连接发了 join_room」。
- 与业务 ID 无对应关系；不参与消息存储或智能体路由。

场景： 连接管理、ping/pong、DevTools 看 WS；业务开发一般不用拿 sid 做逻辑。

## 完整的 WebSocket 消息结构

后端主要通过 Socket.IO 的 agent_message 事件给前端推送消息：

```
42["agent_message", {
  "type": "text|system_info|tool_use|tool_result|error|done|session_init|...",
  "agentId": "office",
  "threadId": "thread_xxx",
  "content": "...",
  "sessionId": "...",
  "toolName": "...",
  "toolInput": {...},
  "toolCallId": "...",
  "error": "...",
  "errorCode": "...",
  "isFinal": true,
  "metadata": { "provider":"...", "model":"...", "sessionId":"...", "usage": {...} },
  "origin": "stream|callback",
  "invocationId": "...",
  "timestamp": 1780...,
  "taskContext": { "id":"...", "title":"...", "index":1, "total":3 },
  "taskPhase": "start|complete",
  "stream_source_id": "main"
}]
```

除 agent_message 外，前端还监听：

- intent_mode
- thread_created / thread_updated
- queue_updated / queue_paused / queue_full_warning
- authorization:*
- ask_user_question:*
- message_deleted / message_restored
- voice_stream_*
- 等等

## 附录：部分 WebSocket 消息

WebSocket 初始消息和发送“你好”之后的消息。

```
[
          {
            "type": "receive",
            "time": 1780315704.666159,
            "opcode": 1,
            "data": "0{\"sid\":\"phZMeMbG0j3HAzS7AAAH\",\"upgrades\":[],\"pingInterval\":25000,\"pingTimeout\":20000,\"maxPayload\":1000000}"
          },
          {
            "type": "send",
            "time": 1780315704.666483,
            "opcode": 1,
            "data": "40{\"userId\":\"05329881d88025750f08c00ccf3a00e0:05329882ba000f711ffec00c21191097\"}"
          },
          {
            "type": "receive",
            "time": 1780315704.687267,
            "opcode": 1,
            "data": "40{\"sid\":\"Zmx3ztnSQHLc6GbCAAAI\"}"
          },
          {
            "type": "send",
            "time": 1780315704.688173,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv5h6b0bd8cp2nm\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688711,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv22gs0zfce821p\"]"
          },
          {
            "type": "send",
            "time": 1780315704.6887279,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv1o3eylh2itjrv\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688741,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv1neqkwnutel9k\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688748,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv0y9u4tac6fsek\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688751,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuyx0ky6dwi9r8b\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688761,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuytkxevfq75ya0\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688768,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuyplsbvjq7f3tf\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688778,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuy9g3ilxn8ug1z\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688789,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuxf98v7y9fjlpj\"]"
          },
          {
            "type": "send",
            "time": 1780315704.6887949,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpuxem73i8hx2quw\"]"
          },
          {
            "type": "send",
            "time": 1780315704.6887999,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:default\"]"
          },
          {
            "type": "send",
            "time": 1780315704.688819,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv603tedrdq1q87\"]"
          },
          {
            "type": "send",
            "time": 1780315704.7021708,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv603tedrdq1q87\"]"
          },
          {
            "type": "send",
            "time": 1780315704.705656,
            "opcode": 1,
            "data": "42[\"join_room\",\"thread:thread_mpv603tedrdq1q87\"]"
          },
          {
            "type": "receive",
            "time": 1780315704.841089,
            "opcode": 1,
            "data": "42[\"thread_updated\",{\"threadId\":\"thread_mpv603tedrdq1q87\",\"title\":\"你好\"}]"
          },
          {
            "type": "receive",
            "time": 1780315705.460286,
            "opcode": 1,
            "data": "42[\"intent_mode\",{\"threadId\":\"thread_mpv603tedrdq1q87\",\"mode\":\"execute\",\"targetAgents\":[\"office\"],\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\"}]"
          },
          {
            "type": "receive",
            "time": 1780315705.4963338,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"invocation_created\\\",\\\"invocationId\\\":\\\"2c5c5529-b340-4ce1-a935-cb18c96a034c\\\"}\",\"timestamp\":1780315705459,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315705.89531,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"invocation_metrics\\\",\\\"kind\\\":\\\"session_started\\\",\\\"sessionId\\\":\\\"officeclaw_b23cf72596b8433087a63831\\\",\\\"invocationId\\\":\\\"2c5c5529-b340-4ce1-a935-cb18c96a034c\\\",\\\"sessionSeq\\\":1}\",\"timestamp\":1780315705894,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315705.9242768,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"session_init\",\"agentId\":\"office\",\"sessionId\":\"officeclaw_b23cf72596b8433087a63831\",\"timestamp\":1780315705889,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.604342,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\"The\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719600,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.656064,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\" user\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719604,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.666293,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\" said\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719605,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.686044,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\" \\\\\\\"\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719641,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.69462,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\"你好\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719647,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.703544,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\"\\\\\\\"\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719689,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.715309,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\" (\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719693,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.769305,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\"Hello\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719765,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.795745,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\").\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719767,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          {
            "type": "receive",
            "time": 1780315719.814414,
            "opcode": 1,
            "data": "42[\"agent_message\",{\"type\":\"system_info\",\"agentId\":\"office\",\"content\":\"{\\\"type\\\":\\\"thinking\\\",\\\"agentId\\\":\\\"office\\\",\\\"text\\\":\\\" This\\\",\\\"mergeStrategy\\\":\\\"append\\\"}\",\"stream_source_id\":\"main\",\"timestamp\":1780315719807,\"invocationId\":\"6272a893-3384-4e32-9e91-7a12316d50b1\",\"threadId\":\"thread_mpv603tedrdq1q87\"}]"
          },
          ...
]
```

本文写于：2026年6月2日

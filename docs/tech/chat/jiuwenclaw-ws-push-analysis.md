# 九问智能体 Python 进程拉起与 WebSocket 消息推送全流程分析

发送问题后如何拉起九问智能体的 Python 进程？为什么每个对话会拉起两个 Python 进程？Python 进程如何将 WebSocket 消息推送给前端？

## 1. 整体架构概览

系统采用 **Sidecar（边车）模式**，Node.js API 服务器作为主进程，Python 九问智能体作为子进程（Sidecar）运行。两者通过本地 WebSocket 通信。

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器 (React Frontend)                   │
│                    Socket.IO Client ←─────────────┐              │
└────────────────────────────────────────────────────┼─────────────┘
                                                     │ Socket.IO
┌────────────────────────────────────────────────────┼─────────────┐
│                  Node.js API Server (Fastify)      │              │
│                                                    │              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────┴──────────┐  │
│  │  messages.ts │──▶│  AgentRouter │──▶│   SocketManager     │  │
│  │  POST /api/  │   │  routeSerial │   │  broadcastAgentMsg  │  │
│  │  messages    │   │  invokeSingle│   │                     │  │
│  └──────────────┘   └──────┬───────┘   └─────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────┼───────────────────────────────┐  │
│  │    RelayClawAgentService  │                               │  │
│  │                           ▼                               │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  ScopeRuntime (per apiBase+apiKey+modelName hash)   │ │  │
│  │  │                                                     │ │  │
│  │  │  ┌──────────────────┐  ┌─────────────────────────┐  │ │  │
│  │  │  │ SidecarController│  │ ConnectionManager       │  │ │  │
│  │  │  │ (进程生命周期)    │  │ (WS客户端→Python)       │  │ │  │
│  │  │  └────────┬─────────┘  └────────┬────────────────┘  │ │  │
│  │  └───────────┼──────────────────────┼──────────────────┘ │  │
│  └──────────────┼──────────────────────┼────────────────────┘  │
│                  │ spawn()             │ WS connect             │
└──────────────────┼──────────────────────┼──────────────────────┘
                   ▼                      ▼
┌──────────────────────────────────────────────────────────────────┐
│              Python Sidecar Process                               │
│              python -m jiuwenclaw.app_agentserver                 │
│                                                                   │
│  ┌────────────────────────┐   ┌──────────────────────────────┐   │
│  │  AgentWebSocketServer  │   │  JiuWenClaw Agent Runtime    │   │
│  │  ws://127.0.0.1:AGENT  │   │  (LLM调用/工具执行/技能)     │   │
│  │         PORT           │   │                              │   │
│  └────────────────────────┘   └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 核心设计模式

| 模式 | 说明 |
|------|------|
| **ADR-008 解耦执行** | 消息写入与智能体调用解耦：POST 创建 InvocationRecord → 写入用户消息 → 返回 202 → 后台异步执行 |
| **Sidecar 边车模式** | Node.js 主进程 spawn Python 子进程，通过本地 WS 通信 |
| **Scope 隔离** | 按 `hash(apiBase, apiKey, modelName)` 分配 ScopeRuntime，相同签名复用 Sidecar |
| **FrameQueue 帧队列** | 每个 request 分配独立队列，WS 帧按 `request_id` 路由到对应队列 |
| **Signature 签名复用** | Sidecar 进程按配置签名复用；配置变更时自动重启 |

---

## 2. 完整调用链：从用户发送到 Python 进程拉起

### 2.1 第一阶段：HTTP 请求入口

**文件**: `packages/api/src/routes/messages.ts`

用户在前端发送消息，触发 `POST /api/messages` 请求：

```
POST /api/messages
Body: { content: "用户问题", threadId: "xxx" }
```

处理流程：

1. **参数解析与鉴权**：提取 `userId`、`threadId`、`content`、`targetAgents`
2. **意图解析**：`parseIntent(content)` 判断是 `execute` 还是 `ideate`
3. **@提及路由**：`detectUserMention(content)` 解析目标智能体
4. **写入用户消息**：`messageStore.append({ userId, content, threadId })`
5. **创建 InvocationRecord**：`invocationRecordStore.create({ status: 'pending' })`
6. **立即返回 202**：`reply.status(202)` — ADR-008 解耦，不等待智能体完成

### 2.2 第二阶段：后台异步执行

**文件**: `packages/api/src/routes/messages.ts` (line ~789)

```typescript
// ⑤ Background: execute agent invocation via routeExecution
context.with(executionContext, async () => {
  // ...
  for await (const msg of router.routeExecution(
    userId,
    routedContent,
    resolvedThreadId,
    storedUserMessage.id,
    targetAgents,
    intent,
    { /* options */ },
  )) {
    // 每条 AgentMessage 实时广播给前端
    opts.socketManager.broadcastAgentMessage(
      { ...msg, invocationId: createResult.invocationId },
      resolvedThreadId,
    );
  }
});
```

关键点：
- 使用 `for await...of` 消费 `AsyncIterable<AgentMessage>` 生成器
- 每产生一条消息就立即通过 `SocketManager.broadcastAgentMessage()` 广播
- 这是**流式推送**的核心：不等全部完成，逐条实时推送

### 2.3 第三阶段：AgentRouter 路由

**文件**: `packages/api/src/domains/agents/services/agents/routing/AgentRouter.ts`

`AgentRouter.routeExecution()` 根据路由策略选择执行方式：

| 策略 | 条件 | 方法 |
|------|------|------|
| **串行** | 单智能体 / execute 意图 | `routeSerial()` |
| **并行** | 多智能体 / ideate 意图 | `routeParallel()` |

### 2.4 第四阶段：routeSerial 串行执行

**文件**: `packages/api/src/domains/agents/services/agents/routing/route-serial.ts` (line ~470)

```typescript
for await (const msg of invokeSingleCat(deps.invocationDeps, {
  agentId,
  service: getService(deps.services, agentId),  // ← 从 AgentRegistry 获取 AgentService
  prompt,
  userPrompt: stripLeadingDirectAgentMention(message, agentId, configByAgentId),
  userId,
  threadId,
  // ...
})) {
  yield msg;  // ← 逐条 yield 给上层 for-await 消费
}
```

### 2.5 第五阶段：invokeSingleCat 调用 AgentService

**文件**: `packages/api/src/domains/agents/services/agents/invocation/invoke-single-agent.ts`

`invokeSingleCat()` 是单智能体调用的核心逻辑，负责：
1. 凭证解析（`resolveRelayClawCredentialEnv`）
2. Session 获取/创建
3. System Prompt 构建
4. 调用 `service.invoke(prompt, options)` — 进入 RelayClawAgentService

### 2.6 第六阶段：RelayClawAgentService.invoke()

**文件**: `packages/api/src/domains/agents/services/agents/providers/RelayClawAgentService.ts`

这是 **Python 进程拉起的核心入口**：

```typescript
async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
  // ① 解析 Scope（按 apiBase+apiKey+modelName 哈希）
  const scope = this.resolveScope(options);

  // ② 获取或创建 ScopeRuntime（含 Sidecar + Connection）
  const runtime = this.getOrCreateScopeRuntime(scope);

  // ③ yield session_init
  yield { type: 'session_init', agentId: this.agentId, sessionId, timestamp: Date.now() };

  // ④ 确保连接（启动 Sidecar + 建立 WS）← Python 进程在此拉起！
  await this.ensureConnected(runtime, signal, options);

  // ⑤ 创建请求帧队列
  const requestId = randomUUID();
  const queue = new FrameQueue();
  runtime.requestQueues.set(requestId, queue);

  // ⑥ 通过 WS 发送请求给 Python
  runtime.connection.send(buildRequest(requestId, channelId, sessionId, prompt, options));

  // ⑦ 消费 Python 返回的帧，逐条 yield AgentMessage
  yield* this.consumeFrames(runtime, requestId, queue, signal, options, sendTs, taskStack);
}
```

### 2.7 第七阶段：ensureConnected → Sidecar 启动

**文件**: `RelayClawAgentService.ts` (line ~466)

```typescript
private async ensureConnected(runtime, signal, options): Promise<void> {
  if (this.config.autoStart) {
    // ← 启动 Python Sidecar 进程！
    runtime.resolvedUrl = await runtime.sidecar.ensureStarted(options, signal);
  }
  const url = runtime.resolvedUrl ?? this.config.url;
  await runtime.connection.ensureConnected(url, signal);
}
```

两步操作：
1. **`sidecar.ensureStarted()`**：启动 Python 子进程（如果尚未运行）
2. **`connection.ensureConnected()`**：建立到 Python 的 WebSocket 连接

---

## 3. Python Sidecar 进程启动详解

### 3.1 SidecarController.ensureStarted()

**文件**: `packages/api/src/domains/agents/services/agents/providers/relayclaw-sidecar.ts`

```typescript
async ensureStarted(options?, signal?): Promise<string> {
  // 1. 构建运行时配置（Python路径、环境变量、签名等）
  const runtime = this.buildRuntime(options);

  // 2. 计算签名哈希
  const newHash = sha256(JSON.stringify(runtime.signature));

  // 3. 检查现有进程是否存活且签名匹配
  if (this.child && this.child.exitCode === null && this.runtimeHash === newHash) {
    // TCP 探活：确认 Python WS 服务器仍在响应
    if (await this.tcpProbeFn('127.0.0.1', agentPort, 400)) {
      return this.resolvedUrl!;  // ← 复用现有进程
    }
  }

  // 4. 签名变更 → 重启
  if (this.runtimeHash !== null && this.runtimeHash !== newHash) {
    this.stop('runtime_signature_changed');
  }

  // 5. 启动新进程
  await this.start(runtime, signal);
  return this.resolvedUrl!;
}
```

### 3.2 buildRuntime() — 构建运行时配置

**文件**: `relayclaw-sidecar.ts` (line ~38)

构建 `RelayClawSidecarRuntime`，包含：

| 字段 | 来源 | 说明 |
|------|------|------|
| `executablePath` | `resolveJiuwenClawExecutable()` | 可执行文件路径（优先使用打包后的 exe） |
| `pythonBin` | `resolveJiuwenClawPythonBin()` | Python 解释器路径 |
| `appDir` | `resolveJiuwenClawAppDir()` | jiuwenclaw 应用目录 |
| `useExecutable` | `existsSync(executablePath)` | 是否使用可执行文件而非 Python |
| `homeDir` | `.office-claw/relayclaw/{agentId}` | Sidecar 主目录 |
| `agentPort` | 动态分配 | WebSocket 端口（Agent 通信） |
| `webPort` | 动态分配 | HTTP 端口（Web UI） |

**环境变量**（传递给 Python 子进程）：

| 环境变量 | 说明 |
|----------|------|
| `API_KEY` | LLM API 密钥 |
| `API_BASE` | LLM API 基础 URL |
| `MODEL_NAME` | 模型名称（如 glm-5.1） |
| `MODEL_PROVIDER` | 提供商（OpenAI/OpenRouter） |
| `AGENT_PORT` | WebSocket 监听端口 |
| `WEB_PORT` | HTTP 监听端口 |
| `WEB_HOST` | `127.0.0.1` |
| `HOME` | Sidecar 主目录 |
| `JIUWENCLAW_DATA_DIR` | 数据目录 |
| `PYTHONUNBUFFERED` | `1`（禁用缓冲） |
| `MEMORY_ENGINE` | 记忆引擎（builtin/none） |
| `EMBED_API_KEY/BASE/MODEL` | 嵌入模型配置 |
| `ENABLED_SKILLS` | 启用的技能列表 |
| `OTEL_*` | OpenTelemetry 配置 |

### 3.3 start() — 实际启动 Python 进程

**文件**: `relayclaw-sidecar.ts` (line ~183)

```typescript
private async start(runtime: RelayClawSidecarRuntime, signal?: AbortSignal): Promise<void> {
  // 1. 创建主目录
  mkdirSync(runtime.homeDir, { recursive: true });

  // 2. 分配端口
  const agentPort = runtime.agentPort || (await this.allocatePort());
  const webPort = runtime.webPort || (await this.allocatePort());
  this.resolvedUrl = `ws://127.0.0.1:${agentPort}`;

  // 3. 构建启动命令
  const launchCommand = buildRelayClawLaunchCommand(runtime);

  // 4. 合并环境变量
  const spawnEnv = {
    ...process.env,
    ...runtime.env,
    AGENT_PORT: String(agentPort),
    WEB_PORT: String(webPort),
  };

  // 5. Windows 特殊处理：强制 UTF-8
  if (process.platform === 'win32') {
    spawnEnv.PYTHONIOENCODING = 'utf-8';
    spawnEnv.PYTHONUTF8 = '1';
    Object.assign(spawnEnv, withBundledPythonPath(spawnEnv, ...));
  }

  // 6. 启动子进程！
  const child = this.spawnFn(launchCommand.command, launchCommand.args, {
    cwd: launchCommand.cwd,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe'],  // stdin忽略，stdout/stderr管道
  });
  this.child = child;

  // 7. 捕获日志
  child.stdout?.on('data', pushLog);
  child.stderr?.on('data', pushLog);

  // 8. 等待就绪（两阶段探活）
  while (Date.now() < timeoutAt) {
    // Stage 1: TCP 探活 — 端口是否可连
    if (!tcpReady && await this.tcpProbeFn('127.0.0.1', agentPort, 400)) {
      tcpReady = true;
    }
    // Stage 2: App 就绪 — 日志中出现初始化完成标记
    if (tcpReady && isSidecarReady(this.recentLogs)) {
      appReady = true;
    }
    if (await isRelayClawRuntimeReady(...)) break;
  }
}
```

### 3.4 buildRelayClawLaunchCommand() — 启动命令

**文件**: `relayclaw-sidecar.ts` (line ~607)

```typescript
export function buildRelayClawLaunchCommand(runtime: RelayClawSidecarRuntime): RelayClawLaunchCommand {
  // 优先使用打包后的可执行文件
  if (runtime.useExecutable) {
    return {
      command: runtime.executablePath,     // 如: jiuwenclaw-app.exe
      args: ['--desktop-run-agentserver'],
      cwd: dirname(runtime.executablePath),
    };
  }

  // 否则使用 Python 解释器
  return {
    command: runtime.pythonBin,            // 如: python.exe
    args: ['-m', 'jiuwenclaw.app_agentserver'],  // ← Python 模块入口
    cwd: runtime.appDir,
  };
}
```

### 3.5 Python 端入口：app_agentserver.py

**文件**: `vendor/jiuwenclaw/jiuwenclaw/app_agentserver.py`

```python
async def _run(host: str, port: int) -> None:
    from jiuwenclaw.agentserver.agent_ws_server import AgentWebSocketServer

    # 启动 WebSocket 服务器，监听 AGENT_PORT
    server = AgentWebSocketServer.get_instance(
        host=host,
        port=port,
        ping_interval=20.0,
        ping_timeout=300.0,
    )
    await server.start()

    logger.info("[AgentServer] ready: ws://%s:%s  Ctrl+C to stop", host, port)
    # 等待停止信号
    await stop_event.wait()

def main() -> None:
    port = os.getenv("AGENT_PORT") or 18092
    asyncio.run(_run(host="127.0.0.1", port=port))
```

Python 进程启动后：
1. 初始化 JiuWenClaw Agent Runtime
2. 启动 `AgentWebSocketServer` 监听 `AGENT_PORT`
3. 输出日志标记 `[JiuWenClawDeepAdapter] 初始化完成`
4. Node.js 侧检测到此标记后认为 Sidecar 就绪

### 3.6 就绪检测标记

**文件**: `relayclaw-sidecar.ts`

```typescript
export function isSidecarReady(recentLogs: string): boolean {
  return (
    recentLogs.includes('[JiuWenClawDeepAdapter] 初始化完成') ||
    recentLogs.includes('JiuWenClawDeepAdapter] 初始化完成')
  );
}
```

### 3.7 进程停止

```typescript
stop(reason?: string): void {
  if (process.platform === 'win32' && child.pid) {
    // Windows: 强制终止进程树（/T = 包含子进程, /F = 强制）
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}
```

---

## 4. 为什么每个对话会拉起两个 Python 进程

### 4.1 根本原因：多智能体配置 + 独立 Sidecar

**文件**: `office-claw-template.json`

系统配置了 **3 个智能体品种（Breed）**，全部使用 `relayclaw` 提供商：

| Breed | agentId | 模型 | 角色 |
|-------|---------|------|------|
| 通用助手 | `office` | `glm-5.1` | 全局梳理、脉络串联（lead=true） |
| 逻辑大师 | `assistant` | `deepseek-v3.2` | 硬核逻辑、严谨论证 |
| 人文顾问 | `agentteams` | `glm-5` | 伦理人情、社会视角 |

### 4.2 每个 Breed 独立创建 RelayClawAgentService

**文件**: `packages/api/src/config/plugins/builtin-providers.ts` (line ~45)

```typescript
export const relayclawPlugin: OfficeClawProviderPlugin = {
  name: 'relayclaw',
  providers: ['relayclaw'],
  async createAgentService(ctx: AgentServiceFactoryContext): Promise<AgentService> {
    return new RelayClawAgentService({
      agentId: ctx.agentId,        // ← 每个 breed 有自己的 agentId
      config: {
        autoStart: true,           // ← 自动启动 Sidecar
        modelName: ctx.agentConfig.defaultModel,  // ← 每个 breed 有不同的模型
        homeDir: join(ctx.projectRoot, '.office-claw', 'relayclaw', ctx.agentId),
        // ...
      },
    });
  },
};
```

关键点：
- 每个 breed（office/assistant/agentteams）在启动时都会创建独立的 `RelayClawAgentService` 实例
- 每个 `RelayClawAgentService` 拥有独立的 `scopes = Map<string, RelayClawScopeRuntime>`
- 每个 `ScopeRuntime` 拥有独立的 `SidecarController` 和 `ConnectionManager`

### 4.3 Scope 隔离机制

**文件**: `RelayClawAgentService.ts` (line ~184)

```typescript
private resolveScope(options?: AgentServiceOptions): RelayClawScopeDescriptor {
  const callbackEnv = mergeCallbackEnv(options);
  const apiBase = callbackEnv.API_BASE || ...;
  const apiKey = callbackEnv.API_KEY || ...;
  const modelName = this.config.modelName?.trim() || '';

  // Scope Key = hash(apiBase + apiKey + modelName)
  const scopeHash = createHash('sha256')
    .update([apiBase, apiKey, modelName].join('\n'))
    .digest('hex').slice(0, 12);

  return {
    key: `auto:${scopeHash}`,
    homeDir: join(baseHomeDir, `scope-${scopeHash}`),
  };
}
```

由于三个 breed 使用不同的模型（`glm-5.1` / `deepseek-v3.2` / `glm-5`），它们的 Scope Key 不同，因此各自拥有独立的 Sidecar 进程。

### 4.4 两个 Python 进程的典型场景

**场景一：默认路由拉起 lead 智能体**

当用户发送消息时，`AgentRouter` 默认路由到 `office`（lead=true），此时只拉起 1 个 Python 进程。

**场景二：@提及触发多智能体**

当用户 `@assistant` 或 `@agentteams` 提及时，路由到对应智能体，拉起第 2 个 Python 进程。

**场景三：A2A（Agent-to-Agent）链式调用**

在 `routeSerial` 中，当一个智能体完成后，其回复中可能包含 @提及，触发另一个智能体追加到工作列表：

```typescript
// route-serial.ts: A2A support
// after each agent completes, its response is checked for @mentions.
// If a mention is detected and depth allows, the mentioned agent is appended
// to the worklist — extending the chain within the SAME function call.
```

**场景四：并行路由（routeParallel）**

当意图为 `ideate` 且涉及多智能体时，`routeParallel` 同时启动多个智能体，每个拉起独立的 Python 进程。

### 4.5 Sidecar 复用机制

**重要**：Sidecar 进程是按 Scope 复用的，不是每次请求都新建：

```typescript
// ensureStarted() 中的复用逻辑
if (this.child && this.child.exitCode === null && this.runtimeHash === newHash) {
  if (await this.tcpProbeFn('127.0.0.1', agentPort, 400)) {
    return this.resolvedUrl!;  // ← 复用现有进程，不重新 spawn
  }
}
```

- **相同 Scope**（相同 apiBase + apiKey + modelName）：复用同一个 Python 进程
- **不同 Scope**：各自独立进程
- **签名变更**（配置改变）：自动重启 Sidecar

### 4.6 总结：两个 Python 进程的原因

| 原因 | 说明 |
|------|------|
| **多 Breed 配置** | 3 个 breed 均使用 `relayclaw` 提供商，各自有独立的 RelayClawAgentService |
| **不同模型 = 不同 Scope** | glm-5.1 / deepseek-v3.2 / glm-5 产生不同 Scope Key，无法复用 Sidecar |
| **路由策略** | 默认路由到 lead 智能体拉起 1 个；@提及/A2A/并行路由拉起第 2 个 |
| **进程复用** | 同一 Scope 的后续请求复用已有进程，不会重复拉起 |

**典型情况**：用户开启对话时，默认路由到 `office` 拉起 1 个 Python 进程；如果对话中触发了另一个智能体（如 @assistant），则拉起第 2 个 Python 进程。两个进程各自监听不同的 `AGENT_PORT`，独立运行。

---

## 5. WebSocket 消息推送完整链路

### 5.1 全链路概览

```
Python AgentRuntime
    │
    │ ① 产生事件帧 (RelayClawWsFrame)
    │    event_type: task.start / chat.delta / chat.tool_call / ...
    ▼
AgentWebSocketServer (Python, ws://127.0.0.1:AGENT_PORT)
    │
    │ ② WS 发送 JSON 帧
    ▼
RelayClawConnectionManager (Node.js WS Client)
    │
    │ ③ 接收 message 事件，JSON.parse → RelayClawWsFrame
    │ ④ 按 request_id 路由到 FrameQueue
    │    queue.put(frame)
    ▼
FrameQueue (per-request)
    │
    │ ⑤ queue.take() 被消费
    ▼
RelayClawAgentService.consumeFrames()
    │
    │ ⑥ transformRelayClawChunk(frame, agentId) → AgentMessage
    │ ⑦ updateRelayClawTaskStack(taskStack, message)
    │ ⑧ attachRelayClawStreamTaskContext(taskStack, message)
    │ ⑨ yield out (AsyncIterable<AgentMessage>)
    ▼
routeSerial / invokeSingleCat
    │
    │ ⑩ yield msg (透传)
    ▼
messages.ts (for await...of 循环)
    │
    │ ⑪ opts.socketManager.broadcastAgentMessage(msg, threadId)
    ▼
SocketManager
    │
    │ ⑫ this.io.to(`thread:${threadId}`).emit('agent_message', {...msg, threadId})
    ▼
Socket.IO Server → 浏览器
    │
    │ ⑬ 前端 Socket.IO Client 接收 'agent_message' 事件
    ▼
React 组件更新 UI
```

### 5.2 第①②步：Python 产生并发送帧

Python 端的 `AgentWebSocketServer` 在处理请求时，通过 JiuWenClaw Agent Runtime 产生各种事件帧，通过 WS 发送给 Node.js：

```python
# Python 端发送的帧格式 (RelayClawWsFrame)
{
  "request_id": "uuid-of-request",
  "channel_id": "officeclaw",
  "payload": {
    "event_type": "chat.delta",    # 事件类型
    "content": "你好",              # 内容
    "is_complete": false            # 是否完成
  },
  "is_complete": false,
  "stream_source_id": "optional-source-id"
}
```

### 5.3 第③④步：Node.js 接收并路由帧

**文件**: `packages/api/src/domains/agents/services/agents/providers/relayclaw-connection.ts`

```typescript
// RelayClawConnectionManager.connect()
ws.addEventListener('message', (event: MessageEvent) => {
  const data = typeof event.data === 'string' ? event.data : String(event.data);
  let rawFrame = JSON.parse(data);

  // 兼容 E2A 协议帧
  const frame: RelayClawWsFrame = isE2AResponseFrame(rawFrame)
    ? e2aToLegacyFrame(rawFrame)
    : rawFrame;

  // connection.ack 处理
  if (frame.type === 'event' && frame.event === 'connection.ack') {
    this.serverReady = true;
    resolve();
    return;
  }

  // 按 request_id 路由到对应的 FrameQueue
  const requestId = frame.request_id;
  const queue = this.requestQueues.get(requestId);
  if (!queue) {
    log.warn('jiuwen frame for unknown/expired request');
    return;
  }
  queue.put(frame);

  // 终止标记
  if (frame.is_complete === true || frame.payload?.is_complete === true ||
      frame.payload?.event_type === 'chat.final') {
    queue.put(null);  // null 表示流结束
  }
});
```

### 5.4 第⑤步：FrameQueue 异步队列

**文件**: `relayclaw-connection.ts`

```typescript
export class FrameQueue {
  private queue: (RelayClawWsFrame | null)[] = [];
  private waitResolve: ((value: RelayClawWsFrame | null) => void) | null = null;

  put(frame: RelayClawWsFrame | null): void {
    if (this.waitResolve) {
      // 有等待者 → 直接交付
      const resolve = this.waitResolve;
      this.waitResolve = null;
      resolve(frame);
      return;
    }
    // 无等待者 → 入队缓冲
    this.queue.push(frame);
  }

  take(): Promise<RelayClawWsFrame | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    // 队列空 → 返回 Promise，等待 put() 唤醒
    return new Promise((resolve) => { this.waitResolve = resolve; });
  }
}
```

FrameQueue 是一个**单消费者异步队列**，实现了生产者-消费者模式：
- **生产者**：WS `message` 事件处理器调用 `queue.put(frame)`
- **消费者**：`consumeFrames()` 循环调用 `queue.take()`

### 5.5 第⑥⑦⑧⑨步：帧消费与转换

**文件**: `RelayClawAgentService.ts` (consumeFrames, line ~479)

```typescript
private async *consumeFrames(
  runtime, requestId, queue, signal, options, sendTs, taskStack,
): AsyncIterable<AgentMessage> {
  while (!signal.aborted) {
    // ⑤ 从队列取帧
    const frame = await queue.take();
    if (frame === null) break;  // 流结束

    // ⑥ 转换为 AgentMessage
    const message = transformRelayClawChunk(frame, this.agentId);
    if (message) {
      // ⑦ 更新任务栈
      updateRelayClawTaskStack(taskStack, message);
      // ⑧ 附加任务上下文
      const out = attachRelayClawStreamTaskContext(taskStack, message);
      // ⑨ yield 给上层消费者
      yield out;
    }

    // 终止条件
    if (frame.is_complete === true || payload?.is_complete === true) break;
  }

  // 流结束，yield done
  yield { type: 'done', agentId: this.agentId, metadata, timestamp: Date.now() };
}
```

### 5.6 第⑩步：routeSerial 透传

**文件**: `route-serial.ts` (line ~470)

```typescript
for await (const msg of invokeSingleCat(deps.invocationDeps, { ... })) {
  // 处理特殊消息（invocation_metrics、TTS 等）
  // ...
  yield msg;  // ← 透传给上层
}
```

### 5.7 第⑪步：messages.ts 广播

**文件**: `messages.ts` (line ~859)

```typescript
for await (const msg of router.routeExecution(userId, routedContent, ...)) {
  // 实时广播每条消息给前端
  opts.socketManager.broadcastAgentMessage(
    { ...msg, invocationId: createResult.invocationId },
    resolvedThreadId,
  );
}
```

### 5.8 第⑫步：SocketManager 广播

**文件**: `packages/api/src/infrastructure/websocket/SocketManager.ts`

```typescript
broadcastAgentMessage(message: AgentMessage, threadId?: string): void {
  // 1. 尝试从 invocationId 恢复 threadId
  const indexedThreadId = message.invocationId
    ? this.invocationThreadIndex.get(message.invocationId)
    : undefined;
  const resolvedThreadId = threadId || indexedThreadId;

  if (!resolvedThreadId) {
    log.error('Rejected agent_message broadcast: missing threadId');
    return;  // ← 拒绝无 threadId 的广播，防止跨线程泄漏
  }

  // 2. 维护 invocationId → threadId 索引
  if (message.invocationId) {
    this.invocationThreadIndex.set(message.invocationId, resolvedThreadId);
  }

  // 3. 通过 Socket.IO 广播到 thread 房间
  const room = `thread:${resolvedThreadId}`;
  this.io.to(room).emit('agent_message', { ...classifiedMessage, threadId: resolvedThreadId });

  // 4. done 消息清理索引
  if (message.type === 'done' && message.isFinal && message.invocationId) {
    this.invocationThreadIndex.delete(message.invocationId);
  }
}
```

### 5.9 第⑬步：前端接收

前端通过 Socket.IO Client 监听 `agent_message` 事件：

```typescript
// 前端代码（概念性）
socket.on('agent_message', (msg: AgentMessage) => {
  switch (msg.type) {
    case 'text':        // 追加流式文本
    case 'system_info': // 处理任务边界/进度/思考等
    case 'tool_use':    // 显示工具调用
    case 'tool_result': // 显示工具结果
    case 'error':       // 显示错误
    case 'done':        // 标记完成
  }
});
```

前端加入房间的时机：

```typescript
// SocketManager.setupEventHandlers()
socket.on('join_room', (room: string) => {
  // 验证房间名格式：thread: | worktree: | workspace:global | user: | preview:global
  if (!/^(thread:|worktree:|workspace:global$|user:|preview:global$)/.test(room)) {
    log.warn('Attempted to join invalid room');
    return;
  }
  socket.join(room);
});
```

---

## 6. 事件类型转换映射表

**文件**: `packages/api/src/domains/agents/services/agents/providers/relayclaw-event-transform.ts`

`transformRelayClawChunk(frame, agentId)` 将 Python WS 帧转换为前端 AgentMessage：

| Python event_type | → AgentMessage.type | → 前端处理 | 说明 |
|-------------------|---------------------|-----------|------|
| `task.start` | `system_info` | 任务边界开始 | `{type:'task_boundary', phase:'start', taskId, title}` |
| `task.update` | `system_info` | 任务进度快照 | `{type:'task_progress', tasks}` |
| `task.complete` | `system_info` | 任务边界完成 | `{type:'task_boundary', phase:'complete', taskId}` |
| `chat.delta` | `text` | 流式文本追加 | 普通文本片段 |
| `chat.delta` (reasoning) | `system_info` | 思考过程展示 | `source_chunk_type='llm_reasoning'` → `{type:'thinking'}` |
| `chat.reasoning` | `system_info` | 思考过程 | `{type:'thinking', mergeStrategy:'append'}` |
| `chat.tool_call` | `tool_use` | 工具调用展示 | `{toolName, toolInput, toolCallId}` |
| `chat.tool_result` | `tool_result` | 工具结果展示 | `{content, toolCallId, toolName}` |
| `chat.error` | `error` | 错误展示 | 含 errorCode 提取（如 ModelArts.81101 限流） |
| `chat.file` | `system_info` | 文件发送就绪 | `{type:'send_file_ready', paths}` |
| `chat.processing_status` | `system_info` | 处理状态 | `{type:'processing_status', status}` |
| `chat.ask_user_question` | `system_info` | 用户交互问题 | 权限审批/结构化问答 |
| `artifact.generated` | `system_info` | 中间产物预览 | `{type:'artifact_generated', artifacts}` |
| `chat.final` | _(skip)_ | — | 完成标记，不产生消息 |
| `chat.done` | _(skip)_ | — | 完成标记 |
| `chat.tool_calls.delta` | _(skip)_ | — | 部分 tool_call 片段 |
| `chat.tool_update` | _(skip)_ | — | 工具执行更新 |
| `chat.usage_metadata` | _(skip)_ | — | 用量统计 |
| `context.compressed` | _(skip)_ | — | 上下文压缩 |
| `todo.updated` | _(skip)_ | — | 待办更新 |
| `connection.ack` | _(skip)_ | — | 连接确认 |

---

## 7. 关键数据结构

### 7.1 RelayClawWsFrame（Python → Node.js WS 帧）

```typescript
interface RelayClawWsFrame {
  request_id: string;          // 请求 ID，用于路由到 FrameQueue
  channel_id: string;          // 频道 ID（如 'officeclaw'）
  payload: {
    event_type: string;        // 事件类型（chat.delta / task.start / ...）
    content?: string;          // 内容
    is_complete?: boolean;     // 是否完成
    // ... 其他事件特定字段
  };
  is_complete?: boolean;       // 帧级完成标记
  metadata?: {                 // 元数据
    usage?: {                  // Token 用量
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  stream_source_id?: string;   // 流来源 ID
}
```

### 7.2 AgentMessage（Node.js 内部统一消息格式）

```typescript
interface AgentMessage {
  type: 'session_init' | 'text' | 'system_info' | 'tool_use' | 'tool_result' | 'error' | 'done';
  agentId: AgentId;
  content?: string;
  timestamp: number;
  invocationId?: string;
  // task context
  taskContext?: AgentTaskContextPayload;
  taskPhase?: 'start' | 'complete';
  // tool fields
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolCallId?: string;
  // error fields
  error?: string;
  errorCode?: string;
  // done fields
  isFinal?: boolean;
  metadata?: MessageMetadata;
  // streaming
  stream_source_id?: string;
}
```

### 7.3 RelayClawScopeRuntime（Scope 运行时）

```typescript
interface RelayClawScopeRuntime {
  scopeKey: string;                          // 'auto:{hash}' 或 'external:{url}'
  homeDir?: string;                          // Sidecar 主目录
  requestQueues: Map<string, FrameQueue>;    // requestId → 帧队列
  connection: RelayClawConnection;           // WS 连接管理器
  sidecar: RelayClawSidecarController;       // Sidecar 进程控制器
  resolvedUrl: string | null;                // ws://127.0.0.1:{agentPort}
  disposeRequested: boolean;
  disposeReason: string | null;
  disposed: boolean;
}
```

### 7.4 RelayClawSidecarRuntime（Sidecar 运行时配置）

```typescript
interface RelayClawSidecarRuntime {
  executablePath: string;        // 可执行文件路径
  pythonBin: string;             // Python 解释器路径
  appDir: string;                // jiuwenclaw 应用目录
  useExecutable: boolean;        // 是否使用可执行文件
  homeDir: string;               // 主目录
  agentPort: number;             // WebSocket 端口
  webPort: number;               // HTTP 端口
  env: Record<string, string>;   // 环境变量
  signature: Record<string, string | number | boolean>;  // 配置签名
}
```

---

## 8. 流程图

### 8.1 Python 进程拉起时序图

```
用户发送消息
    │
    ▼
POST /api/messages ─────────────────────────────────────────
    │
    ├─ 1. 解析参数、鉴权
    ├─ 2. 写入用户消息 (messageStore.append)
    ├─ 3. 创建 InvocationRecord (status: 'pending')
    ├─ 4. 返回 202 (ADR-008 解耦)
    │
    └─ 5. 后台异步执行 ─────────────────────────────────────
         │
         ▼
    AgentRouter.routeExecution()
         │
         ▼
    routeSerial() / routeParallel()
         │
         ▼
    invokeSingleCat()
         │
         ▼
    RelayClawAgentService.invoke()
         │
         ├─ resolveScope() → scopeKey = hash(apiBase+apiKey+modelName)
         ├─ getOrCreateScopeRuntime(scope)
         │     ├─ 若 scope 已存在 → 复用 runtime
         │     └─ 若 scope 不存在 → 创建新 runtime
         │           ├─ new FrameQueue Map
         │           ├─ new SidecarController
         │           └─ new ConnectionManager
         │
         ├─ ensureConnected(runtime, signal, options)
         │     │
         │     ├─ sidecar.ensureStarted()
         │     │     │
         │     │     ├─ buildRuntime() → 构建 Python 启动配置
         │     │     ├─ 计算签名哈希
         │     │     ├─ 检查现有进程（TCP探活 + 签名匹配）
         │     │     │     ├─ 存活且签名匹配 → 复用，返回 resolvedUrl
         │     │     │     └─ 不存活或签名变更 → stop() + start()
         │     │     │
         │     │     └─ start(runtime, signal)
         │     │           ├─ allocatePort() → agentPort, webPort
         │     │           ├─ buildRelayClawLaunchCommand()
         │     │           │     ├─ useExecutable → [exe, --desktop-run-agentserver]
         │     │           │     └─ 否则 → [python, -m, jiuwenclaw.app_agentserver]
         │     │           ├─ spawn(command, args, {env: {AGENT_PORT, WEB_PORT, ...}})
         │     │           ├─ 捕获 stdout/stderr 日志
         │     │           └─ 等待就绪（TCP探活 + 日志标记）
         │     │
         │     └─ connection.ensureConnected(url)
         │           └─ 建立 WS 到 ws://127.0.0.1:{agentPort}
         │
         ├─ 创建 FrameQueue，注册到 runtime.requestQueues
         ├─ connection.send(buildRequest()) → 通过 WS 发送请求给 Python
         │
         └─ yield* consumeFrames()
               └─ while loop: queue.take() → transformRelayClawChunk() → yield AgentMessage
```

### 8.2 WebSocket 消息推送时序图

```
Python AgentRuntime 处理请求
    │
    │ 产生事件帧
    ▼
AgentWebSocketServer.send(frame)
    │  WS 发送 JSON
    ▼
═══════════════════════════════════════════════════════
    │  (网络传输: ws://127.0.0.1:AGENT_PORT)
    ▼
RelayClawConnectionManager WS onMessage
    │
    ├─ JSON.parse(data) → RelayClawWsFrame
    ├─ 兼容 E2A 协议: isE2AResponseFrame() → e2aToLegacyFrame()
    ├─ connection.ack → serverReady = true
    ├─ 按 request_id 查找 FrameQueue
    ├─ queue.put(frame)
    └─ is_complete? → queue.put(null)
         │
         ▼
FrameQueue.take() (被 consumeFrames 消费)
    │
    ▼
consumeFrames() 循环
    │
    ├─ frame = await queue.take()
    ├─ message = transformRelayClawChunk(frame, agentId)
    │     ├─ task.start → system_info (task_boundary start)
    │     ├─ chat.delta → text
    │     ├─ chat.tool_call → tool_use
    │     ├─ chat.error → error
    │     └─ ... (见映射表)
    ├─ updateRelayClawTaskStack(taskStack, message)
    ├─ out = attachRelayClawStreamTaskContext(taskStack, message)
    └─ yield out
         │
         ▼
routeSerial → invokeSingleCat → yield 透传
         │
         ▼
messages.ts: for await (const msg of router.routeExecution(...))
    │
    ├─ socketManager.broadcastAgentMessage(msg, threadId)
    │
    ▼
SocketManager.broadcastAgentMessage()
    │
    ├─ 解析 threadId (从参数或 invocationThreadIndex 恢复)
    ├─ 分类错误码: classifyAgentErrorCode()
    └─ this.io.to(`thread:${threadId}`).emit('agent_message', {...msg, threadId})
         │
         ▼
═══════════════════════════════════════════════════════
    │  (Socket.IO 传输)
    ▼
浏览器 Socket.IO Client
    │
    ▼
socket.on('agent_message', handler)
    │
    └─ React 状态更新 → UI 渲染
```

### 8.3 多智能体 Sidecar 进程布局

```
Node.js API Server
    │
    ├─ AgentRegistry
    │     ├─ 'office'     → RelayClawAgentService (agentId='office')
    │     ├─ 'assistant'  → RelayClawAgentService (agentId='assistant')
    │     └─ 'agentteams' → RelayClawAgentService (agentId='agentteams')
    │
    ├─ RelayClawAgentService['office']
    │     └─ scopes: Map
    │           └─ 'auto:hash1' → ScopeRuntime
    │                 ├─ SidecarController → child process (python, AGENT_PORT=xxx1)
    │                 └─ ConnectionManager → WS to ws://127.0.0.1:xxx1
    │
    ├─ RelayClawAgentService['assistant']
    │     └─ scopes: Map
    │           └─ 'auto:hash2' → ScopeRuntime
    │                 ├─ SidecarController → child process (python, AGENT_PORT=xxx2)
    │                 └─ ConnectionManager → WS to ws://127.0.0.1:xxx2
    │
    └─ RelayClawAgentService['agentteams']
          └─ scopes: Map
                └─ 'auto:hash3' → ScopeRuntime
                      ├─ SidecarController → child process (python, AGENT_PORT=xxx3)
                      └─ ConnectionManager → WS to ws://127.0.0.1:xxx3
```

---

## 附录：关键源文件索引

| 文件 | 路径 | 核心职责 |
|------|------|----------|
| messages.ts | `packages/api/src/routes/messages.ts` | POST /api/messages 入口，ADR-008 解耦执行 |
| AgentRouter.ts | `packages/api/src/domains/agents/services/agents/routing/AgentRouter.ts` | @提及解析与路由策略选择 |
| route-serial.ts | `packages/api/src/domains/agents/services/agents/routing/route-serial.ts` | 串行执行策略，A2A 链式调用 |
| invoke-single-agent.ts | `packages/api/src/domains/agents/services/agents/invocation/invoke-single-agent.ts` | 单智能体调用核心逻辑 |
| RelayClawAgentService.ts | `packages/api/src/domains/agents/services/agents/providers/RelayClawAgentService.ts` | RelayClaw 智能体服务，Scope 管理，帧消费 |
| relayclaw-sidecar.ts | `packages/api/src/domains/agents/services/agents/providers/relayclaw-sidecar.ts` | Python 子进程生命周期管理 |
| relayclaw-connection.ts | `packages/api/src/domains/agents/services/agents/providers/relayclaw-connection.ts` | WS 客户端，FrameQueue，帧路由 |
| relayclaw-event-transform.ts | `packages/api/src/domains/agents/services/agents/providers/relayclaw-event-transform.ts` | Python 帧到 AgentMessage 的转换映射 |
| SocketManager.ts | `packages/api/src/infrastructure/websocket/SocketManager.ts` | Socket.IO 服务器，消息广播 |
| QueueProcessor.ts | `packages/api/src/domains/agents/services/agents/invocation/QueueProcessor.ts` | 排队消息处理，含广播逻辑 |
| AgentRegistry.ts | `packages/api/src/domains/agents/services/agents/registry/AgentRegistry.ts` | agentId → AgentService 映射 |
| builtin-providers.ts | `packages/api/src/config/plugins/builtin-providers.ts` | 提供商插件，创建 RelayClawAgentService |
| office-claw-template.json | `office-claw-template.json` | 智能体品种配置（3 个 relayclaw breed） |
| app_agentserver.py | `vendor/jiuuwenclaw/jiuuwenclaw/app_agentserver.py` | Python Sidecar 入口，启动 WS 服务器 |

本文写于：2026年6月3日

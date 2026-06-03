# 应用启动和初始化流程

当我们访问首页或者某个对话页面时，经历了怎样的流程？

首页（/）流程：
- 主题初始化 → index.html 内联脚本（防 FOUC）
- React 启动 → BrowserRouter + App 路由匹配
- 全局壳初始化 → RootChrome（SW清理、主题同步、协议门控）
- 侧边栏加载 → GET /api/threads 获取会话列表 + Socket 连接
- HomePage 渲染 → setCurrentThread('default') + ChatEmptyState 空状态 + ChatInput 输入框
- 发送消息 → 先 POST /api/threads 创建线程 → 暂存消息到 pendingNewThreadSend → 跳转到 /thread/{id}

对话页（/thread/:threadId）流程：
- 路由匹配 → ThreadPage → ChatContainer（核心组件，协调 10+ 个 Hook）
- 线程切换 → setCurrentThread(threadId) 快照旧线程 + 恢复新线程状态
- 智能体数据加载 → GET /api/agents（带 fallback + 重试）
- 聊天历史加载 → GET /api/threads/{id}/messages?limit=50 + 智能合并本地流式消息
- Socket 连接 → 加入 thread:{id} 房间 + 完整事件处理（agent_message/thread_created/authorization_request 等）
- 消费暂存消息 → 若从首页跳转来，自动发送 pendingNewThreadSend
- 消息发送 → 乐观更新 + POST /api/messages + 服务端确认替换
- 流式响应 → Socket agent_message 事件 → thinking/text/tool_use/done 逐帧处理

## 1. 项目整体架构

### 1.1 目录结构

```
packages/web/src/
├── main.tsx              # 应用入口（Vite 模式）
├── App.tsx               # 路由配置
├── index.tsx             # NPM 库导出入口
├── globals.css           # 全局样式
├── components/           # UI 组件
│   ├── RootChrome.tsx    # 根级壳组件（全局基础设施）
│   ├── MainChrome.tsx    # 主壳组件（侧边栏 + 布局）
│   ├── MainShell.tsx     # 主布局壳（侧边栏 + 右侧内容区）
│   ├── ChatContainer.tsx # 对话容器（核心聊天逻辑）
│   ├── ChatEmptyState.tsx# 首页空状态展示
│   ├── ChatInput.tsx     # 消息输入框
│   ├── ChatMessageList/  # 消息列表
│   ├── thread-sidebar/   # 会话侧边栏
│   ├── StartupAgreementGate.tsx  # 启动协议门控
│   ├── ThemeRootSync.tsx # 主题同步
│   └── ...
├── pages/                # 页面组件（路由懒加载）
│   ├── HomePage.tsx      # 首页
│   ├── ThreadPage.tsx    # 对话页
│   └── ...
├── hooks/                # 自定义 Hooks
│   ├── useSocket.ts      # WebSocket 连接管理
│   ├── useChatHistory.ts # 聊天历史加载
│   ├── useSendMessage.ts # 发送消息
│   ├── useAgentMessages.ts # 智能体消息处理
│   ├── useAgentData.ts   # 智能体数据获取
│   ├── useAuthorization.ts # 授权审批
│   └── ...
├── stores/               # Zustand 状态管理
│   ├── chatStore.ts      # 聊天核心状态（最大最关键）
│   ├── chat-types.ts     # 类型定义
│   ├── themeStore.ts     # 主题状态
│   ├── toastStore.ts     # Toast 通知状态
│   └── ...
├── services/             # 服务层
├── utils/                # 工具函数
│   ├── api-client.ts     # API 客户端（统一请求封装）
│   └── userId.ts         # 用户身份
└── lib/                  # 库函数
```

### 1.2 路由结构

```tsx
<Routes>
  <Route element={<RootChrome />}>          {/* 全局壳 */}
    <Route element={<MainChrome />}>        {/* 主壳（侧边栏+布局） */}
      <Route path="/" element={<HomePage />} />
      <Route path="/thread/:threadId" element={<ThreadPage />} />
      <Route path="/channels" element={<ChannelsPage />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/skills" element={<SkillsPage />} />
      <Route path="/schedule" element={<SchedulePage />} />
      <Route path="/inspiration" element={<InspirationPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Route>
</Routes>
```

### 1.3 组件层级关系

```
BrowserRouter
  └── App (Routes)
        └── RootChrome
              ├── DevServiceWorkerReset
              ├── ThemeRootSync
              ├── ConfirmProvider
              │     └── MainChrome
              │           └── MainShell
              │                 ├── RightContentHeaderOverrideProvider
              │                 ├── StartupAgreementGate
              │                 ├── ThreadSidebar (左侧)
              │                 ├── RightContentHeader (右侧头部)
              │                 └── {children}  ← 页面内容
              ├── DesktopResizeHandles
              └── ToastContainer
```

---

## 2. 应用启动流程

### 2.1 HTML 加载阶段

**文件：`index.html`**

1. 浏览器加载 `index.html`
2. **主题初始化（内联脚本，阻塞式）**：
   - 读取 Cookie 中的 `office-claw-theme` 或旧版 `clowder-ai-theme`
   - 若 Cookie 无值，回退到 `localStorage`
   - 合法值：`warm` / `business` / `dark`，否则使用默认 `business`
   - 设置 `document.documentElement.dataset.uiTheme = theme`
   - 同步写入 Cookie（1 年有效期）和 localStorage
   - **目的**：避免主题闪烁（FOUC），在 React 渲染前就确定主题

3. 加载 `/src/main.tsx`（type=module）

### 2.2 React 初始化阶段

**文件：`main.tsx`**

```tsx
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
```

1. 创建 React Root
2. 包裹 `StrictMode`（开发模式双重渲染）
3. 包裹 `BrowserRouter`（HTML5 History API 路由）
4. 渲染 `<App />`

### 2.3 路由匹配阶段

**文件：`App.tsx`**

1. `Routes` 根据当前 URL 匹配路由
2. 所有有效路由都嵌套在 `<RootChrome />` 和 `<MainChrome />` 内
3. 页面组件使用 `lazy()` 懒加载，包裹在 `<Suspense>` 中（显示"加载中..."旋转动画）
4. 未匹配路由重定向到 `/`

### 2.4 全局基础设施初始化

**组件：`RootChrome`**

按顺序初始化以下全局能力：

| 组件 | 作用 | 初始化时机 |
|------|------|-----------|
| `DevServiceWorkerReset` | 开发模式下清除 Service Worker 缓存 | mount 时 |
| `ThemeRootSync` | 从 `themeStore` 读取主题并同步到 DOM | mount 时 |
| `ConfirmProvider` | 全局确认对话框上下文 | 包裹子组件 |
| `DesktopResizeHandles` | 桌面端窗口调整手柄 | 始终渲染 |
| `ToastContainer` | 全局 Toast 通知容器 | 始终渲染 |

**组件：`MainChrome → MainShell`**

| 组件 | 作用 | 初始化时机 |
|------|------|-----------|
| `RightContentHeaderOverrideProvider` | 右侧头部覆盖上下文 | 包裹子组件 |
| `StartupAgreementGate` | 启动协议签署门控 | mount 时检查 |
| `ThreadSidebar` | 左侧会话列表侧边栏 | lazy 加载 |
| `RightContentHeader` | 右侧内容区头部 | lazy 加载 |

### 2.5 启动协议门控

**组件：`StartupAgreementGate`**

1. 调用 `fetchStartupAgreementStatus()` → `GET /api/agreement` 获取协议签署状态
2. 根据 `remoteAgreeDeclaration` 和本地缓存判断是否需要展示协议弹窗
3. 若需要展示 → 弹出 `StartupAgreementModal`，用户必须签署后才能继续使用
4. 签署流程：
   - `POST /api/agreement` 提交协议签署
   - `POST /api/apm-tracing-enabled` 提交模型改进数据收集偏好
   - 写入 localStorage 标记已签署

### 2.6 侧边栏初始化

**组件：`ThreadSidebar → useThreadSidebarController → useThreadSidebarData`**

1. **加载会话列表**：`GET /api/threads` → 写入 `chatStore.threads`
2. **初始化未读计数**：遍历 threads，调用 `initThreadUnread(threadId, unreadCount, hasUserMention)`
3. **加载待审批授权**：`GET /api/authorization/pending` → 写入 `authorizationPendingStore`
4. **加载治理健康状态**：`GET /api/governance/health` → 写入本地 state
5. **建立侧边栏专用 Socket 连接**：
   - `io(API_URL)` 连接 WebSocket
   - `join_room('user:{userId}')` 加入用户房间
   - 监听 `thread_created` 事件（connector_auto 来源时刷新列表）
   - 监听 `connector_message` 事件（更新 thread 的 lastActiveAt）
6. **监听自定义刷新事件**：`office-claw:threads-refresh` → 重新加载会话列表

---

## 3. 访问首页（/）的完整流程

### 3.1 路由匹配

1. URL 为 `/`，匹配 `<Route path="/" element={<HomePage />} />`
2. `HomePage` 通过 `lazy()` 动态导入，`Suspense` 显示加载动画
3. 加载完成后渲染 `<HomePage />`

### 3.2 HomePage 组件初始化

**文件：`pages/HomePage.tsx`**

#### 3.2.1 Store 订阅

从 `chatStore` 订阅以下状态：

| 状态 | 用途 |
|------|------|
| `setCurrentThread` | 设置当前活跃线程 |
| `threads` | 会话列表（用于工作区选项） |
| `setPendingNewThreadSend` | 设置待发送的新线程消息 |
| `attachPendingNewThreadTarget` | 将待发送消息关联到新线程 |
| `clearPendingNewThreadSend` | 清除待发送状态 |

#### 3.2.2 设置当前线程

```tsx
useEffect(() => {
  setCurrentThread('default');
}, [setCurrentThread]);
```

- 调用 `chatStore.setCurrentThread('default')`
- **`setCurrentThread` 内部逻辑**：
  1. 若 `threadId === currentThreadId`，无操作
  2. 保存当前 flat state 到 `threadStates` map（`snapshotActive`）
  3. 加载目标线程 state（`threadStates['default']` 或 `DEFAULT_THREAD_STATE`）
  4. 更新 `currentThreadId = 'default'`
  5. 恢复目标线程的 messages、isLoading、hasActiveInvocation 等状态
  6. 更新 `rightPanelMode` 和 `activePptPagesDir`

#### 3.2.3 Socket 连接初始化

```tsx
const socketCallbacks = useMemo(() => ({
  onMessage: () => {},
  onThreadCreated: () => {
    window.dispatchEvent(new CustomEvent('office-claw:threads-refresh'));
  },
}), []);

const watchedThreadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
useSocket(socketCallbacks, undefined, watchedThreadIds);
```

- **`useSocket` 初始化流程**：
  1. 获取 `userId`，加载已加入的房间列表（`loadJoinedRoomsFromSession`）
  2. 创建 Socket.IO 连接：`io(API_URL, { transports: ['websocket', 'polling'], auth: { userId } })`
  3. 连接成功后：
     - 加入用户房间：`emit('join_room', 'user:{userId}')`
     - 加入所有 watchedThreadIds 对应的房间：`emit('join_room', 'thread:{threadId}')`
     - 恢复之前 session 中已加入的房间
  4. 注册事件监听器：
     - `agent_message` → 智能体消息（首页 onMessage 为空操作）
     - `thread_created` → 新线程创建（触发侧边栏刷新）
     - `thread_updated` → 线程标题更新
     - `intent_mode` → 意图模式变更
     - `heartbeat` → 心跳
     - `authorization_request` → 工具审批请求
     - `authorization_response` → 工具审批响应
     - `ask_user_question_request` → 向用户提问请求
     - `ask_user_question_response` → 向用户提问响应
     - `game_state_update` → 游戏状态更新
     - `game_thread_created` → 游戏线程创建
     - `queue_updated` → 队列更新
     - `queue_paused` → 队列暂停
     - `connector_message` → 渠道消息
  5. 断线重连时：`reconcileInvocationStateOnReconnect` 与服务端对账

#### 3.2.4 工作区选项计算

```tsx
const workspaceOptions = useMemo(
  () => getProjectPaths(threads).map((path) => ({
    path,
    name: getFolderNameFromPath(path),
    title: path,
  })),
  [threads],
);
```

- 从 `threads` 列表中提取所有项目路径
- 用于 ChatInput 的工作区选择下拉

### 3.3 首页 UI 渲染

```
┌──────────────────────────────────────────────────────────┐
│  ThreadSidebar (左侧)  │         HomePage (右侧)          │
│                        │                                  │
│  ┌──────────────┐     │  ┌────────────────────────────┐  │
│  │ 会话列表      │     │  │     ChatEmptyState          │  │
│  │ - 大厅        │     │  │                              │  │
│  │ - 会话1       │     │  │  [OfficeClaw Logo]          │  │
│  │ - 会话2       │     │  │  AI深度赋能全场景办公...     │  │
│  │              │     │  │                              │  │
│  │              │     │  │  ┌──────────┐ ┌──────────┐  │  │
│  │              │     │  │  │智能体配置 │ │一键接入渠道│  │  │
│  │              │     │  │  └──────────┘ └──────────┘  │  │
│  └──────────────┘     │  └────────────────────────────┘  │
│                        │  ┌────────────────────────────┐  │
│                        │  │     ChatInput               │  │
│                        │  │  [输入框] [发送] [工作区]   │  │
│                        │  └────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**ChatEmptyState** 展示：
- OfficeClaw Logo 和标语
- 两张卡片：**智能体配置**（跳转 `/agents`）和 **一键接入渠道**（跳转 `/channels`）

**ChatInput** 展示：
- 消息输入框（支持文本、图片、文件附件）
- 工作区选择（已有项目 / 打开文件夹选择器 / 空）
- 发送按钮

### 3.4 用户在首页发送消息的流程

当用户在首页输入消息并点击发送时，触发 `handleSend`：

```
用户点击发送
  │
  ├─ 1. 检查 isCreatingThread（防重复提交）
  ├─ 2. 检查会话数量上限（MAX_SESSIONS = 200）
  ├─ 3. setIsCreatingThread(true)
  ├─ 4. setPendingNewThreadSend({ requestId, content, images, whisper, deliveryMode, sendOptions })
  │     → 将消息暂存到 chatStore，等线程创建后自动发送
  ├─ 5. 构建创建线程请求体
  │     → 若选择了工作区：{ projectPath: selectedFolderPath }
  │     → 否则：{}
  ├─ 6. POST /api/threads → 创建新线程
  │     → 返回 { id: threadId, ... }
  ├─ 7. attachPendingNewThreadTarget(thread.id)
  │     → 将暂存消息关联到新线程 ID
  ├─ 8. navigate(`/thread/${thread.id}`)
  │     → 跳转到新线程页面
  │     → ThreadPage 会消费 pendingNewThreadSend 自动发送消息
  └─ 9. setIsCreatingThread(false)
```

**关键设计**：首页不直接发送消息，而是先创建线程，再跳转到线程页面发送。`pendingNewThreadSend` 机制确保消息不会丢失。

### 3.5 文件夹选择器流程

```
用户点击"打开文件夹"
  │
  ├─ 1. abortActiveFolderPicker() 取消进行中的请求
  ├─ 2. 创建 AbortController
  ├─ 3. 若已有 selectedFolderPath：
  │     → POST /api/projects/pick-directory { initialPath }
  ├─ 4. 否则：
  │     → GET /api/projects/cwd 获取当前工作目录
  │     → POST /api/projects/pick-directory { initialDirectory: cwd }
  ├─ 5. 后端打开系统文件夹选择对话框
  │     → 返回 204（用户取消）或 { path }（用户选择）
  └─ 6. 更新 selectedFolderPath / selectedFolderName / selectedFolderTitle
```

---

## 4. 访问对话页面（/thread/:threadId）的完整流程

### 4.1 路由匹配

1. URL 为 `/thread/:threadId`，匹配 `<Route path="/thread/:threadId" element={<ThreadPage />} />`
2. `ThreadPage` 通过 `lazy()` 动态导入
3. 加载完成后渲染 `<ThreadPage />`

### 4.2 ThreadPage 组件

**文件：`pages/ThreadPage.tsx`**

```tsx
export default function ThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  return <ChatContainer mode="thread" threadId={threadId ?? ''} />;
}
```

- 从 URL 参数提取 `threadId`
- 渲染 `<ChatContainer>` 传入 `mode="thread"` 和 `threadId`

### 4.3 ChatContainer 初始化（核心！）

**文件：`components/ChatContainer.tsx`**

这是整个应用最复杂的组件，协调了聊天功能的所有子系统和 Hooks。

#### 4.3.1 Store 状态订阅

从 `chatStore` 订阅大量状态：

| 状态 | 用途 |
|------|------|
| `messages` | 当前线程消息列表 |
| `isLoading` | 是否正在加载 |
| `hasActiveInvocation` | 是否有活跃的智能体调用 |
| `intentMode` | 意图模式（ideate/execute） |
| `targetAgents` | 目标智能体列表 |
| `agentStatuses` | 智能体状态映射 |
| `agentInvocations` | 智能体调用信息 |
| `setCurrentThread` | 切换线程 |
| `viewMode` | 视图模式 |
| `clearUnread` | 清除未读 |
| `consumePendingNewThreadSend` | 消费首页暂存的消息 |
| `rightPanelMode` | 右侧面板模式 |
| `threads` | 会话列表 |

#### 4.3.2 核心 Hooks 初始化顺序

```
ChatContainer mount
  │
  ├─ 1. useDesktopWindowControls()     → 桌面端窗口控制
  ├─ 2. useAgentData()                 → 获取智能体配置数据
  ├─ 3. useCurrentPptSession(threadId) → PPT 会话状态
  ├─ 4. useAgentMessages()             → 智能体消息处理器
  │     ├── handleAgentMessage         → 处理智能体消息
  │     ├── handleStop                 → 停止生成
  │     ├── resetRefs                  → 重置引用
  │     ├── resetRefsForThreadSwitch   → 线程切换时重置
  │     ├── rehydrateStreamingRefs     → 重新绑定流式引用
  │     ├── resetTimeout               → 重置超时
  │     └── clearDoneTimeout           → 清除完成超时
  ├─ 5. useChatHistory(threadId)       → 加载聊天历史（关键！）
  │     ├── handleScroll               → 滚动处理
  │     ├── scrollContainerRef         → 滚动容器引用
  │     ├── scrollToBottom             → 滚动到底部
  │     ├── isLoadingHistory           → 历史加载状态
  │     └── hasMore                    → 是否有更多历史
  ├─ 6. useMessageFeedback(threadId)   → 消息反馈
  ├─ 7. useSendMessage(threadId)       → 发送消息
  ├─ 8. useAuthorization(threadId)     → 授权审批
  ├─ 9. useAskUserQuestion(threadId)   → 向用户提问
  ├─ 10. useChatSocketCallbacks(...)   → Socket 事件回调
  └─ 11. useSocket(socketCallbacks, threadId, watchedThreadIds)
        → 建立 WebSocket 连接并注册事件
```

#### 4.3.3 线程切换逻辑

```tsx
useEffect(() => {
  if (prevThreadRef.current !== threadId) {
    setCurrentThread(threadId);
    resetRefsForThreadSwitch(threadId);
    prevThreadRef.current = threadId;
  }
  setCurrentThread(threadId);
}, [threadId, resetRefsForThreadSwitch, setCurrentThread]);
```

**`setCurrentThread(threadId)` 内部完整流程**：

```
setCurrentThread(threadId)
  │
  ├─ 1. 检查 threadId === currentThreadId → 相同则跳过
  ├─ 2. 持久化当前线程的文件浏览器状态
  ├─ 3. snapshotActive(state) → 快照当前 flat state
  │     → 保存 messages, isLoading, hasActiveInvocation, agentStatuses,
  │       agentInvocations, intentMode, targetAgents, queue 等
  ├─ 4. 加载目标线程 state
  │     → threadStates[threadId] 或 DEFAULT_THREAD_STATE
  ├─ 5. 更新 currentThreadId = threadId
  ├─ 6. 保存旧线程 state 到 threadStates map
  ├─ 7. 更新 _lastReadAtByThread（已读时间戳）
  ├─ 8. 恢复目标线程的 rightPanelMode
  ├─ 9. 恢复目标线程的 activePptPagesDir
  └─ 10. flattenThread(loaded) → 将 ThreadState 展平到 ChatState
        → 恢复 messages, isLoading, hasActiveInvocation 等到顶层
```

#### 4.3.4 聊天历史加载（useChatHistory）

**这是对话页面最核心的数据加载流程。**

```
useChatHistory(threadId) 初始化
  │
  ├─ 1. 创建 AbortController（用于取消进行中的请求）
  ├─ 2. 创建滚动状态引用
  │     ├── scrollContainerRef
  │     ├── messagesEndRef
  │     ├── prevFirstIdRef / prevCountRef
  │     └── pendingScrollToBottomRef
  │
  ├─ 3. useEffect: threadId 变化时触发历史加载
  │     │
  │     ├─ a. 取消之前的请求（abortRef）
  │     ├─ b. 创建新 AbortController
  │     ├─ c. setLoadingHistory(true)
  │     ├─ d. clearMessages() → 清空当前消息
  │     ├─ e. fetchHistory() → 加载第一页历史
  │     │     │
  │     │     ├─ GET /api/threads/{threadId}/messages?limit=50
  │     │     │   → 返回 { messages: [...], hasMore: bool }
  │     │     │
  │     │     ├─ normalizeHistoryToolEvents() → 标准化工具事件
  │     │     │
  │     │     ├─ mergeReplaceHydrationMessages() → 合并本地与服务端消息
  │     │     │   ├── 比对 invocationId 匹配
  │     │     │   ├── 比对文本重叠度
  │     │     │   ├── 比对工具事件共享
  │     │     │   ├── 比对时间窗口
  │     │     │   └── 选择更丰富的版本保留
  │     │     │
  │     │     ├─ replaceMessages(merged) → 写入 chatStore
  │     │     │
  │     │     ├─ 恢复智能体调用状态
  │     │     │   ├── setAgentInvocation() → 恢复调用信息
  │     │     │   ├── replaceThreadTargetAgents() → 恢复目标智能体
  │     │     │   ├── updateThreadAgentStatus() → 恢复智能体状态
  │     │     │   └── setHasActiveInvocation() → 恢复活跃调用标志
  │     │     │
  │     │     ├─ 恢复队列状态
  │     │     │   ├── setQueue() → 恢复队列
  │     │     │   └── setQueuePaused() → 恢复暂停状态
  │     │     │
  │     │     └─ setLoadingHistory(false)
  │     │
  │     └─ f. scrollToBottom('instant') → 滚动到最新消息
  │
  ├─ 4. useEffect: 滚动加载更多（向上滚动到顶部时）
  │     └─ fetchHistory(cursor) → 加载下一页
  │
  └─ 5. useEffect: 监听 thread-live-refresh 事件
        └─ 重新加载当前线程消息（debounce 180ms）
```

#### 4.3.5 智能体数据加载（useAgentData）

```
useAgentData() 初始化
  │
  ├─ 1. 检查模块级缓存 _cached
  │     → 有缓存：直接使用
  │     → 无缓存：使用 buildFallbackAgents()（从 OFFICE_CLAW_CONFIGS 静态配置构建）
  │
  ├─ 2. GET /api/agents → 获取服务端智能体配置
  │     → 成功：normalizeAgents() 标准化 → 缓存到 _cached
  │     → 失败：保留 fallback 数据，10s 后重试（最多 3 次）
  │
  ├─ 3. refreshMentionData(agents) → 更新 @提及 数据
  ├─ 4. refreshSpeechAliases(agents) → 更新语音别名
  └─ 5. notifyListeners(agents) → 通知所有订阅者
```

#### 4.3.6 Socket 连接与事件处理

**`useSocket` 在对话页面的完整事件处理流程：**

```
Socket.IO 连接建立
  │
  ├─ connect 事件
  │     ├─ emit('join_room', 'user:{userId}')
  │     ├─ emit('join_room', 'thread:{threadId}')
  │     └─ 恢复 session 中已加入的房间
  │
  ├─ agent_message 事件（核心！）
  │     │
  │     ├─ 判断消息归属线程
  │     │   ├── 当前活跃线程 → handleAgentMessage(msg)
  │     │   │     → useAgentMessages 处理：
  │     │   │       ├── type='thinking' → 追加思考内容
  │     │   │       ├── type='text' → 追加文本内容
  │     │   │       ├── type='tool_use' → 追加工具调用事件
  │     │   │       ├── type='tool_result' → 追加工具结果事件
  │     │   │       ├── type='done' → 标记流式完成
  │     │   │       ├── type='error' → 显示错误消息
  │     │   │       ├── type='task_progress' → 更新任务进度
  │     │   │       └── type='ppt_studio_*' → PPT 工作室事件
  │     │   │
  │     │   └── 后台线程 → handleBackgroundAgentMessage(msg)
  │     │         → 更新 threadStates[threadId]
  │     │         → 递增 unreadCount
  │     │         → 触发桌面通知
  │     │
  │     └─ 更新 agentStatuses / agentInvocations
  │
  ├─ thread_created 事件
  │     └─ 触发 office-claw:threads-refresh → 侧边栏刷新
  │
  ├─ thread_updated 事件
  │     └─ updateThreadTitle(threadId, title)
  │
  ├─ intent_mode 事件
  │     ├─ setLoading(true)
  │     ├─ setHasActiveInvocation(true)
  │     ├─ setIntentMode(mode)
  │     └─ setTargetAgents(targetAgents)
  │
  ├─ heartbeat 事件
  │     └─ resetTimeout() → 重置超时计时器
  │
  ├─ authorization_request 事件
  │     ├─ registerPending(threadId, requestId)
  │     └─ notifyToolApprovalRequest() → 桌面通知
  │
  ├─ authorization_response 事件
  │     └─ 更新审批状态
  │
  ├─ ask_user_question_request 事件
  │     └─ 显示交互式问题卡片
  │
  ├─ ask_user_question_response 事件
  │     └─ 关闭交互式问题卡片
  │
  ├─ game_state_update 事件
  │     └─ 更新游戏状态
  │
  ├─ game_thread_created 事件
  │     └─ navigate(`/thread/${gameThreadId}`)
  │
  ├─ queue_updated 事件
  │     └─ setQueue(threadId, queue)
  │
  ├─ queue_paused 事件
  │     └─ setQueuePaused(threadId, paused, reason)
  │
  ├─ connector_message 事件
  │     └─ 渠道消息处理（飞书/微信/钉钉/小艺）
  │
  ├─ disconnect 事件
  │     └─ 标记断线，等待重连
  │
  └─ reconnect 事件
        └─ reconcileInvocationStateOnReconnect()
              → GET /api/threads/{threadId}/queue
              → 与服务端对账，修复卡住的流式状态
```

#### 4.3.7 消费首页暂存消息

```tsx
// ChatContainer 内部 useEffect
useEffect(() => {
  const pending = consumePendingNewThreadSend();
  if (pending && threadId) {
    handleSend(pending.content, pending.images, threadId, pending.whisper, pending.deliveryMode, pending.sendOptions);
  }
}, [threadId, consumePendingNewThreadSend, handleSend]);
```

- 如果用户从首页发送消息跳转过来，`pendingNewThreadSend` 中有暂存的消息
- `consumePendingNewThreadSend()` 消费并清除暂存
- 自动调用 `handleSend` 发送消息

#### 4.3.8 流式引用重新绑定

```tsx
useEffect(() => {
  if (!threadId || isLoadingHistory) return;
  rehydrateStreamingRefs(threadId);
}, [threadId, isLoadingHistory, rehydrateStreamingRefs]);
```

- F5 刷新或历史加载完成后，重新绑定正在流式输出的消息引用
- 确保刷新后不会丢失进行中的流式响应

### 4.4 对话页面 UI 渲染

```
┌──────────────────────────────────────────────────────────────────┐
│  ThreadSidebar   │              ChatContainer                     │
│                  │                                                │
│  ┌────────────┐ │  ┌──────────────────────────────────────────┐  │
│  │ 会话列表    │ │  │ ChatContainerHeader                      │  │
│  │            │ │  │  [线程标题] [智能体状态] [操作按钮]       │  │
│  │ ● 大厅     │ │  └──────────────────────────────────────────┘  │
│  │   会话1 ◄──│ │  ┌──────────────────────────────────────────┐  │
│  │   会话2    │ │  │ ParallelStatusBar (并行状态)              │  │
│  │   会话3    │ │  └──────────────────────────────────────────┘  │
│  │            │ │  ┌──────────────────────────────────────────┐  │
│  │            │ │  │ ChatMessageList                           │  │
│  │            │ │  │  ┌────────────────────────────────────┐  │  │
│  │            │ │  │  │ ChatMessageRow (user)              │  │  │
│  │            │ │  │  │ "帮我分析这段代码"                  │  │  │
│  │            │ │  │  └────────────────────────────────────┘  │  │
│  │            │ │  │  ┌────────────────────────────────────┐  │  │
│  │            │ │  │  │ ChatMessageRow (assistant)         │  │  │
│  │            │ │  │  │ [AgentAvatar] 好的，我来分析...     │  │  │
│  │            │ │  │  │ [ThinkingIndicator]                │  │  │
│  │            │ │  │  │ [ToolEvents]                       │  │  │
│  │            │ │  │  │ [MarkdownContent]                  │  │  │
│  │            │ │  │  └────────────────────────────────────┘  │  │
│  │            │ │  │                                            │  │
│  │            │ │  │  [ScrollToBottomButton]                   │  │
│  │            │ │  └──────────────────────────────────────────┘  │
│  │            │ │  ┌──────────────────────────────────────────┐  │
│  │            │ │  │ ThreadExecutionBar (执行状态栏)           │  │
│  │            │ │  └──────────────────────────────────────────┘  │
│  │            │ │  ┌──────────────────────────────────────────┐  │
│  │            │ │  │ ChatInput                                 │  │
│  │            │ │  │  [@提及] [输入框] [附件] [语音] [发送]   │  │
│  │            │ │  └──────────────────────────────────────────┘  │
│  └────────────┘ │                                                │
│                  │  ┌──────────────────────────────────────────┐  │
│                  │  │ PreviewSecondaryPane (预览面板)           │  │
│                  │  │  [文件浏览器 / PPT工作室 / 大纲预览]      │  │
│                  │  └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.5 在对话页面发送消息的完整流程

```
用户输入消息 → 点击发送
  │
  ├─ 1. useSendMessage().handleSend(content, images, threadId, whisper, deliveryMode, sendOptions)
  │
  ├─ 2. processCommand(content, threadId) → 检查是否为斜杠命令
  │     → 是命令：执行命令并返回
  │     → 不是命令：继续
  │
  ├─ 3. 创建 clientMessageId = crypto.randomUUID()
  │     → optimisticMessageId = `user-${clientMessageId}`
  │
  ├─ 4. 构建乐观更新的用户消息
  │     → userMsg = { id: optimisticMessageId, type: 'user', content, timestamp }
  │     → 若有图片/文件：创建 blob URL 并添加 contentBlocks
  │
  ├─ 5. 乐观插入消息到 chatStore
  │     → addMessage(userMsg) 或 addMessageToThread(threadId, userMsg)
  │     → UI 立即显示用户消息气泡
  │
  ├─ 6. setLoading(true), setHasActiveInvocation(true)
  │     → UI 显示"回复中..."状态
  │
  ├─ 7. 发送 HTTP 请求
  │     ├── 有附件：POST /api/messages (FormData)
  │     │   → formData.append('content', content)
  │     │   → formData.append('threadId', threadId)
  │     │   → formData.append('idempotencyKey', clientMessageId)
  │     │   → formData.append('images'/attachments', file)
  │     │
  │     └── 无附件：POST /api/messages (JSON)
  │         → { content, threadId, idempotencyKey, deliveryMode, ... }
  │
  ├─ 8. 处理响应
  │     ├── 成功 + body.userMessageId → replaceThreadMessageId(optimistic → server)
  │     ├── 队列模式 + body.status='queued' → 移除乐观消息，等待 WS 事件
  │     ├── 游戏模式 + body.status='game_started' → 移除乐观消息，跳转游戏线程
  │     └── 失败 → 添加错误系统消息
  │
  ├─ 9. maybeAutoTitleThread(threadId, content)
  │     → 若线程标题为空/默认 → PATCH /api/threads/{threadId} { title: autoTitle }
  │
  └─ 10. 后续：智能体通过 Socket.IO 推送响应
        → agent_message 事件 → useAgentMessages 处理 → 更新 chatStore → UI 更新
```

### 4.6 智能体消息流式处理详解

**`useAgentMessages`** 是处理智能体响应的核心 Hook：

```
agent_message 事件到达
  │
  ├─ type='thinking'
  │     → appendThinkingText() → 追加思考内容到消息
  │     → UI: ThinkingIndicator 展开/折叠
  │
  ├─ type='text'
  │     → 追加文本内容到消息的 content
  │     → 若消息不存在：创建 draft-{invocationId} 消息
  │     → 若消息存在：追加内容（流式拼接）
  │     → UI: MarkdownContent 实时渲染
  │
  ├─ type='tool_use'
  │     → 追加 toolEvent 到消息的 toolEvents 数组
  │     → UI: 工具调用卡片（展开/折叠）
  │
  ├─ type='tool_result'
  │     → 追加 toolEvent（结果）到消息的 toolEvents 数组
  │     → UI: 工具结果展示
  │
  ├─ type='done' (isFinal=true)
  │     → setStreaming(messageId, false) → 标记流式完成
  │     → setLoading(false) → 取消加载状态
  │     → clearActiveInvocation() → 清除活跃调用
  │     → stampAssistantMessageCompletedAt() → 记录完成时间
  │     → UI: 停止"回复中..."动画
  │
  ├─ type='error'
  │     → 添加错误系统消息
  │     → setLoading(false), clearActiveInvocation()
  │     → UI: 显示错误提示
  │
  ├─ type='task_progress'
  │     → 更新 agentInvocations[agentId].taskProgress
  │     → UI: 任务进度面板更新
  │
  ├─ type='ppt_studio_status'
  │     → updatePptStudioStatus() → PPT 工作室状态更新
  │
  ├─ type='ppt_studio_slides_update'
  │     → mergePptStudioSession() → PPT 幻灯片更新
  │
  └─ type='rich_block'
        → 追加 rich block 到消息的 extra.rich.blocks
        → UI: 富交互卡片（确认框、检查清单等）
```

### 4.7 授权审批流程

```
智能体请求工具审批
  │
  ├─ Socket: authorization_request 事件
  │     → useAuthorization.registerPending(threadId, requestId)
  │     → notifyToolApprovalRequest() → 桌面通知
  │     → UI: AuthorizationCard 出现在消息流中
  │
  ├─ 用户点击"允许"或"拒绝"
  │     → POST /api/authorization/{requestId}
  │       { status: 'approved' / 'denied', scope, reason }
  │
  └─ Socket: authorization_response 事件
        → useAuthorization 处理响应
        → 清除 pending 状态
        → UI: AuthorizationCard 更新为已审批/已拒绝
```

### 4.8 向用户提问流程

```
智能体向用户提问
  │
  ├─ Socket: ask_user_question_request 事件
  │     → useAskUserQuestion 处理
  │     → UI: AskUserQuestionCard 出现在消息流中
  │
  ├─ 用户选择答案
  │     → POST /api/ask-user-question/{requestId}/answer
  │       { answer: selectedOption }
  │
  └─ Socket: ask_user_question_response 事件
        → useAskUserQuestion 处理响应
        → 清除 pending 状态
        → UI: AskUserQuestionCard 更新为已回答
```

---

## 5. 核心模块详解

### 5.1 chatStore（Zustand 状态管理）

**文件：`stores/chatStore.ts`** — 整个应用最核心的状态管理

#### 状态架构

```
ChatState
  ├── currentThreadId: string          → 当前活跃线程 ID
  ├── messages: ChatMessage[]          → 当前线程消息列表（flat state）
  ├── isLoading: boolean               → 当前线程是否加载中
  ├── hasActiveInvocation: boolean     → 当前线程是否有活跃调用
  ├── activeInvocations: Map           → 当前线程活跃调用映射
  ├── intentMode: 'ideate'|'execute'   → 意图模式
  ├── targetAgents: string[]           → 目标智能体
  ├── agentStatuses: Map               → 智能体状态
  ├── agentInvocations: Map            → 智能体调用信息
  ├── threads: Thread[]                → 所有线程列表
  ├── threadStates: Map<ThreadId, ThreadState>  → 后台线程状态
  ├── queue: QueueEntry[]              → 当前线程队列
  ├── queuePaused: boolean             → 队列是否暂停
  ├── rightPanelMode: string           → 右侧面板模式
  ├── pendingNewThreadSend: object     → 首页暂存的新线程消息
  ├── unreadCount: number              → 未读计数
  └── ... (PPT、大纲预览等)
```

#### 双层状态设计

- **Flat State（顶层）**：`messages`, `isLoading`, `hasActiveInvocation` 等直接存储当前活跃线程的状态，避免深层嵌套访问
- **Map State（threadStates）**：后台线程的状态存储在 `threadStates` Map 中
- **切换机制**：`setCurrentThread` 时，先 `snapshotActive` 保存当前 flat state 到 map，再 `flattenThread` 从 map 恢复目标线程到 flat state

### 5.2 api-client（统一 API 客户端）

**文件：`utils/api-client.ts`**

```
apiFetch(path, options)
  │
  ├─ 1. 解析 API_URL
  │     ├── Cloudflare Tunnel 模式 → OFFICE_CLAW_CLOUD_API_HOST
  │     ├── 本地回环 → http://127.0.0.1:{frontendPort+1}
  │     ├── 显式环境变量 → NEXT_PUBLIC_API_URL / VITE_API_URL
  │     └── 默认推导 → http://{hostname}:{frontendPort+1}
  │
  ├─ 2. 注入请求头
  │     ├── X-Office-Claw-User: getUserId()  → 用户身份标识
  │     └── X-Trace-Id: crypto.randomUUID()  → 链路追踪 ID
  │
  ├─ 3. 设置超时
  │     → 默认 1 小时（匹配后端 CLI_TIMEOUT_MS）
  │     → AbortController 实现
  │
  ├─ 4. 设置 credentials
  │     → 同源: 'same-origin'
  │     → 跨域: 'include'
  │
  └─ 5. 发起 fetch 请求
```

### 5.3 useSocket（WebSocket 管理）

**文件：`hooks/useSocket.ts`**

核心能力：
- **连接管理**：自动连接/重连，transport 降级（websocket → polling）
- **房间管理**：自动加入 `user:{userId}` 和 `thread:{threadId}` 房间，session 持久化
- **事件路由**：根据 `threadId` 将消息路由到活跃线程或后台线程
- **断线对账**：重连后 `reconcileInvocationStateOnReconnect` 与服务端对账
- **后台线程支持**：非活跃线程的消息通过 `handleBackgroundAgentMessage` 处理
- **缺失线程恢复**：收到未知线程的消息时，缓冲并尝试恢复

### 5.4 useChatHistory（聊天历史管理）

**文件：`hooks/useChatHistory.ts`**

核心能力：
- **分页加载**：每页 50 条，向上滚动加载更多
- **消息合并**：`mergeReplaceHydrationMessages` 智能合并本地流式消息与服务端历史
- **滚动管理**：记住滚动位置，线程切换时恢复
- **实时刷新**：`thread-live-refresh` 事件触发增量更新
- **请求取消**：线程切换时取消进行中的请求

---

## 6. 流程对比总结

### 6.1 首页 vs 对话页 对比

| 维度 | 首页（/） | 对话页（/thread/:threadId） |
|------|-----------|---------------------------|
| **路由组件** | `HomePage` | `ThreadPage → ChatContainer` |
| **当前线程** | `default` | URL 中的 `threadId` |
| **Socket 连接** | 有（监听 thread_created） | 有（完整事件处理） |
| **历史加载** | 无（空状态） | 有（`useChatHistory` 分页加载） |
| **消息展示** | `ChatEmptyState`（空状态卡片） | `ChatMessageList`（消息列表） |
| **输入框** | `ChatInput`（带工作区选择） | `ChatInput`（带 @提及、附件、语音） |
| **发送消息** | 先创建线程再跳转 | 直接发送到当前线程 |
| **智能体数据** | 不加载 | `useAgentData` 加载 |
| **授权审批** | 无 | `useAuthorization` |
| **向用户提问** | 无 | `useAskUserQuestion` |
| **消息反馈** | 无 | `useMessageFeedback` |
| **预览面板** | 无 | `PreviewSecondaryPane`（文件/PPT/大纲） |
| **PPT 工作室** | 无 | `PptStudioBackgroundSync` + `ThreadPptStudioSync` |
| **并行状态** | 无 | `ParallelStatusBar` |
| **执行状态栏** | 无 | `ThreadExecutionBar` |

### 6.2 共享的初始化流程

无论访问哪个页面，以下流程都会执行：

```
1. index.html 主题初始化（内联脚本）
2. main.tsx React 初始化
3. RootChrome 全局基础设施
   ├── DevServiceWorkerReset（开发模式 SW 清理）
   ├── ThemeRootSync（主题同步到 DOM）
   └── ToastContainer（全局通知容器）
4. MainChrome → MainShell
   ├── StartupAgreementGate（协议签署检查）
   ├── ThreadSidebar（侧边栏初始化 + 会话列表加载）
   └── RightContentHeader（右侧头部）
5. useSocket（WebSocket 连接建立）
```

### 6.3 完整时序图：首页访问

```
Browser                React               chatStore           API              Socket.IO
  │                     │                    │                  │                  │
  │── GET / ──────────→│                    │                  │                  │
  │                     │── render App ───→│                  │                  │
  │                     │                    │                  │                  │
  │                     │── RootChrome ───→│                  │                  │
  │                     │  ThemeRootSync    │                  │                  │
  │                     │  StartupAgreementGate               │                  │
  │                     │                    │── GET /api/agreement ──→│          │
  │                     │                    │←─ agreement status ───│          │
  │                     │                    │                  │                  │
  │                     │── MainShell ────→│                  │                  │
  │                     │  ThreadSidebar    │                  │                  │
  │                     │                    │── GET /api/threads ───→│          │
  │                     │                    │←─ threads list ───────│          │
  │                     │                    │                  │                  │
  │                     │── HomePage ─────→│                  │                  │
  │                     │  setCurrentThread('default')          │                  │
  │                     │                    │                  │                  │
  │                     │  useSocket        │                  │── connect ─────→│
  │                     │                    │                  │←─ connect ack ──│
  │                     │                    │                  │── join_room ───→│
  │                     │                    │                  │                  │
  │←── 渲染完成 ───────│                    │                  │                  │
```

### 6.4 完整时序图：对话页访问

```
Browser           React            chatStore         API           Socket.IO
  │                │                 │                │               │
  │── GET /thread/123 ──→│          │                │               │
  │                │── ThreadPage ─→│                │               │
  │                │  ChatContainer │                │               │
  │                │                 │                │               │
  │                │  setCurrentThread('123')         │               │
  │                │  → snapshot old, restore new    │               │
  │                │                 │                │               │
  │                │  useAgentData   │                │               │
  │                │                 │── GET /api/agents ──→│         │
  │                │                 │←─ agents ───────────│         │
  │                │                 │                │               │
  │                │  useChatHistory │                │               │
  │                │                 │── GET /api/threads/123/messages?limit=50 ─→│
  │                │                 │←─ messages ───────────────────│         │
  │                │  mergeReplaceHydrationMessages   │               │
  │                │  replaceMessages(merged)         │               │
  │                │                 │                │               │
  │                │  useSocket      │                │── connect ──→│
  │                │                 │                │── join_room ─→│
  │                │                 │                │  'thread:123' │
  │                │                 │                │               │
  │                │  consumePendingNewThreadSend     │               │
  │                │  → 若有暂存消息 → handleSend    │               │
  │                │                 │                │               │
  │←── 渲染完成 ──│                 │                │               │
  │                │                 │                │               │
  │  (用户发送消息)│                 │                │               │
  │                │── handleSend ─→│                │               │
  │                │  addMessage(optimistic)          │               │
  │                │                 │── POST /api/messages ──→│     │
  │                │                 │←─ { userMessageId } ───│     │
  │                │  replaceMessageId(optimistic → server)        │
  │                │                 │                │               │
  │  (智能体响应)  │                 │                │               │
  │                │                 │                │←─ agent_message ──│
  │                │  handleAgentMessage              │               │
  │                │  → thinking/text/tool_use/done   │               │
  │                │  → update chatStore              │               │
  │←── UI 更新 ───│                 │                │               │
```

---

## 附录：关键 API 端点汇总

| 端点 | 方法 | 用途 | 调用位置 |
|------|------|------|---------|
| `/api/threads` | GET | 获取会话列表 | ThreadSidebar |
| `/api/threads` | POST | 创建新会话 | HomePage |
| `/api/threads/:id` | PATCH | 更新会话标题 | useSendMessage |
| `/api/threads/:id/messages` | GET | 获取会话消息历史 | useChatHistory |
| `/api/threads/:id/queue` | GET | 获取队列状态 | useSocket (reconnect) |
| `/api/threads/:id/restore` | POST | 恢复已删除会话 | ThreadSidebar |
| `/api/threads/read/mark-all` | POST | 全部标记已读 | ThreadSidebar |
| `/api/messages` | POST | 发送消息 | useSendMessage |
| `/api/agents` | GET | 获取智能体配置 | useAgentData |
| `/api/agreement` | GET/POST | 获取/提交协议签署 | StartupAgreementGate |
| `/api/apm-tracing-enabled` | POST | 模型改进数据收集偏好 | StartupAgreementGate |
| `/api/authorization/pending` | GET | 获取待审批列表 | ThreadSidebar |
| `/api/authorization/:id` | POST | 提交审批结果 | useAuthorization |
| `/api/projects/cwd` | GET | 获取当前工作目录 | HomePage |
| `/api/projects/pick-directory` | POST | 打开文件夹选择器 | HomePage |
| `/api/governance/health` | GET | 获取治理健康状态 | ThreadSidebar |

本文写于：2026年6月3日

# 实现原理

介绍 RelayClaw 的整体实现原理。

## 对话模块

概览：

- [整体流程](/tech/chat/overview.md)
- [组件树](/tech/chat/component-tree.md)
- [数据流](/tech/chat/data-flow.md)

数据：

- [WebSocket 流](/tech/chat/websocket.md)
- [Zustand 全局内存数据](/tech/chat/zustand.md)
- [Redis 持久化数据](/tech/chat/redis.md)
- [WebSocket 流式消息存储](/tech/chat/ws-message-store-analysis.md)

策略：

- [对话 UI 渲染](/tech/chat/ui-render.md)
- [按任务分组](/tech/chat/task.md)
- [乐观 UI 策略](/tech/chat/optimistic-ui.md)
- [双指针守卫策略](/tech/chat/dual-pointer-guard.md)

其他：

- [应用启动和初始化流程](/tech/chat/initiation.md)
- [九问推送 WebSocket 流式消息流程](/tech/chat/jiuwenclaw-ws-push-analysis.md)

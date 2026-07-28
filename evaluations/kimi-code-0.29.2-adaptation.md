# Kimi Code 0.29.2 适配记录

审查日期：2026-07-28
比较基线：`@moonshot-ai/kimi-code@0.28.0` → `@moonshot-ai/kimi-code@0.29.2`
不可变源码 revision：`8a45f10eddbb35c317047e82e567cdb59a220b4f`

## 结论

0.29.2 延续 `/api/v1` REST 与 WebSocket v1 兼容面，但对 kap-server、v2 agent、transcript、模型目录和前台 Web 生命周期做了较大内部演进。Farside 不整包搬运上游源码，保留现有 REST/WS client 与 UI/IPC 边界，只适配会影响进程管理和 runtime 完整性校验的行为。

## 变化与决策

| 领域 | 上游变化 | Farside 决策 |
| --- | --- | --- |
| Web 生命周期 | `kimi web` 始终前台运行；0.28.1 起移除 `web kill/ps` | 采纳。由 `ServerService` 持有 child，停止用 SIGTERM；无 child 时调用受保护 shutdown。 |
| RPC | kap-server 的内部调试 RPC 面向 `/api/v1/debug`，动态发现 channels | 延后。Farside 依赖公开 `/api/v1` REST 和 `/api/v1/ws`，避免把内部 RPC 绑定到桌面 UI。 |
| v2 agent/profile | 自定义 agent、profile、工具 allow/deny、thinking effort 能力扩展 | 由上游 runtime 提供；Farside 透传已有 session/profile 输入，不新增重复协议层。 |
| 工具披露 | `select_tools` / 动态工具能力进入上游核心 | 采纳上游实现；0.27/0.28 渐进工具补丁不再重放。 |
| prompt 媒体 | 视频附件可直接进入 prompt 并持久化 | 由上游负责媒体解析；Farside 保持附件大小、数量和路径安全边界。 |
| 模型/配置 | catalog、provider、MCP timeout、环境覆盖和 thinking 解析增强 | 采纳 runtime；现有配置 IPC 继续使用公开 REST 兼容字段。 |
| 旧 patch | 工具结果预算、REST harness 控制、渐进工具披露 | 审查确认 0.29.2 已包含等价实现，patch 队列置空，旧文件保留为历史证据。 |

## 验证状态

- 已核对 npm `@moonshot-ai/kimi-code@0.29.2`、Git tag/revision 与官方六平台 manifest。
- 已更新唯一 `current` lock 的版本、manifest、产物 URL 与 SHA-256。
- 已更新前台服务停止逻辑，避免调用 0.29.2 已移除的 `kimi web kill`。
- 待发布门禁：六平台 Farside 自有产物、协议 smoke、harness 配对评测、真实账号回归、Windows/macOS 安装包启动测试。

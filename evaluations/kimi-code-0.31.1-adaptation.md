# Kimi Code 0.31.1 适配记录

审查日期：2026-08-05
比较基线：`@moonshot-ai/kimi-code@0.29.2` → `@moonshot-ai/kimi-code@0.31.1`
候选源码 revision：`6b56c11697771fe596099b38bafae539820309a4`

## 结论

0.31.1 保持 Farside 当前使用的 `/api/v1` REST、`/api/v1/ws` 和服务生命周期兼容。没有发现需要修改 UI、IPC、持久化或 `KimiClientService` 请求结构的破坏性变化。本轮只更新候选基线、审查证据与 harness 默认源码目录；唯一 `current` Runtime 继续锁定 0.29.2。

## 上游变化与决策

| 领域 | 0.30.0 / 0.31.1 变化 | Farside 决策 |
| --- | --- | --- |
| REST | 新增 search、workspace trust、oauth userinfo 和 fs mkdir；既有路径无删除 | 兼容，不新增平行客户端；有明确产品需求时再接入新端点。 |
| OAuth | `/oauth/usage` 从 `label/reset_hint` 改为 `name/window/reset_at` | Farside 当前直接读取托管账户 usage，不消费该 REST 结构，因此无需迁移。 |
| 配置 | 新增可选 `secondary_model` | 保持透传；现有配置读写不会清除未知字段。 |
| Session | undo 的 `query` 不再要求非空；旧 metadata 缺少 archived 时的索引恢复修复 | 向后兼容，采纳 Runtime 修复。 |
| WebSocket | v1 事件通道与握手版本不变；仅内部事件投影实现调整 | 保持现有订阅、断线恢复与 snapshot 补偿。 |
| 服务生命周期 | `kimi web --no-open`、实例注册磁盘字段、meta、shutdown 路径保持兼容 | 继续使用 Farside 现有 child + SIGTERM/shutdown 管理。 |
| Agent / Plugin | custom agent、plugin agent、plugin system prompt、secondary model | 由 Runtime 提供；不在 Farside 创建第二套配置源。 |
| Tool | TaskOutput 改为即时快照；无效工具调用停止无限重试 | 采纳上游语义；Farside 只投影工具事件，不依赖旧阻塞参数。 |
| Auth / Provider | 配额耗尽快速失败；修复启动时模型目录短暂清空 | 采纳上游修复；Farside 现有错误分类继续适用。 |
| 构建 | kap-server 0.2、node-sdk 0.15、agent-core-v2 0.3 | 候选继续通过单一 runtime 二进制接入，不整包复制依赖。 |

## 可复核证据

- npm 包：`@moonshot-ai/kimi-code@0.31.1`
- tag：`@moonshot-ai/kimi-code@0.31.1`
- commit：`6b56c11697771fe596099b38bafae539820309a4`
- darwin-arm64 SHA-256：`8f2403eddc82229d4593e0e9baa2ef9e51390221ebfe82eaa757521f29c454fc`
- OpenAPI 对比：既有路径无删除；仅新增六个公开路径。
- meta 对比：`websocket`、`file_upload`、`fs_query`、`mcp`、`tasks`、`terminal` 均为 `true`。

## 未完成门禁

- harness 配对评测。
- 专用限额账号真实计费链路回归。
- Linux、Windows、macOS 六平台原生 smoke。
- Windows/macOS 安装包启动和真实账号功能回归。

以上门禁完成前不得更新 `runtime.lock.json` 的唯一 `current`，也不得把候选描述为已发布 Runtime。

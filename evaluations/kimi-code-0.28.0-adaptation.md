# Kimi Code 0.28.0 适配审查

- 上游范围：`@moonshot-ai/kimi-code@0.27.0...@moonshot-ai/kimi-code@0.28.0`
- 候选 tag：`@moonshot-ai/kimi-code@0.28.0`
- 候选 commit：`a05228c67122c8233dc87226ce0ca7414780b680`
- 审查日期：2026-07-20
- 状态：源码与桌面集成已适配；唯一 runtime 产物尚未发布

## 核心结论

0.28 的主要兼容断点不是 REST 或 WebSocket 协议，而是本地服务生命周期。官方删除了 `kimi server` 命令树、后台 daemon 和单实例 lock，改为前台 `kimi web` 与共享 home 的多实例注册表。若只更新版本号，Farside 会等待一个永不退出的启动命令，并继续读取已不存在的 lock 文件。

## 变更决策

| 上游变化 | 因果影响 | Farside 决策 |
| --- | --- | --- |
| `kimi server run/kill` → `kimi web --no-open` / `kimi web kill` | 0.28 服务前台常驻，旧 `execFile` 启动会超时 | 0.28+ 改为持有子进程；0.27 保留 daemon 兼容 |
| `<home>/server/lock` → `<home>/server/instances/*.json` | 多实例可自动递增端口，旧端点发现失效 | 读取、校验并排序实例注册文件，仍回退旧 lock |
| `web kill [serverId]` 支持精确停止 | 无参数会停止最早实例，可能误伤用户自己的 Kimi | 记录 Farside 启动的 `serverId` 并精确停止 |
| thinking effort 限定到当前 session | 新 session 不再继承顶层持久值 | Farside 已在 session profile 明确传递，无需协议改动 |
| query store 改为 16 分片 ClusterDb | 多服务共享 home 时减少存储竞争 | 采纳上游实现，不增加 Farside 补丁 |
| filesystem `stat` 跟随 symlink，并新增 `lstat` | 修复与 Node 语义差异 | 采纳上游实现，现有文件工具接口不变 |
| turn telemetry 增加 `thinking_effort` | wire/REST 业务协议不变，仅遥测字段扩展 | 接受；Farside 不依赖该遥测字段 |

## Harness 补丁审查

三项 0.27 补丁在 0.28 tag 上均可无冲突应用，但仍逐项复核而非直接复制 release：

1. 工具结果 2,048 estimated-token 预算：上游未提供等价机制，保留；补充 Windows 路径断言兼容。
2. REST `system_prompt` / `tools` 控制：0.28 仍未完整透传，保留。
3. K3 渐进工具披露：上游未提供同等默认工具收敛，保留。

新补丁队列位于 `patches/kimi-code/0.28.0/`，只接受精确 commit `a05228c67122c8233dc87226ce0ca7414780b680`。

## 已完成验证

- 三个补丁在全新 0.28 tag 工作树上可干净应用。
- `agent-core`、`agent-core-v2`、`kap-server` 类型检查通过。
- 补丁相关 5 个 Vitest 文件共 121 个测试通过。
- Farside 根项目测试和类型检查通过。
- REST API 版本仍为 1，WebSocket protocol version 仍为 2。

## 发布前剩余门禁

- 使用 0.28 patched runtime 完成 REST/WebSocket 原生二进制 smoke。
- 重新运行 K3 prompt × 工具面 2×2 配对评测及更复杂任务集。
- 完成真实 OAuth/API Key、历史会话、附件、审批、终端、MCP、Goal、Plan、Web 与子代理回归。
- 构建并发布 Windows、macOS、Linux 的 x64/arm64 六个平台 Farside runtime 产物与 SHA-256。
- 上述完成后，才把唯一 `runtime.lock.json` 从 0.27.0 原位更新到 0.28.0；不得填入官方 release 二进制地址作为临时替代。

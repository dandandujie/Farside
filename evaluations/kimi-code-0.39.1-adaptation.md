# Kimi Code 0.39.1 适配记录

审查日期：2026-09-05
比较基线：`@moonshot-ai/kimi-code@0.31.1` → `@moonshot-ai/kimi-code@0.39.1`
候选源码 revision：`5efca0c3116743855c28426000073bfe34a4862f`
上游范围：299 个提交（0.32.0 … 0.39.1），约 3,300 个文件变更

## 结论

0.39.1 对 Farside 消费的 `/api/v1` REST、`/api/v1/ws`（协议版本仍为 2）和服务生命周期全部保持增量兼容；`WS_PROTOCOL_VERSION`、`server.token`、`server/instances/*.json` 注册表、`kimi web --no-open` 前台生命周期与六项 meta capability 均未变化。持久化布局（`sessions/**/wire.jsonl`、`session_index.jsonl`、`state.json`）与 wire record 类型不变，Farside 的本地会话发现与个人资料统计无需调整。

需要适配的只有两处，都是替换 Farside 对 **从未在 0.31 上开放过的 `/api/v2` 服务 RPC** 的调用：

1. `POST /api/v2/pluginService/installPlugin|setPluginEnabled|removePlugin` → 官方 REST `POST /api/v1/plugins`（安装）与 `POST /api/v1/plugins/{id}:enable|:disable|:remove`。
2. `POST /api/v2/configService/reload` → 删除。0.39 的 ConfigService 通过 chokidar 文件监听原生热加载 config.toml，外部写入自动生效。

经实测（对随包 0.31.1 二进制发起真实请求），这两类 `/api/v2` 调用在当前基线上返回 404——即 Farside 0.2.3 的插件管理一直是坏的、配置热加载一直静默失败。0.39.1 恰好为前者提供了官方 REST 面，为后者提供了原生文件监听，本次适配把两个潜在缺陷一并关闭。

## 上游变化与决策

| 领域 | 0.32–0.39.1 变化 | Farside 决策 |
| --- | --- | --- |
| REST v1 | 既有路径无删除；新增 capabilities、plugins、runtime、sessionMedia、fs::suggest、mcp auth/test/inspect、oauth region、session title/generate 等 | 兼容；不新增平行客户端。 |
| REST schema | config 增加 `subagent`、`.passthrough()`；prompt 增加 `prompt_id`、`skills`；meta 增加 `experimental_flags`、`web_title`、`features`；oauth login 增加可选 `provider`/`region`；session 字段放宽为可选并增加 `archived_at` | 全部增量/放宽，向后兼容，采纳。 |
| Plugin REST | 新增 `GET/POST /api/v1/plugins`、`POST /api/v1/plugins/{tail}`（`:enable`/`:disable`/`:remove`）与 marketplace 查询 | **采纳迁移**：`KimiClientService.managePlugin` 改走官方 REST；Farside 读取的 `plugins/installed.json` version 1 落盘格式不变。 |
| 配置热加载 | ConfigService 经 `IAtomicTomlDocumentStore` + chokidar 监听 config.toml 并自动 reload | **采纳删除**：移除 `reloadRuntimeConfiguration` 及其在 `ConfigurationSave` IPC 中的调用，上游原生语义接管。 |
| WebSocket | `WS_PROTOCOL_VERSION` 仍为 2；v1 握手仅新增可选 `runtime_id`，源码差异主要是注释清理 | 保持现有订阅、断线恢复与 snapshot 补偿。 |
| 服务生命周期 | `kimi web --no-open/--port` 选项保留；`server.token`、`server/instances` 注册字段（server_id/pid/host/port/started_at）不变；`/api/v1/healthz` 无鉴权探针、`/api/v1/shutdown` loopback 可用 | 继续 child + SIGTERM / shutdown endpoint 管理，无需桌面适配。 |
| Auth / OAuth | 设备码流响应结构不变（`status`、`verification_uri(_complete)`、`user_code`）；新增可选 region；managed provider 仍为 `managed:kimi-code`，别名前缀仍为 `kimi-code/` | 兼容；`activateManagedProvider` 的 `kimi-code/k3` 优先 + 首个托管模型兜底策略继续适用。 |
| 会话/持久化 | wire record 类型（turn.prompt / llm.request / usage.record / context.append_loop_event）保留；`session_index.jsonl` 追加字段不变 | 兼容；本地发现与 Profile 统计不动。 |
| 引擎 / 工具 | v2 sessions/mcp 查询面、自动标题、媒体解析、 staged swap 自更新、任务面板等 | 由 Runtime 提供，不在 Farside 重复实现；后续有产品需求再评估接入。 |
| 构建 | pnpm workspace 重组、`check-no-comments`（源码去注释，不影响 wire 兼容） | 继续以单一官方二进制接入，不整包复制。 |

## 补丁队列

`scripts/farside-runtime-patch.mjs` 队列为空；`patches/kimi-code/` 下的 0.27/0.28 目录仅为历史审计归档。本轮无需重放或新写任何源码补丁。

## 可复核证据

- npm 包：`@moonshot-ai/kimi-code@0.39.1`
- tag：`@moonshot-ai/kimi-code@0.39.1`（annotated，指向 commit `5efca0c3116743855c28426000073bfe34a4862f`）
- 官方 manifest：`https://code.kimi.com/kimi-code/binaries/0.39.1/manifest.json`，六平台 SHA-256 已固定进 `runtime.lock.json`
- 0.31.1 实测：`POST /api/v2/configService/reload` → 404、`GET /api/v2/pluginService/*` → 404、`POST /api/v1/debug/configService/reload`（未开 `--debug-endpoints`）→ 404
- meta 对比：`websocket`、`file_upload`、`fs_query`、`mcp`、`tasks`、`terminal` 六项 capability 在 0.39.1 仍全部为 `true`

## 验证结果

- `npm run runtime:prepare`（`FARSIDE_DOWNLOAD_KIMI_RUNTIME=1`）按 lock 下载 0.39.1 产物并校验 SHA-256。
- `npm run runtime:smoke`：0.39.1 二进制 meta 版本、六项能力与 WS 协议握手通过。
- `npm test`、`npm run typecheck`、`npm run build` 通过。
- 受影响路径定向验证：插件安装/启停/移除（新 REST 面）、config.toml 保存（原生热加载）、未配置 Provider 启动（本轮 UI 改造）、OAuth 登录态轮询。

本项目的常规上游升级不要求 harness 配对评测或真实计费链路回归；如某次差异直接涉及模型质量或计费语义，再按影响范围增加专项验证。

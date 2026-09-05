# Farside Runtime 维护指南

Farside 只有一套产品版本和一套 Runtime。Kimi Code 是上游核心与代码基础；Farside 在其上进行产品适配、稳定性修复和 harness 优化，但不再同时维护“官方 CLI 通道”和“Farside CLI 通道”。

## 唯一 Runtime

`runtime.lock.json` 是唯一版本来源，schema 只允许一个启用的 `current` 条目。它必须固定：

- Farside Runtime 版本与对应 Kimi Code 上游基线；
- API 与 WebSocket 协议版本；
- 源码仓库、不可变 revision、许可证和产物 manifest；
- Windows、macOS、Linux 的 x64/arm64 六个平台产物与 SHA-256。

不存在运行时通道切换、缺失产物回退或“官方/自定义”双线选择。`kind` 只记录当前产物的真实来源，不代表可切换产品线。

当前 `current` 已锁定完成适配与 smoke 验证的 0.39.1 官方基线制品。它不会被后续官方 release 直接替换；下一次版本更新必须完成源码适配和自动化验证，并原位更新唯一 `current`。

```powershell
# 使用本机同版本源码构建产物准备开发资源
npm run runtime:prepare

# 正式构建只接受锁定产物
$env:FARSIDE_DOWNLOAD_KIMI_RUNTIME = '1'
npm run runtime:prepare
npm run runtime:smoke
```

`FARSIDE_KIMI_BINARY` 仅用于开发者显式覆盖，不参与正式发布。正式安装包缺失或不匹配时直接失败，不回退 PATH。

## 上游更新不是整包同步

`.github/workflows/runtime-sync.yml` 每周只检查 Kimi Code 是否有新稳定版本。它不会：

- 下载新官方二进制并替换 Farside；
- 修改 `runtime.lock.json`；
- 自动提交代码、创建升级分支或 Pull Request；
- 假设新版本可以无差异兼容。

发现新版本时，工作流只创建一次适配审查 Issue，并给出上游源码比较入口与强制检查清单。本地等价命令是：

```powershell
npm run runtime:upstream:check
```

每次上游升级必须先回答真正的核心问题：**哪些行为和协议发生了变化，这些变化应如何融入 Farside，而不破坏现有优化、界面和数据兼容性？**

## 适配流程

1. 固定当前上游基线与候选新版本的 tag/commit，阅读 release notes 和完整源码 diff。
2. 按功能域记录变化：REST、WebSocket、wire、session、profile、tool、auth、配置、模型能力、构建与平台支持。
3. 对每项变化作出明确决策：采纳、改写、延后或拒绝，并说明因果和兼容性影响。
4. 对照 `patches/kimi-code/<version>/`：上游已解决的补丁删除；仍需要的补丁重放或重写；禁止无审查地把旧补丁堆到新基线上。
5. 以小步适配提交更新 Runtime、Farside UI/IPC、持久化和测试，不整包覆盖工作树。
6. 完成类型检查、定向测试、协议 smoke、正式产物校验和支持平台构建；不把 harness 配对评测或真实计费链路回归设为发布门禁。
7. 发布唯一 Runtime 的六平台不可变产物与 SHA-256，然后原位更新 `runtime.lock.json` 的 `current`。
8. 最后发布与该 Runtime 严格绑定的 Farside 版本。

维护源码可以使用从 `MoonshotAI/kimi-code` 建立的 Fork，但它只是 Farside 唯一 Runtime 的构建源，不是第二个面向用户的 CLI 产品。推荐分支：

- `main`：当前可发布的 Farside Runtime；
- `upstream/<version>`：只读记录候选 Kimi Code 基线；
- `adapt/kimi-<version>`：完成差异审查和适配的临时分支；
- `v<upstream>-farside.<n>`：唯一 Runtime 的不可变发布 tag。

## 0.28.0 候选基线（历史记录）

已完成 Kimi Code 0.27.0 → 0.28.0 的源码差异审查。候选源码固定为 tag `@moonshot-ai/kimi-code@0.28.0`、commit `a05228c67122c8233dc87226ce0ca7414780b680`；详细决策见 `evaluations/kimi-code-0.28.0-adaptation.md`。

`patches/kimi-code/0.28.0/` 按顺序包含：

- `0001-tool-result-token-budget.patch`：v1/v2 工具结果使用 2,048 estimated-token 门槛；完整内容先归档，只给上下文 metadata 与可分页路径。
- `0002-rest-harness-controls.patch`：修复 v2 REST 创建与更新会话时忽略 `system_prompt`、`tools` 和其余 `agent_config` 的问题。
- `0003-progressive-builtin-tools.patch`：K3 默认只暴露六个核心工具和 `select_tools`，Goal、Plan、Web、Agent、Cron 等按名称、分组或明确意图加载，同时保留会话恢复能力。

0.28 移除了 `kimi server` 命令树和单实例 `<home>/server/lock`。Farside 已兼容新的 `kimi web --no-open` 前台生命周期及 `<home>/server/instances/*.json` 多实例发现，并保留对当前 0.27 runtime 的兼容；停止服务时只精确停止 Farside 自己启动的实例。

在正确的干净上游源码中校验或应用：

```powershell
npm run runtime:patch:check -- D:\path\to\kimi-code
npm run runtime:patch:apply -- D:\path\to\kimi-code
```

该节保留 0.28.0 的审查证据；0.29.2 已吸收其中三项 harness 变化，旧补丁不再重放。

## 0.29.2 适配基线

已完成 Kimi Code 0.28.0 → 0.29.2 的源码差异审查。候选源码固定为 tag `@moonshot-ai/kimi-code@0.29.2`、commit `8a45f10eddbb35c317047e82e567cdb59a220b4f`；详细决策见 `evaluations/kimi-code-0.29.2-adaptation.md`。

关键决策：

- 采纳 0.28.1+ 前台 `kimi web --no-open` 生命周期；0.29.2 已移除 `kimi web kill/ps`，Farside 改为持有子进程并通过 SIGTERM / `/api/v1/shutdown` 回收，保留 0.27 `server kill` 仅用于显式旧 runtime。
- 采纳 0.29 的 v2 agent/profile、动态工具披露、视频 prompt、模型能力与 REST 扩展；Farside 继续使用稳定的 `/api/v1` REST 与 `/api/v1/ws` 兼容面，不切换到内部 `/api/v1/debug` RPC。
- 0.27/0.28 的三项 harness 补丁已在 0.29.2 上游实现中出现，`scripts/farside-runtime-patch.mjs` 的 0.29.2 队列为空；历史 patch 文件只作审计归档。
- `runtime.lock.json` 的唯一 `current` 已更新为 0.29.2，并固定 manifest、六平台 URL 与 SHA-256。发布仍必须通过本指南的完整发布门禁。

本地 K3 prompt × 工具面 2×2 pilot 的 8 个单元均通过；精简工具面的边际平均总输入下降 59.4%，精简 prompt 没有稳定独立收益。渐进披露真实 smoke 首轮严格为 7 个工具，任务通过。详细数据见 `evaluations/k3-harness-factorial-pilot.md`。这些结果只支持当前工程方向，不能替代复杂任务质量评测。

## 0.31.1 适配基线

已完成 Kimi Code 0.29.2 → 0.31.1 的源码与公开协议差异审查。候选源码固定为 tag `@moonshot-ai/kimi-code@0.31.1`、commit `6b56c11697771fe596099b38bafae539820309a4`；详细决策见 `evaluations/kimi-code-0.31.1-adaptation.md`。

审查结论：

- `/api/v1` 没有删除既有路径，`/api/v1/ws`、协议版本与 Farside 要求的六项 capability 保持兼容。
- 公开契约变化集中在 OAuth usage 字段、可选 `secondary_model` 配置和 undo 查询校验放宽；Farside 不消费 OAuth usage REST，另外两项向后兼容。
- 前台 `kimi web --no-open`、实例注册文件、`/api/v1/meta` 与 `/api/v1/shutdown` 生命周期不需要新的桌面适配。
- 上游新增自定义 agent、plugin system prompt、secondary model、非阻塞 TaskOutput、配额快速失败等能力，由 Runtime 提供，不在 Farside 重复实现。
- 官方六平台 manifest、URL 与 SHA-256 已锁定；darwin-arm64 二进制通过 meta、OpenAPI 路径和启动行为对比，`current` 已原位更新为 0.31.1。

## 0.39.1 适配基线

已完成 Kimi Code 0.31.1 → 0.39.1 的源码与公开协议差异审查。候选源码固定为 tag `@moonshot-ai/kimi-code@0.39.1`、commit `5efca0c3116743855c28426000073bfe34a4862f`；详细决策见 `evaluations/kimi-code-0.39.1-adaptation.md`。

审查结论：

- `/api/v1` 无路径删除，schema 全部增量兼容；`/api/v1/ws` 协议版本仍为 2，六项 capability 不变；`kimi web --no-open` 生命周期、实例注册文件与持久化布局不变。
- 两处适配均为替换 0.31 上从未开放（404）的 `/api/v2` 服务 RPC：插件管理迁移到官方 REST `POST /api/v1/plugins` 与 `/api/v1/plugins/{id}:enable|:disable|:remove`；`configService/reload` RPC 删除，由 0.39 的 ConfigService 文件监听原生热加载接管。
- 上游新增 plugin marketplace、capabilities、session media、v2 sessions/mcp 查询面、自动标题等能力由 Runtime 提供，Farside 不重复实现。
- 官方六平台 manifest、URL 与 SHA-256 已锁定；`current` 已原位更新为 0.39.1。

## 发布门禁

每次唯一 Runtime 更新至少完成：

- Runtime 上游包类型检查和相关定向测试；
- Farside `npm test`、`npm run typecheck`、`npm run build`；
- `/api/v1` REST、`/api/v1/ws`、wire 和持久化兼容性审查；
- 官方六平台 manifest、下载地址与 SHA-256 校验，以及 Farside 支持平台的安装包构建；
- 对受上游变化影响的未登录、OAuth、API Key、会话、附件、审批、Goal、Plan、Web、子代理和断线恢复路径进行定向自动化验证。

全面适配的判断以源码/API 差异、受影响产品路径和可复核的自动化证据为准；harness 配对评测与真实计费链路回归可按专项需要执行，但不是常规升级门禁。

# Farside Runtime 维护指南

Farside 同时支持“及时跟随 Kimi Code 官方版本”和“保留 Farside 自有优化”。核心原则是把两条版本线显式分开，用同一份可审计锁文件约束产物，而不是直接修改桌面端构建脚本里的版本常量。

## 通道与锁文件

根目录的 `runtime.lock.json` 是唯一运行时版本来源：

- `official`：MoonshotAI 官方 Kimi Code 单文件产物；当前默认发布通道。
- `farside`：基于官方源码维护的自定义产物；在六个平台产物、来源提交与校验值齐全前保持禁用。

每个已启用通道必须固定版本、上游基线、API 与 WebSocket 协议版本、源码 revision、manifest URL，以及 Windows、macOS、Linux 的 x64/arm64 六个平台下载地址和 SHA-256。构建时通过 `FARSIDE_RUNTIME_CHANNEL` 选择通道；未指定时使用 `defaultChannel`。

```powershell
# 使用本机同版本 CLI 准备开发资源
npm run runtime:prepare

# 忽略本机 PATH，只下载并校验锁文件中的官方产物
$env:FARSIDE_DOWNLOAD_KIMI_RUNTIME = '1'
$env:FARSIDE_RUNTIME_CHANNEL = 'official'
npm run runtime:prepare
npm run runtime:smoke
```

`FARSIDE_KIMI_BINARY` 是开发者显式覆盖入口，不参与发布 CI。发布构建必须开启 `FARSIDE_DOWNLOAD_KIMI_RUNTIME=1`，这样构建机上碰巧安装的其他版本不会污染安装包。本地复制的 CLI 只有在 SHA-256 也与锁定产物完全一致时才能进入正式安装包；开发模式仍允许同版本的本地自编译产物。

## 跟随官方更新

`.github/workflows/runtime-sync.yml` 每周执行一次，也可手动触发。它会：

1. 从 npm 官方 registry 读取 `@moonshot-ai/kimi-code` 的稳定版 `latest`。
2. 下载 `code.kimi.com` 上对应版本的 manifest，严格核对版本、tag、六平台文件名与 SHA-256。
3. 只更新 `official` 通道并运行测试、类型检查和构建。
4. 创建或更新升级 PR，等待人工审查；不会直接合并或发布。

仓库需在 GitHub 的 Actions 设置中允许工作流创建 Pull Request；若组织策略禁止，工作流仍会保留已验证的升级分支，但 PR 需要维护者手动创建。

本地可执行：

```powershell
npm run runtime:check  # 有新版本时退出码为 2
npm run runtime:sync   # 更新 official 锁文件
```

同一官方版本的远端 manifest 如果与已锁定内容不同，同步会直接失败，要求人工调查，不会静默接受校验值变化。

## 自有优化的落点

按侵入程度从低到高选择扩展位置：

1. Skills、Plugins、MCP：优先承载提示词、工具和外部集成，不产生 Runtime 分叉。
2. Farside 桌面端：界面、会话展示、文件预览、IPC 和本地编排留在本仓库。
3. `farside-runtime` Fork：只有必须修改 Agent Core、Server 协议或 CLI 原生行为时才进入 Runtime Fork。

自定义 Runtime 仓库应从 `MoonshotAI/kimi-code` Fork，添加 `upstream` remote，并采用以下最小分支约定：

- `main`：跟踪官方稳定基线，不放 Farside 补丁。
- `farside/main`：可发布补丁队列，定期 rebase 到 `upstream/main` 或明确的官方版本 tag。
- `v<upstream>-farside.<n>`：不可变发布 tag，例如 `v0.27.0-farside.1`。

补丁应按独立目的拆分，避免格式化或无关重构，以降低后续 rebase 成本。上游已经支持的能力应及时从 Fork 删除并回归官方实现。

自定义仓库使用 Kimi Code 自带的原生构建链：

```powershell
npm ci
npm run build:native:release
npm run package:native
npm run produce:native:manifest
npm run test:native:smoke
```

CI 必须在对应操作系统和架构上构建，不交叉伪造平台产物；发布页保留 MIT 许可证、上游版权、源码 tag/commit、构建日志和六平台 SHA-256。

## 启用自定义通道

只有自定义仓库完成真实发布后，才能填写 `runtime.lock.json` 的 `farside` 通道：

1. 将 `revision` 固定到不可变 tag 或 commit，填写 HTTPS manifest URL。
2. 填齐六平台 `filename`、`url` 与小写 SHA-256。
3. 将 `enabled` 改为 `true`，运行 `npm test`。
4. 将发布工作流的 `FARSIDE_RUNTIME_CHANNEL` 从 `official` 改为 `farside`。
5. 完成下述协议和真实账号回归后，再发布 Farside。

不完整的自定义通道会被锁文件校验器拒绝，不能靠缺失平台时回退官方二进制。这样可避免同一个 Farside 版本在不同系统上实际运行不同逻辑。

## 兼容契约与发布门禁

随包 Runtime 启动前会用编译进主进程的 `runtime.lock.json` 交叉校验相邻 `manifest.json`、平台、API 与 WebSocket 协议版本和二进制 SHA-256。正式安装包缺失或不匹配时直接失败，不回退系统 PATH。发布 smoke test 会完成真实 `server_hello/client_hello/ack` 往返；Server 就绪后还会读取 `GET /api/v1/meta`，核对自报版本并要求以下能力均为 `true`：

- `websocket`
- `file_upload`
- `fs_query`
- `mcp`
- `tasks`
- `terminal`

每次官方升级或自定义 Runtime 发布至少完成：

- `npm test`、`npm run typecheck`、`npm run build`。
- 六平台原生 smoke test，Windows/macOS 安装包启动测试。
- `/api/v1` REST 与 `/api/v1/ws` 的协议差异审查。
- 未登录启动、OAuth 登录、API Key、已有会话、新会话、附件、审批、结构化提问、Goal、断线重连。
- 计费与真实账号操作仅使用专用测试账号和限额环境，不在普通 CI 中执行破坏性测试。

官方通道与自定义通道各自升级、各自回归。官方发布可随时作为审查基线，但已发布的自定义版本不得在运行时静默切换来源。

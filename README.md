# Farside（月背）

面向 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的桌面 Agent 客户端，基于 Electron、React 与 TypeScript 构建。

[![Release](https://github.com/dandandujie/Farside/actions/workflows/release.yml/badge.svg)](https://github.com/dandandujie/Farside/actions/workflows/release.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-white.svg)](LICENSE)

Farside 不把编程任务表现成普通聊天：月相表示 Agent 状态，会话是一条轨道时间线，思考是深空信号，工具是仪器读数，子代理是卫星。

![Farside 主工作区](.github/assets/farside-overview.png)

## 界面预览

### 对话轨迹与紧凑工具详情

![对话轨迹与工具详情](.github/assets/farside-trajectory.png)

### 内置文件预览舱

![Markdown 与代码预览](.github/assets/farside-preview.png)

### 中英文与明暗主题

![明亮模式设置页](.github/assets/farside-light-settings.png)

## 特性

- **月相状态语言**：朔=空闲、上弦=思考、盈凸=执行、满月=等待批准、残月=收尾。
- **轨道时间线**：Transmission（思考）/ Instrument（工具）/ Satellite（子代理）/ Ground（用户指令）。
- **项目与会话管理**：基于 Kimi Workspace/Session，支持创建项目、资源管理器打开、重命名、置顶、归档、移除，以及会话置顶、归档、分叉与导出。
- **多模态与文件上下文**：图片、视频、工作区搜索和 `@文件` 引用。
- **结构化交互**：工具审批、单选/多选提问、Goal 暂停/恢复/取消，以及 Agent Swarm 事件展示。
- **命令面板 ⌘K**：斜杠命令与 Kimi Code CLI 对齐，支持动作、命令和会话搜索。
- **真实终端**：xterm.js；node-pty 缺失时自动降级到 shell 管道。
- **工程上下文**：实时文件树、文件内容、Git 状态与 diff、MCP 服务列表。
- **内置预览舱**：Markdown、HTML、SVG、图片与纯文本可在右侧栏直接预览；HTML 以禁用脚本的沙箱运行，图片支持缩放。
- **低噪声轨道**：连续工具活动默认聚合成一行；请求完成后只折叠中间处理过程，问题与最终答复保持可读。
- **真实消息边界**：`system-reminder`、运行时通知与能力上下文归入折叠的内部事件，不再伪装成用户请求气泡。
- **可调工作区**：会话栏、Mission Panel 与文件树均可鼠标拖动调整比例，宽度自动记忆。
- **多种账户接入**：Kimi OAuth、Moonshot 官方 API，以及 OpenAI 格式的第三方 Kimi 服务。
- **会员用量**：OAuth 账户显示当前套餐、5 小时窗口、周周期、Extra Usage 与官方升级入口。
- **账户与扩展中心**：左下角账户卡提供登录、退出和额度入口；设置页可管理 MCP、Skills、Plugins、环境文件与全局 AGENTS.md。
- **中英与明暗主题**：默认中文和暗黑模式，可即时切换英文或明亮模式，偏好保存在本机。
- **随包 Agent Runtime**：Windows 安装包内置官方 Kimi Code 单文件 runtime，终端用户无需单独安装 CLI。
- **安全边界**：Kimi server 仅监听 loopback，Bearer token 只保存在 Electron 主进程。

## 开发

前置条件：Node.js 22 或更高版本，以及通过[官方脚本](https://github.com/MoonshotAI/kimi-code#install)安装的 Kimi Code。

```powershell
npm ci
npm run dev                 # 本地开发模式
npm run typecheck           # 主进程与渲染进程类型检查
npm run build               # 编译 Electron 应用
npm run runtime:prepare     # 校验并复制官方 Kimi Code runtime
npm run dist                # 为当前操作系统生成安装包
```

发布构建机需先通过 Kimi 官方安装器准备单文件 runtime，或用 `FARSIDE_KIMI_BINARY` 指定它；`npm run dist` 会记录版本与 SHA-256 并随安装包分发。终端用户安装 Farside 后无需另装 Kimi Code。Farside 优先启动随包 `kimi server`，仅在开发资源缺失时回退系统 PATH。

## 自动发布

推送任意新 tag 后，[Release workflow](.github/workflows/release.yml) 会在 GitHub 托管 Runner 中安装官方 Kimi Code runtime，分别生成 Windows NSIS、macOS DMG 与 Linux AppImage，并把三端安装包发布到对应的 GitHub Release。

```powershell
git tag v0.1.0
git push origin v0.1.0
```

工作流不会使用或上传开发机上的账户配置、API Key、OAuth Token、会话数据与本地 runtime。

## 当前状态

核心链路已经接通：随包 Kimi server 生命周期和鉴权、Workspace/Session 操作、WebSocket 流式事件、发送与附件、内部消息归一化、审批和提问、Goal、文件/Git/MCP、三类账户接入、OAuth 会员用量、中英/明暗界面、图片与文档侧边预览，以及 Windows NSIS 打包均已实现并完成本机验证。

仍有明确边界：macOS DMG 尚未签名和实测；会员周期用量仅适用于 Kimi OAuth，API Key Provider 不提供会员额度；`node-pty` 是可选增强，默认使用 shell 管道终端。

## 结构

```text
src/main/       Electron 主进程（窗口、IPC、Kimi REST/WS 客户端、server、PTY）
src/preload/    contextBridge（window.api，类型契约位于 src/shared/ipc.ts）
src/shared/     跨进程类型与 IPC 契约
src/renderer/   React 界面、状态仓库、设计系统与功能组件
scripts/        runtime 准备、图标与视觉回归脚本
```

## 隐私与安全

- API Key、OAuth Token 与 Kimi server Bearer Token 只由 Electron 主进程处理，不回传渲染页。
- 仓库忽略 `.env*`、证书与私钥、`config.toml`、`mcp.json`、`AGENTS.md`、会话数据、本地 runtime、日志和原始视觉回归输出。
- 发布工作流始终从干净源码重新安装依赖与官方 runtime，不读取开发机环境。

## 致谢

- [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) by Moonshot AI（月之暗面）
- 字体：Space Grotesk · JetBrains Mono

## 许可证

Farside 以 [MIT License](LICENSE) 开源；随包 Kimi Code runtime 保留其原始 MIT 许可证与来源说明。

## 友情链接

- [LINUX DO](https://linux.do)

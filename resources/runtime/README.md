# Kimi Code Runtime

Farside 的发布安装包会在此目录下生成平台相关的 Kimi Code 单文件 runtime：

```powershell
npm run runtime:prepare
```

版本、来源、API 契约和六平台产物统一记录在根目录 `runtime.lock.json`。本地开发优先读取 `FARSIDE_KIMI_BINARY`，否则读取 Kimi 官方安装器的默认路径，并要求 `--version` 与所选通道一致。正式打包设置 `FARSIDE_DOWNLOAD_KIMI_RUNTIME=1` 后会忽略本机 PATH，只下载锁文件中的产物并校验 SHA-256，不执行远程安装脚本；未登记的本地自编译产物只允许开发模式使用。

`FARSIDE_RUNTIME_CHANNEL` 可选择已启用的 `official` 或 `farside` 通道；不完整或禁用的通道会直接失败。可执行文件和生成的 manifest 是本机构建产物，不提交到 Git；MIT 许可证保留在本目录并随安装包分发。完整维护流程见根目录 `RUNTIME.md`。

# Kimi Code Runtime

Farside 的发布安装包会在此目录下生成平台相关的官方 Kimi Code 单文件 runtime：

```powershell
npm run runtime:prepare
```

构建脚本优先读取 `FARSIDE_KIMI_BINARY`，否则读取 Kimi 官方安装器的默认路径；它会执行 `--version`、计算 SHA-256，并生成 `manifest.json`。CI 设置 `FARSIDE_DOWNLOAD_KIMI_RUNTIME=1` 后，只会下载脚本内固定版本的官方二进制，并与仓库中固定的各平台 SHA-256 比对，不执行远程安装脚本。

升级随包 runtime 时，必须同时更新 `scripts/prepare-kimi-runtime.mjs` 中的版本、文件名和全部平台校验值，并从 `https://code.kimi.com/kimi-code/binaries/<version>/manifest.json` 复核。可执行文件和 manifest 是本机构建产物，不提交到 Git；MIT 许可证保留在本目录并随安装包分发。

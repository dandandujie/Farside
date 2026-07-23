# Farside 项目维护约束

## Runtime 单版本原则

- Farside 只有一套产品版本和一个 `current` Runtime，不维护“官方 CLI”与“Farside CLI”两条平行产品线。
- Kimi Code 是 Farside Runtime 的上游核心和代码基础，不是可以整包覆盖 Farside 的二进制依赖。
- 发现 Kimi Code 新版本时，禁止直接拉取新官方 release、自动重写 `runtime.lock.json`、切换下载地址或完整搬运 CLI。
- 升级前必须审查上游源码提交、release notes、协议、配置、工具、会话、认证与构建变化，并形成可复核的适配记录。
- 只把确认需要的上游变化以小步适配提交合入 Farside；同步调整本地补丁、测试、UI/IPC 和持久化兼容层。
- 上游已经原生解决的 Farside 补丁应删除或缩小，不能与上游实现重复叠加。
- 只有适配测试、harness 配对评测、协议 smoke、真实账号回归和六平台产物全部通过后，才可原位更新唯一 `current` Runtime。

具体流程和门禁见 `RUNTIME.md`。

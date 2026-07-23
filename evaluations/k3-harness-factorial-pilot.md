# K3 Harness Prompt × Tool Surface 2×2 Pilot（2026-07-20）

## 结论

本轮在 patched Kimi Code 0.27.0、K3、max thinking 下完成 2 道代码任务 × 4 个条件，
共 8 个独立会话，自动测试 8/8 通过。

当前最强、且跨两题一致的信号来自**精简工具面**：边际平均总输入从 191,146 降至
77,539，下降 **59.4%**。单独精简 prompt 的边际平均几乎为零，但这是两个相反的简单效应
抵消后的结果：在原始工具面下总输入增加 8.9%，在精简工具面下下降 19.1%。因此 prompt
收益与工具面存在明显交互，不能脱离工具面单独下结论。

这只是链路与方向性 pilot。两题都很小且四组全部通过，无法估计真实任务成功率，也不能用来
替代 Terminal-Bench 2.1 的配对评测。

## 固定条件

- Runtime：Kimi Code 0.27.0，基线提交 `5cc194956f6f9752d172aa4994385d2d2e7a066f`，
  应用 Farside `0001` / `0002` 补丁。
- 模型：`kimi-code/k3`，thinking `max`，permission `yolo`。
- 原始 prompt：Kimi 默认主 Agent prompt，不覆盖。
- 精简 prompt：`experiments/harness-factorial/lean-system-prompt.md`。
- 原始工具面：默认 27 个 profile 模式；本次没有 MCP，provider 实际可见 26 个工具。
- 精简工具面：`Read / Write / Edit / Grep / Glob / Bash`，provider 实际可见 6 个工具。
- 每个单元使用全新会话和独立工作区；任务顺序轮换；结果由 `node --test` 自动验收。

## 汇总结果

| 条件 | 通过 | 总输入 | 未缓存输入 | 缓存读取 | 输出 | 请求 | 工具调用 | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 原始 prompt + 原始工具 | 2/2 | 182,968 | 9,144 | 173,824 | 1,454 | 8 | 10 | 102.6s |
| 精简 prompt + 原始工具 | 2/2 | 199,324 | 6,044 | 193,280 | 2,165 | 11 | 12 | 176.9s |
| 原始 prompt + 精简工具 | 2/2 | 85,720 | 20,952 | 64,768 | 1,340 | 8 | 10 | 100.5s |
| 精简 prompt + 精简工具 | 2/2 | 69,358 | 12,014 | 57,344 | 1,436 | 12 | 12 | 94.5s |

“总输入”是 `inputOther + inputCacheRead + inputCacheCreation`。本轮缓存创建均为 0；不同 token
类别的实际价格可能不同，因此总输入只代表上下文流量，不能直接等同于账单成本。

## 每题配对结果

| 任务 | 条件 | 通过 | 总输入 | 输出 | 请求 | 工具数 | 耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| retry-off-by-one | 原始 prompt + 原始工具 | 是 | 91,226 | 620 | 4 | 26 | 50.3s |
| retry-off-by-one | 精简 prompt + 原始工具 | 是 | 88,937 | 555 | 5 | 26 | 76.4s |
| retry-off-by-one | 原始 prompt + 精简工具 | 是 | 42,569 | 564 | 4 | 6 | 48.2s |
| retry-off-by-one | 精简 prompt + 精简工具 | 是 | 34,257 | 619 | 6 | 6 | 54.3s |
| inventory-summary | 原始 prompt + 原始工具 | 是 | 91,742 | 834 | 4 | 26 | 52.3s |
| inventory-summary | 精简 prompt + 原始工具 | 是 | 110,387 | 1,610 | 6 | 26 | 100.5s |
| inventory-summary | 原始 prompt + 精简工具 | 是 | 43,151 | 776 | 4 | 6 | 52.2s |
| inventory-summary | 精简 prompt + 精简工具 | 是 | 35,101 | 817 | 6 | 6 | 40.2s |

## 因子效应

- 工具面主效应：对两个 prompt 条件取边际平均，精简工具面总输入下降 **59.4%**。
- 工具面简单效应：原始 prompt 下下降 **53.2%**；精简 prompt 下下降 **65.2%**。
- prompt 简单效应：原始工具面下增加 **8.9%**；精简工具面下下降 **19.1%**。
- prompt 边际效应：原始 prompt 134,344，精简 prompt 134,341，表面上约为 0；但不应忽略
  上述交互和单元内请求数差异。
- 组合精简相对全原始：总输入下降 **62.1%**，输出下降 **1.2%**，耗时下降 **7.9%**，
  但请求数从 8 增至 12。
- 按请求归一化的总输入依次约为 22,871、18,120、10,715、5,780；组合精简相对基线
  每请求下降 **74.7%**。

## 配置有效性检查

- 精简 prompt 的 provider-visible system prompt hash 在四个相关单元中完全一致：
  `4a6b6557dc148e1a19ad7fac480504b9cc1ad48fbf02ebb686f6f262f20d1f9b`。
- 原始工具面 wire snapshot 为 26 个实际工具；精简工具面严格为 6 个预期工具。
- 四组均来自 patched REST 创建路径，不是通过修改任务指令模拟 prompt 或工具差异。

## 决策

暂不把精简 prompt 单独设为默认：在完整工具面下，它没有减少本轮总输入，且其中一题产生了
额外请求。下一步优先验证工具面的渐进披露方案：六个核心工具常驻，Goal、Plan、Web、Agent、
Cron 等按意图或显式调用加载。正式上线前至少需要在 Harbor / Terminal-Bench 2.1 上做更多
配对任务，并分别报告成功率、未缓存输入、缓存读取、输出、请求数和 deadline kill。

后续实现记录：上述方案现已落入 `0003-progressive-builtin-tools.patch`。它复用 Kimi 已有
`select_tools` 协议，默认入口为六个核心工具加一个选择工具，低频能力按名称、分组或明确意图
动态注入；完整 product system prompt 保持不变。当前仅通过上游类型检查和工具披露定向测试，
尚未完成 Harbor / Terminal-Bench 质量结论。

实现后另跑了 `retry-off-by-one` 单单元真实 K3 wire smoke：自动测试通过，首次工具 snapshot
严格为 `Bash / Edit / Glob / Grep / Read / select_tools / Write` 7 个入口，总输入 44,879、
输出 538、4 次请求、5 次工具调用。原四宫格中同题“原始 prompt + 原始工具”单元总输入为
91,226；本次约低 50.8%，但两次生成并非同一随机轨迹，故只作为配置生效和方向一致性证据，
不作为效果量估计。

# 测试摘要（run-20261025-01）

最终代码提交：`ffeb6d0`。以下为实际执行结果；完整 TAP 输出见同目录日志。

| 套件 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 公平性 + JS5 + 配置 + Worker + joint | `node --test --test-concurrency=1 ai-fairness joint-fairness public-sim.fairness public-sim.differential js5-phase5-regression js5-near-terminal js5-config-identity js5-budget js5-worker-config joint-pr26-regression` | **59 pass / 0 fail**（96.5s） | `fairness-js5-tests.log` |
| 适配器 + AI 模块 + Worker + 引擎 + 牌表 | `node --test --test-concurrency=1 adapter-champion ai-modules ai-runtime engine canonical` | **53 pass / 0 fail** | 见提交说明；该组在 `run-relevant-tests.sh` 中与上一组共同执行 |
| human-analytics + duel identity | `node --test training/human-analytics/tests/run-tests.mjs training/joint/tests/duel-identity.test.mjs` | **22 pass / 0 fail** | 终端输出已记录于 `EXPERIMENTS.jsonl` T-001 |
| C10 / 预算探针 | `probe-c10.mjs`、`probe-budget.mjs` | 见 `evidence/` | `budget-*.json` |

**合并 main 后复跑（69ec14c）**：
- `web-v1` 相关 11 个测试文件：**74 pass / 0 fail**（92.7s），
  日志 `merged-web-tests.log`。
- analytics + duel + version-identity + seed-ledger：**45 pass / 0 fail**（10.3s），
  日志 `merged-training-tests.log`。
- `tsc` 通过；C10/预算/配置/Worker 测试均包含在 74 项内。

**未运行**：`ai.test.mjs`、`human-ai.test.mjs`——在默认活动冠军 JS5 100ms 下需 >15min，
且其分派/公平/结构语义已由上述套件覆盖。该排除在 `EXPERIMENTS.jsonl` T-001 披露。
**测试通过不等于棋力提高**；它只证明规则/配置/公平性/接口一致性。

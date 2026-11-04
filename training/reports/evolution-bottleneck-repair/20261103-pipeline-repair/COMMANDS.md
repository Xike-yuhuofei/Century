# 执行命令与可复现入口

工作目录均为 `/Volumes/Extreme SSD/Projects/Century-ai13`，报告根目录为 `training/reports/evolution-bottleneck-repair/20261103-pipeline-repair`（下文 R）。真实运行命令只能串行执行；重跑会新增消费，不应直接覆盖现有结果。

## 已执行的主要入口

```sh
R='/Volumes/Extreme SSD/Projects/Century-ai13/training/reports/evolution-bottleneck-repair/20261103-pipeline-repair'
# 基线身份、修改保护（只读）
git status --short
git diff --stat
git worktree list --porcelain
git rev-parse HEAD origin/main
git branch --show-current

# 基线构建，日志 baseline-build.log
npm --prefix web-v1 run build

# 初始复现、离线历史重放
node "$R/reproduce-before.mjs"
node "$R/replay-history.mjs"
node "$R/replay-history-resumed.mjs"

# 开发种子事前登记（均已执行，不重复登记）
node "$R/prepare-experiment.mjs"
node "$R/prepare-validation.mjs"
node "$R/prepare-confirmation.mjs"
node "$R/prepare-final-comparison.mjs"
node "$R/prepare-probe-score-check.mjs"

# 原始两臂，日志 baseline-experiment.log / repaired-experiment.log
node "$R/run-experiment.mjs" baseline
node "$R/run-experiment.mjs" repaired

# 原始三代确认与最终三代流程回归，外部watchdog/独立进程组
python3 "$R/run-confirmation-budget.py"
python3 "$R/run-confirmation-final-budget.py"

# 最终受控两臂：每臂900秒，顺序固定；日志 final-comparison/{arm}.log
python3 "$R/run-final-comparison-budget.py"

# 评分修复：固定提案、零新增LLM、180秒
python3 "$R/run-probe-score-check.py"

# 独立复验与模式验证：总上限1800秒
python3 "$R/run-validation-budget.py"

# 最终串行测试：准确参数、工作目录、耗时、返回值见 FINAL-TESTS.json
python3 "$R/run-final-tests.py"

# 研究反馈与种子收尾（已执行；会追加记录，不是只读查询）
node "$R/record-independent-feedback.mjs"
node "$R/close-seed-entries.mjs"

# 离线归档复算，可重复；只写本报告的派生汇总
python3 "$R/summarize-results.py"
node "$R/audit-lineage.mjs"
node "$R/audit-generation-diversity.mjs"
python3 "$R/replay-probe-score.py"
python3 "$R/audit-evaluation-contexts.py"
python3 "$R/build-cost-audit.py"
python3 "$R/audit-boundaries.py"
git diff --check
```

`R` 需设置为上述报告绝对路径；不要复用 HOME 等系统变量。各 runner 是确切参数的权威来源，内含模型配置、seed文件、预算、隔离root和watchdog。`run-experiment-original.mjs` 保留最初执行器；原基线仅完成第1代，第二代父代继承修订没有改变已发生的基线计算。

## 测试与失败记录

早期回归日志全部保留：regression-initial/repaired/resumed、evolution-full、evolution-final、evolution-final-isolated、evolution-release-candidate。release-candidate 的159/160唯一失败是新增深验配额用例遗漏 selectedIds 的夹具问题，修正后定向15/15通过；种子入口新增后16/16通过。最终以 FINAL-TESTS.json 的完整重跑为准，不以旧绿灯替代。

谱系单测曾意外启动初评，已终止自己的进程并隔离该单测（researchContext=off）；事故种子通过现有 reserveConsumption/completeConsumption **事后**补记voided，不伪称预登记。原始运行路径、进程与不可恢复游戏计数见 TEST-ISOLATION-NOTE.md / accidental-seed-quarantine.json。该事故保守计入120秒真实预算。

没有执行 isolation_test.mjs（其旧脚本在沙箱外运行恶意样例并覆盖旧结果）。最终使用隔离临时 WORK_ROOT 的 test_security_sandbox.py 验证真实Seatbelt；运行前检查固定探针文件不存在，避免覆盖用户文件。

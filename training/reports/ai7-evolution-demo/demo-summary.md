# AI7 自主进化轻量闭环演示

- 模式：real-dev-games (lightweight)
- campaign：`ai7-demo-20261025`
- 状态：completed（第一次运行安全停止：stopped → 恢复完成）
- 检查点序号：21
- 预算使用：候选 6，对局 18，深验 1
- 种子窗口：screen `ai7-screen-w000` [1610000000, 1610000001]；deep `ai7-deep-w000` [1620000000, 1620000001, 1620000002]

## 候选结果

| 候选 | 模式 | 阶段 | 快筛分 | 深验分 | 第一名率 | proxy Δ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| cand-ai7-searchbudget-r1c0-bfe007 | game | selected | 0.6688 | — | 0.500 | — |
| cand-ai7-candidatecap-r1c1-33cef5 | game | pending-approval | 0.7090 | 0.5872 | 0.750 | — |
| cand-ai7-overridemargin-r1c0-3a144d | game | not-selected | 0.6671 | — | 0.500 | — |
| cand-ai7-acquisitionvalue-r1c1-d31db4 | proxy | selected | 0.7366 | — | — | 0.042 |
| cand-ai7-compiled-acq-r1c4-1d7b60 | proxy | selected | 0.7325 | — | — | 0.027 |

安全失败候选（隔离，不污染其他候选）：cand-ai7-enginevalue-r1c3-acf817
生成即拒绝候选：candidateCap（candidateCap.candidateCap 越界：必须为 2–8，实际：99）
保留候选：cand-ai7-searchbudget-r1c0-bfe007(game)、cand-ai7-candidatecap-r1c1-33cef5(game)、cand-ai7-acquisitionvalue-r1c1-d31db4(proxy)、cand-ai7-compiled-acq-r1c4-1d7b60(proxy)

## 待人工审批的正式挑战请求

- `greq-030de52c930dd0ff` 候选 cand-ai7-candidatecap-r1c1-33cef5，状态 pending-human-approval，自动晋级=false；文件 training/reports/ai7-evolution-demo/pending-approval/greq-030de52c930dd0ff.json

## 失败诊断回流

- 诊断来源：training/reports/diagnostics-latest/analysis.json
- finding 标签：认领延迟(32)、竞争抢牌失败(32)
- 研究提示目标：candidateCap、overrideMargin、goalValue、acquisitionValue
- advisoryOnly=true, notRewardTruth=true

## 验收检查

- multipleValidCandidates: PASS
- independentArtifacts: PASS
- evidenceIndependence: PASS
- safetyChecksRan: PASS
- failureIsolation: PASS
- generationRejectedInvalid: PASS
- selectedMultiple: PASS
- deepConfirmed: PASS
- pendingHumanApproval: PASS
- stopAndResume: PASS
- noValidationPoolConsumption: PASS
- noChampionMutation: PASS
- diagnosticsFlowedBack: PASS
- advisoryOnlyHints: PASS

总判定：**PASS**

# CI 运行耗时采集

| 运行 | 工作流 | 事件 | 结论 | 分支 | 墙钟 | 作业累计 |
|---|---|---|---|---|---|---|
| 40302123426 | CI | push | success | main | 21m29s | 56m33s |
| 40329160607 | CI | pull_request | success | feat/ai9-actions-upgrade | 9m34s | 59m54s |
| 40337047766 | CI | pull_request | success | feat/ai9-actions-upgrade | 14m04s | 68m33s |

## CI · run 40302123426

| 作业 | 结论 | 耗时 | 失败步骤 |
|---|---|---|---|
| rules-cards | success | 9s | - |
| changes | success | 7s | - |
| governance-tests | success | 7s | - |
| build | success | 12s | - |
| web-unit | success | 13m04s | - |
| audit-gate | success | 23s | - |
| simulation | success | 9m20s | - |
| ui-smoke | success | 1m59s | - |
| research-e2e | success | 2m44s | - |
| training-unit | success | 20m53s | - |
| research-python | success | 1m37s | - |
| research-worker (anomaly, 回传越界序号被如实记为异常对局) | success | 7s | - |
| research-worker (mlp, MLP 席位往返) | success | 15s | - |
| research-seatbelt | success | 59s | - |
| research-node | success | 3m42s | - |
| research-worker (repro, 全 node 席位完整对局并按种子复现) | success | 20s | - |
| promotion-gate | skipped | 0s | - |
| pages-deploy | success | 17s | - |
| deploy-verify | success | 10s | - |
| rollback-on-deploy-failure | skipped | - | - |
| ci-summary | success | 8s | - |
| promotion-machine-gate | skipped | - | - |

## CI · run 40329160607

| 作业 | 结论 | 耗时 | 失败步骤 |
|---|---|---|---|
| changes | success | 11s | - |
| rules-cards | success | 7s | - |
| governance-tests | success | 9s | - |
| build | success | 12s | - |
| simulation | success | 5m26s | - |
| audit-gate | success | 17s | - |
| web-long-tests (2) | success | 3m26s | - |
| web-long-tests (1) | success | 1m47s | - |
| web-long-tests (3) | success | 4m05s | - |
| ui-smoke | success | 2m37s | - |
| training-unit (2) | success | 5m55s | - |
| training-unit (3) | success | 4m55s | - |
| training-unit (0) | success | 8m50s | - |
| web-unit (2) | success | 4m08s | - |
| web-unit (3) | success | 2m06s | - |
| web-unit (0) | success | 56s | - |
| web-unit (1) | success | 1m28s | - |
| training-unit (1) | success | 33s | - |
| web-long-tests (4) | success | 4m59s | - |
| ai9-research | success | 7m37s | - |
| research-worker | skipped | - | - |
| research-e2e | skipped | - | - |
| research-node | skipped | - | - |
| rollback-gate | skipped | - | - |
| promotion-gate | skipped | - | - |
| research-seatbelt | skipped | - | - |
| research-python | skipped | - | - |
| deploy-verify | skipped | 0s | - |
| pages-deploy | skipped | 0s | - |
| rollback-on-deploy-failure | skipped | 0s | - |
| ci-summary | success | 10s | - |
| promotion-machine-gate | skipped | - | - |

## CI · run 40337047766

| 作业 | 结论 | 耗时 | 失败步骤 |
|---|---|---|---|
| rules-cards | success | 8s | - |
| governance-tests | success | 16s | - |
| changes | success | 7s | - |
| build | success | 11s | - |
| web-unit (1) | success | 1m28s | - |
| web-long-tests (3) | success | 3m40s | - |
| training-unit (3) | success | 4m55s | - |
| training-unit (1) | success | 42s | - |
| web-unit (0) | success | 50s | - |
| simulation | success | 6m03s | - |
| audit-gate | success | 25s | - |
| ui-smoke | success | 2m02s | - |
| training-unit (2) | success | 4m17s | - |
| web-long-tests (4) | success | 5m17s | - |
| training-unit (0) | success | 13m23s | - |
| web-long-tests (2) | success | 2m55s | - |
| web-unit (3) | success | 3m30s | - |
| web-unit (2) | success | 6m47s | - |
| ai9-research | success | 9m27s | - |
| web-long-tests (1) | success | 1m59s | - |
| research-worker | skipped | 0s | - |
| research-seatbelt | skipped | 0s | - |
| rollback-gate | skipped | 0s | - |
| research-node | skipped | 0s | - |
| research-e2e | skipped | 0s | - |
| promotion-gate | skipped | 0s | - |
| research-python | skipped | 0s | - |
| pages-deploy | skipped | - | - |
| deploy-verify | skipped | - | - |
| rollback-on-deploy-failure | skipped | 0s | - |
| ci-summary | success | 11s | - |
| promotion-machine-gate | skipped | - | - |


# v1 深度独立验证——废止声明与审计证据（2026-10-22）

## 废止结论

**本目录中的 `deep_validation_best.json` 与 `deep_validation_baseline.json` 的
"100 个独立种子深度验证"结论自即日起废止（INVALID）。** 报告正文
（AI5-OPENEVOLVE-INTEGRATION-REPORT.md §7）中引用它们的段落已加注失效标记。

## 事故根因（追踪结论）

种子文件 `work/deep-seeds.txt`（本目录留档 `deep-seeds.txt`）的 101 行**全部**
是同一文本 `3.00001e+08` —— 这是 `300001000` 的科学计数法（`%g` 类浮点格式化的产物）。
完整调用链：

1. **种子生成/写入**（会话期临时步骤，未入库）：生成器只产生了一个种子值
   （101 次重复），并以浮点科学计数法写入文件——两处缺陷叠加；
2. **读取/解析**（`ai5/openevolve/node/duel_runner.mjs` 旧版 `loadSeeds()`）：
   `Number("3.00001e+08")` 静默接受科学计数法，且无重复种子检测；
3. **对局执行**：101 个配对样本全部在同一种子 300001000 上进行，202 局实为
   同一对局的 101 次重复（引擎确定性）；
4. **统计判定**（`training/evaluator/stats.mjs` 旧版 `pairedPromotionDecision`）：
   把 101 个同值配对当独立样本计算 Wilson 区间——样本量被虚增 101 倍，
   CI 被系统性低估。

因此"100 个新种子上 +0.417 反转并落败（−1.5/种子，CI 上界 0.037）"的表述
中，唯一种子数实为 **1**，任何基于 101 独立样本的区间与判定均无效。

（注：−1.5/种子 这一点值本身是真实对局结果，但只是单种子观察值，不具备
"100 种子独立验证"的证据力。）

## 整改（详见 PR：AI5 双轨系统可靠性整改）

- 种子解析统一走 `ai5/lib/seed_policy.mjs::parseSeedList`：严格十进制整数
  （拒绝科学计数法/浮点）、区间校验、唯一种子强制；
- `pairedPromotionDecision` 对重复配对种子直接抛错；
- 深度验证重建为入库脚本 `ai5/openevolve/deep_validation.py`：账本原子分配
  （`results/deep-validation-ledger.json`）+ 纯整数种子文件 + 读回校验 +
  沙箱执行 + 唯一种子数显式披露；
- v2 验证结果见 `results/deep_validation_v2_best.json` 与
  `deep_validation_v2_best_baseline.json`（同种子块、100 个唯一种子）。

## 保留原因

按整改纪律"保留失败日志和可复现证据"，本目录数据仅作审计证据，不作为任何
结论依据；其种子 300001000 已在账本中占位（`deep-validation:v1-invalid`），
不再参与分配。

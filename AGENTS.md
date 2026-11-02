# AGENTS.md — AI Agent 项目上下文

本文件供所有 AI 编码代理在开始任何任务前阅读。项目已存在成熟管线：**先审计相关目录，再动手；禁止在不知情的情况下重复造轮子**。

## 项目概况

《Century: Golem Edition》桌游 AI 项目。持续迭代多代 AI（AI4 → AI9），在 Mac mini M4 / 16GB 本地资源约束下训练与评估。

## 仓库地图

| 路径 | 职责 | 关键点 |
| --- | --- | --- |
| `web-v1/` | 正式网页游戏与 AI 决策核心 | `web-v1/dist/js`（`engine.js` / `ai.js`）是训练系统与 PPO 共用的唯一引擎来源；源码改动后必须重新构建 |
| `training/` | Node 训练基础设施（模拟器、锦标赛、参数进化、晋级） | 与 web-v1 共用编译产物，不复制算法 |
| `ai5/ppo/` | MLP + PPO 强化学习训练与评估 | Python 侧；依赖 `web-v1/dist/js` |
| `ai5/openevolve/` | LLM 引导的策略函数进化 + Seatbelt 沙箱 | 只允许进化白名单函数；候选代码不可信 |
| `ai5/lib/seed_policy.{mjs,py}` | 全局种子布局唯一权威 | 任何实验不得自造种子区间 |
| `data/`、`scripts/validate-cards.mjs` | 牌表数据与校验 | 改牌表后必须跑校验 |
| `docs/`、`century-replays/` | 架构/CI 文档与人类对局复盘 | 只读参考 |

根目录 `*-REPORT.md` 是历史快照，不代表当前代码状态。

## 环境与验证命令

- **Node ≥ 20**。根 `README.md` 中的 "Node 18+" 已过时，以各 `package.json` 的 `engines` 为准。
- **Python**：PPO 复用现有 `~/century-ai5-env`（Python 3.13 + PyTorch MPS），不要为 PPO 新建 venv；OpenEvolve 按 `ai5/openevolve/requirements.txt` 使用独立的 `ai5/openevolve/.venv`。
- OpenEvolve 沙箱依赖 macOS `sandbox-exec`。

首次准备与提交前验证（均在仓库根目录执行）：

```bash
(cd web-v1 && npm install && npm run build)   # 决策核心编译产物，训练/PPO 的前置
(cd web-v1 && npm test)
(cd training && npm test)
node scripts/validate-cards.mjs
```

按改动范围补跑最小验证：

| 改动范围 | 验证命令 |
| --- | --- |
| `web-v1/**` | `(cd web-v1 && npm test)` |
| `training/**` | `(cd training && npm test)`（依赖 web-v1 构建产物） |
| `ai5/ppo/**` | `node --test "ai5/ppo/tests/node/*.test.mjs"`；`python -m unittest discover -s ai5/ppo/tests/python -v`；冒烟训练 `python -m ai5.ppo.training.train_cli --smoke --out ai5/ppo/reports/smoke` |
| `ai5/openevolve/**` | `node ai5/openevolve/experiments/isolation_test.mjs`；`node --test ai5/openevolve/tests/*.test.mjs`；`ai5/openevolve/.venv/bin/python ai5/openevolve/tests/test_security_sandbox.py` |
| `data/**` | `node scripts/validate-cards.mjs` |

## 硬性约束（违反即返工）

1. **优先复用已验证基础设施**。开发前必须审计相关目录确认现有能力；不允许以新的简化实现替代现有可靠能力；未核实的既有功能不得视为已完成。
2. **种子全局布局唯一权威**：`ai5/lib/seed_policy.{mjs,py}`。任何需要随机种子的实验（PPO / OpenEvolve / 评测 / 基准）必须从该模块取种子，不得自造种子区间。
3. **候选策略必须经独立验证**（真实对局、机器门禁）才能成为正式冠军；模拟评分不得冒充正式晋级。
4. **OpenEvolve 生成代码一律视为不可信代码**（本条仅约束 OpenEvolve 候选代码及其沙箱执行上下文，不限制正常开发）：仅允许修改白名单内的策略实现；候选不得修改游戏规则/评估器/测试/晋级脚本；禁止访问隐藏牌库、密钥、任意文件与网络；执行必须在 Seatbelt 隔离 + 资源限制下进行。
5. **保留既有训练命令与工作流**（AI4 时代起的命令不变），Python 与 Node 环境相互独立。
6. **PPO 恢复确定性**：checkpoint 须含三套 RNG 状态；确定性评估使用 `node:champion-det-<N>` / `node:champion-beam` 模式并 `torch.set_num_threads(1)`。
7. **验收以真实端到端运行为准**，不得以 PoC、接口、演示、静态测试或代理评分宣布成功。

## 事实优先级

发生冲突时：**代码与测试 > 本文件 > 各目录 README > 根目录历史报告**。若发现冲突，先向用户报告，不要静默选边或按旧报告改代码。

## 操作边界

- **长任务/资源**：PPO 训练、OpenEvolve 迭代、全量对战属于重任务，启动前先确认；16GB 机器上禁止并行跑多个训练/进化会话。
- **Git**：未经用户明确要求，不 commit、不 push、不建 PR；不在 `main` 上直接改动。
- **沙箱**：安全测试必须使用临时 `WORK_ROOT`；不得为省事关闭 Seatbelt 或放宽静态白名单。
- **密钥与隐藏信息**：不得读取或写入任何密钥；AI 决策不得接触隐藏牌库字段（`merchantDeck` / `golemDeck`）。
- **语言与风格**：文档用中文，代码注释沿用所在文件现有语言与风格。

## 已知坑（历史踩坑，避免重蹈）

- OpenEvolve stage2 超时应为 **1200s**（420s 会错误淘汰真实候选）。
- `acquisitionValue` 已增至 7 参数（含 model）；改签名时 `static_check.mjs` 的 `EXPECTED_PARAMS`、初始 program、恶意样例、Python/Node benign fixture 必须同步。
- 安全测试必须用临时 `WORK_ROOT`，共享 work root 会被并行 OpenEvolve 会话交叉消费。
- 沙箱网络拒绝判定以 `connect EPERM` 为准（`fetch failed` 有歧义）。

## 关键文档（历史背景，非现状依据）

- `AI5-OPENEVOLVE-INTEGRATION-REPORT.md` / `AI5-MLP-PPO-TRAINING-REPORT.md` — 两大管线设计
- `AI7-EVOLUTION-PIPELINE-REPORT.md` / `AI9-REAL-TRAINING-REPORT-20261026.md` / `CENTURY-AI-8.0-FINAL-REPORT.md` — 后续迭代与真实训练
- `01-可靠性与正确性审计报告.md`、`02-AI-实战竞技能力审计报告.md`、`03-自主进化架构审计报告.md`、`04-工程与产品审计报告.md` — 审计报告
- `training/README.md`、`ai5/ppo/README.md`、`ai5/openevolve/README.md`、`web-v1/README.md` — 各子系统说明

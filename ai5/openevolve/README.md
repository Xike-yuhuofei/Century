# Century AI5 — OpenEvolve 自主算法进化集成（POC）

将 [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve)（MAP-Elites + 岛屿模型的 LLM 代码进化框架）
与 Century AI 4.0 训练系统融合：由 LLM 自动生成/变异**策略算法代码**（不只是参数），
由 Century 的官方规则引擎、配对战、统计检验负责独立验证。

**本目录所有实验分支为 `feat/ai5-openevolve-poc`，不触碰 main、不触碰 AI 4.0 的任何训练命令与工作流。**

## 演化目标（第一轮闭环）

`web-v1/src/ai/evaluator.ts` 中的商人卡获取估值函数 `acquisitionValue()`：
- 对引擎建设与关键商人卡竞争有直接影响；输入输出明确、易测试、修改范围可控；
- 初始程序 = 当前冠军实现（[`program/acquisition_value.ts`](program/acquisition_value.ts)）；
- EVOLVE-BLOCK 标记限定可演化区域，且 OpenEvolve 侧显式开启 `enforce_evolve_blocks: true`
  （该开关上游默认**关闭**，不能假设有保护）。

## 架构

```
OpenEvolve（Python，codex app-server LLM）
   │ 生成/变异 acquisitionValue 候选（diff-based）
   ▼
century_evaluator.py ── 级联评估（stage1 → stage2 → stage3）
   │        │
   │        ├─ stage1（廉价、确定性）：static_check → assemble_candidate → 沙箱 tsc 编译 → 沙箱单元探针
   │        ├─ stage2（快筛对战）：沙箱内配对对战 16 种子 × 2 局 = 32 局
   │        └─ stage3（深评对战）：沙箱内配对对战 48 种子 × 2 局 = 96 局（种子与 stage2 隔离）
   ▼
Node 评估管线（ai5/openevolve/node/）
   ├─ static_check.mjs        静态安全检查（禁 import/eval/constructor 逃逸/隐藏牌库/随机数/时钟…）
   ├─ assemble_candidate.mjs  候选源码树组装（官方源码字节级副本 + 单函数替换 + SHA256 固证）
   ├─ probe.mjs               3000 个确定性用例上的行为探针（官方 vs 候选逐位对比）
   └─ duel_runner.mjs         同局双版本对战（核心隔离机制，见下）
```

### 同局双版本隔离（AI 4.0 做不到、AI 5.0 新增的能力）

AI 4.0 的 `training/simulator/simulate.mjs` 模块级 import 唯一的 `web-v1/dist/js/ai.js`，
所有席位共用同一份决策代码 —— 候选若替换公共编译产物，对照组冠军也会运行候选算法（评估污染）。

AI5 方案（`duel_runner.mjs`）：
- 规则引擎只有一份：官方 `web-v1/dist/js/engine.js`；
- 冠军代码：官方 `web-v1/dist/js/ai.js`，**永不修改**（每次实验前后 SHA256 断言）；
- 候选代码：独立源码树独立编译的 `ai.js`，与官方模块在同一 Node 进程内是两个互不共享状态的 ESM 实例；
- 席位注入：配对模式每种子两局 —— 局 1 候选@席位 0（中立位），局 2 候选@席位 4（战术大师位）；
  配对分差 = [(cand@0局1 − champ@0局2) + (cand@4局2 − champ@4局1)] / 2，角色匹配、同种子共享洗牌序列；
- 统计口径复用 `training/evaluator/stats.mjs`（pairedPromotionDecision / firstPlaceStats），不另起炉灶。

### 安全模型（OpenEvolve 生成代码一律视为不可信）

双层防御，实际效力由 `experiments/isolation_test.mjs` 用恶意样例验证（12/12 通过）：

1. **静态检查**（执行前拒绝）：禁 import/require/eval/Function 构造/**constructor 逃逸**/
   process/globalThis/fetch/隐藏牌库字段（merchantDeck/golemDeck）/Math.random/时钟/模板字符串；
   函数签名逐参校验；EVOLVE-BLOCK 边界复核（OpenEvolve enforce 开关的独立冗余校验）。
2. **macOS Seatbelt 沙箱**（`sandbox/candidate.sb.tmpl`）：编译、探针、对战全部在
   `sandbox-exec` 内执行 —— 默认全拒；禁读用户主目录（~/.codex、~/.ssh 等密钥不可达）；
   禁一切网络；只允许写 AI5 工作区。子进程环境变量白名单（无任何密钥），HOME 指向空目录。
3. **运行时淘汰**：超时/异常/非法行动（正式引擎校验）→ 候选直接判负淘汰；
   死循环样本实测被超时击杀。

残余风险披露：候选可读仓库内非密钥文件（沙箱允许读系统与仓库以完成编译）；
密钥类资产的隔离由「环境变量白名单 + 主目录整体拒绝」承担，恶意样例实测不可达。

### 种子纪律（与 AI 4.0 物理隔离）

| 区间 | 用途 | 归属 |
|---|---|---|
| [0, 300M) | AI 4.0 日常进化 | 不触碰 |
| [300M, 400M) | **AI5 快筛/深评专用子块** | 本系统 |
| [400M, 900M) | AI 4.0 基准评测约定区 | 不触碰 |
| [900M, 1.06e9) | 冠军确认挑战验证池（种子账本管理） | **绝不触碰** |

AI5 只产出实验证据，正式晋级必须走 AI 4.0 既有冠军挑战流程
（独立验证种子 + 配对挑战 + 几何 alpha 消耗 + promote/apply 双脚本 + PR 评审）。

## 环境与启动

```bash
# 0. 前置：Node ≥ 20（含 web-v1 构建产物）；macOS（依赖 sandbox-exec）；
#    codex CLI 已通过 ChatGPT 登录（codex login status 应显示 Logged in）。
cd web-v1 && npm install && npm run build && cd ..

# 1. Python 环境（独立 venv，OpenEvolve 锁定 commit）
python3 -m venv ai5/openevolve/.venv
ai5/openevolve/.venv/bin/pip install -r ai5/openevolve/requirements.txt

# 2. 单元探针 / 基线 / 变体实验
node ai5/openevolve/experiments/exp_a_baseline.mjs      # 实验 A：基线一致性
node ai5/openevolve/experiments/exp_b_mutation.mjs      # 实验 B：算法修改有效性
node ai5/openevolve/experiments/isolation_test.mjs      # 安全隔离验证（恶意样例）

# 3. OpenEvolve 冒烟（3 次迭代）
cd ai5/openevolve && .venv/bin/openevolve-run \
  program/acquisition_value.ts century_evaluator.py \
  --config config.yaml --iterations 3 --output_dir results/openevolve-smoke

# 4. 受控迭代（10–30 次，预算内）
.venv/bin/openevolve-run program/acquisition_value.ts century_evaluator.py \
  --config config.yaml --iterations 10 --output_dir results/openevolve-run-controlled
```

单阶段手动评估（调试用）：

```bash
cd ai5/openevolve && .venv/bin/python century_evaluator.py program/acquisition_value.ts 1
```

## 成本与资源（Mac mini M4 / 16GB）

| 项 | 数值（实测见 results/） |
|---|---|
| stage1（静态+组装+编译+探针） | 秒级 |
| stage2 快筛对战 | 32 局 ≈ 1 分钟 |
| stage3 深评对战 | 96 局 ≈ 3 分钟 |
| 单候选最重路径 | < 5 分钟（级联使多数劣候选只花秒级） |
| LLM 调用 | 每迭代 1 次（codex app-server，无 API Key） |

## 已知边界与后续方向

- 第一轮只进化 `acquisitionValue` 一个函数；扩展其他策略函数只需新增 program 模板与对应 splice 规则；
- duel_runner 串行执行对局（复现优先）；后续可按 worker 并行提升吞吐（AI 4.0 已有并行基准）；
- 候选只能在函数体层面改变算法；结构级进化（planner/搜索骨架）需先扩展静态允许清单并重审安全模型。

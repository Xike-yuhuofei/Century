# AI7 桌面 UI 与 AI Worker 运行时报告

- 任务：Century AI 7.0 · 任务 E（E1–E5）
- 分支：`feat/ai7-desktop-runtime`
- 基线：`main` @ `19fa564`（创建 worktree）；rebase 至 `35f2413`（PR #48 合并后）
- Worktree：`/Volumes/Extreme SSD/Projects/Century-ai7-desktop`
- 日期：2026-10-25

## 0. 结论

1. **默认 1 真人 + 4 AI 已进入 Focus 布局**：3440×1440 三列、1920×1080 与 1440×900 双列（右侧市场 + AI 轨道上下分区）。三种桌面分辨率均无横向溢出；1 真人局三种分辨率均无纵向溢出（1440 基线为 2361px 高，现为 900px）。
2. **AI 已打出卡牌成为常驻公开信息**：所有 AI 轨道的「已打出」默认展开；3–4 名 AI 在 1920/1440 使用 2×2 轨道。点击 AI 标签即可展开完整回收区/手牌详情。
3. **AI 决策已移出主线程**：单文件 `standalone.html` 与服务器入口都内联经典 Worker 源码，运行时经 Blob 创建，不依赖外部 `worker.js` 请求。GitHub Pages `_site` 子路径部署实测通过（Chromium + WebKit）。
4. **主线程长任务从每回合 84–105ms 降为 0ms**（Chromium PerformanceObserver，4 个 AI 回合窗口），帧间隙 ≤28ms，view-only 交互 2.5–6ms。
5. **行为一致性**：2–5 人各 2 个真实合法局面 + 临近终局 5 人冻结局面 + 6 人扩展，固定算法/参数/随机流/工作量下 Worker 与主线程逐位一致。墙钟模式的轨迹数差异只由计时造成，行动仍一致。
6. **规则与冠军未改变**：未修改 `src/engine.ts`、`src/ai/parameters.ts`、`src/js/**`、`training/**`、种子账本或冠军注册表。`CHAMPION_PARAMETERS`（JS5，100ms）原样读取。
7. **保留 2 真人 + AI 成熟布局**：结构与三列尺寸未改；仅把 AI 轨道内容升级为「已打出引擎 + 手牌计数 + 一键详情」。1440 宽下该成熟布局仍按既有设计纵向滚动（基线即如此），未推倒重排。

---

## 1. 执行约束核对

| 约束 | 执行情况 |
|---|---|
| 统一 main SHA 独立 Worktree | `git worktree add ... -b feat/ai7-desktop-runtime 19fa564` |
| 只改 UI、Worker 集成与必要测试 | 改动集中在 `src/app.ts`、`src/styles.css`、`src/ai-runtime/**`、构建与测试脚本 |
| 不改游戏规则/正式冠军算法 | `src/engine.ts`、`src/ai/**`、`src/js/**`、`training/**` 零改动 |
| 不增加联网推理依赖 | Worker/页面无 `fetch`/`XHR`/`WebSocket`；`ai-runtime` 静态扫描强制 |
| 不重做手机端 | 未触碰已删除的手机端 |
| 不改训练评测/种子账本/冠军注册表 | 未触碰 |

---

## 2. E1：默认 Focus 布局

### 2.1 布局模型

`renderSoloFocusBoard` 成为 1 真人 + 1–4 AI 的唯一入口，替换旧的 `ai-board-layout`。

- **≥2400px（3440 优先）**：三列
  - 左：真人操作区（手牌 / 回收区 / 商队 / 休息）
  - 中：魔像市场 + 商人市场 + 玩家态势 + 行动记录
  - 右：所有 AI 的公开引擎轨道（1–4 条，纵向占满）
- **1100–2399px（1920 / 1440）**：两列
  - 左：真人整列
  - 右：上 = 市场，下 = AI 轨道（3–4 AI 时 2×2，1–2 AI 时纵向）
- **<1100px**：纵向堆叠，仅作为窄屏兼容，不横向溢出。

关键尺寸（实测，Chromium）：

| 视口 | 真人列 | 中央列 | AI 轨道 | 手牌卡 | 手牌字号 | 市场魔像 | 市场商人 | 横向/纵向溢出 |
|---|---|---|---|---|---|---|---|---|
| 3440×1440 | 1027×1385 | 1355×1385 | 1027×1385 | 180×180 | 12px | 261×300 | 216×250 | 无/无 |
| 1920×1080 | 656×1025 | 1240×466 | 1240×551（2×2） | 180×180 | 11px | 238×205 | 197×173 | 无/无 |
| 1440×900 | 483×832 | 913×403 | 913×421（2×2） | 180×180 | 11px | 173×171 | 143×144 | 无/无 |

3440 下 AI 引擎卡 132×200；1920 下 132×200；1440 下 115×183。主信息不靠缩小卡牌/字号实现。

### 2.2 手牌增长

沿用并强化现有 `hand-few / hand-some / hand-many / hand-packed` 分级：

- 手牌 ≤4：居中放大（`auto-fit`，150–180px 宽 / 180px 高，接近方形卡面），避免巨大手牌区只剩左上角两张小卡。
- 5–16 / 17–28 / 29+：按数量自动切换密度。
- ≥2400px 时 `hand-many/packed` 最小列宽提升到 118/104px（基线为全局 131/89），30+ 张手牌仍保持可读。
- 压力局面实测：1440×900、1 真人 + 4 AI、16 张手牌，手牌卡 150×142，页面无任何溢出。

### 2.3 前后对比

| 指标 | main 基线（1H+4AI） | 本分支 |
|---|---|---|
| 3440 手牌卡 | 104×109，字号 10px | 180×180，字号 12px |
| 3440 AI 信息 | 2×2 大席位（582×660），默认只展示手牌 | 4 条横向轨道（1027×342），已打出常驻 |
| 1440 页面高度 | 2361px（约 2.6 屏，纵向溢出） | 900px（精确一首屏） |
| 1440 AI 区 | 位于页面底部（首屏不可见） | 首屏右侧 2×2 可见 |
| 3440 首屏 | 手牌/市场可见 | 手牌/市场/AI 轨道全部可见 |

截图：

- [3440 基线](docs/ai7/screenshots/chromium-before-solo-3440x1440.jpg) / [3440 本分支](docs/ai7/screenshots/chromium-solo-3440x1440.jpg)
- [1440 基线](docs/ai7/screenshots/chromium-before-solo-1440x900.jpg) / [1440 本分支](docs/ai7/screenshots/chromium-solo-1440x900.jpg)
- [1920 本分支](docs/ai7/screenshots/chromium-solo-1920x1080.jpg)
- [WebKit 1440](docs/ai7/screenshots/webkit-solo-1440x900.jpg)

---

## 3. E2：公开信息展示

- AI 轨道默认展示 **已打出商人卡**（`played-face`，紧凑卡面），显示「回收 N」；手牌只显示数量，点击标签展开完整详情。
- 每个轨道有独立折叠按钮（沿用 `viewState` 持久化）；默认展开，用户可逐席位折叠。
- 3–4 名 AI 在 1920/1440 改为 2×2 轨道，每个 AI 的引擎同时可见；无需逐个打开面板。
- 详情浮层优先展示「已打出」，其次「手牌」，覆盖右半屏，不挤压棋盘。
- 「玩家态势」面板在 3440 中央区常驻：所有人的分数、魔像数、商队容量、终局目标；全部为公开信息。
- 未引入任何隐藏信息：`buildObservation` 仍是唯一观察入口；Worker 防火墙继续递归拒绝 `merchantDeck/golemDeck/log/version`。

---

## 4. E3：AI Worker 接入

### 4.1 部署形态

`web-v1/scripts/build.mjs` 新增：

1. 用 esbuild 把 `src/ai-runtime/worker.ts` 打成经典 IIFE（含 `worker-core`、`decision-core`、`js/sim/om` 决策链）。
2. 同时写入：
   - `dist/js/ai-runtime/worker-browser.js`（诊断副本，未转义）；
   - `dist/index.html` 与 `dist/standalone.html` 的 `<script type="text/plain" id="ai-worker-source">` 内联源码（仅做 `</script>` 防逃逸）。
3. 页面运行时读取该元素文本，`Blob` → `URL.createObjectURL` → `new Worker(url)`（经典 Worker），不请求任何外部文件。

GitHub Pages 工作流把 `dist/standalone.html` 复制为 `_site/index.html`；浏览器实测正是按 `_site` + `/Century/` 子路径进行，而不是本地开发服务器直连 `dist`。

**与 main 并行工作的整合**：PR #48 在 main 上引入了 G2 桌面 Worker（整份 `Game` 进 Worker、`ai-worker.ts`）与 AI6 的冠军参数透传。本分支 rebase 至 `35f2413` 后：
- 用公开观察协议 Worker 替换 G2（删除 `src/ai-worker.ts`，避免两套 Worker 并存）；
- `offline-ai-worker.test.mjs` 改为在 Node vm 中真实执行 `init + decision` 协议往返，继续覆盖“嵌入闭包完整性”这一原始防回归目标；
- `decision-core` 固定注入 `CHAMPION_PARAMETERS`，与 AI6 正式入口的 `championParameters` 透传逐位同源。

### 4.2 信息边界

- 页面只发送 `buildObservation(game)` 产出的公开观察；
- Worker 端 `validateDecisionPayload` 递归校验：字段白名单、禁止字段、数值范围、玩家数 2–6、市场规模等；
- 随机流固定 `simSeed = 0`（与主线程 `chooseJointAction` 缺省一致），**不读取真实牌库种子**；
- `ai` 描述符只含 `jointVersion`（当前 `joint-js5`），预算从 `CHAMPION_PARAMETERS.budgetMs`（100ms）读取，避免两套口径。

### 4.3 生命周期

| 场景 | 页面行为 |
|---|---|
| 新决策请求 | `requestId` + `gameStateVersion` 双标识；新请求先废弃旧 inflight |
| 游戏状态变化 | `stateVersion++`，`invalidate()` 立即废弃旧任务并终止忙碌 Worker |
| 用户取消（帮助/历史/暂停/换局） | `cancelBot()` 递增 `runId`、客户端 cancel；旧 Promise 结果永不提交 |
| 超时 | 客户端看门狗 = 预算 + 2s；超时终止 Worker，使用已验证合法回退 |
| Worker 崩溃 | 重生并原样重试一次；再次失败 → 回退 |
| Worker 无法启动 | **锁定本局主线程冠军降级**，顶栏 chip 变为「AI 主线程降级」并提示一次；不再逐回合等待启动超时 |
| 返回行动 | 页面用正式引擎 `applyAction` 复核；非法则使用 `chooseVerifiedFallback` 并显式提示 |
| 过期/取消结果 | `decide()` 返回 `null`，页面不提交 |

### 4.4 降级语义

- **Worker 正常**：顶栏 `AI Worker`，无额外提示。
- **Worker 启动失败**：顶栏 `AI 主线程降级`；使用 `chooseAIAction`（同一 JS5 冠军），棋力不变，界面可能短暂停顿。
- **单次决策失败**（看门狗/崩溃重试后）：使用 `chooseVerifiedFallback`（公开合法集首个行动 / 冠军 `trimStock` 溢出口径），toast 显式披露原因。
- 绝不在未知版本下静默执行：未知 `jointVersion`、协议主版本不一致、载荷越权都会显式报错并回退。

### 4.5 单文件部署验证

`scripts/smoke_desktop_runtime.py` 按 Pages 工作流组装 `_site`：

- `standalone.html` → `index.html`；
- HTTP 服务挂载在 `/Century/`；
- Chromium（本机 Chrome）与 WebKit 均创建内联 Blob Worker；
- 14 次运行的 Worker 决策成功率 100%（`workerDecisions` 4/4、8/8，`fallbacks=0`，`spawnFailures=0`）。

---

## 5. E4：行为一致性

测试文件：`web-v1/tests/ai-runtime-desktop.test.mjs`。

### 5.1 方法

- 主线程参照：`chooseJointAction(game, {version:'joint-js5', workUnits:8, horizon:40, simSeed:20261025})`
- Worker：`client.requestDecision` 固定 `fixed-work` 8、同 `simSeed`、同 `horizon`
- 比较：行动逐位相等；`rollouts`、`gated` 相等；行动必须通过正式引擎 `applyAction`
- 局面：
  - 2 / 3 / 4 / 5 人各 2 个真实合法局面（JS2 推进到 AI 行动）
  - 5 人临近终局冻结局面（`tests/fixtures/js5-near-terminal-c10.json`，16 workUnits）
  - 6 人扩展（2 真人 + 4 AI，6 workUnits）

结果：全部一致，测试通过。

### 5.2 墙钟噪声

同一 4 人局、120ms 墙钟预算、3 次采样：

| 采样 | Worker 行动 = 主线程 | Worker rollouts | 主线程 rollouts | Worker elapsed | 主线程 elapsed |
|---|---|---|---|---|---|
| 1 | 是 | 16 | 32 | 156ms | 140ms |
| 2 | 是 | 16 | 32 | 104ms | 141ms |
| 3 | 是 | 32 | 32 | 163ms | 123ms |

轨迹数差异来自批次中途的计时截止，而非算法/参数/随机流不同；三次行动均一致。**不得把这种差异判为逻辑不一致。**

---

## 6. E5：浏览器实测

脚本：`web-v1/scripts/smoke_desktop_runtime.py`
指标：`docs/ai7/desktop-runtime-metrics.json`；基线：`docs/ai7/baseline-metrics.json`

覆盖：Chromium + WebKit × 3440×1440 / 1920×1080 / 1440×900 ×（1H+4AI、2H+2AI）+ 16 张手牌压力局面 = 14 次运行。

| 项目 | 结果 |
|---|---|
| 横向溢出 | 0/14 |
| 纵向溢出 | 1H+4AI 0/12；2H+AI 1440 保留既有纵向滚动（基线 1454px → 本分支 1454px，结构未改） |
| 首屏信息 | 1H+4AI 三种分辨率：手牌 / 市场 / AI 轨道均可见 |
| 手牌字号 | 11px（1440/1920）、12px（3440）；基线 10px |
| AI 已打出展示 | 所有 solo 运行 ≥1 张；2×2 轨道 3–4 AI 全部可见 |
| 主线程 longtask | 基线 4 回合：84–105ms/次，合计 365–383ms；本分支 0ms |
| 帧间隙 | Chromium ≤17ms；WebKit ≤28ms |
| 交互响应（视图切换） | 2.5–6ms |
| Worker 决策成功率 | 100%（无 fallback / 无 spawn failure） |
| 页面错误 | 0 |

截图：

- [1H+4AI 3440 Chromium](docs/ai7/screenshots/chromium-solo-3440x1440.jpg)
- [1H+4AI 1920 Chromium](docs/ai7/screenshots/chromium-solo-1920x1080.jpg)
- [1H+4AI 1440 Chromium](docs/ai7/screenshots/chromium-solo-1440x900.jpg)
- [1H+4AI 3440 WebKit](docs/ai7/screenshots/webkit-solo-3440x1440.jpg)
- [1H+4AI 1440 WebKit](docs/ai7/screenshots/webkit-solo-1440x900.jpg)
- [2H+2AI 3440 Chromium](docs/ai7/screenshots/chromium-human_ai-3440x1440.jpg)
- [16 张手牌压力 1440 Chromium](docs/ai7/screenshots/chromium-pressure-1440x900.jpg)

---

## 7. 规则与冠军未改变的证据

- `git diff --stat` 仅包含 UI、运行时、构建、测试与证据文件；`src/engine.ts`、`src/ai/**`、`src/js/**`、`training/**` 无改动。
- Worker 决策核心直接复用 `createChampionGuidedPlanner` / `createJointPlanner` / 冠军 `trimStock`，未新增/修改搜索参数。
- 身份测试断言 `championDecisionConfig()` 为 `champion-guided` / `joint-js5` / 100ms / `simSeed=0`，且不读取对局种子。
- 现有规则/AI/冠军回归套件全部通过（见第 8 节命令）。

---

## 8. 复现

```bash
cd web-v1
npm ci
npm test                         # tsc + 构建 + 全部单元测试
python3 scripts/smoke_desktop_runtime.py   # Chromium + WebKit 桌面矩阵
python3 scripts/smoke_focus.py             # 2 真人成熟布局回归
python3 scripts/live-five-smoke.py         # 真实行动/开局回归
python3 scripts/smoke_organize.py          # 手牌整理/压力手牌回归
```

关键提交文件：

- `web-v1/src/ai-runtime/desktop-runtime.ts`（生产接入层）
- `web-v1/src/app.ts`（Focus 布局、AI 轨道、Worker 生命周期）
- `web-v1/src/styles.css`（solo Focus、AI 轨道、响应式）
- `web-v1/scripts/build.mjs`（内联 Worker 构建）
- `web-v1/tests/ai-runtime-desktop.test.mjs`（E4 一致性）
- `web-v1/scripts/smoke_desktop_runtime.py`（E5）
- `docs/ai7/`（前后截图与指标 JSON）

---

## 9. 已知限制与风险

1. **2 真人 + AI 的 1440 纵向滚动**：为遵守「保留成熟布局」约束，未重排该布局；1440 宽下按既有设计纵向滚动（基线 1454px，本分支 1454px，结构未改）。1 真人默认布局已精确一首屏。
2. **Blob Worker 依赖**：极旧浏览器或严格 CSP 若阻断 Blob Worker，会显式降级为主线程冠军（顶栏可见、提示一次），不会静默换算法。
3. **墙钟预算不可逐位重放**：生产默认 100ms 墙钟；一致性断言只在固定工作量模式下逐位成立。墙钟差异按轨迹数解释，报告已单独披露。
4. **6 人扩展**：协议玩家上限从 5 放宽到 6 只为承载既有「2 真人 + 4 AI」非官方扩展；正式规则仍为 2–5 人。
5. **AI 引擎轨道密度**：3–4 AI 在 1440 下引擎卡为 115×183；这是在不挤压真人与市场前提下的紧凑档，详情浮层提供完整卡面。

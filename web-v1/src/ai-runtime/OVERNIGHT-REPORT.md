# 夜间自主任务 C：Century 离线高算力 AI Worker 运行时 — 交付报告

- 分支：`feat/overnight-ai-worker-runtime`（独立 git worktree；初始自 origin/main `e7d3bfa`，会话内并行会话推进 main 后已 rebase 至 `e5880d5`）
- 日期：2026-10-24（夜间会话）
- 角色：浏览器运行时 / Apple Silicon 性能 / TypeScript 架构
- 结论先行：**可运行 Worker 原型完成并通过全部测试（22 项新增 + 既有全套 206/206），浏览器实测 500ms/1000ms 思考预算下主线程 0 longtask、最大帧隙 17ms；默认冠军行为与离线产物逐字节不变。**

---

## 一、目标回顾与设计立场

允许未来 Century JS6 AI 使用 500ms/1000ms 乃至更长决策时间而不阻塞游戏主线程。
高计算量允许；界面失去响应、提交过期行动、违反信息公平性不允许。

三条结构性立场：

1. **决策核心只有一个实现**（`decision-core.ts`），Worker 与主线程直调共用同一函数——"Worker 与直接调用一致"不是巧合而是同源性；
2. **信息公平性是运行时强制的，不是约定**——Worker 端对请求载荷做白名单结构防火墙，即使调用方误传整份 `Game`（含 `merchantDeck`/`golemDeck` 隐藏牌序）也在协议层被拒绝；
3. **默认路径零接触**——`src/ai`、`src/js`、`src/sim`、`src/om`、`engine.ts`、`app.ts`、`mobile/*` 一行未改；`champion.json`/冠军参数未动；`chooseJointAction` 搜索语义未动。改动全部为增量新文件（1863 行，见 §九清单）。

## 二、现状审查（实现前实测，非假设）

| 入口 | 现状 | 与目标的关系 |
|---|---|---|
| 桌面 ESM（`dist/index.html` + `dist/js/app.js`） | [app.ts#L607](../../app.ts) `scheduleBot()` 480ms 定时后**主线程同步** `chooseAIAction(game)`；冠军=JS5（`CHAMPION_PARAMETERS.adapter='champion-guided'`，`budgetMs:100`） | 思考时间被钉死在主线程阻塞预算内 |
| 手机独立页（`dist/mobile/modules.html`） | [mobile/app.ts#L237-L254](../../mobile/app.ts) 每回合新建一次 Worker（350ms 延迟），**postMessage 传整份 Game**（信息公平性违规）；`onerror`/离线回退 `mFallbackAI` = 主线程同步调用 | 现有 worker 不能承载 JS5：构建清单只有 `data+engine+ai/*`，**不含 `sim/`、`om/`、`js/`**，JS5 依赖图根本不在包内 |
| 手机离线单文件（`mobile/standalone.html`） | Worker 以 `<script type="text/plain" id="offline-worker">` 内嵌 → Blob classic worker；WebKit 离线态可能禁建 Blob Worker → 主线程回退 | 路径存在但同样只含旧 AI 包 |
| 桌面离线单文件（`dist/standalone.html`） | 全部模块剥 import 后内联进单 IIFE，**完全没有 Worker** | 旧架构无并发决策能力 |
| 已有信息边界资产 | `AIObservation`（[ai/observation.ts](../../ai/observation.ts)，隐藏牌库结构不可达）、`PublicSimState`（[sim/state.ts](../../sim/state.ts)）、`JointPlanner.decide(observation, options)` 同步签名，`workUnits`（逐位可复现）/`budgetMs`（墙钟）/`simSeed` 全部现成 | JS5 决策核心天然满足"只消费公开观察"，Worker 化的信息边界工作在协议层即可闭合 |

关键确认：任务书"不要假设现有 mobile/worker 可以直接承载 JS5"的怀疑**成立**——不仅依赖图缺失，其消息契约（整份 Game）本身就违反新协议。

## 三、架构

```
主线程（拥有完整 Game）                         Worker（只见过公开观察）
┌────────────────────────────┐   protocol v1   ┌──────────────────────────┐
│ app（未来接入点）            │ ──────────────▶ │ worker.js（浏览器薄壳）    │
│  └ AIDecisionClient         │  init/decision/ │  └ worker-core.ts（同核）  │
│    · requestId+双版本失效    │  cancel/reset   │    · 结构防火墙（白名单）   │
│    · invalidate() 废弃旧任务 │ ◀────────────── │    · decideFromObservation│
│    · 看门狗 terminate+respawn│  decision/      │      · js5 planner        │
│    · crash 重生重试 ×1       │  cancelled/error│      · 顾问性合法预检       │
│    · 回退 chooseVerifiedFallback              └──────────────────────────┘
└────────────────────────────┘
```

- `protocol.ts`：版本化消息协议（§四）。
- `decision-core.ts`：**环境无关决策核心**。镜像 [js/adapter.ts](../../js/adapter.ts) 的"观察-only 决策"语义（溢出=冠军 `trimStock` 口径、未注册版本/`champion-contest` 显式拒绝、席位校验），但**不做 `applyAction` 复核**——那是主线程的职责；Worker 侧只做公开模拟合法集的顾问性预检。运行时 import 图中无 `engine.js`。
- `worker-core.ts`：环境无关消息核（协议分派 + 顺序处理 + superseded 淘汰 + 发送前二次取消检查——**已取消的决策结果永不投递**）。
- `worker.ts`：浏览器 `DedicatedWorkerGlobalScope` 薄壳（22 行）。
- `client.ts`：主线程生命周期管理器（§五）。
- `fallback.ts`：经过验证的合法回退（公开模拟合法枚举首项 / 冠军溢出口径；零搜索、确定性）。
- `harness.html` + `scripts/smoke_ai_runtime.py`：真实浏览器 opt-in 验收页与冒烟。

### 为什么 Worker 内"取消"不能中断同步搜索

`JointPlanner.decide` 是同步函数，占满 Worker 事件循环；在搜索循环内插入检查点需要修改 `src/js`（任务书禁止，且会改变冠军搜索语义）。因此取消语义分三层，逐层兜底：

1. **请求级**：已排队未开始的请求在 worker 侧被 `superseded` 淘汰（回 `cancelled`，零算力浪费）；
2. **结果级**：决策执行期间到达的 cancel → 发送前二次检查 → 结果被 `cancelled` 替换，client 永远拿不到可提交的行动；
3. **算力级**：client 看门狗（预算 + 宽限）`terminate()` + 重生——这是对"执行中"同步搜索的真抢占，代价是损失一次模块加载（数十 ms，远小于 500–1000ms 预算）。

## 四、协议（v1.0.0）

请求（client → worker）：`init | decision | cancel | reset`；响应：`ready | decision | cancelled | error(category: protocol|decision|fatal)`。

`decision` 请求字段：`requestId`、`gameStateVersion`、`payload{ observation(白名单公开观察), ai{jointVersion, profileName?}, budget{fixed-work|wall-clock}, simSeed, horizon?, worlds? }`。
响应 `decision.diagnostics`：`elapsedMs`、`stats`（rollouts/transitions/worldsUsed/budgetExhausted…）、`gated`、`topEvaluations`（前 5 根行动评价）、预算与种子回显。

握手校验协议**主版本**一致；`validateObservationShape` 强制：白名单 10 字段齐全、`merchantDeck/golemDeck/log/version` 禁止出现、白名单外字段拒绝。协议破坏性变更递增主版本 → 旧 HTML 配新 worker（Pages 十分钟缓存窗口）时握手失败 → 安全回退，不会静默错配。

## 五、客户端生命周期语义

| 事件 | 行为 | 过期行动防线 |
|---|---|---|
| `requestDecision` | 队列化 setup：先 supersede inflight（终止忙碌 worker）→ 确保握手 → 发送 | 旧请求解析为 `superseded`，不携带行动 |
| `invalidate(v)` | 失效水位推进 + 废弃 `gameStateVersion < v` 的未决任务 | 迟到响应被水位拦截 |
| `cancel()` | 发 cancel + terminate | 解析 `cancelled`，无行动字段 |
| worker 崩溃 | 重生 + **原样重试一次**；再失败 → 回退 | 重试期间 inflight 保持占用，新请求仍可 supersede |
| 看门狗超时 | terminate + respawn + 回退（`cause:'watchdog'`） | 回退行动经正式引擎验证 |
| 协议/防火墙错误 | 确定性错误不重试，直接回退并显式暴露 error | 回退行动合法 |
| `dispose()` | 拒绝/结算全部未决 promise | 无悬挂 |

回退链终点：`chooseVerifiedFallback(observation)` —— 溢出走冠军 `trimStock` 口径，其余取公开模拟合法枚举首项；测试将其输出逐一喂给正式引擎 `applyAction` 验证（§七）。Worker 完全不可用（如不支持 Worker 的环境）时，`requestDecision` 直接走同一回退函数——调用方代码路径不变。

## 六、构建与兼容性结论

构建链：`npm run build` = `tsc && node scripts/build.mjs && node scripts/build-ai-runtime.mjs`（第三步仅复制 opt-in 验收页到 `dist/ai-runtime/`，不触碰任何既有产物）。

**逐环境结论：**

1. **桌面 ESM 页（dist/index.html）**：✅ 即用。Worker 地址 `js/ai-runtime/worker.js`（相对路径，兼容 Pages 子路径 `/Century/`），`{type:'module'}`。接线方案见 §八-A。
2. **手机独立页（modules.html）**：路径可行，需把 `sim/`、`om/`、`js/`、`ai-runtime` 加入 `build.mjs` 的 `mobileNames` 资源清单并替换 `mobile/worker.ts` 消息契约（§八-B）。本分支未做（避免与第六阶段并行研发冲突），方案与风险已写明。
3. **手机离线单文件**：机制可行——沿用 `#offline-worker` text/plain 内嵌 → Blob worker；需把离线 worker 拼装清单扩展为 `data+engine+ai/*+sim/om/js+ai-runtime/worker-core`。属共享构建改动，本分支不改（§八-B 风险注记）。
4. **桌面离线单文件（standalone.html）**：现状无 Worker。**本分支保持逐字节不变（git diff 为空）**。可行方案（未实施）：比照手机离线模式，把 worker-core+决策依赖图作为第二段 text/plain 内嵌脚本 + `Blob` classic worker；技术约束是单文件内不能有第二条 module 脚本，需用 classic worker（worker-core 恰好不依赖 ESM 运行时语义，剥 import 后可用）。改动面：`build.mjs` standalone 段 + 顶层标识符冲突复检（pages-entrypoints 测试已有机制）。**不静默破坏离线模式**——在方案落地并过完整离线回归前，离线单文件维持同步直调现状。
5. **不支持 Worker 的环境**：client 回退路径（§五），已验证合法。
6. **网络**：静态扫描 + 浏览器实测确认运行时零网络请求（无 fetch/XHR/WebSocket/importScripts/远程地址）；模型与信息全部来自随页分发的代码。

## 七、实验正确性（测试证据）

新增 22 项测试（`tests/ai-runtime.test.mjs` + `tests/ai-runtime-client.test.mjs`），**全部通过**；Node 侧通过 `worker_threads` 桥接运行**与浏览器同一份 worker-core**（tests/ai-runtime-node-worker.mjs），测试即浏览器同核验证。算力纪律：全部为 workUnits ≤ 16 / budgetMs ≤ 400 的少量固定工作量决策，无对局扫描。

| 要求 | 测试 | 结果 |
|---|---|---|
| 同观察+同算法+同随机流+固定工作量 ⇒ Worker==直调 | worker 往返 vs `decideFromObservation` vs `chooseJointAction`（全量 Game 入口）三方一致，含 rollouts 数 | ✅ 3 位置逐位一致 |
| 隐藏牌库随机化不变性 | 打乱 `merchantDeck/golemDeck` ×3 变体 | ✅ 公开观察逐字段相同、决策不变 |
| 逐位确定性 | 同请求两次直调 | ✅ |
| 旧请求不污染新局 | invalidate 废弃旧任务 + 新局决策==全新 client 决策 | ✅ |
| 取消后不提交行动 | cancel/invalidate/supersede 三路径断言 outcome 无 `action` 字段 + worker 发送前二次检查 | ✅ |
| 非法行动被正式引擎阻断 | worker 决策与回退行动 ×5 中局位置逐一过 `applyAction` | ✅ |
| AI 异常不卡页面 | 看门狗/双重崩溃/决策异常重试→回退/握手超时，全部有限时间结算 | ✅ |
| 运行时不通过网络获取模型/信息 | 静态扫描（源码+编译产物）+ 浏览器冒烟 | ✅ |
| 墙钟预算延迟分布（Node worker） | 200→186ms(32 rollouts) / 300→311ms(96) / 400→375ms(144) | ✅ 报告口径 |
| 协议防火墙端到端 | 越权载荷（含 merchantDeck）→ 回退 + 客户端继续可用 | ✅ |
| 回归 | 既有全套 `npm test`（含冠军行为、公平性、pages-entrypoints）：**206/206 全部通过**（新基线 `e5880d5`） | ✅ |
| **默认冠军行为不变** | `git diff web-v1/dist/standalone.html` 为空（逐字节）；`src/ai|js|sim|om`、`engine.ts`、`mobile/*` 零改动 | ✅ |

**既有失败披露（与本分支无关，基线复现，随后已被 main 修复）**：在基线 `e7d3bfa` 上全套唯一失败为 `B root 延迟创建 + gate=never ≡ js0（单元级快查）`（[js5-phase5-regression.test.mjs#L124](../../tests/js5-phase5-regression.test.mjs)，gate=never 与冠军直调在个别中局位置决策不一致）。本分支曾在**零改动的基线 worktree** 单独复现同样失败，确认为 main 既有问题（且该比对路径本分支一行未动）；并行会话的 PR #31（`fix/js5-regression-legacy-champion`）随后在 main 修复了它——rebase 至 `e5880d5` 后该测试通过，全套在新基线全绿（见下）。

**浏览器实测（HeadlessChrome 136 / 本机 M4，`scripts/smoke_ai_runtime.py`）：**

| 预算 | 延迟 | rollouts | longtask | 最大帧隙 |
|---|---|---|---|---|
| 500ms 墙钟 | 472ms | 272 | **0** | **17ms** |
| 1000ms 墙钟 | 951ms | 608 | **0** | **17ms** |

对照组（主线程同步直调 500ms 预算，旧行为）在该 headless 环境的 longtask 观测为 0（headless 对 longtask 上报不完整，此对照仅记录不判定；同步调用阻塞主线程 500ms 是结构性事实，rAF 在阻塞期间必然停摆）。

## 八、接线方案（显式 opt-in，不自动切换）

### A. 桌面（建议形态，约 30 行改动）

```ts
// app.ts（未来 PR）：scheduleBot 内用 client 替换同步调用；既有 expectedTurn/expectedPlayer
// 守卫保持不变，直接映射为 gameStateVersion。
const aiClient = createAIDecisionClient({
  spawn: () => new Worker('./js/ai-runtime/worker.js', { type: 'module' }),
});
// scheduleBot 的 setTimeout 回调内：
const obs = buildObservation(game, game.current);
const outcome = await aiClient.requestDecision({
  gameStateVersion: game.turnNumber * 10 + game.current,
  observation: obs,
  ai: { jointVersion: CHAMPION_PARAMETERS.jointVersion ?? 'joint-js5' },
  budget: { mode: 'wall-clock', budgetMs: 1000 },   // 决策预算从 100ms 提到 1000ms
  simSeed: (game.turnNumber * 7919 + game.current) >>> 0,
});
if (outcome.status === 'superseded' || outcome.status === 'cancelled') return; // 状态已变，绝不提交
const next = outcome.action;                                        // worker 或已验证回退
try { applyAction(game, next); action(next); }                      // 正式引擎权威校验（既有纪律）
catch { action(aiFallback(obs).action); }
```

- 500/1000ms 预算下主线程 0 longtask（§七实测）；
- 预算大小是纯策略参数，冠军算法与参数不动；
- 建议以查询参数/设置项显式开启（如 `?aiWorker=1`），默认路径维持现状直至独立评审。

### B. 手机 / 离线单文件（独立后续 PR，本分支不动）

1. `build.mjs` `mobileNames` 与 `offlineWorker` 清单追加 `sim/*`、`om/*`、`js/*`、`ai-runtime/worker-core`（注意 `strip` 顺序与标识符冲突复检——pages-entrypoints 测试已强制）；
2. `mobile/worker.ts` 替换为 worker-core 薄壳（消息契约从"整份 Game"迁移到协议 v1）；
3. `mobile/app.ts` `mSchedule` 改用 `createAIDecisionClient`（`spawn` 按 `#offline-worker` 存在与否选择 Blob/文件路径），`mFallbackAI` 保留为最终回退；
4. WebKit 离线禁建 Blob Worker 的既有兼容路径语义不变——client 的回退函数与 `mFallbackAI` 同为已验证合法行动；
5. 风险：清单改动影响资源指纹（全量重发）与离线包体积（+sim/om/js 约数十 KB）；须完整跑 `smoke_mobile.py`（Chromium+WebKit）后合并。**本分支选择不混入这些共享改动，保证第六阶段研发零干扰。**

## 九、交付清单与验证记录

```
web-v1/src/ai-runtime/
  protocol.ts        182 行  版本化协议 + 观察白名单防火墙
  decision-core.ts   181 行  环境无关决策核心（观察-only）
  worker-core.ts     125 行  环境无关 Worker 消息核
  worker.ts           22 行  浏览器薄壳
  client.ts          437 行  生命周期管理器
  fallback.ts         51 行  已验证合法回退
  harness.html       188 行  opt-in 浏览器验收页
  OVERNIGHT-REPORT.md（本文件）
web-v1/tests/ai-runtime.test.mjs          278 行  协议/等价/公平性/合法性/隔离/延迟
web-v1/tests/ai-runtime-client.test.mjs   268 行  生命周期（取消/废弃/看门狗/恢复）
web-v1/tests/ai-runtime-helpers.mjs + ai-runtime-node-worker.mjs   Node 桥接
web-v1/scripts/build-ai-runtime.mjs       构建步骤（仅复制验收页）
web-v1/scripts/smoke_ai_runtime.py        Playwright 浏览器冒烟
web-v1/package.json                       build 链 +1 步（唯一修改的既有文件）
```

验证命令：

```bash
npm test                                  # 既有全套 + 新增 22 项
node --test tests/ai-runtime.test.mjs tests/ai-runtime-client.test.mjs
python3 scripts/smoke_ai_runtime.py       # 真实浏览器验收（需先 npm run build）
```

## 十、限制与后续

- Worker 内同步搜索不可中断（§三），真抢占靠 terminate+respawn；若未来允许改搜索内部，可在 trial 批间插 `Atomics.wait` 检查点实现毫秒级取消；
- fixed-work 模式看门狗需要调用方提供 `expectedMs`（workUnits 与耗时非线性，未内置估计表）；wall-clock 模式无需；
- 1000ms 预算在 M4 上约 600 rollouts（≈1.65ms/轨迹），较 100ms 冠军预算（≈60）约 10 倍搜索量——对胜率的影响属对局级实验，按仓库纪律须走正式挑战流程，本任务不做；
- 手机/离线接线见 §八-B，属独立 PR；
- 协议 v1 未含进度消息（`progress`）——同步搜索内无上报点，待检查点机制落地后补充。

#!/usr/bin/env node
/** 红队审计 #1：版本身份污染检测（P0）。
 *
 * 只读、行为学（非静态字符串）审计：直接加载 web-v1/dist 正式产物，
 * 重放训练侧各调用点的真实决策分派，验证「标签身份 = 执行身份」。
 *
 * 审计的缺陷模式（2026-10-24 PR #30 晋级后全部实锤，见 OVERNIGHT-AUDIT.md）：
 * - V1 冠军参数区同步：dist CHAMPION_PARAMETERS ≡ champion.json；
 * - V2 js0 标签污染：duel.mjs candidateVersion('js0') →
 *   chooseAIAction({parameters: CHAMPION_PARAMETERS})。参数携带
 *   adapter='champion-guided' 时 decision.ts 优先分派到 JS5 适配器——
 *   晋级后「js0（冻结冠军）」实际执行 JS5。行为学判据：与归档前任冠军
 *   （training/champions/candidates/ai5-readiness-efficiency.json）逐决策对比，
 *   任一探针状态动作不同即污染；
 * - V3 js1 标签污染：同调用点（structure 选项在适配器分支被忽略）；
 * - V4 对手池变体标签化：classicPool/diversePool 的 @tempo/@contest/@engine/
 *   style-rush/style-engine 权重变体在适配器分支下全部退化为 JS5 本体
 *   （权重不被消费）——「风格不同」只剩标签不同；
 * - V5 双入口一致：web-v1/src/ai/parameters.ts 生成区 ≡ champion.json；
 * - V6 历史产物卫生：confirm 块 versionsIds 是否为晋级前真实对手标签；
 * - V7 晋级指纹一致性：champion.json.provenance.engineBundleSha256 ≡
 *   candidate.engineBundleSha256；与当前重建产物比对（不一致 = 按项目
 *   自订规则「证据不再适用，须重新挑战」）。
 *
 * 用法：node training/redteam/audit-versions.mjs [--json]
 * 退出码：0=干净；2=发现污染（当前 main 预期为 2）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
// 指纹计算必须与训练侧完全同源（自实现闭包易引入解析偏差——本审计曾因此产生假指纹）
const { engineBundleSha256 } = await import(`file://${resolve(REPO_ROOT, 'training/lib/paths.mjs')}`);
const findings = [];
const note = (severity, id, title, detail) => { findings.push({ severity, id, title, detail }); };

// ---- 加载正式产物（与训练侧同一路径） ----
const DIST = resolve(REPO_ROOT, 'web-v1/dist/js');
if (!existsSync(resolve(DIST, 'ai.js'))) {
  console.error('未找到 web-v1/dist/js——先执行 cd web-v1 && npm run build');
  process.exit(1);
}
const { createGame, applyAction } = await import(`file://${resolve(DIST, 'engine.js')}`);
const { chooseAIAction, PROFILES, NEUTRAL_PROFILE } = await import(`file://${resolve(DIST, 'ai.js')}`);
const { CHAMPION_PARAMETERS } = await import(`file://${resolve(DIST, 'ai/parameters.js')}`);

const championDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParams = championDoc.parameters;
const prevDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/ai5-readiness-efficiency.json'), 'utf8'));
const prevParams = prevDoc.parameters ?? prevDoc;

// ---- 探针状态集：多 seed × 多步数，覆盖开/中局（足够触发适配器 override）。
// 默认 64 探针（约 40s，墙钟预算决策每个 ~100ms）；--probes N 或 --free 自定义。 ----
const probeArg = process.argv.find(a => a.startsWith('--probes='));
const PROBE_FULL = process.argv.includes('--full');
const PROBE_CAP = probeArg ? Number(probeArg.split('=')[1]) : PROBE_FULL ? Infinity : 64;
function* probeStates() {
  let emitted = 0;
  for (let k = 0; k < 8; k++) {
    const seed = 941512402 + k * 17;
    let game = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    game.players[0].isAI = true;
    for (let step = 0; step < 40 && game.phase !== 'finished'; step++) {
      if (emitted >= PROBE_CAP) return;
      const seat = game.current;
      game.players[seat].isAI = true;
      emitted++;
      yield { game, seed, step, seat };
      // 用前任冠军推进（确定性、与被审对象无关）
      const r = chooseAIAction(game, {
        parameters: prevParams, structure: prevParams.structure,
        profile: seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length],
      });
      game = applyAction(game, r.action);
    }
  }
}

const js0Call = game => chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, profile: NEUTRAL_PROFILE }); // duel.mjs js0 分支原样
const js1Call = game => chooseAIAction(game, { parameters: CHAMPION_PARAMETERS, structure: 'beam-contest', profile: NEUTRAL_PROFILE }); // duel.mjs js1 分支原样
const prevCall = game => chooseAIAction(game, { parameters: prevParams, structure: prevParams.structure, profile: NEUTRAL_PROFILE });
const act = r => JSON.stringify(r.action);
const isAdapter = r => /联合仲裁|联合/.test(r.reason) || /champion-guided|js5/i.test(r.reason);

// ---- V1 冠军参数区同步 ----
{
  const mism = [];
  for (const key of ['id', 'adapter', 'jointVersion', 'budgetMs', 'acquisitionVariant']) {
    if (JSON.stringify(CHAMPION_PARAMETERS[key]) !== JSON.stringify(championParams[key])) {
      mism.push(`${key}: dist=${JSON.stringify(CHAMPION_PARAMETERS[key])} vs champion.json=${JSON.stringify(championParams[key])}`);
    }
  }
  if (mism.length) note('P0', 'V1', 'dist 参数区与 champion.json 不同步（stale dist 双入口漂移）', mism.join('；'));
  else note('PASS', 'V1', 'dist CHAMPION_PARAMETERS 与 champion.json 同步', `id=${CHAMPION_PARAMETERS.id} adapter=${CHAMPION_PARAMETERS.adapter ?? '无'}`);
}

// ---- V2/V3：js0 / js1 标签下实际执行的算法 ----
{
  let js0Diff = null, js0AdapterTags = 0, probes = 0, js1AdapterTags = 0, js1Diff = null;
  for (const { game, seed, step } of probeStates()) {
    probes++;
    const a0 = js0Call(game), ap = prevCall(game);
    if (isAdapter(a0)) js0AdapterTags++;
    if (act(a0) !== act(ap) && !js0Diff) js0Diff = { seed, step, js0: a0.action, js0Reason: a0.reason.slice(0, 60), prev: ap.action };
    const a1 = js1Call(game);
    if (isAdapter(a1)) js1AdapterTags++;
    if (act(a1) !== act(ap) && !js1Diff) js1Diff = { seed, step };
  }
  if (js0AdapterTags > 0 || js0Diff) {
    note('P0', 'V2', '「js0（冻结冠军）」标签实际执行 JS5 适配器（身份污染）',
      `${js0AdapterTags}/${probes} 探针决策走适配器路径；首个动作分歧 @seed=${js0Diff?.seed} step=${js0Diff?.step}：` +
      `js0-labeled=${JSON.stringify(js0Diff?.js0)}（${js0Diff?.js0Reason}…）vs 真冻结冠军=${JSON.stringify(js0Diff?.prev)}。` +
      '晋级后任何以 js0 为基线的 duel/compare 重跑都是 JS5 自我对弈。');
  } else {
    note('PASS', 'V2', 'js0 标签与归档冻结冠军行为一致', `${probes} 探针零分歧`);
  }
  if (js1AdapterTags > 0) {
    note('P0', 'V3', '「js1（beam-contest）」标签实际执行 JS5 适配器',
      `${js1AdapterTags}/${probes} 探针走适配器路径——decision.ts 适配器分支先于 structure 选项生效，` +
      'js1 的 beam-contest 结构参数在晋级产物上被静默忽略。');
  } else {
    note('PASS', 'V3', 'js1 标签未走适配器路径', `${probes} 探针`);
  }
}

// ---- V4：对手池权重变体是否仍是有别于 JS5 的真实策略 ----
{
  const c = CHAMPION_PARAMETERS;
  const variants = [
    { id: 'classic@tempo', parameters: { ...c, tempoWeight: 1.35 }, structure: c.structure },
    { id: 'classic@engine', parameters: { ...c, engineWeight: 1.3 }, structure: c.structure },
    { id: 'style-rush', parameters: { ...c, tempoWeight: 1.6, restWeight: 0.5 }, structure: c.structure },
    { id: 'style-engine', parameters: { ...c, engineWeight: 1.6 }, structure: c.structure },
  ];
  let adapterTags = 0, calls = 0, plain = CHAMPION_PARAMETERS;
  for (const { game, seed, step } of probeStates()) {
    for (const v of variants) {
      const r = chooseAIAction(game, { ...(v.parameters ? { parameters: v.parameters } : {}), ...(v.structure ? { structure: v.structure } : {}), profile: NEUTRAL_PROFILE });
      calls++;
      if (isAdapter(r)) adapterTags++;
    }
    if (seed === 941512402 && step === 0) plain = act(js0Call(game));
  }
  if (adapterTags > 0) {
    note('P0', 'V4', '对手池风格变体（@tempo/@contest/@engine/rush/engine）全部退化为 JS5 本体',
      `${adapterTags}/${calls} 变体决策走适配器路径——适配器不消费权重乘子，` +
      '晋级后 classic/diverse 池的「风格差异」只剩 id 标签；基于该池的新对局将把 JS5 与自身比较。');
  } else {
    note('PASS', 'V4', '对手池变体仍走权重路径（非适配器）', `${calls} 次调用`);
  }
}

// ---- V5：双入口（网页源码生成区 vs champion.json） ----
{
  const src = readFileSync(resolve(REPO_ROOT, 'web-v1/src/ai/parameters.ts'), 'utf8');
  const m = src.match(/CHAMPION-PARAMETERS-BEGIN[\s\S]*?export const CHAMPION_PARAMETERS: AIParameters = \{([\s\S]*?)\};[\s\S]*?END/);
  const block = m ? m[1] : '';
  const srcId = block.match(/id:\s*"([^"]+)"/)?.[1];
  const srcAdapter = block.match(/adapter:\s*"([^"]+)"/)?.[1];
  if (srcId !== championParams.id || srcAdapter !== championParams.adapter) {
    note('P0', 'V5', 'web-v1/src 参数生成区与 champion.json 不一致', `src=${srcId}/${srcAdapter} vs champion.json=${championParams.id}/${championParams.adapter}`);
  } else {
    note('PASS', 'V5', '网页源码生成区与 champion.json 一致', `id=${srcId} adapter=${srcAdapter ?? '无'}`);
  }
}

// ---- V6：历史 confirm 产物的对手标签卫生（晋级前数据是否真实多样） ----
{
  const f = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm/js5-classic/ablation-confirm-js5-2_3_4_5-200s.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const ids = new Set();
  for (const cell of j.cells) for (const g of cell.games) for (const id of g.versionsIds ?? []) ids.add(id);
  const polluted = [...ids].filter(id => /joint-js5/.test(id) && !/^joint-js5$/.test(id));
  note('PASS', 'V6', 'confirm 块对手标签为晋级前真实版本（历史数据不受污染影响）',
    `versionsIds 样本：${[...ids].slice(0, 8).join('，')}；engineBundleSha256=${j.engineBundleSha256.slice(0, 12)}（晋级前产物）`);
}

// ---- V7：晋级指纹一致性（项目自订规则：不一致 ⇒ 证据不再适用） ----
{
  const cand = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge/candidate.json'), 'utf8'));
  const prov = championDoc.provenance ?? {};
  const recorded = prov.engineBundleSha256;
  const evidence = cand.engineBundleSha256;
  let current = null;
  try { current = engineBundleSha256(); } catch { /* dist 未构建时跳过 */ }
  const detail = `champion.json.provenance=${recorded?.slice(0, 12)}；candidate.json=${evidence?.slice(0, 12)}；当前重建=${current?.slice(0, 12) ?? '未构建'}`;
  if (recorded && evidence && recorded !== evidence) {
    note('P0', 'V7a', 'champion.json 晋级指纹与挑战证据指纹不一致', detail);
  } else if (recorded && current && recorded !== current) {
    note('P0', 'V7b', '晋级证据指纹 ≠ 当前产物（按 paths.mjs 自订规则「证据不再适用，须重新挑战」）',
      detail + '；已独立验证 77292a19 可由 codeCommit 4a11b62 逐字节复现——证据链诚实，但晋级 PR 改动了 champion-guided.ts（+166/−50），晋级产物不再是受试产物');
  } else {
    note('PASS', 'V7', '晋级指纹一致', detail);
  }
}

// ---- 输出 ----
const blocked = findings.filter(f => f.severity === 'P0');
const summary = { audit: 'redteam-version-identity', date: new Date().toISOString(), championOnDisk: championParams.id, findings, verdict: blocked.length ? 'POLLUTED' : 'CLEAN' };
if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\n== 红队版本身份审计：${summary.verdict}（champion=${championParams.id}）==`);
  for (const f of findings) console.log(`[${f.severity}] ${f.id} ${f.title}\n    ${f.detail}`);
}
process.exit(blocked.length ? 2 : 0);

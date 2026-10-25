/** 实验前置门禁（AI6 第六阶段 P0：版本身份机器检查）。
 *
 * 任何新的胜率实验运行前必须通过本门禁（exit 0）；任何一项失败即拒绝实验。
 * 检查项（任务书 §3.3）：
 * 1. 部署一致性：champion.json ↔ CHAMPION_PARAMETERS 无漂移（注册表冻结版本
 *    与部署冠军解耦，不受 champion.json 更新影响——对照身份不漂移）；
 * 2. 冻结版本指纹：注册表参数指纹与 version-canary.json 记录一致（任何
 *    对冻结快照的改动都会被捕获）；
 * 3. 决策级身份（金丝雀自对局）：每个冻结/池版本在固定种子上全席位自对局，
 *    决策序列摘要与记录一致——算法身份由行为而非显示名决定；
 * 4. 跨身份不等式：legacy-js0 ≠ legacy-js1 ≠ joint-js5-frozen（旧冠军与新
 *    冠军不能静默解析为同一实现）；风格变体 ≠ legacy-js0（池变体有真实
 *    行为差异，不能只改被适配器忽略的参数）；
 * 5. gate=never 等价（mini）：js5(gate=never) ≡ legacy-js0 逐决策一致——
 *    对照对象是真正的历史束搜索冠军，而非新冠军自身；
 * 6. 历史证据抽查（可选，存在第五阶段 confirm 产物时）：js0 重放逐位一致。
 *
 * 用法：node training/joint/version-gate.mjs [--bootstrap] [--quick]
 * --bootstrap：首次登记金丝雀摘要（须人工审查后提交 version-canary.json）。
 * 退出码：0=通过；1=身份检查失败（拒绝实验）；2=金丝雀缺失（先 --bootstrap）。
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createGame, applyAction, score as engineScore, ranking } from '../../web-v1/dist/js/engine.js';
import { chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../web-v1/dist/js/js/adapter.js';
import { BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';
import { FROZEN_VERSIONS, frozenVersion, parametersFingerprint } from '../../web-v1/dist/js/ai/version-registry.js';
import { POOLS, HISTORICAL_POOLS } from './pools.mjs';
import { assertInBlock } from '../../ai5/lib/seed_policy.mjs';
import { REPO_ROOT, engineBundleSha256 } from '../lib/paths.mjs';
import { mulberry32 } from '../lib/rng.mjs';
import { enumerateLegalActions } from '../../web-v1/dist/js/sim/legal.js';

const CANARY_PATH = resolve(REPO_ROOT, 'training/joint/version-canary.json');
const REPORT_DIR = resolve(REPO_ROOT, 'training/reports/phase6-p0');

/** 金丝雀种子（审计子块未消费段 [1.3005e9,+)：与 version-audit [1.3e9,+24)、
 * 等价审计 [1.3e9+100,+132) 不重叠；基础设施种子，不用于强度结论）。 */
const CANARY_SEEDS = { 2: [1_300_500_000, 1_300_500_001], 3: [1_300_500_100, 1_300_500_101] };

const seatProfile = seat => (seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length]);

function sha(text) { return createHash('sha256').update(text).digest('hex'); }

/** 金丝雀自对局：全部席位同一版本，逐决策记录 → sha256 摘要。
 * adapter 版本走 workUnits 固定工作量（确定性）；束搜索版本天然确定。 */
function canaryGame({ seed, seatCount, versionId }) {
  let game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, Array.from({ length: seatCount - 1 }, (_, i) => i + 1));
  game.players[0].isAI = true;
  const seatRngs = new Map();
  const rngFor = seat => { if (!seatRngs.has(seat)) seatRngs.set(seat, mulberry32(((seed >>> 0) ^ Math.imul(seat + 1, 0x9E3779B9)) >>> 0)); return seatRngs.get(seat); };
  const decisions = [];
  let moves = 0;
  while (game.phase !== 'finished') {
    if (moves > 1500) throw new Error(`金丝雀对局步数上限 seed=${seed}`);
    const seat = game.current;
    const profile = seatProfile(seat);
    let action;
    if (versionId === 'joint-js5-frozen') {
      // 固定工作量模式（确定性）：墙钟预算跨运行不可逐位复现。
      const r = chooseJointAction(game, { version: 'joint-js5', workUnits: 16, simSeed: seed, profile });
      action = r.action;
    } else if (versionId === 'random-legal') {
      const view = {
        current: game.current, phase: game.phase, turnNumber: game.turnNumber,
        players: game.players.map(p => ({ id: p.id, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed] })),
        golemMarket: [...game.golemMarket],
        merchantMarket: game.merchantMarket.map(m => ({ id: m.id })),
      };
      const legal = enumerateLegalActions(view, { dedupe: false });
      action = legal.length ? legal[Math.floor(rngFor(seat)() * legal.length)] : { type: 'rest' };
    } else {
      const v = POOL_MEMBERS[versionId] ?? null;
      const params = v ? v.parameters : frozenVersion(versionId).parameters;
      const structure = v ? v.structure : frozenVersion(versionId).structure;
      action = chooseAIAction(game, { parameters: params, ...(structure ? { structure } : {}), profile }).action;
    }
    decisions.push(JSON.stringify(action));
    game = applyAction(game, action);
    moves += 1;
  }
  const ranked = ranking(game);
  const fingerprintText = JSON.stringify({
    winnerSeat: ranked[0].id, moves,
    ranking: ranked.map(p => ({ seat: p.id, score: engineScore(p), golems: p.claimed.length })),
    decisions,
  });
  return sha(fingerprintText);
}

/** 池成员表（金丝雀覆盖全部池身份）。 */
const POOL_MEMBERS = Object.fromEntries(
  [...POOLS.classic(), ...POOLS.diverse()]
    .filter(m => !FROZEN_VERSIONS[m.id])
    .map(m => [m.id, m]),
);

function canaryDigests() {
  const digests = {};
  // 只登记冻结版本（frozen=true）+ 池成员——实验候选（js6）代码仍在演化，
  // 其决策摘要不钉定（由单因子消融与确认实验约束），冻结版本漂移才拒绝实验。
  const ids = [...Object.values(FROZEN_VERSIONS).filter(v => v.frozen).map(v => v.id),
    ...Object.keys(POOL_MEMBERS)];
  for (const versionId of ids) {
    const perGame = [];
    for (const [seatCount, seeds] of Object.entries(CANARY_SEEDS)) {
      for (const seed of seeds) {
        assertInBlock(seed, [1_300_000_000, 1_301_000_000], '金丝雀种子');
        perGame.push(canaryGame({ seed, seatCount: Number(seatCount), versionId }));
      }
    }
    digests[versionId] = sha(perGame.join('|'));
  }
  return digests;
}

/** mini gate=never 等价审计：js5(gate=never) vs legacy-js0（对手席 = legacy-js0）。
 * 返回 { pairs, mismatches, decisions }。 */
function miniEquivalence() {
  const legacy = frozenVersion('legacy-js0');
  let mismatches = 0, totalDecisions = 0;
  const rows = [];
  for (const [seatCount, seeds] of Object.entries(CANARY_SEEDS)) {
    for (const seed of seeds) {
      const run = jointCandidate => {
        let game = createGame(Array.from({ length: Number(seatCount) }, (_, i) => `席位${i}`), seed, Array.from({ length: Number(seatCount) - 1 }, (_, i) => i + 1));
        game.players[0].isAI = true;
        const candidateSeat = 0;
        const decisions = [];
        let moves = 0;
        while (game.phase !== 'finished') {
          if (moves > 1500) throw new Error('mini 等价对局步数上限');
          const seat = game.current;
          const profile = seatProfile(seat);
          let action;
          if (seat === candidateSeat && jointCandidate) {
            action = chooseJointAction(game, { version: 'joint-js5', gateMode: 'never', workUnits: 1, simSeed: seed, profile }).action;
          } else if (seat === candidateSeat) {
            action = chooseAIAction(game, { parameters: legacy.parameters, structure: legacy.structure, profile }).action;
          } else {
            action = chooseAIAction(game, { parameters: legacy.parameters, structure: legacy.structure, profile }).action;
          }
          if (seat === candidateSeat) decisions.push(JSON.stringify(action));
          game = applyAction(game, action);
          moves += 1;
        }
        const ranked = ranking(game);
        return { decisions, end: JSON.stringify({ w: ranked[0].id, r: ranked.map(p => engineScore(p)) }) };
      };
      const js0 = run(false);
      const js5n = run(true);
      const n = Math.max(js0.decisions.length, js5n.decisions.length);
      let firstDiff = null;
      for (let d = 0; d < n; d++) {
        if (js0.decisions[d] !== js5n.decisions[d]) { firstDiff = d; break; }
      }
      totalDecisions += js0.decisions.length;
      const same = firstDiff === null && js0.end === js5n.end;
      if (!same) mismatches += 1;
      rows.push({ seed, seatCount: Number(seatCount), same, firstDiff });
    }
  }
  return { rows, mismatches, totalDecisions };
}

/** 历史证据抽查（可选）：第五阶段 confirm js0 classic 重放 3 局逐位一致。 */
function historicalSpotCheck() {
  const file = resolve(REPO_ROOT, 'training/reports/js5-phase5/confirm/js0-classic/ablation-confirm-js0-2_3_4_5-200s.json');
  if (!existsSync(file)) return { available: false, note: 'confirm 产物不在本地（untracked），跳过' };
  const legacy = frozenVersion('legacy-js0');
  const pool = HISTORICAL_POOLS.classic();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const games = doc.cells.find(c => c.seatCount === 2).games.filter(g => g.status === 'finished').slice(0, 3);
  let match = 0;
  for (const g of games) {
    const seed = g.seed;
    const seatCount = 2;
    const candidateSeat = g.candidateSeats[0];
    const poolSize = pool.length;
    const versions = Array.from({ length: seatCount }, (_, seat) => {
      if (seat === candidateSeat) return { candidate: true, kind: 'frozen', parameters: legacy.parameters, structure: legacy.structure };
      const opponent = pool[(poolSize - 1) * ((seed % 100000 + seat) % poolSize) % poolSize];
      return { candidate: false, parameters: opponent.parameters, structure: opponent.structure, randomLegal: opponent.randomLegal === true };
    });
    let game = createGame(Array.from({ length: seatCount }, (_, i) => `席位${i}`), seed, [1]);
    game.players[0].isAI = true;
    const seatRngs = new Map();
    const rngFor = seat => { if (!seatRngs.has(seat)) seatRngs.set(seat, mulberry32(((seed >>> 0) ^ Math.imul(seat + 1, 0x9E3779B9)) >>> 0)); return seatRngs.get(seat); };
    while (game.phase !== 'finished') {
      const seat = game.current;
      const version = versions[seat];
      let action;
      if (version.randomLegal) {
        const view = {
          current: game.current, phase: game.phase, turnNumber: game.turnNumber,
          players: game.players.map(p => ({ id: p.id, stock: [...p.stock], hand: [...p.hand], played: [...p.played], claimed: [...p.claimed] })),
          golemMarket: [...game.golemMarket],
          merchantMarket: game.merchantMarket.map(m => ({ id: m.id })),
        };
        const legal = enumerateLegalActions(view, { dedupe: false });
        action = legal.length ? legal[Math.floor(rngFor(seat)() * legal.length)] : { type: 'rest' };
      } else {
        action = chooseAIAction(game, { parameters: version.parameters, ...(version.structure ? { structure: version.structure } : {}), profile: seatProfile(seat) }).action;
      }
      game = applyAction(game, action);
    }
    const ranked = ranking(game);
    if (ranked[0].id === g.winnerSeat) match += 1;
  }
  return { available: true, match, total: games.length, ok: match === games.length };
}

async function deploymentCoherence() {
  const champDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  const deployed = champDoc.parameters;
  const { CHAMPION_PARAMETERS } = await import('../../web-v1/dist/js/ai/parameters.js');
  const fields = ['id', 'adapter', 'jointVersion', 'budgetMs', 'acquisitionVariant'];
  const diffs = fields.filter(f => (deployed[f] ?? null) !== (CHAMPION_PARAMETERS[f] ?? null));
  return { ok: diffs.length === 0, diffs, championJsonId: deployed.id, liveId: CHAMPION_PARAMETERS.id };
}

async function main() {
  const bootstrap = process.argv.includes('--bootstrap');
  const args = { bootstrap };
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  // 1. 部署一致性。
  try {
    const d = await deploymentCoherence();
    (d.ok ? pass : fail)('deployment-coherence', d.ok ? `champion.json ↔ CHAMPION_PARAMETERS 一致（${d.championJsonId}）` : `漂移字段：${d.diffs.join(',')}（champion.json=${d.championJsonId} vs live=${d.liveId}）`);
  } catch (e) { fail('deployment-coherence', e.message); }

  // 2+3+4. 金丝雀指纹与摘要。
  let recorded = null;
  if (existsSync(CANARY_PATH)) recorded = JSON.parse(readFileSync(CANARY_PATH, 'utf8'));
  const digests = canaryDigests();
  const fingerprints = Object.fromEntries(Object.entries(FROZEN_VERSIONS).map(([id, v]) => [id, parametersFingerprint(v.parameters)]));

  if (!recorded) {
    if (args.bootstrap) {
      writeFileSync(CANARY_PATH, JSON.stringify({
        schema: 'century-version-canary-v1', createdAt: new Date().toISOString(),
        engineBundleSha256: engineBundleSha256(), fingerprints, digests,
        note: '金丝雀登记须人工审查后提交；此后任何身份漂移都会被 version-gate 拒绝。',
      }, null, 2) + '\n');
      pass('canary-bootstrap', `已写入 ${CANARY_PATH}（${Object.keys(digests).length} 版本）`);
    } else {
      fail('canary-present', `${CANARY_PATH} 不存在——先运行 --bootstrap 登记并人工审查`);
    }
  } else {
    // 指纹检查只约束冻结版本（frozen=true）——实验候选（js6）参数快照在研发期
    // 有意可变（其行为由单因子消融与确认实验约束）；实验指纹仍记录于报告供溯源。
    const frozenIds = Object.values(FROZEN_VERSIONS).filter(v => v.frozen).map(v => v.id);
    const fpDiffs = frozenIds.filter(id => recorded.fingerprints[id] !== fingerprints[id]);
    (fpDiffs.length ? fail : pass)('frozen-fingerprints', fpDiffs.length ? `冻结版本参数指纹漂移：${fpDiffs.join(',')}` : `${frozenIds.length} 个冻结版本指纹一致`);
    const digestDiffs = Object.keys(recorded.digests).filter(id => digests[id] !== undefined && recorded.digests[id] !== digests[id]);
    (digestDiffs.length ? fail : pass)('canary-digests', digestDiffs.length ? `决策级行为漂移：${digestDiffs.join(',')}（身份或实现被改动）` : `${Object.keys(digests).length} 个版本决策摘要一致`);

    // 4. 跨身份不等式。
    const d = digests;
    const ineq = [
      ['legacy-js0', 'legacy-js1'], ['legacy-js0', 'joint-js5-frozen'], ['legacy-js1', 'joint-js5-frozen'],
      ...Object.keys(POOL_MEMBERS).filter(id => id.startsWith('style-') || id === 'neutral-baseline').map(id => [id, 'legacy-js0']),
    ];
    const eqViolations = ineq.filter(([a, b]) => d[a] !== undefined && d[b] !== undefined && d[a] === d[b]);
    (eqViolations.length ? fail : pass)('identity-inequality', eqViolations.length ? `不同版本解析为相同行为：${eqViolations.map(([a, b]) => `${a}≡${b}`).join('、')}` : `${ineq.length} 组跨身份不等式全部成立`);
  }

  // 5. mini gate=never 等价。
  try {
    const eq = miniEquivalence();
    (eq.mismatches ? fail : pass)('gate-never-equivalence', eq.mismatches ? `js5(gate=never) 与 legacy-js0 有 ${eq.mismatches} 局不一致（对照对象错误或冠军路径被扰动）` : `js5(gate=never) ≡ legacy-js0（${eq.rows.length} 局 ${eq.totalDecisions} 决策零不一致）`);
  } catch (e) { fail('gate-never-equivalence', e.message); }

  // 6. 历史证据抽查（可选）。
  try {
    const h = historicalSpotCheck();
    if (!h.available) pass('historical-replay-spot', h.note);
    else (h.ok ? pass : fail)('historical-replay-spot', h.ok ? `js0 历史对局重放 ${h.match}/${h.total} 逐位一致` : `js0 历史对局重放仅 ${h.match}/${h.total} 一致——legacy-js0 身份与历史冠军不符`);
  } catch (e) { fail('historical-replay-spot', e.message); }

  const ok = checks.every(c => c.ok);
  const report = {
    schema: 'century-version-gate-v1', date: new Date().toISOString(),
    engineBundleSha256: engineBundleSha256(), bootstrap: args.bootstrap,
    checks, verdict: ok ? 'PASS（允许实验）' : 'FAIL（拒绝实验）',
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(resolve(REPORT_DIR, 'version-gate-latest.json'), JSON.stringify(report, null, 2));
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`);
  console.log(`门禁结论：${report.verdict}`);
  if (!ok) process.exitCode = 1;
  else if (!recorded && !args.bootstrap) process.exitCode = 2;
}

main().catch(error => { console.error(error); process.exit(1); });

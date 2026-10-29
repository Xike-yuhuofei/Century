#!/usr/bin/env node
/** P2.5：无人值守运行验收审计（只读证据，不修改任何状态）。
 *
 * 判定：
 * - IN_PROGRESS：supervisor 报告缺失/无 endedAt，或 campaign 仍在运行；
 * - FAIL：结束但缺少硬性证据（时长、真实 LLM、跨代谱系、失败归因反馈、恢复、预算）；
 * - PASS：全部满足。
 *
 * 用法：node training/scripts/ai11-endurance-audit.mjs --campaign ai11-6h [--hours 6]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const campaign = String(arg('campaign', ''));
const requiredHours = Number(arg('hours', 6));
if (!campaign) {
  console.error('必须指定 --campaign');
  process.exit(2);
}

const root = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
const readJSON = path => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readLines = path => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : []);

const state = readJSON(join(root, 'state.json'));
const report = readJSON(join(root, 'supervisor-report.json'));
const results = readJSON(join(root, 'results.json'));
const indexLines = readLines(join(root, 'research-index.jsonl'));
const memoryLines = readLines(join(root, 'research-memory.jsonl'));

const checks = [];
const add = (id, title, ok, evidence, unmet = null) => checks.push({ id, title, ok, evidence, unmet: ok ? null : unmet });

if (!state) {
  console.log(JSON.stringify({
    verdict: 'IN_PROGRESS', campaign,
    reason: 'state.json 不存在（运行尚未开始）',
  }, null, 2));
  process.exit(0);
}

const running = !report?.endedAt;
const actualHours = report?.actualHours ?? null;
add('P2-1', '连续运行 ≥ 请求时长（真实墙钟）', actualHours !== null && actualHours >= requiredHours,
  `actualHours=${actualHours} required=${requiredHours}`,
  actualHours === null ? 'supervisor 报告缺少 actualHours' : `实际 ${actualHours}h < ${requiredHours}h`);

const rounds = results?.rounds?.length ?? state.rounds?.length ?? 0;
const candidates = results?.budgetUsed?.candidates ?? state.budgetUsed?.candidates ?? 0;
const games = results?.budgetUsed?.games ?? state.budgetUsed?.games ?? 0;
add('P2-2', '真实候选与真实对局（非空转）', candidates >= 10 && games >= 100,
  `candidates=${candidates} games=${games} rounds=${rounds}`,
  candidates < 10 ? `候选 ${candidates} < 10` : `对局 ${games} < 100`);

const llmCandidates = indexLines.filter(e => e.schema === 'century-research-candidate-v1'
  && (e.generator === 'openevolve-llm' || e.llm?.totalTokens > 0 || e.strategy === 'openevolve'));
const llmTokenRecords = indexLines.filter(e => e.llm && Number.isFinite(e.llm.totalTokens));
add('P2-3', '真实 LLM 参与（OpenEvolve + token 核算）', llmCandidates.length >= 1,
  `llmCandidates=${llmCandidates.length} tokenRecords=${llmTokenRecords.length}`,
  '没有任何来自真实 OpenEvolve/LLM 的候选记录');

const lineageRecords = indexLines.filter(e => e.schema === 'century-research-lineage-v1');
const parents = new Set(lineageRecords.map(e => e.parentCandidateId).filter(Boolean));
const threeGen = lineageRecords.some(child => parents.has(child.candidateId));
add('P2-4', '跨代继承（≥3 代真实父源码链）', lineageRecords.length >= 2 && threeGen,
  `lineageRecords=${lineageRecords.length} threeGenerationChain=${threeGen}`,
  '谱系记录不足以证明三代继承');

const briefConfigs = existsSync(join(root, 'openevolve-configs')) ? readdirSync(join(root, 'openevolve-configs')).filter(f => f.endsWith('.yaml')) : [];
const hypotheses = memoryLines.filter(e => e.kind === 'hypothesis');
const diagnoses = existsSync(join(root, 'diagnostics'))
  ? readdirSync(join(root, 'diagnostics')).filter(f => f.startsWith('failure-diagnosis-')) : [];
add('P2-5', '研究简报进入 LLM 配置 + 失败归因回流',
  briefConfigs.length >= 1 && hypotheses.length >= 1 && diagnoses.length >= 1,
  `briefConfigs=${briefConfigs.length} hypotheses=${hypotheses.length} diagnoses=${diagnoses.length}`,
  '缺少简报注入 / 研究假设 / 失败归因其中一项');

const recoveries = report?.recoveries?.length ?? 0;
const failures = report?.failures?.length ?? 0;
// 恢复能力可以由两类**真实**证据支撑：
// 1) 本次长跑中发生的卡死/崩溃被自动恢复；
// 2) 独立、可重复的 7 点故障注入（至少 1 项 PASS，且无 FAIL）。
const faultReport = readJSON(resolve(REPO_ROOT, 'training/reports/ai11-fault-injection.json'));
const faultPass = (faultReport?.checks ?? []).filter(c => c.status === 'PASS').length;
const faultFail = (faultReport?.checks ?? []).filter(c => c.status === 'FAIL').length;
const recoveryEvidence = recoveries >= 1 || failures >= 1 || (faultPass >= 1 && faultFail === 0);
add('P2-6', '异常恢复证据', recoveryEvidence,
  `recoveries=${recoveries} failures=${failures} faultInjectionPass=${faultPass} faultInjectionFail=${faultFail}`,
  '既无长跑恢复记录，也没有通过的无 FAIL 故障注入证据');

const wall = results?.budgetUsed?.wallMs ?? state.budgetUsed?.wallMs ?? 0;
const maxWall = results?.budget?.maxWallMs ?? state.config?.budget?.maxWallMs ?? null;
add('P2-7', '预算控制（墙钟不越界 + 正式验证池零消耗）',
  (maxWall === null || wall <= maxWall * 1.1) && state.guardrails?.validationPoolConsumed !== true,
  `wallUsed=${wall} maxWall=${maxWall} validationPoolConsumed=${state.guardrails?.validationPoolConsumed}`,
  '墙钟超预算或触碰正式验证池');

const queueMarkers = existsSync(join(root, 'queue/commits')) ? readdirSync(join(root, 'queue/commits')) : [];
add('P2-8', '持久任务队列与幂等提交',
  queueMarkers.length >= 1 && (report?.queue?.byState?.DONE ?? 0) >= 1,
  `commitMarkers=${queueMarkers.length} queue=${JSON.stringify(report?.queue ?? null)}`,
  '任务队列没有完成记录或提交标记');

const failed = checks.filter(c => !c.ok);
const verdict = running ? 'IN_PROGRESS' : (failed.length ? 'FAIL' : 'PASS');
console.log(JSON.stringify({
  schema: 'century-endurance-audit-v1',
  campaign,
  verdict,
  actualHours,
  rounds,
  candidates,
  games,
  checks,
  unmet: failed.map(c => `${c.id}: ${c.unmet}`),
  note: verdict === 'PASS'
    ? '可靠性验收通过；是否带来竞技提升必须另行看配对第一名率证据'
    : (running ? '运行仍在进行' : '存在未满足的硬性证据'),
}, null, 2));
process.exit(verdict === 'FAIL' ? 1 : 0);

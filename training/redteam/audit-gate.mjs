#!/usr/bin/env node
/** 红队审计 #4：第六阶段审计门禁（P0-2 整改：结构化、分层、可放行可阻断）。
 *
 * 缺陷背景（原 v1）：
 * - 「晋级治理」检查写死 verdict:'BLOCKED'——门禁永远红，放行能力为伪；
 * - 回归测试被重复执行两次（run() + node --test 各一次）；
 * - 无结构化结果、无分层（晋级治理阻断把全部开发单测一并锁死）；
 * - 子脚本执行失败未正确计入判定（exit code 被吞）。
 *
 * v2 设计：
 * - 每项检查返回结构化结果：{id, severity, status, evidence, remediation, checkVersion}；
 *   status ∈ PASS | FAIL | BLOCKED | NOT_RUN | REQUIRES_APPROVAL | INFO；
 * - 分层门禁（--tier）：
 *   · dev        开发门禁：代码合法性、版本身份、信息公平、回归测试——
 *                日常开发/单测的准入线（晋级治理问题不在此层阻断）；
 *   · research   研究门禁：dev + 统计证据核算 + 联赛种子账本完整性——
 *                消耗研究种子块/产生实验结论前必须通过；
 *   · promotion  正式晋级门禁：research + 晋级治理（冻结产物指纹、独立验证
 *                证据覆盖、人工授权）——REQUIRES_APPROVAL 在此层阻断；
 * - 命令失败/缺产物默认阻断（FAIL/BLOCKED），绝不静默放行；
 * - 不允许通过删除审计脚本使门禁变绿（本脚本检查审计工具自身在场）；
 * - 输出：人类可读文本（缺省）+ 机器可读 JSON（--json [path]）+ Markdown（--md path）；
 * - CI 入口：npm run gate（training/package.json）+ ai-training 工作流 audit job。
 *
 * 用法：node training/redteam/audit-gate.mjs [--tier dev|research|promotion] [--json [path]] [--md path]
 * 退出码：0=该层放行；1=参数/环境错误；2=该层阻断。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const GATE_VERSION = 'v2';

// ---- 参数 ----
const argv = process.argv.slice(2);
const getArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined;
};
const TIER = getArg('--tier') ?? 'dev';
if (!['dev', 'research', 'promotion'].includes(TIER)) {
  console.error(`--tier 必须为 dev|research|promotion，实际：${TIER}`);
  process.exit(1);
}
const JSON_OUT = getArg('--json'); // true（stdout）或路径
const MD_OUT = getArg('--md');

/** 结构化检查结果构造器。 */
const checks = [];
const add = ({ id, tier, status, severity, title, evidence, remediation = null, checkVersion = GATE_VERSION }) => {
  checks.push({ id, tier, status, severity, title, evidence, remediation, checkVersion });
};

/** 执行子审计脚本：返回 {code, json|null, raw}；执行失败不是异常而是检查证据。 */
function runAudit(script, args = []) {
  try {
    const raw = execFileSync('node', [resolve(REPO_ROOT, script), ...args], { encoding: 'utf8', timeout: 900_000 });
    return { code: 0, raw };
  } catch (error) {
    return { code: error.status ?? 1, raw: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}
const parseJSONLoose = (raw) => {
  try {
    const start = raw.indexOf('{');
    return JSON.parse(raw.slice(start));
  } catch { return null; }
};

// ---- 通用前置：dist 产物（缺失默认阻断——不评估无产物的代码） ----
const distReady = existsSync(resolve(REPO_ROOT, 'web-v1/dist/js/ai.js'));
if (!distReady) {
  add({
    id: 'build-artifacts', tier: 'dev', status: 'BLOCKED', severity: 'P0',
    title: 'web-v1/dist 未构建（缺少编译产物，门禁拒绝在无产物状态下评估）',
    evidence: 'web-v1/dist/js/ai.js 不存在',
    remediation: 'cd web-v1 && npm run build',
  });
}

// ---- 0.5 构建产物一致性（AI7-A3；dev 层，fail-closed） ----
if (distReady) {
  const { verifyBuildManifest } = await import(`file://${resolve(REPO_ROOT, 'web-v1/scripts/build-hash.mjs')}`);
  const v = verifyBuildManifest({ repoRoot: REPO_ROOT, webRoot: resolve(REPO_ROOT, 'web-v1') });
  add({
    id: 'dist-freshness', tier: 'dev', status: v.ok ? 'PASS' : 'BLOCKED', severity: v.ok ? 'PASS' : 'P0',
    title: v.ok ? '源码闭包 ↔ dist 产物一致（构建清单复核通过）' : '源码已变更但 dist 未重新构建（stale dist）',
    evidence: v.ok
      ? `source=${String(v.manifest?.source?.sha256).slice(0, 16)} artifact=${String(v.manifest?.artifact?.sha256).slice(0, 16)} dirty=${v.manifest?.gitDirty}`
      : v.errors.join('；'),
    remediation: v.ok ? null : 'cd web-v1 && npm run build（禁止在旧产物上运行训练/评测/正式挑战）',
  });
}

// ---- 0.6 历史算法版本锁（AI7-A2；dev 层，fail-closed） ----
{
  const { verifyVersionLock } = await import(`file://${resolve(REPO_ROOT, 'training/lib/version-lock.mjs')}`);
  const v = verifyVersionLock();
  add({
    id: 'version-lock', tier: 'dev', status: v.ok ? 'PASS' : 'BLOCKED', severity: v.ok ? 'PASS' : 'P0',
    title: v.ok ? '历史算法版本锁完整（归档 + 决策核心源码字节级固定）' : '历史算法版本锁与归档/源码不一致（静默身份漂移）',
    evidence: v.ok
      ? `archives=${Object.keys(v.lock.archives).length} decisionSources=${Object.keys(v.lock.decisionSources).length}`
      : v.errors.join('；'),
    remediation: v.ok ? null : '如属有意变更：node training/scripts/version-lock.mjs --write --note <原因> 并随 PR 审核；否则恢复文件',
  });
}

// ---- 1. 版本身份（行为学；dev 层） ----
if (distReady) {
  const r = runAudit('training/redteam/audit-versions.mjs', ['--probes=16', '--json']);
  const j = parseJSONLoose(r.raw);
  if (r.code !== 0 || !j) {
    add({
      id: 'version-identity', tier: 'dev', status: 'FAIL', severity: 'P0',
      title: '版本身份审计执行失败（命令失败默认阻断）',
      evidence: `exit=${r.code}；输出末段：${r.raw.slice(-400)}`,
      remediation: '先修复 training/redteam/audit-versions.mjs 的执行错误',
    });
  } else {
    const p0 = j.findings.filter(f => f.severity === 'P0');
    const governance = j.findings.filter(f => f.severity === 'GOVERNANCE');
    add({
      id: 'version-identity', tier: 'dev',
      status: p0.length ? 'FAIL' : 'PASS',
      severity: p0.length ? 'P0' : 'PASS',
      title: p0.length ? `版本身份存在 ${p0.length} 项 P0 污染` : '版本身份干净（js0/js1/对手池 = 冻结归档身份）',
      evidence: p0.length
        ? p0.map(f => `${f.id} ${f.title}`).join('；')
        : `verdict=${j.verdict}；checks=${j.checks.map(c => `${c.id}:${c.status}`).join(' ')}`,
      remediation: p0.length ? '评测运行器必须经 training/lib/version-registry.mjs 冻结描述符分派（禁止内联 CHAMPION_PARAMETERS）' : null,
    });
    for (const g of governance) {
      add({
        id: `governance:${g.id}`, tier: 'promotion', status: 'REQUIRES_APPROVAL', severity: 'GOVERNANCE',
        title: g.title, evidence: g.detail, remediation: g.remediation ?? '等待人工授权（不得自动消费验证池）',
      });
    }
  }
}

// ---- 2. 历史证据核算（research 层） ----
if (distReady || true) { // 核算是纯数据复算，不依赖 dist
  const r = runAudit('training/redteam/audit-evidence-accounting.mjs', ['--json']);
  const j = parseJSONLoose(r.raw);
  if (r.code !== 0 || !j) {
    add({
      id: 'evidence-accounting', tier: 'research', status: 'FAIL', severity: 'P0',
      title: '历史证据核算执行失败（命令失败默认阻断）',
      evidence: `exit=${r.code}；输出末段：${r.raw.slice(-400)}`,
      remediation: '先修复 training/redteam/audit-evidence-accounting.mjs',
    });
  } else {
    const p0 = j.findings.filter(f => f.severity === 'P0');
    add({
      id: 'evidence-accounting', tier: 'research',
      status: p0.length ? 'FAIL' : 'PASS',
      severity: p0.length ? 'P0' : 'PASS',
      title: p0.length ? `证据核算存在 ${p0.length} 项差异` : '历史证据核算一致（confirm 12,800 局；challenge-11 可独立复现）',
      evidence: p0.length ? p0.map(f => `${f.id} ${f.title}`).join('；') : `verdict=${j.verdict}`,
    });
  }
}

// ---- 3. 双人 A/B 独立统计（信息性，不阻断） ----
{
  const r = runAudit('training/redteam/stats-two-player.mjs', ['--json']);
  const j = parseJSONLoose(r.raw);
  add({
    id: 'two-player-stats', tier: 'research', status: j?.crossCheck?.agreePoint ? 'INFO' : 'NOT_RUN',
    severity: 'INFO',
    title: '双人 A/B 独立统计（信息性，不阻断）',
    evidence: j ? `交叉核对一致=${j.crossCheck?.agreePoint}；CI 重叠=${j.crossCheck?.agreeCIOrder}` : `执行失败 exit=${r.code}（信息性检查不阻断，但建议修复）`,
  });
}

// ---- 4. 回归测试（P0-2：只执行一次；快照已迁移为正向不变量） ----
{
  const r = (() => {
    try {
      const raw = execFileSync('node', ['--test', '--test-concurrency=2', resolve(REPO_ROOT, 'training/redteam/tests/redteam.test.mjs')], { encoding: 'utf8', timeout: 900_000 });
      return { code: 0, raw };
    } catch (error) { return { code: error.status ?? 1, raw: (error.stdout ?? '') + (error.stderr ?? '') }; }
  })();
  const pass = Number(/# pass (\d+)/.exec(r.raw)?.[1] ?? 0);
  const fail = Number(/# fail (\d+)/.exec(r.raw)?.[1] ?? 0);
  add({
    id: 'redteam-regression', tier: 'dev',
    status: r.code !== 0 || fail > 0 ? 'FAIL' : 'PASS',
    severity: r.code !== 0 || fail > 0 ? 'P0' : 'PASS',
    title: r.code !== 0 ? '红队回归测试执行失败（命令失败默认阻断）' : fail > 0 ? `红队回归存在 ${fail} 项失败` : '红队正向不变量全部成立',
    evidence: `pass=${pass} fail=${fail} exit=${r.code}（单次执行，无重复调用）`,
    remediation: fail > 0 ? '正向不变量失败 = 行为回归；先修根因，不得删除检测条件' : null,
  });
}

// ---- 5. 联赛种子账本完整性（research 层；P0-4） ----
{
  const ledgerPath = resolve(REPO_ROOT, 'training/adversarial/seed-ledger.json');
  if (!existsSync(ledgerPath)) {
    add({
      id: 'seed-ledger', tier: 'research', status: 'BLOCKED', severity: 'P0',
      title: '联赛种子账本缺失（fail-closed）',
      evidence: `${ledgerPath} 不存在——缺失账本下任何联赛实验分配都必须拒绝`,
      remediation: '从仓库恢复 seed-ledger.json（含历史只读事实导入）',
    });
  } else {
    let verdict = 'PASS'; let evidence = ''; let defects = [];
    try {
      const { loadLedger, verifyLedger } = await import(`file://${resolve(REPO_ROOT, 'training/adversarial/seed-ledger.mjs')}`);
      const ledger = loadLedger(ledgerPath);
      defects = verifyLedger(ledger);
      evidence = `experiments=${ledger.experiments.length}；区间重叠（非 CRN）=${defects.length}；prereg 历史=[1403000000,1403001620)${ledger.experiments.some(e => e.experimentId === 'prereg-15s-official') ? ' 在账' : ' 缺失'}`;
      if (defects.length || !ledger.experiments.some(e => e.experimentId === 'prereg-15s-official')) verdict = 'FAIL';
    } catch (error) {
      verdict = 'FAIL';
      evidence = `账本加载/校验失败：${error.message}`;
    }
    add({
      id: 'seed-ledger', tier: 'research', status: verdict, severity: verdict === 'PASS' ? 'PASS' : 'P0',
      title: verdict === 'PASS' ? '联赛种子账本完整（历史导入在场、无未声明重叠）' : '联赛种子账本存在缺陷（fail-closed）',
      evidence,
      remediation: verdict === 'PASS' ? null : `修复账本结构缺陷：${defects.join('；') || '恢复历史导入'}`,
    });
  }
}

// ---- 5.5 统一跨系统种子治理（research 层；AI7-A1） ----
{
  try {
    const { loadSeedGovernance, governanceReport } = await import(`file://${resolve(REPO_ROOT, 'training/lib/seed-governance.mjs')}`);
    const registry = loadSeedGovernance({ strict: true });
    const report = governanceReport(registry);
    const ppoArena = registry.entries.find(e => e.sourceId === 'ppo-ledger' && e.purposeClass === 'arena');
    const long20 = registry.entries.find(e => e.experimentId === 'openevolve-long20-deep-validation-unledgered');
    const healthy = registry.complete && registry.conflicts.length === 0;
    add({
      id: 'seed-governance', tier: 'research', status: healthy ? 'PASS' : 'FAIL', severity: healthy ? 'PASS' : 'P0',
      title: healthy
        ? `跨系统种子治理健康（正式挑战 ${report.summary.formalChallenges} 次；来源 ${registry.sources.length} 个）`
        : '跨系统种子治理存在缺失/冲突（fail-closed）',
      evidence: healthy
        ? `PPO 验证池块已识别=${Boolean(ppoArena)}（[${ppoArena?.base}, ${ppoArena?.base + ppoArena?.size})）；long20 未入账区间已保守占用=${Boolean(long20)}；` +
          `不确定条目=${report.summary.uncertainEntries}；冲突=0`
        : JSON.stringify(report.conflicts),
      remediation: healthy ? null : '修复账本缺失/冲突后重跑；禁止跳过治理层',
    });
  } catch (error) {
    add({
      id: 'seed-governance', tier: 'research', status: 'BLOCKED', severity: 'P0',
      title: '统一种子治理层不可用（缺失账本/加载失败，fail-closed）',
      evidence: error.message,
      remediation: '恢复全部账本与 training/governance/* 治理文件后重跑',
    });
  }
}

// ---- 5.6 第一名率统计核心自检（dev 层；P0 唯一主判据） ----
{
  const testPath = resolve(REPO_ROOT, 'training/tests/first-place.test.mjs');
  if (!existsSync(testPath)) {
    add({
      id: 'first-place-stats', tier: 'dev', status: 'BLOCKED', severity: 'P0',
      title: '第一名率统计核心测试缺失（禁止删除反例测试使门禁变绿）',
      evidence: 'training/tests/first-place.test.mjs 不存在',
      remediation: '恢复 P0 反例测试与 evaluator/first-place.mjs',
    });
  } else {
    const r = (() => {
      try {
        const raw = execFileSync('node', ['--test', '--test-concurrency=1', testPath], { encoding: 'utf8', timeout: 300_000 });
        return { code: 0, raw };
      } catch (error) { return { code: error.status ?? 1, raw: (error.stdout ?? '') + (error.stderr ?? '') }; }
    })();
    const pass = Number(/# pass (\d+)/.exec(r.raw)?.[1] ?? 0);
    const fail = Number(/# fail (\d+)/.exec(r.raw)?.[1] ?? 0);
    add({
      id: 'first-place-stats', tier: 'dev',
      status: r.code !== 0 || fail > 0 ? 'FAIL' : 'PASS',
      severity: r.code !== 0 || fail > 0 ? 'P0' : 'PASS',
      title: fail > 0 ? `第一名率统计反例测试存在 ${fail} 项失败` : '第一名率统计反例与正向用例全部通过',
      evidence: `pass=${pass} fail=${fail} exit=${r.code}`,
      remediation: fail > 0 ? '修复 first-place.mjs 或预注册/alpha 账本实现；不得放宽断言' : null,
    });
  }
}

// ---- 6. 晋级治理（promotion 层；P0：第一名率唯一判据） ----
{
  const champPath = resolve(REPO_ROOT, 'training/champions/champion.json');
  const champ = JSON.parse(readFileSync(champPath, 'utf8'));
  const evidence = champ.provenance?.promotionEvidence ?? {};
  const isFirstPlace = evidence.metric === 'pairedFirstPlaceRateDelta'
    && evidence.schema === 'century-first-place-formal-challenge-v1';
  if (isFirstPlace) {
    const problems = [];
    if (evidence.decision?.promote !== true) problems.push('decision.promote != true');
    if (!/^[0-9a-f]{64}$/.test(String(evidence.planHash ?? ''))) problems.push('缺少预注册 planHash');
    if (!/^[0-9a-f]{64}$/.test(String(evidence.evidenceHash ?? ''))) problems.push('缺少证据 evidenceHash');
    if (!Array.isArray(evidence.seatCounts) || ![2, 3, 4, 5].every(n => evidence.seatCounts.includes(n))) {
      problems.push(`人数覆盖不完整：${JSON.stringify(evidence.seatCounts)}`);
    }
    if (evidence.alphaLedger?.outcome?.decision !== 'promote') problems.push('alpha 账本结果不是 promote');
    if (!evidence.alphaLedger?.reservation?.planId) problems.push('alpha 账本缺少预留记录');
    if (!evidence.recalculated?.promote) problems.push('独立重算未通过');
    if (!evidence.decision?.pooled || evidence.decision.pooled.lower <= 0) problems.push('加权第一名率增量下界 ≤ 0');
    add({
      id: 'promotion-governance', tier: 'promotion',
      status: problems.length ? 'BLOCKED' : 'PASS',
      severity: problems.length ? 'P0' : 'PASS',
      title: problems.length
        ? '第一名率晋级证据存在缺陷（fail-closed）'
        : '第一名率晋级证据完整（预注册 + 2–5 人主检验/非劣效 + alpha 账本）',
      evidence: problems.length
        ? problems.join('；')
        : `冠军=${champ.parameters?.id}；challengeIndex=${evidence.challengeIndex}；α=${evidence.alpha}；` +
          `加权增量=${evidence.decision.pooled.mean.toFixed(4)}（下界 ${evidence.decision.pooled.lower.toFixed(4)}）；` +
          `plan=${String(evidence.planHash).slice(0, 12)} evidence=${String(evidence.evidenceHash).slice(0, 12)}`,
      remediation: problems.length ? '重新生成预注册证据并执行正式挑战；不得以旧判据或手工修改 provenance 放行' : null,
    });
  } else {
    const seatCountsCovered = evidence.seatCounts ?? [5];
    add({
      id: 'promotion-governance', tier: 'promotion', status: 'REQUIRES_APPROVAL', severity: 'GOVERNANCE',
      title: '当前冠军证据仍是旧判据（配对得分优势率），不得作为新晋级依据',
      evidence: `冠军=${champ.parameters?.id}；metric=${String(evidence.metric ?? 'score-advantage（legacy）')}；` +
        `人数覆盖=${JSON.stringify(seatCountsCovered)}；旧判据只作历史复现，不参与晋级`,
      remediation: '执行 run-first-place-challenge.mjs 生成第一名率正式证据；promote-first-place-champion.mjs 通过机器门禁后自动晋级',
    });
  }
}

// ---- 6.5 冠军证据待重新验证（AI7-A4；新第一名率证据可解除） ----
{
  const revalidationPath = resolve(REPO_ROOT, 'training/champions/revalidation-required.json');
  if (existsSync(revalidationPath)) {
    const doc = JSON.parse(readFileSync(revalidationPath, 'utf8'));
    const champForCheck = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
    const currentEvidence = champForCheck.provenance?.promotionEvidence ?? {};
    const resolvedByFirstPlace = currentEvidence.metric === 'pairedFirstPlaceRateDelta'
      && currentEvidence.decision?.promote === true
      && [2, 3, 4, 5].every(n => (currentEvidence.seatCounts ?? []).includes(n))
      && currentEvidence.championId !== doc.championId;
    add({
      id: 'champion-revalidation', tier: 'promotion',
      status: resolvedByFirstPlace ? 'PASS' : 'REQUIRES_APPROVAL',
      severity: resolvedByFirstPlace ? 'PASS' : 'GOVERNANCE',
      title: resolvedByFirstPlace
        ? `历史冠军 ${doc.championId} 的重新验证已由新的 2–5 人第一名率证据覆盖`
        : `冠军 ${doc.championId} 的既有晋级证据待重新验证（${doc.status}）`,
      evidence: resolvedByFirstPlace
        ? `新冠军=${champForCheck.parameters?.id}；challengeIndex=${currentEvidence.challengeIndex}；seatCounts=${JSON.stringify(currentEvidence.seatCounts)}`
        : `受试产物=${String(doc.finding?.evidenceEngineBundleSha256).slice(0, 12)}；人数覆盖=${JSON.stringify(doc.finding?.seatCountsCovered)}；未重新晋级、未改写历史 provenance——需新第一名率挑战`,
      remediation: resolvedByFirstPlace ? null : '按 revalidation-required.json 的 remediation 执行新的 2–5 人第一名率挑战；在此之前不得宣称全人数已验证',
    });
  }
}

// ---- 6.6 Alpha 消耗账本（research 层；P0 长期错误率控制） ----
{
  try {
    const { readAlphaLedger, alphaLedgerSummary } = await import(`file://${resolve(REPO_ROOT, 'training/lib/alpha-ledger.mjs')}`);
    const ledger = readAlphaLedger();
    const summary = alphaLedgerSummary(ledger);
    add({
      id: 'alpha-ledger', tier: 'research', status: 'PASS', severity: 'PASS',
      title: 'Alpha 消耗账本完整（append-only，challengeIndex 连续，累计 ≤ 预算）',
      evidence: `模式=${summary.spendingPlan.mode}；challenges=${summary.challenges}；completed=${summary.completed}；` +
        `spent=${summary.spent}；remaining=${summary.remaining}；next=${summary.nextChallengeIndex}`,
    });
  } catch (error) {
    add({
      id: 'alpha-ledger', tier: 'research', status: 'BLOCKED', severity: 'P0',
      title: 'Alpha 消耗账本缺失/损坏（fail-closed）',
      evidence: error.message,
      remediation: '恢复 training/governance/alpha-ledger.json；禁止重置或重建预算',
    });
  }
}

// ---- 7. 审计工具自身在场（防"删脚本变绿"） ----
for (const tool of [
  'training/redteam/audit-versions.mjs', 'training/redteam/audit-evidence-accounting.mjs',
  'training/redteam/stats-two-player.mjs', 'training/redteam/tests/redteam.test.mjs',
  'training/lib/seed-governance.mjs', 'training/scripts/seed-governance-cli.mjs',
  'training/lib/version-lock.mjs', 'training/scripts/version-lock.mjs', 'training/champions/version-lock.json',
  'training/governance/historical-seed-claims.json', 'training/governance/seed-consumption-registry.json',
  'training/champions/revalidation-required.json',
  'training/evaluator/first-place.mjs', 'training/evaluator/preregistration.mjs',
  'training/lib/alpha-ledger.mjs', 'training/governance/alpha-ledger.json',
  'training/tests/first-place.test.mjs',
  'training/tournament/first-place-challenge.mjs', 'training/tournament/run-first-place-challenge.mjs',
  'training/scripts/promote-first-place-champion.mjs',
  'web-v1/scripts/build-hash.mjs', 'web-v1/scripts/build-manifest.mjs',
]) {
  if (!existsSync(resolve(REPO_ROOT, tool))) {
    add({
      id: `tool-presence:${tool}`, tier: 'dev', status: 'BLOCKED', severity: 'P0',
      title: '审计工具缺失（禁止通过删除审计脚本使门禁变绿）',
      evidence: `${tool} 不存在`,
      remediation: '从仓库恢复审计工具',
    });
  }
}

// ---- 汇总与分层判定 ----
const tierRank = { dev: 0, research: 1, promotion: 2 };
const relevant = checks.filter(c => tierRank[c.tier] <= tierRank[TIER]);
const blocking = relevant.filter(c => ['FAIL', 'BLOCKED'].includes(c.status));
const approval = relevant.filter(c => c.status === 'REQUIRES_APPROVAL');
const pass = blocking.length === 0 && (TIER !== 'promotion' || approval.length === 0);

const verdictText = pass ? '放行' : '阻断';
const report = {
  schema: 'century-redteam-audit-gate-v2',
  checkVersion: GATE_VERSION,
  date: new Date().toISOString(),
  tier: TIER,
  verdict: pass ? 'PASS' : approval.length && !blocking.length ? 'REQUIRES_APPROVAL' : 'BLOCKED',
  summary: {
    checks: relevant.length,
    pass: relevant.filter(c => c.status === 'PASS' || c.status === 'INFO').length,
    fail: blocking.filter(c => c.status === 'FAIL').length,
    blocked: blocking.filter(c => c.status === 'BLOCKED').length,
    requiresApproval: approval.length,
  },
  checks,
};
const statusIcon = { PASS: '✓', INFO: 'ℹ', FAIL: '✗', BLOCKED: '⛔', NOT_RUN: '∅', REQUIRES_APPROVAL: '⏳' };

console.log(`\n== 第六阶段审计门禁（${GATE_VERSION}，层级 ${TIER}）==\n`);
for (const c of relevant) {
  console.log(`${statusIcon[c.status] ?? '?'} [${c.tier.padEnd(9)}] ${c.status.padEnd(19)} ${c.id} — ${c.title}`);
}
console.log('');
for (const c of relevant) {
  if (c.status !== 'PASS' && c.status !== 'INFO') {
    console.log(`-- ${c.id} --\n  证据：${c.evidence}${c.remediation ? `\n  处置：${c.remediation}` : ''}\n`);
  }
}
console.log(pass
  ? `门禁判定（${TIER} 层）：放行。${TIER !== 'promotion' && approval.length ? `（${approval.length} 项治理事项待人工授权，仅阻断晋级层）` : ''}`
  : `门禁判定（${TIER} 层）：阻断（FAIL=${report.summary.fail} BLOCKED=${report.summary.blocked}${approval.length ? ` REQUIRES_APPROVAL=${approval.length}（仅晋级层阻断）` : ''}）。`);

if (JSON_OUT) {
  const text = JSON.stringify(report, null, 2);
  if (typeof JSON_OUT === 'string') writeFileSync(resolve(JSON_OUT), text);
  else console.log(text);
}
if (MD_OUT) {
  const lines = [
    `# 第六阶段审计门禁报告（${GATE_VERSION}）`,
    '',
    `- 时间：${report.date}`,
    `- 层级：${TIER}`,
    `- 判定：**${report.verdict}**`,
    `- 汇总：${report.summary.checks} 项检查（PASS ${report.summary.pass} / FAIL ${report.summary.fail} / BLOCKED ${report.summary.blocked} / REQUIRES_APPROVAL ${report.summary.requiresApproval}）`,
    '',
    '| 层级 | 状态 | 检查 | 结论 | 证据 |',
    '|---|---|---|---|---|',
    ...relevant.map(c => `| ${c.tier} | ${c.status} | ${c.id} | ${c.title} | ${String(c.evidence).replace(/\|/g, '\\|').slice(0, 200)} |`),
    '',
  ];
  writeFileSync(resolve(typeof MD_OUT === 'string' ? MD_OUT : 'audit-gate-report.md'), lines.join('\n'));
}
process.exit(pass ? 0 : 2);

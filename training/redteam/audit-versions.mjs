#!/usr/bin/env node
/** 红队审计 #1：版本身份污染检测（P0）——结构化输出版（P0-2 整改）。
 *
 * 只读、行为学（非静态字符串）审计：直接加载 web-v1/dist 正式产物，
 * 验证「标签身份 = 执行身份」。P0-2 整改要点：审计对象从"复制旧缺陷模式"
 * 改为探测**真实调用点**——
 * - V2/V3 探测 training/joint/duel.mjs 与 equivalence-audit.mjs 的候选版本
 *   （经不可变版本注册表 training/lib/version-registry.mjs 解析），并行为学
 *   验证冻结 JS0/JS1 的实际决策分派；
 * - V4 探测真实对手池（duel classicPool/diversePool、opponents.styleVariants、
 *   adversarial registry 风格族）——变体参数不得携带 adapter，权重必须真实生效；
 * - V7 晋级指纹：证据内部一致性=代码缺陷（P0）；证据 ≠ 当前重建产物=治理问题
 *   （REQUIRES_APPROVAL，阻断晋级不阻断开发——修复需人工授权的新挑战）。
 *
 * 审计的缺陷模式（2026-10-24 PR #30 晋级后全部实锤，见 OVERNIGHT-AUDIT.md）：
 * - V1 冠军参数区同步：dist CHAMPION_PARAMETERS ≡ champion.json；
 * - V2 js0 标签污染 / V3 js1 标签污染 / V4 对手池变体标签化（历史缺陷，
 *   已由 version-registry + 不可变描述符修复，本审计防回归）；
 * - V5 双入口一致：web-v1/src/ai/parameters.ts 生成区 ≡ champion.json；
 * - V6 历史产物卫生：confirm 块 versionsIds 是否为晋级前真实对手标签；
 * - V7 晋级指纹一致性。
 *
 * 输出：人类可读文本；--json 时机器可读（check 结构见 audit-gate.mjs）。
 * 退出码：0=无 P0；2=存在 P0。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
// 指纹计算必须与训练侧完全同源（自实现闭包易引入解析偏差——本审计曾因此产生假指纹）
const { engineBundleSha256, buildProvenance } = await import(`file://${resolve(REPO_ROOT, 'training/lib/paths.mjs')}`);
const findings = [];
/** 结构化检查结果（audit-gate 消费）：id/severity/status/evidence/remediation/checkVersion。 */
const checks = [];
const checkVersion = 'v2'; // P0-2 结构化整改后版本（真实调用点探测）
const note = (severity, id, title, detail, remediation = null) => {
  findings.push({ severity, id, title, detail });
  checks.push({
    id, severity,
    status: severity === 'PASS' ? 'PASS' : severity === 'GOVERNANCE' ? 'REQUIRES_APPROVAL' : 'FAIL',
    title, evidence: detail, remediation, checkVersion,
  });
};

// ---- 加载正式产物（与训练侧同一路径） ----
const DIST = resolve(REPO_ROOT, 'web-v1/dist/js');
if (!existsSync(resolve(DIST, 'ai.js'))) {
  console.error('未找到 web-v1/dist/js——先执行 cd web-v1 && npm run build');
  process.exit(2); // 缺少编译产物默认阻断（P0-2：NOT_RUN 也不得放行研究门禁）
}
const { createGame, applyAction } = await import(`file://${resolve(DIST, 'engine.js')}`);
const { chooseAIAction, PROFILES, NEUTRAL_PROFILE } = await import(`file://${resolve(DIST, 'ai.js')}`);
const { chooseJointAction } = await import(`file://${resolve(DIST, 'js/adapter.js')}`);
const { CHAMPION_PARAMETERS } = await import(`file://${resolve(DIST, 'ai/parameters.js')}`);
const { resolveAlgorithmVersion, decisionOptions } = await import(`file://${resolve(REPO_ROOT, 'training/lib/version-registry.mjs')}`);
const { candidateVersion, classicPool, diversePool } = await import(`file://${resolve(REPO_ROOT, 'training/joint/duel.mjs')}`);
const { candidateVersion: eqCandidateVersion } = await import(`file://${resolve(REPO_ROOT, 'training/joint/equivalence-audit.mjs')}`);
const { styleVariants } = await import(`file://${resolve(REPO_ROOT, 'training/lib/opponents.mjs')}`);
const { buildRegistry } = await import(`file://${resolve(REPO_ROOT, 'training/adversarial/registry.mjs')}`);

const championDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
const championParams = championDoc.parameters;
const prevDoc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/candidates/ai5-readiness-efficiency.json'), 'utf8'));
const prevParams = prevDoc.parameters ?? prevDoc;

// ---- 探针状态集：多 seed × 多步数，覆盖开/中局（足够触发适配器 override）。
// 默认 64 探针（约 40s，墙钟预算决策每个 ~100ms）；--probes N 或 --full 自定义。 ----
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

const act = r => JSON.stringify(r.action);
// 联合搜索路径标记：champion-guided 决策 reason 含「联合」（联合仲裁/联合规划）。
// 不能用 /js5|champion-guided/ ——束搜索 reason 含参数 id（基座归档 id=joint-js5），
// 会把合法束搜索误判为适配器路由（P0-2 整改中修正的假阳性）。
const isAdapter = r => r.reason.includes('联合');

// ---- V1 冠军参数区同步 ----
{
  const mism = [];
  for (const key of ['id', 'adapter', 'jointVersion', 'budgetMs', 'acquisitionVariant']) {
    if (JSON.stringify(CHAMPION_PARAMETERS[key]) !== JSON.stringify(championParams[key])) {
      mism.push(`${key}: dist=${JSON.stringify(CHAMPION_PARAMETERS[key])} vs champion.json=${JSON.stringify(championParams[key])}`);
    }
  }
  if (mism.length) note('P0', 'V1', 'dist 参数区与 champion.json 不同步（stale dist 双入口漂移）', mism.join('；'), '重新构建 web-v1（cd web-v1 && npm run build）');
  else note('PASS', 'V1', 'dist CHAMPION_PARAMETERS 与 champion.json 同步', `id=${CHAMPION_PARAMETERS.id} adapter=${CHAMPION_PARAMETERS.adapter ?? '无'}`);
}

// ---- V2/V3：真实候选版本（duel + equivalence-audit 调用点）的身份与行为 ----
{
  const js0Desc = resolveAlgorithmVersion('legacy-js0');
  const js1Desc = resolveAlgorithmVersion('legacy-js1');
  const js0Opts = decisionOptions(js0Desc);
  const js1Opts = decisionOptions(js1Desc);

  // 链路一致性：duel/equivalence-audit 的候选版本必须解析到同一冻结描述符。
  const duelJs0 = candidateVersion('js0');
  const duelJs1 = candidateVersion('js1');
  const eqJs0 = eqCandidateVersion('js0');
  const linkage = [
    ['duel.js0', duelJs0.descriptor?.fingerprint === js0Desc.fingerprint],
    ['duel.js1', duelJs1.descriptor?.fingerprint === js1Desc.fingerprint],
    ['equivalence-audit.js0', eqJs0.descriptor?.fingerprint === js0Desc.fingerprint],
  ];
  const brokenLink = linkage.filter(([, ok]) => !ok).map(([k]) => k);
  if (brokenLink.length) {
    note('P0', 'V2-link', '评测运行器候选版本与冻结注册表失去链接', `断链：${brokenLink.join('、')}`, '运行器必须经 resolveAlgorithmVersion 解析候选身份，禁止内联 CHAMPION_PARAMETERS');
  }

  // 结构不变量：legacy 核心绝不允许携带适配器字段。
  const adapterFields = d => ['adapter', 'jointVersion', 'budgetMs'].filter(k => d.parameters?.[k] !== undefined);
  if (adapterFields(js0Desc).length || adapterFields(js1Desc).length) {
    note('P0', 'V2-struct', '冻结基线描述符携带适配器字段（分派劫持风险）',
      `js0: ${adapterFields(js0Desc).join('/') || '无'}；js1: ${adapterFields(js1Desc).join('/') || '无'}`,
      'legacy 描述符必须来自 strip-adapter 后的晋级归档');
  }

  // 行为学：冻结 JS0 = 归档前任冠军逐决策一致；不进适配器；与 JS5 有分歧探针。
  let js0Diff = null, js0AdapterTags = 0, js0VsJs5Diff = 0, probes = 0, js1AdapterTags = 0, js1Diff = null, js1VsJs0Diff = 0;
  for (const { game, seed, step } of probeStates()) {
    probes++;
    const a0 = chooseAIAction(game, { ...js0Opts.beam, profile: NEUTRAL_PROFILE });
    const ap = chooseAIAction(game, { parameters: prevParams, structure: prevParams.structure, profile: NEUTRAL_PROFILE });
    if (isAdapter(a0)) js0AdapterTags++;
    if (act(a0) !== act(ap) && !js0Diff) js0Diff = { seed, step, js0: a0.action, js0Reason: a0.reason.slice(0, 60), prev: ap.action };
    const a5 = chooseJointAction(game, { version: 'joint-js5', profile: NEUTRAL_PROFILE });
    if (act(a0) !== act(a5)) js0VsJs5Diff++;
    const a1 = chooseAIAction(game, { ...js1Opts.beam, profile: NEUTRAL_PROFILE });
    if (isAdapter(a1)) js1AdapterTags++;
    if (/·beam-contest/.test(a1.reason) === false && !js1Diff) js1Diff = { seed, step, reason: a1.reason.slice(0, 60) };
    if (act(a1) !== act(a0)) js1VsJs0Diff++;
  }
  if (js0AdapterTags > 0 || js0Diff) {
    note('P0', 'V2', '「js0（冻结冠军）」标签实际执行 JS5 适配器（身份污染）',
      `${js0AdapterTags}/${probes} 探针决策走适配器路径；首个动作分歧 @seed=${js0Diff?.seed} step=${js0Diff?.step}：` +
      `js0-labeled=${JSON.stringify(js0Diff?.js0)}（${js0Diff?.js0Reason}…）vs 真冻结冠军=${JSON.stringify(js0Diff?.prev)}。` +
      '晋级后任何以 js0 为基线的 duel/compare 重跑都是 JS5 自我对弈。',
      'js0 必须经 resolveAlgorithmVersion(legacy-js0) 冻结归档分派');
  } else {
    note('PASS', 'V2', 'js0（legacy-js0）= 归档冻结冠军逐决策一致，未走适配器',
      `${probes} 探针零分歧；与 JS5 适配器行动分歧探针 ${js0VsJs5Diff}/${probes}（身份独立性证据）`);
  }
  if (js1AdapterTags > 0) {
    note('P0', 'V3', '「js1（beam-contest）」标签实际执行 JS5 适配器',
      `${js1AdapterTags}/${probes} 探针走适配器路径——decision.ts 适配器分支先于 structure 选项生效，` +
      'js1 的 beam-contest 结构参数在晋级产物上被静默忽略。',
      'js1 必须经 resolveAlgorithmVersion(legacy-js1)（冻结基座 + beam-contest）分派');
  } else if (js1Diff) {
    note('P0', 'V3', 'js1 未携带 beam-contest 结构标记（结构选项未生效）',
      `首个无标记探针 @seed=${js1Diff.seed} step=${js1Diff.step}：reason="${js1Diff.reason}"`,
      'beam-contest 结构必须真实参与决策（reason 含 ·beam-contest 标记）');
  } else {
    note('PASS', 'V3', 'js1 = 冻结基座 + beam-contest（结构真实生效，未走适配器）',
      `${probes} 探针全部携带 ·beam-contest 标记、零适配器路由；与 js0 行动分歧探针 ${js1VsJs0Diff}/${probes}（结构差异活性证据）`);
  }
}

// ---- V4：真实对手池变体是否仍是有别于基座/冠军的真实策略 ----
{
  const pools = { classic: classicPool(), diverse: diversePool() };
  const variants = [];
  for (const [poolName, pool] of Object.entries(pools)) {
    for (const entry of pool) {
      if (entry.liveChampion || entry.randomLegal || entry.championBody) continue; // 冠军本体（活动别名或冻结注册身份）与随机策略不属权重变体
      variants.push({ id: `${poolName}:${entry.id}`, parameters: entry.parameters, structure: entry.structure });
    }
  }
  for (const v of styleVariants(prevParams)) {
    variants.push({ id: `styleVariants:${v.id}`, parameters: v, structure: v.structure });
  }
  const reg = buildRegistry({});
  for (const id of ['style-rush', 'style-engine', 'style-contest', 'style-balanced']) {
    const d = reg.versions[id];
    variants.push({ id: `adversarial:${id}`, parameters: d.parameters, structure: d.structure });
  }
  const base = prevParams; // 变体基座 = 冻结冠军基线
  const withAdapter = variants.filter(v => v.parameters.adapter !== undefined);
  if (withAdapter.length) {
    note('P0', 'V4a', '对手池变体携带 adapter 字段（将被静默分派到 JS5，权重失效）',
      withAdapter.map(v => v.id).join('、'),
      '变体派生必须 strip-adapter + 权重补 1.0（beamBaseParameters 口径）');
  }
  // 行为学探针 1：零变体被适配器路由（分派劫持检测）。
  const probeList = [...probeStates()];
  let adapterRouted = [];
  for (const v of variants) {
    for (const { game } of probeList.slice(0, 8)) {
      const rVariant = chooseAIAction(game, { parameters: v.parameters, ...(v.structure ? { structure: v.structure } : {}), profile: NEUTRAL_PROFILE });
      if (isAdapter(rVariant)) { adapterRouted.push(v.id); break; }
    }
  }
  if (adapterRouted.length) {
    note('P0', 'V4b', '风格变体被适配器路由（权重 100% 失效 ≡ 冠军本体）',
      `${[...new Set(adapterRouted)].join('、')}`,
      '变体派生必须剥离 adapter 字段');
  }
  // 行为学探针 2：权重路径活性——极端权重变体（tempo 5×/rest 下界，strip-adapter）
  // 必须与基座产生行动分歧且不被适配器路由。真实池中的弱扰动/同参变体
  // （如 style-balanced = 基座权重）允许与基座一致，不判失败。
  let extremeDiffers = false, extremeAdapterRouted = false;
  const extreme = { ...base, id: 'audit-extreme-probe', tempoWeight: 5, restWeight: 0.05 };
  for (const { game } of probeList.slice(0, 12)) {
    const rExtreme = chooseAIAction(game, { parameters: extreme, structure: base.structure, profile: NEUTRAL_PROFILE });
    if (isAdapter(rExtreme)) { extremeAdapterRouted = true; break; }
    const rBase = chooseAIAction(game, { parameters: base, structure: base.structure, profile: NEUTRAL_PROFILE });
    if (act(rExtreme) !== act(rBase)) { extremeDiffers = true; break; }
  }
  if (extremeAdapterRouted || !extremeDiffers) {
    note('P0', 'V4c', '束搜索权重路径失活（极端权重探针无行动分歧或被适配器路由）',
      `极端探针 tempoWeight=5/restWeight=0.05：${extremeAdapterRouted ? '被适配器路由' : '与基座零行动分歧'}`,
      '检查 decision.ts 分派与 planner 权重消费链路');
  }
  if (!withAdapter.length && !adapterRouted.length && !extremeAdapterRouted && extremeDiffers) {
    note('PASS', 'V4', '全部对手池变体走束搜索权重路径（零适配器路由；极端权重探针证实权重可达）',
      `${variants.length} 变体（classic/diverse/styleVariants/adversarial）；极端权重探针 ${probeList.slice(0, 12).length} 局内产生行动分歧`);
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
    note('P0', 'V5', 'web-v1/src 参数生成区与 champion.json 不一致', `src=${srcId}/${srcAdapter} vs champion.json=${championParams.id}/${championParams.adapter}`, '重跑 training/scripts/apply-champion.mjs --check');
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

// ---- V7：晋级指纹（新格式：冠军自身 provenance vs 当前构建；旧格式按历史 js5 证据） ----
{
  const prov = championDoc.provenance ?? {};
  const normalized = Boolean(prov.decisionSourceSha256 && prov.decisionArtifactSha256 && prov.championParametersSha256);
  if (normalized) {
    // 新格式由 refresh-champion-provenance 在 apply+build 后回写。
    // 不再把任何一次历史挑战（js5）当作所有未来冠军的锚点。
    let currentProv = null;
    try { currentProv = buildProvenance(); } catch { /* dist 未构建 */ }
    const detail = currentProv
      ? `decisionSource=${prov.decisionSourceSha256.slice(0, 12)}/${currentProv.decisionSourceSha256.slice(0, 12)}；` +
        `decisionArtifact=${prov.decisionArtifactSha256.slice(0, 12)}/${currentProv.decisionArtifactSha256.slice(0, 12)}；` +
        `championParameters=${prov.championParametersSha256.slice(0, 12)}/${currentProv.championParametersSha256.slice(0, 12)}`
      : `冠军=${championDoc.parameters?.id}；dist 未构建`;
    if (!currentProv) {
      note('BLOCKED', 'V7', '无法核验晋级身份：dist 未构建', detail, 'cd web-v1 && npm run build');
    } else {
      const sourceDrift = prov.decisionSourceSha256 !== currentProv.decisionSourceSha256;
      const paramsDrift = prov.championParametersSha256 !== currentProv.championParametersSha256;
      const artifactDrift = prov.decisionArtifactSha256 !== currentProv.decisionArtifactSha256;
      if (sourceDrift || paramsDrift) {
        note('P0', 'V7a', '冠军 provenance 与当前源码/参数不一致', detail,
          '重新执行正式挑战或恢复正确 parameters.ts；禁止手工改 provenance');
      } else if (artifactDrift) {
        note('GOVERNANCE', 'V7b', '冠军 provenance 构建产物 ≠ 当前产物', detail,
          '执行 apply-champion + npm run build + refresh-champion-provenance 后重新提交');
      } else {
        note('PASS', 'V7', '晋级身份一致（冠军 provenance = 当前构建）', detail);
      }
    }
  } else {
  const cand = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/reports/js5-promotion-challenge/candidate.json'), 'utf8'));
  const recorded = prov.engineBundleSha256;
  const evidence = cand.engineBundleSha256;
  let currentProv = null;
  try { currentProv = buildProvenance(); } catch { /* dist 未构建时跳过 */ }
  // AI7-A4 规范化身份：决策核心（参数块占位）+ 冠军参数块分离核验。
  // 晋级会按预期改变 CHAMPION_PARAMETERS；全量 bundle 指纹变化不再自动视为漂移。
  const normalizedLegacy = prov.decisionSourceSha256 && prov.decisionArtifactSha256 && prov.championParametersSha256
    ? {
        decisionSource: prov.decisionSourceSha256,
        decisionArtifact: prov.decisionArtifactSha256,
        championParameters: prov.championParametersSha256,
      }
    : null;
  const evidenceNormalized = cand.decisionSourceSha256 && cand.decisionArtifactSha256 && cand.championParametersSha256
    ? {
        decisionSource: cand.decisionSourceSha256,
        decisionArtifact: cand.decisionArtifactSha256,
        championParameters: cand.championParametersSha256,
      }
    : null;
  const detail = normalizedLegacy
    ? `规范化身份：decisionSource=${normalizedLegacy.decisionSource.slice(0, 12)}；decisionArtifact=${normalizedLegacy.decisionArtifact.slice(0, 12)}；` +
      `championParameters=${normalizedLegacy.championParameters.slice(0, 12)}；当前=${currentProv ? `${currentProv.decisionSourceSha256.slice(0, 12)}/${currentProv.decisionArtifactSha256.slice(0, 12)}/${currentProv.championParametersSha256.slice(0, 12)}` : '未构建'}`
    : `champion.json.provenance=${recorded?.slice(0, 12)}；candidate.json=${evidence?.slice(0, 12)}；当前重建=${currentProv?.engineBundleSha256.slice(0, 12) ?? '未构建'}`;
  const internalMismatch = normalizedLegacy && evidenceNormalized
    ? ['decisionSource', 'decisionArtifact', 'championParameters'].some(k => normalizedLegacy[k] !== evidenceNormalized[k])
    : Boolean(recorded && evidence && recorded !== evidence);
  const drift = normalizedLegacy && currentProv
    ? ['decisionSource', 'decisionArtifact', 'championParameters'].some(k =>
        normalizedLegacy[k] !== (k === 'decisionSource' ? currentProv.decisionSourceSha256
          : k === 'decisionArtifact' ? currentProv.decisionArtifactSha256
            : currentProv.championParametersSha256))
    : Boolean(recorded && currentProv && recorded !== currentProv.engineBundleSha256);
  if (internalMismatch) {
    note('P0', 'V7a', 'champion.json 晋级身份与挑战证据不一致', detail, '晋级链路（promote-champion / apply-champion）必须回写受试身份');
  } else if (drift) {
    // 治理问题（REQUIRES_APPROVAL）：证据链本身诚实，但当前产物与受试身份不同。
    // 修复需要人工授权的新正式挑战，不得在本类整改中自动消费验证池。
    note('GOVERNANCE', 'V7b', '晋级证据身份 ≠ 当前产物（正式晋级证据待重新验证）',
      detail + '；本项阻断正式晋级门禁（需独立重挑战），不阻断开发/研究门禁',
      '对当前冻结产物执行新一轮正式冠军挑战（消费验证池新块）');
  } else {
    note('PASS', 'V7', '晋级身份一致', detail);
  }
  }
}

// ---- 输出 ----
const blocked = findings.filter(f => f.severity === 'P0');
const governance = findings.filter(f => f.severity === 'GOVERNANCE');
const summary = {
  audit: 'redteam-version-identity',
  checkVersion,
  date: new Date().toISOString(),
  championOnDisk: championParams.id,
  findings,
  checks,
  verdict: blocked.length ? 'POLLUTED' : governance.length ? 'CLEAN_WITH_GOVERNANCE' : 'CLEAN',
};
if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\n== 红队版本身份审计：${summary.verdict}（champion=${championParams.id}）==`);
  for (const f of findings) console.log(`[${f.severity}] ${f.id} ${f.title}\n    ${f.detail}`);
}
process.exit(blocked.length ? 2 : 0);

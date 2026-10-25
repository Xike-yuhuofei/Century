/** D1：标准化 Candidate Artifact v1。
 *
 * 目标：解决"不同系统靠人工搬运候选代码与参数"的问题。一个 artifact 自带
 * 生成→打包→注册→加载→可复现验证所需的全部身份字段：
 * - candidateId / parentId；
 * - 源码哈希（descriptor 候选 = 描述符身份哈希；声明模块 = 文件内容哈希）；
 * - 算法结构标识（目标插件、决策核心、结构、联合版本、评测模式、分人数选项）；
 * - 参数及版本（values + version + boundsVersion）；
 * - 编译/构建产物哈希（buildArtifact.kind + sha256 + compiled 标记）；
 * - 游戏规则版本（规则语义版本 + 引擎产物指纹）；
 * - 实验配置与实验种子引用（configRef/configHash + seedRefs）；
 * - 适用人数；
 * - 评测证据目录；
 * - 安全验证状态。
 *
 * 两种身份哈希分离（可审计的关键）：
 * - identityDigest：候选算法身份（不含实验/证据/安全状态），同候选跨 campaign 稳定；
 * - artifactHash：artifact 文件全文封印，任何字段改动都会被 verify 检出。
 */

import {
  SCHEMAS, canonicalJSON, sha256Canonical, sha256Hex, deepFreeze,
  assertCondition, ALL_PLAYER_COUNTS,
} from './core.mjs';

export const ARTIFACT_VERSION = 1;
export const PARAMETER_BOUNDS_VERSION = 'ai-parameters-v1';

const SOURCE_KINDS = Object.freeze(['descriptor', 'declarative-module', 'esm-module-bundle']);
const EVALUATION_MODES = Object.freeze(['game', 'proxy']);
const STATUSES = Object.freeze(['created', 'checked', 'evaluated', 'selected', 'pending-approval', 'promotion-queued', 'rejected', 'archived']);
const SAFETY_STATUSES = Object.freeze(['pending', 'passed', 'failed']);

/** identityDigest 覆盖的字段：只含算法身份，不含实验/证据/安全状态。 */
function identityFields(artifact) {
  return {
    candidateId: artifact.candidateId,
    parentId: artifact.parentId,
    sourceHash: artifact.sourceHash,
    algorithmStructure: artifact.algorithmStructure,
    parameters: artifact.parameters,
    buildArtifact: artifact.buildArtifact,
    gameRules: artifact.gameRules,
    applicablePlayerCounts: artifact.applicablePlayerCounts,
  };
}

function normalizeFiles(files) {
  assertCondition(Array.isArray(files) && files.length > 0, 'source.files 必须为非空数组');
  return files.map(file => {
    assertCondition(typeof file?.path === 'string' && file.path.length > 0, 'source 文件缺少 path');
    assertCondition(!file.path.startsWith('/') && !file.path.includes('..'), `source 非法路径：${file.path}`);
    assertCondition(typeof file.content === 'string', `source 文件 ${file.path} 缺少字符串 content`);
    return {
      path: file.path,
      sha256: sha256Hex(file.content),
      content: file.content,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/** 源码哈希：对 (path, content) 有序列表做 canonical 哈希。 */
export function computeSourceHash(source) {
  const files = source?.files ?? [];
  return sha256Canonical(files.map(f => [f.path, f.sha256]));
}

/** 构建产物哈希：对构建输入做 canonical 哈希；若提供真实编译产物文件，
 * 则按文件内容哈希（compiled=true），并把编译产物内容随 artifact 一起封印，
 * 使加载方无需原构建目录即可复现校验。descriptor 候选没有代码增量，显式标记
 * compiled=false，绝不把参数描述符伪装成编译产物。 */
export function computeBuildArtifact({ source, algorithmStructure, parameters, buildInput = null }) {
  if (buildInput?.files?.length) {
    const files = normalizeFiles(buildInput.files);
    return deepFreeze({
      kind: buildInput.kind ?? 'esm-module-bundle-v1',
      sha256: sha256Canonical(files.map(f => [f.path, f.sha256])),
      compiled: true,
      compiler: buildInput.compiler ?? 'unknown',
      reproducible: true,
      files,
    });
  }
  const kind = source.kind === 'descriptor'
    ? 'descriptor-bundle-v1'
    : 'declarative-module-bundle-v1';
  return deepFreeze({
    kind,
    sha256: sha256Canonical({ kind, sourceHash: source.sha256, algorithmStructure, parameters }),
    compiled: false,
    compiler: null,
    reproducible: true,
  });
}

function validateSafety(safety) {
  const status = safety?.status ?? 'pending';
  assertCondition(SAFETY_STATUSES.includes(status), `安全状态非法：${String(status)}`);
  const checks = safety?.checks ?? [];
  assertCondition(Array.isArray(checks), 'safety.checks 必须为数组');
  for (const check of checks) {
    assertCondition(typeof check?.id === 'string' && check.id.length > 0, 'safety check 缺少 id');
    assertCondition(check.status === 'pass' || check.status === 'fail', `safety check ${check.id} 状态非法`);
    assertCondition(typeof check.detail === 'string', `safety check ${check.id} 缺少 detail`);
  }
  if (status === 'passed') {
    assertCondition(checks.length > 0 && checks.every(c => c.status === 'pass'), '安全状态 passed 但存在失败/缺失检查');
  }
  if (status === 'failed') {
    assertCondition(checks.some(c => c.status === 'fail'), '安全状态 failed 但没有任何失败检查');
  }
  return { status, checks };
}

function validateExperiment(experiment) {
  assertCondition(experiment && typeof experiment === 'object', 'artifact 缺少 experiment');
  assertCondition(typeof experiment.configRef === 'string' && experiment.configRef.length > 0, 'experiment.configRef 缺失');
  assertCondition(typeof experiment.configHash === 'string' && /^[0-9a-f]{64}$/.test(experiment.configHash), 'experiment.configHash 非法');
  const seedRefs = experiment.seedRefs ?? [];
  assertCondition(Array.isArray(seedRefs), 'experiment.seedRefs 必须为数组');
  for (const ref of seedRefs) {
    assertCondition(ref.purpose === 'screen' || ref.purpose === 'deep', `seedRef purpose 非法：${ref.purpose}`);
    assertCondition(typeof ref.windowId === 'string' && ref.windowId.length > 0, 'seedRef.windowId 缺失');
    assertCondition(Number.isSafeInteger(ref.base) && Number.isSafeInteger(ref.count) && ref.count > 0, 'seedRef base/count 非法');
  }
  return { configRef: experiment.configRef, configHash: experiment.configHash, seedRefs: seedRefs.map(r => ({ ...r })) };
}

function validateAlgorithmStructure(structure, evaluationMode) {
  assertCondition(structure && typeof structure === 'object', 'artifact 缺少 algorithmStructure');
  assertCondition(Array.isArray(structure.targetIds) && structure.targetIds.length > 0, 'algorithmStructure.targetIds 必须非空');
  assertCondition(EVALUATION_MODES.includes(evaluationMode), `evaluationMode 非法：${String(evaluationMode)}`);
  assertCondition(typeof structure.decisionCore === 'string' && structure.decisionCore.length > 0, 'algorithmStructure.decisionCore 缺失');
  if (evaluationMode === 'game') {
    assertCondition(['champion-guided', 'beam-search'].includes(structure.decisionCore),
      `game 候选的 decisionCore 非法：${structure.decisionCore}`);
  } else {
    assertCondition(structure.decisionCore === 'plugin-only',
      `proxy 候选的 decisionCore 必须为 plugin-only，实际：${structure.decisionCore}`);
  }
  return deepFreeze({
    targetIds: [...structure.targetIds],
    decisionCore: structure.decisionCore,
    adapter: structure.adapter ?? null,
    structure: structure.structure ?? null,
    jointVersion: structure.jointVersion ?? null,
    evaluationMode,
    jointOptionsByPlayerCount: structure.jointOptionsByPlayerCount ?? null,
    integration: structure.integration ?? (evaluationMode === 'game' ? 'production-seat-dispatch' : 'candidate-plugin-only'),
  });
}

/**
 * 创建并封印 Candidate Artifact v1。
 *
 * @param {object} input
 * @param {string} input.candidateId
 * @param {string|null} input.parentId
 * @param {object} input.algorithmStructure
 * @param {object} input.parameters { id, version, values, boundsVersion? }
 * @param {object} input.source { kind, entry?, files? }
 * @param {object} input.experiment
 * @param {number[]} input.applicablePlayerCounts
 * @param {object} [input.safety]
 * @param {object} [input.buildInput]
 * @param {object} input.gameRules
 * @param {string} [input.status]
 */
export function createCandidateArtifact(input) {
  const {
    candidateId, parentId = null, algorithmStructure, parameters, source,
    experiment, applicablePlayerCounts = ALL_PLAYER_COUNTS, safety = { status: 'pending', checks: [] },
    buildInput = null, gameRules, status = 'created',
  } = input ?? {};

  assertCondition(typeof candidateId === 'string' && /^cand-[a-z0-9][a-z0-9._-]{2,63}$/i.test(candidateId),
    `candidateId 非法（必须 cand- 前缀）：${String(candidateId)}`);
  assertCondition(parentId === null || (typeof parentId === 'string' && parentId.length > 0), 'parentId 非法');
  assertCondition(parameters && typeof parameters === 'object', 'artifact 缺少 parameters');
  assertCondition(typeof parameters.id === 'string' && parameters.id.length > 0, 'parameters.id 缺失');
  assertCondition(Number.isSafeInteger(parameters.version) && parameters.version >= 1, 'parameters.version 必须为 ≥1 整数');
  assertCondition(parameters.values && typeof parameters.values === 'object', 'parameters.values 缺失');
  assertCondition(Array.isArray(applicablePlayerCounts) && applicablePlayerCounts.length > 0, 'applicablePlayerCounts 必须非空');
  for (const n of applicablePlayerCounts) {
    assertCondition(ALL_PLAYER_COUNTS.includes(n), `适用人数非法：${n}`);
  }
  assertCondition(STATUSES.includes(status), `artifact 状态非法：${String(status)}`);
  assertCondition(gameRules && typeof gameRules === 'object', 'artifact 缺少 gameRules');
  assertCondition(typeof gameRules.version === 'string' && /^[0-9a-f]{64}$/.test(gameRules.engineBundleSha256 ?? ''),
    'gameRules.engineBundleSha256 非法');

  assertCondition(source && SOURCE_KINDS.includes(source.kind), `source.kind 非法：${String(source?.kind)}`);
  // 编译型候选必须携带真实编译产物，且源码类型必须为 esm-module-bundle；
  // 产物的内容随 artifact 封印，加载侧可独立重算哈希。
  if (buildInput?.files?.length) {
    assertCondition(source.kind === 'esm-module-bundle',
      `编译产物只允许 esm-module-bundle 候选，实际：${source.kind}`);
  }
  const files = source.files?.length ? normalizeFiles(source.files) : null;
  let normalizedSource;
  if (files) {
    normalizedSource = { kind: source.kind, entry: source.entry ?? files[0].path, hashKind: 'file-content', files };
  } else {
    // descriptor 候选：没有代码增量，用「描述符身份」作为源码哈希并显式标注。
    const content = canonicalJSON({ algorithmStructure, parameters });
    normalizedSource = {
      kind: 'descriptor',
      entry: 'descriptor.json',
      hashKind: 'descriptor-identity',
      files: [{ path: 'descriptor.json', sha256: sha256Hex(content), content }],
    };
  }
  const sourceHash = computeSourceHash(normalizedSource);
  const buildArtifact = computeBuildArtifact({
    source: { ...normalizedSource, sha256: sourceHash },
    algorithmStructure,
    parameters,
    buildInput,
  });
  const evaluationMode = algorithmStructure.evaluationMode
    ?? (algorithmStructure.decisionCore === 'plugin-only' ? 'proxy' : 'game');
  const algorithm = validateAlgorithmStructure(algorithmStructure, evaluationMode);
  const experimentNormalized = validateExperiment(experiment);
  const safetyNormalized = validateSafety(safety);

  const artifact = {
    schema: SCHEMAS.candidateArtifact,
    version: ARTIFACT_VERSION,
    candidateId,
    parentId,
    sourceHash,
    source: normalizedSource,
    algorithmStructure: algorithm,
    parameters: {
      id: parameters.id,
      version: parameters.version,
      values: deepFreeze({ ...parameters.values }),
      boundsVersion: parameters.boundsVersion ?? PARAMETER_BOUNDS_VERSION,
    },
    buildArtifact,
    gameRules: { version: gameRules.version, engineBundleSha256: gameRules.engineBundleSha256 },
    experiment: experimentNormalized,
    applicablePlayerCounts: [...applicablePlayerCounts].sort((a, b) => a - b),
    evidenceDir: null,
    safety: safetyNormalized,
    status,
    identityDigest: null,
    artifactHash: null,
  };
  return sealArtifact(artifact);
}

/** 重算并写入 identityDigest / artifactHash（不改变其他字段）。 */
export function sealArtifact(artifact) {
  const identity = identityFields(artifact);
  const { artifactHash: _previousHash, ...base } = artifact;
  const sealed = {
    ...base,
    identityDigest: sha256Canonical(identity),
  };
  // artifactHash 覆盖除自身外的全部字段；绝不把旧哈希/null 写进哈希输入。
  sealed.artifactHash = sha256Canonical(sealed);
  return deepFreeze(sealed);
}

/** 校验 artifact 结构 + 全部哈希（加载/注册时必须调用）。 */
export function validateArtifact(artifact) {
  assertCondition(artifact?.schema === SCHEMAS.candidateArtifact, `artifact schema 非法：${String(artifact?.schema)}`);
  assertCondition(artifact.version === ARTIFACT_VERSION, `artifact version 非法：${String(artifact.version)}`);
  assertCondition(typeof artifact.candidateId === 'string' && /^cand-/i.test(artifact.candidateId), 'artifact candidateId 非法');
  assertCondition(Array.isArray(artifact.source?.files) && artifact.source.files.length > 0, 'artifact source.files 缺失');
  for (const file of artifact.source.files) {
    assertCondition(typeof file.content === 'string', `artifact source 文件 ${file.path} 缺少 content（不可复现）`);
    assertCondition(sha256Hex(file.content) === file.sha256, `artifact source 文件 ${file.path} 哈希不符（内容被篡改）`);
  }
  const sourceHash = computeSourceHash(artifact.source);
  assertCondition(sourceHash === artifact.sourceHash, `artifact sourceHash 不符：期望 ${sourceHash}，实际 ${artifact.sourceHash}`);

  if (artifact.buildArtifact?.compiled === true) {
    assertCondition(artifact.source?.kind === 'esm-module-bundle',
      'artifact buildArtifact.compiled=true 但 source.kind 不是 esm-module-bundle');
    assertCondition(artifact.buildArtifact.kind === 'esm-module-bundle-v1',
      `artifact buildArtifact.kind 非法：${String(artifact.buildArtifact.kind)}`);
    assertCondition(typeof artifact.buildArtifact.compiler === 'string' && artifact.buildArtifact.compiler.length > 0,
      'artifact 编译产物缺少 compiler');
    const compiledFiles = normalizeFiles(artifact.buildArtifact.files ?? []);
    const expectedSha = sha256Canonical(compiledFiles.map(f => [f.path, f.sha256]));
    assertCondition(expectedSha === artifact.buildArtifact.sha256,
      `artifact buildArtifact.sha256 不符：编译产物内容被篡改或缺失（期望 ${expectedSha}）`);
  } else {
    const expectedBuild = computeBuildArtifact({
      source: { ...artifact.source, sha256: artifact.sourceHash },
      algorithmStructure: artifact.algorithmStructure,
      parameters: artifact.parameters,
    });
    assertCondition(expectedBuild.kind === artifact.buildArtifact?.kind, 'artifact buildArtifact.kind 不符');
    assertCondition(expectedBuild.sha256 === artifact.buildArtifact?.sha256, 'artifact buildArtifact.sha256 不符');
  }

  validateAlgorithmStructure(artifact.algorithmStructure, artifact.algorithmStructure.evaluationMode);
  validateExperiment(artifact.experiment);
  validateSafety(artifact.safety);
  assertCondition(SOURCE_KINDS.includes(artifact.source.kind), `artifact source.kind 非法：${String(artifact.source.kind)}`);
  assertCondition(Array.isArray(artifact.applicablePlayerCounts) && artifact.applicablePlayerCounts.length > 0,
    'artifact applicablePlayerCounts 缺失');
  for (const n of artifact.applicablePlayerCounts) {
    assertCondition(ALL_PLAYER_COUNTS.includes(n), `artifact 适用人数非法：${n}`);
  }
  assertCondition(typeof artifact.parameters?.id === 'string' && artifact.parameters.id.length > 0, 'artifact parameters.id 缺失');
  assertCondition(Number.isSafeInteger(artifact.parameters?.version) && artifact.parameters.version >= 1, 'artifact parameters.version 非法');
  assertCondition(artifact.buildArtifact?.compiled === true || artifact.buildArtifact?.compiled === false,
    'artifact buildArtifact.compiled 必须为布尔值');

  const identityDigest = sha256Canonical(identityFields(artifact));
  assertCondition(identityDigest === artifact.identityDigest,
    `artifact identityDigest 不符：期望 ${identityDigest}，实际 ${artifact.identityDigest}`);
  const { artifactHash, ...rest } = artifact;
  const expectedHash = sha256Canonical(rest);
  assertCondition(expectedHash === artifactHash,
    `artifact artifactHash 不符：期望 ${expectedHash}，实际 ${artifactHash}（文件被改动）`);
  return true;
}

/** 更新可变字段（experiment/evidenceDir/safety/status），重封印 artifactHash，
 * 但保持 identityDigest 不变；若算法身份被改动则显式拒绝。 */
export function updateArtifact(artifact, patch) {
  validateArtifact(artifact);
  const allowed = ['experiment', 'evidenceDir', 'safety', 'status'];
  for (const key of Object.keys(patch ?? {})) {
    assertCondition(allowed.includes(key), `artifact 更新字段不允许：${key}`);
  }
  const next = { ...artifact, ...patch };
  if (patch.experiment !== undefined) next.experiment = validateExperiment(patch.experiment);
  if (patch.safety !== undefined) next.safety = validateSafety(patch.safety);
  if (patch.status !== undefined) {
    assertCondition(STATUSES.includes(patch.status), `artifact 状态非法：${patch.status}`);
  }
  if (patch.evidenceDir !== undefined) {
    assertCondition(patch.evidenceDir === null || (typeof patch.evidenceDir === 'string' && patch.evidenceDir.length > 0),
      'evidenceDir 非法');
  }
  const beforeIdentity = artifact.identityDigest;
  const sealed = sealArtifact(next);
  assertCondition(sealed.identityDigest === beforeIdentity, 'artifact 更新改变了算法身份（identityDigest 漂移）');
  return sealed;
}

/** 读取 artifact 的运行时席位配置（仅 game 候选；proxy 候选返回 null）。 */
export function seatVersionFor(artifact, seatCount) {
  assertCondition(Number.isSafeInteger(seatCount), `seatCount 非法：${String(seatCount)}`);
  assertCondition(artifact.applicablePlayerCounts.includes(seatCount), `候选不适用 ${seatCount} 人局`);
  const structure = artifact.algorithmStructure;
  if (structure.evaluationMode !== 'game') return null;
  const options = structure.jointOptionsByPlayerCount?.[String(seatCount)] ?? structure.jointOptionsByPlayerCount?.[seatCount] ?? null;
  return deepFreeze({
    id: artifact.candidateId,
    fingerprint: artifact.identityDigest,
    decisionCore: structure.decisionCore,
    parameters: artifact.parameters.values,
    structure: structure.structure ?? null,
    jointVersion: structure.jointVersion ?? null,
    jointOptions: options,
  });
}

/** artifact 可复现性检查（加载时使用）：返回结构化结果，不抛错。 */
export function verifyArtifactReproducibility(artifact) {
  try {
    validateArtifact(artifact);
    return {
      ok: true,
      candidateId: artifact.candidateId,
      identityDigest: artifact.identityDigest,
      artifactHash: artifact.artifactHash,
      sourceHash: artifact.sourceHash,
      buildArtifactHash: artifact.buildArtifact.sha256,
      checks: ['schema', 'source-hash', 'build-hash', 'identity-digest', 'artifact-hash', 'safety-shape'],
    };
  } catch (error) {
    return { ok: false, candidateId: artifact?.candidateId ?? null, error: error.message };
  }
}

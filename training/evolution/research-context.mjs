/** P1.2：ResearchBrief（结构化研究简报）→ 真实进入 OpenEvolve / LLM 上下文。
 *
 * 两个通道（都来自 OpenEvolve 原生能力，不另造框架）：
 * 1. prompt 通道：把简报写进每轮 `system_message`（config-ai9 的副本），
 *    由 runMultiModuleOpenEvolve 通过 --config 传入；
 * 2. artifact feedback 通道：evaluator 返回 `artifacts`，上游 PromptSampler
 *    会把 program_artifacts 注入后续迭代的提示上下文。
 *
 * 纪律：
 * - 简报里的机制解释一律标记 unverified，只能作为待验证假设；
 * - 至少两个可区分的机制 + 可证伪预测 + 能否定假设的实验设计；
 * - contextHash 覆盖简报 + 父代源码哈希，便于事后核验"模型到底看到了什么"。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { sha256Canonical, assertCondition } from './core.mjs';

const PROMPT_VERSION = 'ai11-research-brief-v1';

/**
 * 构建 ResearchBrief（确定性；LLM 解释只作为假设）。
 *
 * @param {object} options
 * @param {number} options.round
 * @param {object|null} options.parentArtifact
 * @param {object|null} options.evidence 最近一次深验证据（可空）
 * @param {object|null} options.diagnosis failure-diagnosis 输出
 * @param {object|null} options.memory 研究记忆摘要（testedHypotheses/positiveModules/failures）
 * @param {string[]} options.moduleIds 允许修改的模块
 * @param {object} [options.experiment] { playerCounts, quickSeeds, deepSeeds }
 */
export function buildResearchBrief({
  round, parentArtifact = null, evidence = null, diagnosis = null,
  memory = null, moduleIds, experiment = null, previousBest = null,
}) {
  assertCondition(Number.isSafeInteger(round) && round >= 1, `round 非法：${round}`);
  assertCondition(Array.isArray(moduleIds) && moduleIds.length > 0, 'brief 需要允许修改的模块列表');

  const metrics = evidence?.metrics ?? {};
  const bySeat = metrics.byPlayerCount ?? {};
  const weakestSeat = Object.entries(bySeat)
    .filter(([, s]) => Number.isFinite(s?.delta))
    .sort((a, b) => a[1].delta - b[1].delta)[0] ?? null;

  const observation = {
    round,
    parentCandidateId: parentArtifact?.candidateId ?? null,
    parentSourceHash: parentArtifact?.sourceHash ?? null,
    pairedFirstPlaceDelta: Number.isFinite(metrics.firstPlaceDelta) ? metrics.firstPlaceDelta : null,
    pairedFirstPlaceLower: metrics.firstPlaceDeltaPooledCi?.oneSidedLower ?? null,
    pairs: metrics.pairs ?? evidence?.pairs?.length ?? null,
    anomalyRate: metrics.anomalyRate ?? null,
    weakestSeat: weakestSeat ? { seatCount: Number(weakestSeat[0]), delta: weakestSeat[1].delta } : null,
    stagnation: previousBest?.stagnantRounds ?? null,
  };

  const failures = (diagnosis?.failureCases ?? []).slice(0, 6).map(f => ({
    category: f.category, seatCount: f.seatCount, status: f.status, detail: f.detail,
  }));

  const history = {
    testedHypotheses: (memory?.testedHypotheses ?? []).slice(-8).map(h => ({
      hypothesisId: h.hypothesisId, status: h.status, statement: String(h.statement).slice(0, 200),
    })),
    positiveModules: (memory?.positiveModules ?? []).slice(0, 8),
    recentFailures: (memory?.recentFailures ?? []).slice(-5),
  };

  const seatLabel = observation.weakestSeat?.seatCount ?? null;
  const hypotheses = [
    {
      id: `H${round}A`,
      statement: seatLabel
        ? `候选在 ${seatLabel} 人层的配对第一名率增量为 ${observation.weakestSeat.delta}，可能源于资源获取/认领节奏失衡`
        : '候选的配对第一名率增量可能源于资源获取/认领节奏失衡',
      status: 'unverified',
      mechanisms: [
        {
          id: 'mechanism-acquisition-tempo',
          claim: '获取（acquire）节奏偏离最优：过早/过晚认领导致目标竞争失败',
          prediction: '调整 M02/M04/M10 中的获取-认领权衡后，该层 championWinFlips 下降 ≥2',
          falsification: '若动作分布 L1 改变但配对 delta 不变或下降，则该机制被否定',
          modules: ['M02', 'M04', 'M10'],
        },
        {
          id: 'mechanism-endgame-contest',
          claim: '终局目标竞争估值不足：对手关键目标被抢或自身终局路线选错',
          prediction: '调整 M06/M07/M08 的终局/竞争项后，该层终局分差缩小且配对 delta 上升',
          falsification: '若终局分差不变，则该机制被否定',
          modules: ['M06', 'M07', 'M08'],
        },
      ],
    },
    {
      id: `H${round}B`,
      statement: '候选改动可能只改变了行为分布而未触及胜负机制（无效探索）',
      status: 'unverified',
      mechanisms: [
        {
          id: 'mechanism-behavior-only',
          claim: '改动只改变动作分布，不改变关键决策点',
          prediction: '动作分布 L1 显著变化但同种子胜负不翻转',
          falsification: '若出现 ≥2 个 candidate-win-flip 且无对应 champion-win-flip，则否定该机制',
          modules: [...moduleIds].slice(0, 4),
        },
        {
          id: 'mechanism-variance',
          claim: '观测到的差异来自小样本随机波动而非算法差异',
          prediction: '在新研究种子上独立复验时 delta 收缩到 0 附近',
          falsification: '若独立种子复验仍显著为正，则否定该机制',
          modules: [...moduleIds].slice(0, 4),
        },
      ],
    },
  ];

  const brief = {
    schema: 'century-research-brief-v2',
    promptVersion: PROMPT_VERSION,
    round,
    observation,
    failures,
    history,
    hypotheses,
    allowedModules: [...moduleIds].sort(),
    forbidden: [
      '规则引擎、裁判、评估器、统计门禁、测试与冠军发布脚本',
      '隐藏牌库顺序 / 对手私有信息 / 正式验证种子',
      'import / eval / 进程 / 文件 / 网络 / 时钟 / 随机数',
    ],
    experiment: {
      playerCounts: experiment?.playerCounts ?? [2, 3, 4, 5],
      quickSeeds: experiment?.quickSeeds ?? null,
      deepSeeds: experiment?.deepSeeds ?? null,
      pairedArms: 2,
      independentSeeds: true,
      note: '同种子/同对手/同焦点席位配对；开发池与正式验证池严格隔离',
    },
    discipline: [
      '机制解释未经验证，只能作为假设',
      '必须产生可执行的行为改变；原样返回或只改注释视为失败',
      '优先小而有原则的改动，避免大规模重写',
    ],
  };
  const contentHash = sha256Canonical(brief);
  const contextHash = sha256Canonical({
    promptVersion: PROMPT_VERSION,
    contentHash,
    parentSourceHash: parentArtifact?.sourceHash ?? null,
    moduleHashes: parentArtifact?.source?.modules?.map(m => [m.id, m.functionSha256]) ?? null,
  });
  return { ...brief, contentHash, contextHash };
}

/** 把简报渲染成 system_message 追加块（紧凑、可审计）。 */
export function renderBriefPrompt(brief) {
  const lines = [];
  lines.push('## Research brief (unverified hypotheses, do not treat as facts)');
  lines.push(`Round ${brief.round}. Context hash: ${brief.contextHash}`);
  if (brief.observation.parentCandidateId) {
    lines.push(`Parent candidate: ${brief.observation.parentCandidateId}`);
  }
  lines.push(`Paired first-place delta: ${brief.observation.pairedFirstPlaceDelta} `
    + `(lower ${brief.observation.pairedFirstPlaceLower}, pairs ${brief.observation.pairs})`);
  if (brief.observation.weakestSeat) {
    lines.push(`Weakest seat stratum: ${brief.observation.weakestSeat.seatCount}p (delta ${brief.observation.weakestSeat.delta})`);
  }
  if (brief.failures.length) {
    lines.push('Observed weaknesses:');
    for (const f of brief.failures) lines.push(`- [${f.status}] ${f.detail}`);
  }
  if (brief.history.testedHypotheses.length) {
    lines.push('Previously tested hypotheses (do not repeat without new evidence):');
    for (const h of brief.history.testedHypotheses) lines.push(`- ${h.hypothesisId} ${h.status}: ${h.statement}`);
  }
  lines.push('Competing mechanisms you must distinguish:');
  for (const h of brief.hypotheses) {
    lines.push(`- ${h.id}: ${h.statement}`);
    for (const m of h.mechanisms) {
      lines.push(`  * ${m.id}: ${m.claim}`);
      lines.push(`    prediction: ${m.prediction}`);
      lines.push(`    would be falsified if: ${m.falsification}`);
      lines.push(`    modules: ${m.modules.join(', ')}`);
    }
  }
  lines.push(`Allowed modules: ${brief.allowedModules.join(', ')}. Do not touch anything else.`);
  lines.push('Forbidden: rules engine, evaluator, statistics gate, tests, champion publishing, hidden deck order, imports/eval/IO/network/clock/randomness.');
  return lines.join('\n');
}

/**
 * 生成注入简报的 OpenEvolve 配置副本（不改动原始 config-ai9.yaml）。
 *
 * @param {object} options
 * @param {string} options.baseConfigPath
 * @param {object} options.brief
 * @param {string} options.outPath
 */
export function writeBriefConfig({ baseConfigPath, brief, outPath }) {
  const base = readFileSync(baseConfigPath, 'utf8');
  const marker = '  system_message: >-';
  const start = base.indexOf(marker);
  if (start < 0) throw new Error(`配置缺少 ${marker}（拒绝静默注入研究简报）`);
  const lines = base.split('\n');
  const markerLineIndex = lines.findIndex(line => line.trimStart().startsWith('system_message:'));
  if (markerLineIndex < 0) throw new Error('配置缺少 system_message 行');
  const indent = lines[markerLineIndex].match(/^\s*/)[0].length;
  let end = markerLineIndex + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') { end += 1; continue; }
    const lineIndent = line.match(/^\s*/)[0].length;
    if (lineIndent < indent + 2) break;
    end += 1;
  }
  const briefText = renderBriefPrompt(brief);
  const block = [
    `${' '.repeat(indent)}system_message: |`,
    ...briefText.split('\n').map(line => `${' '.repeat(indent + 2)}${line}`),
  ];
  const merged = [
    ...lines.slice(0, markerLineIndex),
    ...block,
    ...lines.slice(end),
  ].join('\n');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, merged);
  // 简报 JSON：evaluator 通过 artifacts 通道注入后续提示上下文。
  const briefPath = `${outPath.replace(/\.yaml$/, '')}.brief.json`;
  writeFileSync(briefPath, JSON.stringify(brief, null, 2));
  return {
    path: outPath,
    briefPath,
    contextHash: brief.contextHash,
    briefHash: brief.contentHash,
    bytes: merged.length,
  };
}

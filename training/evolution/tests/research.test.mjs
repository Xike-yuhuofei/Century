/** P1 验收：ResearchBrief 进入真实提示配置、研究记忆跨进程、失败归因、调度决策。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResearchBrief, renderBriefPrompt, writeBriefConfig,
} from '../research-context.mjs';
import { openResearchMemory } from '../research-memory.mjs';
import { diagnosePairedEvidence } from '../failure-diagnosis.mjs';
import { decideNextResearch, summarizeTrend } from '../research-orchestrator.mjs';
import { moduleRegistry } from '../../../ai5/openevolve/node/module_registry.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';

const AI9_CONFIG = join(REPO_ROOT, 'ai5/openevolve/config-ai9.yaml');

function pairedEvidence({ seatCounts = [2, 4], seeds = [1, 2, 3, 4], championWins = 3 } = {}) {
  const games = [];
  const pairs = [];
  for (const seatCount of seatCounts) {
    for (const seed of seeds) {
      const focusSeat = seed % seatCount;
      const candidateFirst = (seed % 2) === 0;
      const championFirst = seed % 4 < championWins;
      const actions = { acquire: 12 + seed, claim: 3, rest: 4, play: 6, discard: 1 };
      for (const arm of ['A', 'B']) {
        games.push({
          seed, seedIndex: seed, seatCount, focusSeat, arm, status: 'finished',
          reason: null, firstPlace: arm === 'A' ? candidateFirst : championFirst,
          winnerSeat: focusSeat, moves: 80, wallMs: 1000, score: 60,
          meanDecisionMs: 50, rank: 1, candidateActions: actions, focusActions: actions,
          opponentIds: [], versions: [],
        });
      }
      pairs.push({
        seed, focusSeat, seatCount,
        candidateFirst: candidateFirst ? 1 : 0, championFirst: championFirst ? 1 : 0,
        anomalies: 0, status: 'finished',
      });
    }
  }
  return {
    candidateId: 'cand-research-test',
    metrics: {
      evidenceType: 'dev-game-compiled-modules', totalGames: games.length,
      finishedGames: games.length, anomalies: 0, anomalyRate: 0,
      pairs: pairs.length, finishedPairs: pairs.length,
      firstPlaceDelta: -0.1, firstPlaceDeltaPooledCi: { oneSidedLower: -0.3 },
      byPlayerCount: Object.fromEntries(seatCounts.map(n => [String(n), { seatCount: n, delta: -0.2 }])),
    },
    games, pairs,
  };
}

test('ResearchBrief：包含 ≥2 个可区分机制、可证伪预测与上下文哈希', () => {
  const evidence = pairedEvidence();
  const diagnosis = { failureCases: [{ category: 'x', seatCount: 2, status: 'supported', detail: '2 人层弱点' }] };
  const brief = buildResearchBrief({
    round: 3, parentArtifact: { candidateId: 'cand-parent', sourceHash: 'a'.repeat(64), source: { modules: [{ id: 'M02', functionSha256: 'b'.repeat(64) }] } },
    evidence, diagnosis, memory: null, moduleIds: ['M02', 'M06'],
  });
  assert.equal(brief.hypotheses.length >= 2, true);
  for (const hypothesis of brief.hypotheses) {
    assert.ok(hypothesis.mechanisms.length >= 2, '每个假设至少两个机制');
    for (const mechanism of hypothesis.mechanisms) {
      assert.ok(mechanism.prediction, '机制必须有可证伪预测');
      assert.ok(mechanism.falsification, '机制必须说明如何被否定');
      assert.equal(mechanism.claim !== undefined, true);
    }
  }
  assert.match(brief.contextHash, /^[0-9a-f]{64}$/);
  assert.match(brief.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(brief.allowedModules.includes('M02'));
  assert.ok(renderBriefPrompt(brief).includes(brief.contextHash));
});

test('ResearchBrief 写入真实 OpenEvolve 配置：system_message 被替换且上下文哈希可核验', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-brief-'));
  const brief = buildResearchBrief({
    round: 2, parentArtifact: null, evidence: pairedEvidence(), diagnosis: null,
    memory: null, moduleIds: ['M02', 'M06', 'M08'],
  });
  const written = writeBriefConfig({
    baseConfigPath: AI9_CONFIG,
    brief,
    outPath: join(root, 'r002.yaml'),
  });
  const text = readFileSync(written.path, 'utf8');
  assert.ok(text.includes(brief.contextHash), 'LLM 配置必须包含简报上下文哈希');
  assert.ok(text.includes('Research brief'), 'LLM 配置必须包含研究简报');
  assert.ok(text.includes('mechanism-acquisition-tempo'), '必须包含可区分机制');
  assert.ok(existsSync(written.briefPath), '必须落盘简报 JSON（供 artifacts 通道）');
  // 原配置不得被改写
  assert.ok(readFileSync(AI9_CONFIG, 'utf8').includes('OpenEvolve 多模块联合进化配置'));
});

test('研究记忆：跨进程持久化，被否定的假设保留且可检索', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai11-memory-'));
  const path = join(root, 'memory.jsonl');
  const memory = openResearchMemory({ path });
  memory.recordHypothesis({
    hypothesisId: 'H1', statement: 'M02 获取节奏假设',
    mechanisms: ['获取过快', '认领过晚'], predictions: ['动作分布改变'], moduleScope: ['M02'],
  });
  memory.recordExperiment({
    hypothesisId: 'H1', candidateId: 'cand-1', stage: 'deep',
    metrics: { firstPlaceDelta: -0.1 }, verdict: 'rejected', seeds: [1, 2],
  });
  memory.recordFailure({
    candidateId: 'cand-1', seatCount: 2, phase: 'mid', category: 'champion-win-flip',
    detail: '2 人层连续输给冠军', status: 'supported',
  });
  memory.updateHypothesis({ hypothesisId: 'H1', status: 'rejected', note: '独立种子复验未复现' });

  // 重新打开（模拟跨进程）
  const reopened = openResearchMemory({ path });
  const tested = reopened.testedHypotheses();
  assert.equal(tested.length, 1);
  assert.equal(tested[0].status, 'rejected', '否定的假设必须保留状态而不是删除');
  assert.equal(reopened.readAll().filter(e => e.kind === 'failure').length, 1);
  assert.equal(reopened.positiveModules().length, 0);
});

test('失败归因：按人数分层给出 supported/weakened/inconclusive，不使用隐藏信息', () => {
  const evidence = pairedEvidence({ seedCounts: undefined });
  const { summary, divergences } = diagnosePairedEvidence({ evidence, minSamplesPerStratum: 4 });
  assert.equal(summary.pairs, divergences.length);
  assert.ok(summary.strata['2']);
  assert.ok(['supported', 'weakened', 'rejected', 'inconclusive'].includes(summary.strata['2'].verdict));
  for (const failure of summary.failureCases) {
    assert.ok(['supported', 'weakened'].includes(failure.status));
    assert.ok(failure.detail.includes('人层'));
  }
});

test('失败归因：8 对/层足量时区分 supported 与 weakened（不做结果后调整）', () => {
  const supported = diagnosePairedEvidence({
    evidence: pairedEvidence({ seatCounts: [2], seeds: [1, 2, 3, 4, 5, 6, 7, 8], championWins: 3 }),
    minSamplesPerStratum: 8,
  });
  assert.equal(supported.summary.strata['2'].pairs, 8);
  assert.equal(supported.summary.strata['2'].verdict, 'supported');

  const weakened = diagnosePairedEvidence({
    evidence: pairedEvidence({ seatCounts: [2], seeds: [1, 2, 3, 4, 5, 6, 7, 8], championWins: 2 }),
    minSamplesPerStratum: 8,
  });
  assert.equal(weakened.summary.strata['2'].verdict, 'weakened');
});

test('Orchestrator：无证据→bootstrap；连续负增益→exploit-weakness；停滞→replicate', () => {
  const modules = moduleRegistry().modules.map(m => m.id);
  const bootstrap = decideNextResearch({ trend: summarizeTrend([]), modules, hasElites: false });
  assert.equal(bootstrap.decision, 'bootstrap');

  const negative = decideNextResearch({
    trend: summarizeTrend([{ delta: -0.1 }, { delta: -0.2 }]),
    diagnosis: { failureCases: [{ seatCount: 2, status: 'supported' }] },
    modules, hasElites: true,
  });
  assert.equal(negative.decision, 'exploit-weakness');

  const stagnant = decideNextResearch({
    trend: summarizeTrend([{ delta: 0.05 }, { delta: 0 }, { delta: -0.01 }]),
    diagnosis: { failureCases: [] },
    memory: { positiveModules: [{ moduleId: 'M06', positives: 1 }], testedHypotheses: [] },
    modules, hasElites: true,
  });
  assert.equal(stagnant.decision, 'replicate');
});

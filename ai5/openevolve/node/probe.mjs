/** AI5 单元探针：在确定性构造状态上直接调用官方与候选的 acquisitionValue。
 *
 * 用途：
 * - 实验 A（基线一致性）：候选=官方代码时，两组输出必须逐位一致；
 * - 实验 B（修改有效性）：行为不同的候选必须产生可观测的输出差异，
 *   证明候选代码真实参与决策，而不是只改了文件没影响运行结果。
 *
 * 探针只构造公开信息形态的入参（stock/hand/played/cardId/preferred/
 * pressure/params），不涉及任何隐藏牌库。
 *
 * 用法：node probe.mjs --candidate <workdir>/dist/js/ai/evaluator.js --out <json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const official = await import(pathToFileURL(join(repoRoot, 'web-v1/dist/js/ai/evaluator.js')).href);
const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
function join(a, b) { return a + '/' + b; }

const candidatePath = arg('candidate');
const outPath = arg('out');
if (!candidatePath) { console.error('缺少 --candidate'); process.exit(2); }
const candidate = await import(pathToFileURL(resolve(candidatePath)).href);
if (typeof candidate.acquisitionValue !== 'function' || typeof official.acquisitionValue !== 'function') {
  console.error('acquisitionValue 不可调用'); process.exit(1);
}

// 冠军参数（与 champion.json 对齐；结构字段不参与本函数，仅保留完整形态）。
const params = {
  id: 'probe', structure: 'beam-rollout',
  engineWeight: 1, tempoWeight: 1, contestWeight: 1, synergyWeight: 1,
  goalWeight: 1, capacityWeight: 1, restWeight: 1, endgameWeight: 1,
};

// 确定性探针状态集：覆盖 trade/create/upgrade 三类卡 × 有/无目标 × 压力强度。
const CASES = [];
const stockSets = [
  [2, 1, 3, 0], [0, 0, 4, 2], [1, 1, 1, 1], [3, 0, 0, 2], [0, 2, 0, 4],
];
const handSets = [
  [], ['M01', 'M35'], ['M05', 'M36', 'M01'], ['M43'], ['S01'],
];
const golems = ['G01', 'G05', 'G09', 'G17', null];
const cardIds = ['M02', 'M08', 'M14', 'M24', 'M35', 'M38', 'M41', 'M43'];
const profiles = [{ engine: 1, contest: 1 }, { engine: 1.35, contest: 0.7 }, { engine: 0.6, contest: 1.5 }];
const pressureLevels = [
  { mean: {}, peak: {} },
  { mean: { M02: 0.8, M14: 0.3 }, peak: { M02: 1.2, M14: 0.4 } },
  { mean: { M24: 1.5, M35: 0.9, M43: 2.0 }, peak: { M24: 2.5, M35: 1.1, M43: 2.0 } },
];
let caseIndex = 0;
for (const stock of stockSets) {
  for (const hand of handSets) {
    for (const preferred of golems) {
      for (const cardId of cardIds) {
        for (const profile of profiles) {
          const pressure = pressureLevels[caseIndex % pressureLevels.length];
          CASES.push({
            id: `case-${caseIndex++}`,
            state: { stock, hand, played: hand.length ? ['M02'] : [] },
            cardId, preferred, profile, pressure, params,
          });
        }
      }
    }
  }
}

function runAll(mod) {
  return CASES.map(c => {
    let value, error = null;
    try { value = mod.acquisitionValue(c.state, c.cardId, c.preferred, c.profile, c.pressure, c.params); }
    catch (e) { error = e.message; }
    return { id: c.id, value, error };
  });
}

const officialOut = runAll(official);
const candidateOut = runAll(candidate);
const errors = [...officialOut, ...candidateOut].filter(r => r.error);
let mismatchCount = 0, maxAbsDiff = 0;
for (let i = 0; i < CASES.length; i++) {
  const a = officialOut[i].value, b = candidateOut[i].value;
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) { mismatchCount++; continue; }
  const d = Math.abs(a - b);
  if (d > 1e-9) { mismatchCount++; maxAbsDiff = Math.max(maxAbsDiff, d); }
}

const result = {
  cases: CASES.length,
  probeErrors: errors.length,
  officialSample: officialOut.slice(0, 8),
  candidateSample: candidateOut.slice(0, 8),
  identicalToOfficial: mismatchCount === 0 && errors.length === 0,
  mismatchCount,
  maxAbsDiff: Number(maxAbsDiff.toFixed(6)),
};
if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: errors.length === 0, identicalToOfficial: result.identicalToOfficial, mismatchCount, probeErrors: errors.length }));
process.exit(errors.length ? 1 : 0);

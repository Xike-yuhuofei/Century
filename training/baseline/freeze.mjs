/** 冠军基线冻结（AI6 第一阶段：research/m4-baseline-freeze）。
 *
 * 目标：把当前正式冠军固化为可审计、可复现的评测基线，供未来 AI 6.0 公平对照。
 * - 冠军代码 / 配置 / 版本指纹 / 模型信息全部快照进 manifest，不做任何行为修改；
 * - engineBundleSha256 当场重算并与 champion.provenance 比对：不一致即抛错
 *   （冠军证据生成后的引擎变更会让"冻结"失真，宁可终止也不出假基线）；
 * - championFingerprint 复用 optimizer/evolve.mjs 的官方实现（id + 结构 + 全参数），
 *   与进化系统对"冠军是否切换"的判定保持同一语义；
 * - manifest 内含逐字节可复现的评测入口命令，未来挑战者（AI 6.0）以此对照。
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { engineBundleSha256, REPO_ROOT } from '../lib/paths.mjs';
import { championFingerprint } from '../optimizer/evolve.mjs';
import { readJSON, writeJSON } from '../lib/io.mjs';

export const CHAMPION_PATH = resolve(REPO_ROOT, 'training/champions/champion.json');

/** 读取正式冠军并校验最小结构完整性。 */
export function loadChampion(championPath = CHAMPION_PATH) {
  const champion = readJSON(championPath);
  if (!champion?.id) throw new Error('champion.json 缺少 id 字段');
  if (!champion?.parameters) throw new Error('champion.json 缺少 parameters 字段');
  if (champion.parameters.id !== champion.id) {
    throw new Error(`champion.json 顶层 id（${champion.id}）与 parameters.id（${champion.parameters.id}）不一致`);
  }
  if (!champion?.provenance?.engineBundleSha256) {
    throw new Error('champion.json 缺少 provenance.engineBundleSha256（无法核验版本指纹）');
  }
  return champion;
}

/** 冠军冻结清单：固定身份、参数、指纹与复现入口。不修改任何冠军行为。 */
export function freezeChampion({ championPath = CHAMPION_PATH, now = new Date().toISOString() } = {}) {
  const champion = loadChampion(championPath);
  const currentBundleSha256 = engineBundleSha256();
  const expected = champion.provenance.engineBundleSha256;
  if (currentBundleSha256 !== expected) {
    throw new Error(
      `冠军版本指纹不一致：champion.provenance=${expected}，当前编译产物=${currentBundleSha256}。\n` +
      '冠军证据生成后引擎已变更，冻结基线失真；请先核实冠军记录或重建证据。',
    );
  }
  const parameters = champion.parameters;
  const evidence = champion.provenance.promotionEvidence ?? {};
  const manifest = {
    schema: 'century-champion-freeze-v1',
    frozenAt: now,
    champion: {
      id: champion.id,
      name: champion.name,
      description: champion.description,
      structure: parameters.structure ?? 'beam-lineage',
      acquisitionVariant: parameters.acquisitionVariant ?? null,
      parameters,
      fingerprint: championFingerprint(parameters),
    },
    version: {
      // 冠军注册时的代码提交（晋级证据，只读引用）与冻结时的仓库提交。
      championCodeCommit: champion.provenance.codeCommit ?? null,
      promotedAt: champion.provenance.promotedAt ?? null,
      engineBundleSha256: currentBundleSha256,
      frozenAtRepoCommit: execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(),
    },
    promotionEvidence: {
      challengeIndex: evidence.challengeIndex ?? null,
      seeds: evidence.seeds ?? null,
      games: evidence.games ?? null,
      seedBase: evidence.seedBase ?? null,
      winRate: evidence.winRate ?? null,
      alphaBudget: evidence.alphaBudget ?? null,
    },
    // 未来挑战者（AI 6.0 / 任何候选）与冻结冠军公平对照的入口。
    reproduce: {
      command: 'npm run baseline -- --players 2,3,4,5 --freeze-check',
      simulator: 'training/simulator/simulate.mjs#simulateGame（正式引擎 web-v1/dist/js 唯一编译产物）',
      runner: 'training/baseline/runner.mjs',
      seedPolicy: 'ai5/lib/seed_policy.mjs AI6_BASELINE_BLOCK [1.1e9, 1.2e9)（账本 training/baseline/seed-ledger.json）',
    },
  };
  return manifest;
}

/** 冻结清单写盘（training/baseline/champion-freeze.json，随 PR 归档审计）。 */
export function writeChampionFreeze(outPath, options = {}) {
  const manifest = freezeChampion(options);
  writeJSON(outPath, manifest);
  return manifest;
}

/** 冻结完整性自检：manifest 与当前仓库状态逐项比对（评审 / 复跑校验用）。 */
export function verifyChampionFreeze(manifest, { championPath = CHAMPION_PATH } = {}) {
  const problems = [];
  const champion = loadChampion(championPath);
  if (manifest.champion.id !== champion.id) problems.push(`冠军 id 变更：${manifest.champion.id} → ${champion.id}`);
  if (manifest.champion.fingerprint !== championFingerprint(champion.parameters)) {
    problems.push('冠军参数指纹变更（championFingerprint 不一致）');
  }
  const currentBundleSha256 = engineBundleSha256();
  if (manifest.version.engineBundleSha256 !== currentBundleSha256) {
    problems.push(`引擎产物指纹变更：${manifest.version.engineBundleSha256} → ${currentBundleSha256}`);
  }
  const canonical = JSON.stringify(freezeChampion({ championPath, now: manifest.frozenAt }).champion);
  if (canonical !== JSON.stringify(manifest.champion)) {
    problems.push('冻结清单的 champion 段与当前冻结输出不一致（配置漂移）');
  }
  return { ok: problems.length === 0, problems };
}

/** 便捷入口：node training/baseline/freeze.mjs [--check] */
const isMain = process.argv[1] && process.argv[1].endsWith('freeze.mjs');
if (isMain) {
  const outPath = resolve(import.meta.dirname, 'champion-freeze.json');
  if (process.argv.includes('--check')) {
    const manifest = readJSON(outPath);
    const { ok, problems } = verifyChampionFreeze(manifest);
    console.log(ok ? '冻结校验通过：冠军配置与版本指纹与冻结清单一致' : `冻结校验失败：\n- ${problems.join('\n- ')}`);
    process.exitCode = ok ? 0 : 1;
  } else {
    const manifest = writeChampionFreeze(outPath);
    console.log(JSON.stringify(manifest, null, 2));
    console.log(`\n冻结清单已写入：${outPath}`);
  }
}

#!/usr/bin/env node
/** 冠军落地后回写构建身份（provenance）。
 *
 * 背景：promote-first-place-champion 在 apply-champion 之前写冠军记录，此时
 * web-v1/dist 仍是旧参数构建；apply + npm run build 后产物身份已经变化。
 * 若不回写，audit-gate 的 V7 会判定“晋级证据身份 ≠ 当前产物”，真实冠军 PR
 * 将无法通过 promotion 门禁。
 *
 * 本脚本只更新 champion.json 的构建身份字段，不改参数、证据、归档或历史。
 * 必须在 apply-champion 与 web-v1 构建之后运行。
 *
 * 用法：node training/scripts/refresh-champion-provenance.mjs [--champion <path>]
 * 退出码：0=已回写且身份一致；1=构建/参数不一致（fail-closed）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT, buildProvenance, requireBuiltEngine } from '../lib/paths.mjs';
import { validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import { championParametersSha256 } from '../../web-v1/scripts/build-hash.mjs';

const args = process.argv.slice(2);
const idx = args.indexOf('--champion');
const championPath = resolve(REPO_ROOT, idx >= 0 ? args[idx + 1] : 'training/champions/champion.json');

requireBuiltEngine();
const doc = JSON.parse(readFileSync(championPath, 'utf8'));
if (!doc?.parameters?.id) throw new Error('冠军文件缺少 parameters.id');
if (!doc.provenance?.promotionEvidence) {
  throw new Error('冠军文件缺少 provenance.promotionEvidence——只允许回写正式第一名率晋级记录');
}
const parameters = validateAIParameters(doc.parameters);
const paramsSha = championParametersSha256(parameters);
const current = buildProvenance();
if (current.championParametersSha256 !== paramsSha) {
  throw new Error(
    `构建产物的冠军参数哈希 ${current.championParametersSha256.slice(0, 12)} ≠ 冠军文件 ${paramsSha.slice(0, 12)}：` +
    '先执行 apply-champion 并重新构建，禁止把旧产物身份写回冠军记录',
  );
}

const provenance = {
  ...doc.provenance,
  engineBundleSha256: current.engineBundleSha256,
  sourceClosureSha256: current.sourceClosureSha256,
  decisionSourceSha256: current.decisionSourceSha256,
  decisionArtifactSha256: current.decisionArtifactSha256,
  championParametersSha256: paramsSha,
  build: {
    schema: current.buildManifestSchema,
    generatedAt: current.buildGeneratedAt,
    gitCommit: current.buildGitCommit,
    gitDirty: current.buildGitDirty,
    artifact: current.engineBundleSha256,
    decisionArtifact: current.decisionArtifactSha256,
    source: current.sourceClosureSha256,
    decisionSource: current.decisionSourceSha256,
    championParameters: paramsSha,
  },
  promotionEvidence: {
    ...doc.provenance.promotionEvidence,
    engineBundleSha256: current.engineBundleSha256,
    sourceClosureSha256: current.sourceClosureSha256,
    decisionSourceSha256: current.decisionSourceSha256,
    decisionArtifactSha256: current.decisionArtifactSha256,
    championParametersSha256: paramsSha,
  },
};
const next = { ...doc, provenance };
writeFileSync(championPath, JSON.stringify(next, null, 2) + '\n');
console.log(JSON.stringify({
  verdict: 'PROVENANCE_REFRESHED',
  champion: parameters.id,
  engineBundleSha256: current.engineBundleSha256,
  decisionSourceSha256: current.decisionSourceSha256,
  decisionArtifactSha256: current.decisionArtifactSha256,
  championParametersSha256: paramsSha,
  gitCommit: current.buildGitCommit,
  gitDirty: current.buildGitDirty,
}, null, 2));

/** 训练系统公共路径工具：定位仓库根目录与已编译的正式 AI/引擎产物。
 *
 * AI7 任务 A3（构建产物一致性）：
 * - 构建时由 web-v1/scripts/build-manifest.mjs 写入 dist/build-manifest.json；
 * - 训练/挑战启动前 requireBuiltEngine 复核「源码闭包哈希 + 产物闭包哈希」，
 *   源码改动但未重新构建 → fail-closed（旧实现只查文件存在性）；
 * - engineBundleSha256 保留旧口径（dist/js 运行时闭包），另提供
 *   engineSourceSha256 / buildProvenance 供证据同时记录源码与产物身份。
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBuildManifest, BUILD_MANIFEST_PATH } from '../../web-v1/scripts/build-hash.mjs';

export const TRAINING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(TRAINING_ROOT, '..');
export const WEB_V1_ROOT = resolve(REPO_ROOT, 'web-v1');
export const DIST_ROOT = resolve(WEB_V1_ROOT, 'dist', 'js');

/** 训练与正式网页游戏使用同一份编译产物，禁止训练侧自带算法副本。
 * 启动前强制复核构建清单：清单缺失 / 源码变更 / 产物变更一律抛错。 */
export function requireBuiltEngine({ allowStale = false } = {}) {
  const engine = resolve(DIST_ROOT, 'engine.js');
  const ai = resolve(DIST_ROOT, 'ai.js');
  if (!existsSync(engine) || !existsSync(ai)) {
    throw new Error(
      '未找到 web-v1/dist/js 编译产物。训练系统与正式游戏共用同一决策核心，请先执行：\n' +
      '  cd web-v1 && npm install && npm run build',
    );
  }
  const verification = verifyBuildManifest({ repoRoot: REPO_ROOT, webRoot: WEB_V1_ROOT });
  if (!verification.ok && !allowStale) {
    throw new Error(
      `构建产物一致性校验失败（fail-closed，AI7-A3）：\n- ${verification.errors.join('\n- ')}\n` +
      '禁止在陈旧/不一致的 dist 上运行训练、评测或正式挑战。',
    );
  }
  for (const warning of verification.warnings) {
    console.error(`构建一致性警告：${warning}`);
  }
  return { engine, ai, manifest: verification.manifest, verification };
}

/** 构建溯源证据（训练报告/挑战证据统一落盘字段）。 */
export function buildProvenance() {
  const { manifest } = requireBuiltEngine();
  return {
    engineBundleSha256: manifest.artifact.sha256,
    sourceClosureSha256: manifest.source.sha256,
    // AI7-A4 规范化身份：决策核心（参数块占位）+ 当前冠军参数块分离核验。
    decisionSourceSha256: manifest.decisionSource.sha256,
    decisionArtifactSha256: manifest.decisionArtifact.sha256,
    championParametersSha256: manifest.championParameters.sha256,
    championParametersId: manifest.championParameters.id,
    parametersArtifactSha256: manifest.parametersArtifact?.sha256 ?? null,
    buildManifestSchema: manifest.schema,
    buildGeneratedAt: manifest.generatedAt,
    buildGitCommit: manifest.gitCommit,
    buildGitDirty: manifest.gitDirty,
    buildManifestPath: BUILD_MANIFEST_PATH,
  };
}

/** 源码闭包指纹（与构建清单同一实现）。 */
export function engineSourceSha256() {
  return buildProvenance().sourceClosureSha256;
}

/** 运行时产物指纹（P1 证据完整性）：对 engine.js + ai.js 的相对 import 闭包内
 * 全部文件做确定性 sha256（路径 + 内容），代表"证据生成时所用的实际引擎版本"。
 * 构建确定性 + package-lock 锁定工具链 → 同源码同指纹。
 * 晋级核验时与确认挑战证据中的指纹比对，不一致说明引擎在证据生成后已变更，
 * 证据不再适用（须重新挑战），杜绝"旧引擎证据晋级到新引擎"的追溯断链。 */
export function engineBundleSha256() {
  const { manifest } = requireBuiltEngine();
  if (!/^[0-9a-f]{64}$/.test(manifest.artifact?.sha256 ?? '')) {
    throw new Error('构建清单缺少合法的 artifact.sha256');
  }
  return manifest.artifact.sha256;
}

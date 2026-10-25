/** 构建一致性哈希（AI7 任务 A3：源码 ↔ 产物强制一致性）。
 *
 * 单一实现，两个消费者共用：
 * - web-v1/scripts/build-manifest.mjs（构建时写清单）；
 * - training/lib/paths.mjs（训练/挑战启动前复核清单）。
 *
 * 哈希口径（确定性，不依赖文件系统遍历顺序）：
 * - 源码闭包 = 全部构建输入（web-v1/src/**、index.html、tsconfig、package 文件、
 *   构建脚本、data/cards.json）；
 * - 产物闭包 = dist/js/engine.js + dist/js/ai.js 的相对 import 闭包（训练与网页
 *   实际加载的运行时文件集），保留旧 engineBundleSha256 的逐字节口径（路径相对
 *   dist/js + 内容），确保证据字段语义不变；
 * - 每个文件单独记录 sha256，清单可人工核对。
 *
 * 纪律：源码闭包/产物闭包任一变化都会改变哈希；训练与挑战启动前必须复核清单，
 * 源码改动但未重新构建 → fail-closed（禁止静默运行旧 dist）。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

export const BUILD_MANIFEST_SCHEMA = 'century-web-build-manifest-v2';
export const BUILD_MANIFEST_PATH = 'dist/build-manifest.json';
export const PARAMETERS_SOURCE_PATH = 'web-v1/src/ai/parameters.ts';
export const PARAMETERS_ARTIFACT_PATH = 'ai/parameters.js';
const PARAMS_BEGIN = '// === CHAMPION-PARAMETERS-BEGIN';
const PARAMS_END = '// === CHAMPION-PARAMETERS-END ===';

/** 稳定 canonical JSON（键排序递归序列化；数组保序）。 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/** 候选/冠军参数身份哈希（晋级证据与部署参数块共用同一口径）。 */
export function championParametersSha256(parameters) {
  return createHash('sha256').update(canonicalJSON(parameters)).digest('hex');
}

/** 把 parameters.ts 的生成区替换为固定占位：参数值变化不改变决策核心源码身份。
 * 生成区之外（校验函数/类型）仍参与决策核心哈希。 */
export function normalizeParametersSource(text) {
  const begin = text.indexOf(PARAMS_BEGIN);
  const end = text.indexOf(PARAMS_END);
  if (begin < 0 || end < 0 || end < begin) return text;
  return text.slice(0, begin) + '// CHAMPION-PARAMETERS-BLOCK-NORMALIZED\n' + text.slice(end + PARAMS_END.length);
}

/** 解析生成区参数对象（apply-champion.mjs 的确定性输出格式）。 */
export function parseChampionParameters(sourceText) {
  const begin = sourceText.indexOf(PARAMS_BEGIN);
  const end = sourceText.indexOf(PARAMS_END);
  if (begin < 0 || end < 0) throw new Error('parameters.ts 缺少 CHAMPION-PARAMETERS 标记块');
  const block = sourceText.slice(begin, end);
  const brace = block.indexOf('{');
  const close = block.lastIndexOf('}');
  if (brace < 0 || close <= brace) throw new Error('CHAMPION_PARAMETERS 生成区缺少对象字面量');
  const body = block.slice(brace + 1, close);
  const parsed = {};
  for (const line of body.split('\n')) {
    const match = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*,?\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    let value;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      value = JSON.parse(raw.replace(/^'|'$/g, '"'));
    } else if (raw === 'true' || raw === 'false') {
      value = raw === 'true';
    } else {
      value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`CHAMPION_PARAMETERS 无法解析字段 ${key}=${raw}`);
    }
    parsed[key] = value;
  }
  return parsed;
}

/** 构建输入清单（相对 repo root；目录递归展开，文件保持顺序稳定）。 */
const SOURCE_INPUTS = Object.freeze([
  'data/cards.json',
  'web-v1/index.html',
  'web-v1/tsconfig.json',
  'web-v1/package.json',
  'web-v1/package-lock.json',
  'web-v1/src',
  'web-v1/scripts/build.mjs',
  'web-v1/scripts/build-ai-runtime.mjs',
  'web-v1/scripts/build-manifest.mjs',
  'web-v1/scripts/build-hash.mjs',
]);

/** 递归列出目录内全部普通文件（排序；忽略 .DS_Store 与临时文件）。 */
function listFilesRecursive(absoluteDir, out = []) {
  for (const name of readdirSync(absoluteDir).sort()) {
    if (name === '.DS_Store') continue;
    const full = resolve(absoluteDir, name);
    const st = statSync(full);
    if (st.isDirectory()) listFilesRecursive(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** repo 相对路径统一为 POSIX 分隔符（跨平台哈希稳定）。 */
function toPosix(path) {
  return path.split(sep).join('/');
}

/** 收集源码闭包文件（绝对路径 + repo 相对路径），排序后返回。 */
export function collectSourceFiles({ repoRoot, webRoot = resolve(repoRoot, 'web-v1') }) {
  const files = [];
  for (const input of SOURCE_INPUTS) {
    const full = resolve(repoRoot, input);
    if (!existsSync(full)) throw new Error(`构建输入缺失：${input}`);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  const unique = [...new Set(files.map(f => resolve(f)))].sort();
  return unique.map(full => ({
    absolute: full,
    path: toPosix(relative(repoRoot, full)),
  }));
}

/** 对文件清单做确定性 sha256（路径 + NUL + 内容）。
 * normalizeParameters=true 时把 parameters.ts 生成区替换为固定占位（决策核心身份）。 */
export function hashFileList(files, { normalizeParameters = false } = {}) {
  const hash = createHash('sha256');
  const records = [];
  for (const file of files) {
    const rel = file.path ?? String(file);
    let bytes = readFileSync(file.absolute ?? file);
    const normalized = normalizeParameters && rel === PARAMETERS_SOURCE_PATH;
    if (normalized) bytes = Buffer.from(normalizeParametersSource(bytes.toString('utf8')), 'utf8');
    hash.update(rel);
    hash.update('\0');
    hash.update(bytes);
    records.push({
      path: rel,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      ...(normalized ? { normalizedParametersBlock: true } : {}),
    });
  }
  return { sha256: hash.digest('hex'), files: records };
}

/** dist/js 运行时闭包（与旧 engineBundleSha256 口径逐字节一致）。 */
export function collectArtifactFiles({ distRoot }) {
  const entries = [resolve(distRoot, 'engine.js'), resolve(distRoot, 'ai.js')];
  for (const entry of entries) {
    if (!existsSync(entry)) throw new Error(`产物缺失：${entry}`);
  }
  const seen = new Set();
  const queue = [...entries];
  const importPattern = /(?:from\s+|import\s+|import\()\s*['"](\.[^'"]+)['"]/g;
  while (queue.length) {
    const file = resolve(queue.shift());
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      let target = resolve(dirname(file), match[1]);
      if (!target.endsWith('.js')) target += '.js';
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].sort().map(full => ({
    absolute: full,
    path: toPosix(relative(distRoot, full)),
  }));
}

/** 产物指纹（旧口径：相对 dist/js 的路径 + 内容）。 */
export function hashArtifactFiles(files) {
  const hash = createHash('sha256');
  const records = [];
  for (const file of files) {
    const bytes = readFileSync(file.absolute ?? file);
    const rel = file.path ?? String(file);
    hash.update(rel);
    hash.update('\0');
    hash.update(bytes);
    records.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  return { sha256: hash.digest('hex'), files: records };
}

/** git 状态（commit + 已跟踪改动，不把未跟踪产物算作 dirty）。 */
export function captureGitState(repoRoot) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const commit = run(['rev-parse', 'HEAD']);
  const dirtyText = run(['status', '--porcelain', '--untracked-files=no']);
  return {
    commit,
    dirty: dirtyText === null ? null : dirtyText.length > 0,
    dirtyFiles: dirtyText === null ? null : dirtyText.split('\n').filter(Boolean).slice(0, 50),
  };
}

/** 生成构建清单（build 的最后一步写入 dist/build-manifest.json）。 */
export function createBuildManifest({ repoRoot, webRoot = resolve(repoRoot, 'web-v1') }) {
  const distRoot = resolve(webRoot, 'dist', 'js');
  const sourceFiles = collectSourceFiles({ repoRoot, webRoot });
  const source = hashFileList(sourceFiles);
  const decisionSource = hashFileList(sourceFiles, { normalizeParameters: true });
  const parametersText = readFileSync(resolve(repoRoot, PARAMETERS_SOURCE_PATH), 'utf8');
  const championParameters = parseChampionParameters(parametersText);
  const artifactFiles = collectArtifactFiles({ distRoot });
  const artifact = hashArtifactFiles(artifactFiles);
  const parametersArtifactFile = artifactFiles.find(file => file.path === PARAMETERS_ARTIFACT_PATH);
  const decisionArtifact = hashArtifactFiles(artifactFiles.filter(file => file.path !== PARAMETERS_ARTIFACT_PATH));
  const parametersArtifact = parametersArtifactFile
    ? hashArtifactFiles([parametersArtifactFile])
    : { sha256: null, files: [] };
  const git = captureGitState(repoRoot);
  const packageJson = JSON.parse(readFileSync(resolve(webRoot, 'package.json'), 'utf8'));
  return {
    schema: BUILD_MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    gitCommit: git.commit,
    gitDirty: git.dirty,
    gitDirtyFiles: git.dirtyFiles,
    source: { algorithm: 'sha256(path\\0content)', sha256: source.sha256, fileCount: source.files.length, files: source.files },
    decisionSource: {
      algorithm: 'sha256(path\\0normalized-content)',
      note: 'parameters.ts 的 CHAMPION-PARAMETERS 生成区替换为固定占位（参数值变化不改变决策核心身份）',
      sha256: decisionSource.sha256,
      fileCount: decisionSource.files.length,
      files: decisionSource.files,
    },
    championParameters: {
      algorithm: 'sha256(canonicalJSON)',
      id: championParameters.id ?? null,
      sha256: championParametersSha256(championParameters),
    },
    artifact: { root: 'dist/js', algorithm: 'sha256(path\\0content)', sha256: artifact.sha256, fileCount: artifact.files.length, files: artifact.files },
    decisionArtifact: {
      algorithm: 'sha256(path\\0content)',
      note: '运行产物闭包排除 ai/parameters.js（参数块单独以 championParameters 身份核验）',
      sha256: decisionArtifact.sha256,
      fileCount: decisionArtifact.files.length,
      files: decisionArtifact.files,
    },
    parametersArtifact: {
      path: PARAMETERS_ARTIFACT_PATH,
      sha256: parametersArtifact.sha256,
    },
    toolchain: {
      node: process.version,
      esbuild: packageJson.devDependencies?.esbuild ?? null,
      typescript: packageJson.devDependencies?.typescript ?? null,
    },
  };
}

/** 复核构建清单：返回值不抛错（调用方决定阻断策略），错误列表可直接展示。 */
export function verifyBuildManifest({ repoRoot, webRoot = resolve(repoRoot, 'web-v1') }) {
  const manifestPath = resolve(webRoot, BUILD_MANIFEST_PATH);
  const errors = [];
  const warnings = [];
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      errors: [`构建清单缺失：${manifestPath}（必须先执行 cd web-v1 && npm run build）`],
      warnings,
      manifest: null,
      current: null,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`构建清单不是合法 JSON：${error.message}`], warnings, manifest: null, current: null };
  }
  if (manifest.schema !== BUILD_MANIFEST_SCHEMA) {
    errors.push(`构建清单 schema 不识别：${String(manifest.schema)}（期望 ${BUILD_MANIFEST_SCHEMA}）`);
  }
  let current = null;
  try {
    const sourceFiles = collectSourceFiles({ repoRoot, webRoot });
    const source = hashFileList(sourceFiles);
    const decisionSource = hashFileList(sourceFiles, { normalizeParameters: true });
    const parametersText = readFileSync(resolve(repoRoot, PARAMETERS_SOURCE_PATH), 'utf8');
    const championParameters = parseChampionParameters(parametersText);
    const artifactFiles = collectArtifactFiles({ distRoot: resolve(webRoot, 'dist', 'js') });
    const artifact = hashArtifactFiles(artifactFiles);
    const decisionArtifact = hashArtifactFiles(artifactFiles.filter(file => file.path !== PARAMETERS_ARTIFACT_PATH));
    const parametersArtifactFile = artifactFiles.find(file => file.path === PARAMETERS_ARTIFACT_PATH);
    const parametersArtifact = parametersArtifactFile
      ? hashArtifactFiles([parametersArtifactFile])
      : { sha256: null, files: [] };
    const git = captureGitState(repoRoot);
    current = {
      sourceSha256: source.sha256,
      decisionSourceSha256: decisionSource.sha256,
      championParametersId: championParameters.id ?? null,
      championParametersSha256: championParametersSha256(championParameters),
      artifactSha256: artifact.sha256,
      decisionArtifactSha256: decisionArtifact.sha256,
      parametersArtifactSha256: parametersArtifact.sha256,
      git,
    };
    if (manifest.source?.sha256 !== source.sha256) {
      errors.push(
        `源码在构建后已变更（stale dist）：清单 ${String(manifest.source?.sha256).slice(0, 12)} ≠ 当前 ${source.sha256.slice(0, 12)}；` +
        '拒绝在旧产物上运行训练/评测，请先 cd web-v1 && npm run build',
      );
    }
    if (manifest.artifact?.sha256 !== artifact.sha256) {
      errors.push(
        `产物与清单不一致（dist 被改动或未完整构建）：清单 ${String(manifest.artifact?.sha256).slice(0, 12)} ≠ 当前 ${artifact.sha256.slice(0, 12)}`,
      );
    }
    if (manifest.decisionSource?.sha256 !== decisionSource.sha256) {
      errors.push(
        `决策核心源码在构建后已变更：清单 ${String(manifest.decisionSource?.sha256).slice(0, 12)} ≠ 当前 ${decisionSource.sha256.slice(0, 12)}`,
      );
    }
    if (manifest.championParameters?.sha256 !== championParametersSha256(championParameters)) {
      errors.push(
        `CHAMPION_PARAMETERS 生成区与清单不一致：清单 ${String(manifest.championParameters?.sha256).slice(0, 12)} ≠ 当前 ${championParametersSha256(championParameters).slice(0, 12)}`,
      );
    }
    if (manifest.decisionArtifact?.sha256 !== decisionArtifact.sha256) {
      errors.push(
        `决策核心产物闭包与清单不一致：清单 ${String(manifest.decisionArtifact?.sha256).slice(0, 12)} ≠ 当前 ${decisionArtifact.sha256.slice(0, 12)}`,
      );
    }
    if ((manifest.parametersArtifact?.sha256 ?? null) !== parametersArtifact.sha256) {
      errors.push('ai/parameters.js 产物哈希与清单不一致');
    }
    if (manifest.gitCommit && git.commit && manifest.gitCommit !== git.commit) {
      warnings.push(`构建时 commit ${manifest.gitCommit.slice(0, 12)} ≠ 当前 HEAD ${git.commit.slice(0, 12)}（源码哈希已覆盖实际一致性）`);
    }
    if (git.dirty) {
      warnings.push('当前工作区存在已跟踪文件改动（dirty=true）；正式挑战证据必须记录该状态');
    }
  } catch (error) {
    errors.push(`复核构建清单失败：${error.message}`);
  }
  return { ok: errors.length === 0, errors, warnings, manifest, current };
}

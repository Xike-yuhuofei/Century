/** D1：Candidate Artifact 内容寻址仓库。
 *
 * 目录布局（root 可注入，默认 training/evolution/artifacts）：
 *   objects/<candidateId>/<identityDigest>/candidate.json
 *   objects/<candidateId>/<identityDigest>/source/<path>
 *   index.jsonl（只追加审计日志：每次 put/update 记录 id、身份、全文哈希）
 *
 * 纪律：
 * - candidateId 与 identityDigest 一一对应；同 id 不同身份直接拒绝（防人工覆盖）；
 * - 同身份不同 id 允许保存但 `findByIdentity` 会报告别名（供去重）；
 * - 写入使用临时文件 + rename（崩溃不产生半截 artifact）；
 * - 读取即校验全部哈希（内容寻址仓库不接受"看起来像"的 artifact）。
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateArtifact, validateArtifact, verifyArtifactReproducibility } from './candidate-artifact.mjs';
import { assertCondition, SCHEMAS } from './core.mjs';

const EVOLUTION_ROOT = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ARTIFACT_ROOT = resolve(EVOLUTION_ROOT, 'artifacts');

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function atomicWrite(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return path;
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export class ArtifactStore {
  constructor({ root = DEFAULT_ARTIFACT_ROOT } = {}) {
    this.root = resolve(root);
    this.indexPath = join(this.root, 'index.jsonl');
    ensureDir(this.root);
  }

  _objectDir(artifact) {
    return join(this.root, 'objects', artifact.candidateId, artifact.identityDigest);
  }

  _appendIndex(record) {
    ensureDir(dirname(this.indexPath));
    const line = JSON.stringify(record) + '\n';
    const existing = existsSync(this.indexPath) ? readFileSync(this.indexPath, 'utf8') : '';
    atomicWrite(this.indexPath, existing + line);
  }

  /** 打包并注册（幂等：同 id + 同身份重复写入直接返回现有对象）。 */
  put(artifact) {
    validateArtifact(artifact);
    const idDir = join(this.root, 'objects', artifact.candidateId);
    if (existsSync(idDir)) {
      const identities = readdirSync(idDir).filter(name => statSync(join(idDir, name)).isDirectory());
      const other = identities.find(identity => identity !== artifact.identityDigest);
      if (other) {
        throw new Error(`candidateId ${artifact.candidateId} 已注册不同身份 ${other}——禁止覆盖历史候选`);
      }
    }
    const dir = this._objectDir(artifact);
    const artifactPath = join(dir, 'candidate.json');
    let created = true;
    if (existsSync(artifactPath)) {
      created = false;
      const existing = readJSON(artifactPath);
      validateArtifact(existing);
      assertCondition(existing.identityDigest === artifact.identityDigest,
        `candidateId ${artifact.candidateId} 已注册但身份不同（现有 ${existing.identityDigest}，新 ${artifact.identityDigest}）——禁止覆盖历史候选`);
      if (existing.artifactHash === artifact.artifactHash) {
        return { candidateId: artifact.candidateId, identityDigest: artifact.identityDigest, path: artifactPath, created: false };
      }
    }
    atomicWrite(artifactPath, JSON.stringify(artifact, null, 2));
    const sourceRoot = join(dir, 'source');
    for (const file of artifact.source.files) {
      atomicWrite(join(sourceRoot, file.path), file.content);
    }
    this._appendIndex({
      schema: SCHEMAS.artifactManifest,
      candidateId: artifact.candidateId,
      identityDigest: artifact.identityDigest,
      artifactHash: artifact.artifactHash,
      status: artifact.status,
      at: new Date().toISOString(),
    });
    return { candidateId: artifact.candidateId, identityDigest: artifact.identityDigest, path: artifactPath, created };
  }

  /** 按 candidateId 加载（缺省返回该 id 的最新身份目录；同 id 多身份会被拒绝）。 */
  get(candidateId) {
    assertCondition(typeof candidateId === 'string' && candidateId.length > 0, 'candidateId 缺失');
    const idDir = join(this.root, 'objects', candidateId);
    if (!existsSync(idDir)) throw new Error(`artifact 不存在：${candidateId}`);
    const identities = readdirSync(idDir).filter(name => statSync(join(idDir, name)).isDirectory());
    assertCondition(identities.length === 1,
      `candidateId ${candidateId} 存在 ${identities.length} 个身份目录——仓库状态异常`);
    const artifact = readJSON(join(idDir, identities[0], 'candidate.json'));
    validateArtifact(artifact);
    return artifact;
  }

  /** 按算法身份查找（去重/别名检测）。 */
  findByIdentity(identityDigest) {
    const matches = this.list({ identityDigest });
    return matches.map(m => m.candidateId);
  }

  /** 列出全部候选摘要；可按 identityDigest/status 过滤。 */
  list({ identityDigest = null, status = null } = {}) {
    const objects = join(this.root, 'objects');
    if (!existsSync(objects)) return [];
    const rows = [];
    for (const candidateId of readdirSync(objects)) {
      const idDir = join(objects, candidateId);
      if (!statSync(idDir).isDirectory()) continue;
      for (const identity of readdirSync(idDir)) {
        const artifactPath = join(idDir, identity, 'candidate.json');
        if (!existsSync(artifactPath)) continue;
        const artifact = readJSON(artifactPath);
        if (identityDigest !== null && artifact.identityDigest !== identityDigest) continue;
        if (status !== null && artifact.status !== status) continue;
        rows.push({
          candidateId: artifact.candidateId,
          parentId: artifact.parentId,
          identityDigest: artifact.identityDigest,
          artifactHash: artifact.artifactHash,
          status: artifact.status,
          sourceHash: artifact.sourceHash,
          buildArtifactHash: artifact.buildArtifact.sha256,
          safetyStatus: artifact.safety.status,
          evidenceDir: artifact.evidenceDir,
          evaluationMode: artifact.algorithmStructure.evaluationMode,
          targetIds: artifact.algorithmStructure.targetIds,
          applicablePlayerCounts: artifact.applicablePlayerCounts,
        });
      }
    }
    return rows.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
  }

  /** 更新可变字段并重封印（身份不变）。 */
  update(candidateId, patch) {
    const current = this.get(candidateId);
    const next = updateArtifact(current, patch);
    this.put(next);
    return next;
  }

  /** 可复现验证：重算全部哈希 + 源文件内容。 */
  verify(candidateId) {
    const artifact = this.get(candidateId);
    return verifyArtifactReproducibility(artifact);
  }

  /** 索引审计行（最近 limit 条）。 */
  readIndex({ limit = 200 } = {}) {
    if (!existsSync(this.indexPath)) return [];
    const lines = readFileSync(this.indexPath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  }
}


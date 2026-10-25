/** macOS Seatbelt（sandbox-exec）执行器：编译/探针等不可信代码步骤专用。
 *
 * 纪律（与 AI5 沙箱同口径）：
 * - 默认全拒；允许执行/派生进程；允许读系统与仓库；
 * - 只允许写工作区与系统临时目录；
 * - 拒绝读取真实用户主目录内容（避免密钥/历史泄漏），但放行元数据；
 * - 拒绝一切网络。
 *
 * 非 macOS 或 sandbox-exec 缺失时 **fail closed**：直接抛错，绝不降级为
 * 无沙箱执行（Linux CI 不得冒充 Seatbelt 验证）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SEATBELT_AVAILABLE = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

function sbString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function renderSeatbeltProfile({ workRoot, repoRoot = REPO_ROOT, home = homedir() }) {
  const work = sbString(resolve(workRoot));
  return [
    '(version 1)',
    ';; AI7 候选编译/探针沙箱：禁网、禁读 HOME 内容、只写工作区。',
    '(deny default)',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${work}) (subpath ${sbString(tmpdir())}) (subpath "/private/var/folders/") (subpath "/private/tmp/") (subpath "/private/etc/"))`,
    `(deny file-read-data (subpath ${sbString(home)}))`,
    `(allow file-read-data (subpath ${sbString(resolve(repoRoot))}))`,
    `(allow file-read-data (subpath ${work}))`,
    '(deny network*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow iokit-open)',
  ].join('\n') + '\n';
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

/** 在 Seatbelt 内执行命令；返回结构化结果（不抛超时异常）。 */
export function runSeatbelt({
  workRoot, command, args = [], cwd = null, timeoutMs = 120_000, extraEnv = {},
}) {
  if (!SEATBELT_AVAILABLE) {
    throw new Error('Seatbelt 不可用（非 macOS 或缺少 /usr/bin/sandbox-exec）——编译型候选 fail closed');
  }
  const root = resolve(workRoot);
  ensureDir(root);
  ensureDir(join(root, 'home'));
  ensureDir(join(root, 'tmp'));
  const profilePath = join(root, 'sandbox.sb');
  writeFileSync(profilePath, renderSeatbeltProfile({ workRoot: root }), 'utf8');

  const nodeDir = dirname(process.execPath);
  const env = {
    PATH: `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    ...extraEnv,
  };
  const result = spawnSync(SANDBOX_EXEC, ['-f', profilePath, command, ...args], {
    cwd: cwd ? resolve(cwd) : root,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  return {
    ok: !timedOut && result.status === 0,
    status: timedOut ? -1 : result.status,
    timedOut,
    stdout: result.stdout ?? '',
    stderr: result.error && !timedOut ? `${result.stderr ?? ''}\n${result.error.message}` : (result.stderr ?? ''),
    profilePath,
  };
}

/** 以当前 node 执行仓库内脚本（绝对路径，避免依赖 cwd）。 */
export function runNodeSeatbelt({ workRoot, script, args = [], timeoutMs = 120_000, cwd = null, extraEnv = {} }) {
  return runSeatbelt({
    workRoot,
    command: process.execPath,
    args: [resolve(script), ...args],
    cwd: cwd ?? workRoot,
    timeoutMs,
    extraEnv,
  });
}

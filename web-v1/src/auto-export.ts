import { archiveKey } from './archive.js';
import { downloadReplay } from './replay.js';
import type { Game } from './engine.js';

/** 自动导出：对局结束后自动把复盘 JSON 下载到浏览器默认下载文件夹（~/Downloads）。
 * 走普通浏览器下载机制（downloadReplay 同款），不涉及任何权限 API，刷新后无需重新授权。
 * 如需固定到专属文件夹，在浏览器设置中把下载目录指向该文件夹即可。 */

export const AUTO_EXPORT_KEY = 'crystal-corridor-auto-export-v1';

function safeLocal(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
export function autoExportEnabled(): boolean {
  try { return safeLocal()?.getItem(AUTO_EXPORT_KEY) === 'on'; } catch { return false; }
}
export function enableAutoExport(): void {
  try { safeLocal()?.setItem(AUTO_EXPORT_KEY, 'on'); } catch { /* 存储不可用时本次会话仍可手动导出 */ }
}
export function disableAutoExport(): void {
  try { safeLocal()?.removeItem(AUTO_EXPORT_KEY); } catch { /* 同上 */ }
}

export type AutoExportContext = {
  enabled: boolean;
  exported: ReadonlySet<string>;
};
export type AutoExportPlan =
  | { kind: 'download' }
  | { kind: 'skip'; reason: 'not-finished' | 'disabled' | 'duplicate' };

/** 纯决策：只导出「结束」的对局；同指纹会话内只导出一次。 */
export function autoExportPlan(g: Game, ctx: AutoExportContext): AutoExportPlan {
  if (g.phase !== 'finished') return { kind: 'skip', reason: 'not-finished' };
  if (!ctx.enabled) return { kind: 'skip', reason: 'disabled' };
  if (ctx.exported.has(archiveKey(g))) return { kind: 'skip', reason: 'duplicate' };
  return { kind: 'download' };
}

const autoExported = new Set<string>();

/** 对局结束时调用。下载 JSON 复盘；未触发返回 null，触发返回 'download'。 */
export function maybeAutoExport(g: Game): 'download' | null {
  const plan = autoExportPlan(g, { enabled: autoExportEnabled(), exported: autoExported });
  if (plan.kind === 'skip') return null;
  autoExported.add(archiveKey(g));
  downloadReplay(g);
  return 'download';
}

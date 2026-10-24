#!/usr/bin/env node
/** 红队审计 #4：第六阶段正式实验前审计门禁。
 *
 * 聚合全部红队审计并给出放行判定。第六阶段任何正式实验（消耗新种子块、
 * 产生晋级候选证据）开始前必须先跑本门禁；P0 未清零则不放行。
 *
 * 用法：node training/redteam/audit-gate.mjs
 * 退出码：0=放行（P0 清零，P1 可带条件放行）；2=阻断（存在 P0）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const run = (script, args = []) => {
  try {
    return { out: execFileSync('node', [resolve(REPO_ROOT, script), ...args], { encoding: 'utf8', timeout: 600_000 }), code: 0 };
  } catch (error) {
    return { out: (error.stdout ?? '') + (error.stderr ?? ''), code: error.status ?? 1 };
  }
};

console.log('== 第六阶段审计门禁 ==\n');
const results = {};

// 1. 版本身份审计（行为学；需要 dist）
const distReady = existsSync(resolve(REPO_ROOT, 'web-v1/dist/js/ai.js'));
if (!distReady) {
  results['版本身份'] = { verdict: 'BLOCKED', note: 'web-v1/dist 未构建——先 cd web-v1 && npm run build（门禁拒绝在无产物状态下放行）' };
} else {
  const r = run('training/redteam/audit-versions.mjs');
  const p0 = (r.out.match(/\[P0\]/g) ?? []).length;
  results['版本身份'] = { verdict: p0 ? 'BLOCKED' : 'PASS', p0, detail: r.out.split('\n').filter(l => l.startsWith('[')).join('\n  ') };
}

// 2. 历史证据核算
{
  const r = run('training/redteam/audit-evidence-accounting.mjs');
  const p0 = (r.out.match(/\[P0\]/g) ?? []).length;
  results['证据核算'] = { verdict: p0 ? 'BLOCKED' : 'PASS_WITH_NOTES', p0, detail: r.out.split('\n').filter(l => l.startsWith('[')).join('\n  ') };
}

// 3. 双人 A/B 独立统计（信息性，不阻断）
{
  const r = run('training/redteam/stats-two-player.mjs');
  results['双人统计'] = { verdict: 'INFO', detail: r.out.includes('交叉核对') ? '完成（与 compare.mjs 交叉一致）' : '完成' };
}

// 4. 回归测试（缺陷快照 + 期望不变量）
{
  const r = run('training/redteam/tests/redteam.test.mjs', []); // node --test 由下方直接调用
}
{
  const r = (() => {
    try {
      return { out: execFileSync('node', ['--test', '--test-concurrency=2', resolve(REPO_ROOT, 'training/redteam/tests/redteam.test.mjs')], { encoding: 'utf8', timeout: 600_000 }), code: 0 };
    } catch (error) { return { out: (error.stdout ?? '') + (error.stderr ?? ''), code: error.status ?? 1 }; }
  })();
  const pass = /# pass (\d+)/.exec(r.out)?.[1];
  const fail = /# fail (\d+)/.exec(r.out)?.[1];
  results['回归测试'] = { verdict: Number(fail) ? 'BLOCKED' : 'PASS', detail: `pass=${pass} fail=${fail}（快照类失败=缺陷已被修复，请更新 OVERNIGHT-AUDIT.md 缺陷清单与快照断言）` };
}

// 5. 治理核查：全局晋级 vs 按人数证据（P0-3 现状追踪）
{
  const champ = JSON.parse(readFileSync(resolve(REPO_ROOT, 'training/champions/champion.json'), 'utf8'));
  const evidence = champ.provenance?.promotionEvidence ?? {};
  const routed = existsSync(resolve(REPO_ROOT, 'training/champions/seat-routing.json'));
  const globalWithoutRouting = !routed;
  results['晋级治理'] = {
    verdict: 'BLOCKED',
    detail: `冠军 ${champ.parameters?.id} 为全局晋级（无分人数路由文件），但正式挑战证据仅覆盖 5 人局` +
      `（promotionEvidence.seeds=${evidence.seeds}，challenge.mjs SEAT_COUNT=5）；PHASE5 门槛 B 明确「2 人保留冠军」。` +
      '修复路径二选一：①实现分人数路由（2p 回退前任冠军）后复审；②补跑 2p（及 3p/4p 需要时）正式挑战。修复后本门禁项改判。',
  };
}

// ---- 汇总 ----
let blocked = false;
console.log('门禁项            判定');
for (const [k, v] of Object.entries(results)) {
  console.log(`${k.padEnd(16)} ${v.verdict}${v.p0 !== undefined ? `（P0×${v.p0}）` : ''}`);
  if (v.verdict === 'BLOCKED') blocked = true;
}
console.log('');
for (const [k, v] of Object.entries(results)) {
  if (v.detail) console.log(`-- ${k} --\n  ${v.detail}\n`);
}
console.log(blocked
  ? '门禁判定：阻断。第六阶段正式实验（新种子消费/晋级候选证据）不得开始；先清零 P0。'
  : '门禁判定：放行。');
process.exit(blocked ? 2 : 0);

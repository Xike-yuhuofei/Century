/** Century 真人竞技复盘与失败诊断系统 —— CLI 入口。
 *
 * 命令：
 *   node cli.mjs check <对局.json...>                 只做导入校验，打印异常报告
 *   node cli.mjs analyze <对局.json...> --out <目录>  导入→指标→失败诊断→案例→报告
 *   node cli.mjs aggregate --out <目录> [--dir <分析目录>] [--js5 <diagnostics.jsonl>]
 *   node cli.mjs fixtures --out <目录>               生成 AI 模拟测试对局（明确标注来源）
 *
 * 选项（analyze）：--max-cases <N>（默认 60）；--no-cases 跳过案例提取。
 *
 * 隐私：完全离线，不上传任何数据、不调用在线 API。
 * 确定性：同一记录重复运行输出逐字节一致。
 */

import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { importGameFiles } from './import-games.mjs';
import { computeGameMetrics } from './metrics.mjs';
import { computeFailureDiagnosis } from './failures.mjs';
import { extractCases, assertNoHiddenInfo } from './cases.mjs';
import { writeGameReports, writeAggregateReport, collectAnalysisEntries, summarizeJs5Diagnostics } from './report.mjs';
import { generateFixtures } from './fixtures-gen.mjs';

function usage() {
  console.log(`用法：
  node cli.mjs check <对局.json...>
  node cli.mjs analyze <对局.json...> --out <目录> [--max-cases N] [--no-cases]
  node cli.mjs aggregate --out <目录> [--dir <analyze 输出目录>] [--js5 <jsonl>]
  node cli.mjs fixtures --out <目录>`);
}

function parseArgs(argv) {
  const args = { files: [], out: null, dir: null, js5: null, maxCases: 60, noCases: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--dir') args.dir = resolve(argv[++i]);
    else if (a === '--js5') args.js5 = resolve(argv[++i]);
    else if (a === '--max-cases') args.maxCases = Number(argv[++i]);
    else if (a === '--no-cases') args.noCases = true;
    else args.files.push(a);
  }
  return args;
}

const inputOk = p => { try { return statSync(p).isFile(); } catch { return false; } };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd) { usage(); process.exit(2); }

  if (cmd === 'fixtures') {
    if (!args.out) { console.error('需要 --out <目录>'); process.exit(2); }
    const made = await generateFixtures(args.out);
    for (const m of made) console.log(`[simulated-scripted] ${m.tag} ${m.seats}p turns=${m.turns} finished=${m.finished} → ${m.file}`);
    console.log('注意：以上均为 AI 模拟对局（脚本化合法策略），不得冒充真人数据。');
    return;
  }

  if (cmd === 'check') {
    if (!args.files.length) { usage(); process.exit(2); }
    // P1-2 整改（批处理失败策略，fail-closed）：
    // - 输入文件不存在 = 检查失败（绝不静默过滤）；全部输入不存在 = 直接非零退出
    //   （空检查集合不得代表"全部通过"）；
    // - 报告必须披露：实际检查数 / 通过数 / 失败数 / 缺失数。
    const missing = args.files.filter(f => !inputOk(f));
    for (const m of missing) console.error(`[错误] 找不到文件：${m}`);
    const present = args.files.filter(inputOk);
    let checked = 0, passed = 0, failed = 0;
    for (const r of await importGameFiles(present)) {
      checked++;
      const errors = r.anomalies.filter(a => a.level === 'error');
      if (errors.length) failed++;
      else passed++;
      console.log(`\n${r.file}: ${errors.length ? '拒绝' : r.ok ? '通过' : '拒绝'}（座位 ${r.meta?.seatCount ?? '?'}，${r.meta?.turnCount ?? 0} 手）`);
      for (const a of r.anomalies) console.log(`  ${a.level === 'error' ? '[错误]' : '[警告]'} ${a.code}：${a.message}`);
    }
    console.error(`\n检查披露：输入 ${args.files.length}（缺失 ${missing.length}），实际检查 ${checked}，通过 ${passed}，失败 ${failed}`);
    // 非零退出条件：任一输入缺失 / 任一文件检查失败 / 一个文件都没检查。
    if (missing.length || failed || !checked) process.exit(1);
    return;
  }

  if (cmd === 'analyze') {
    if (!args.files.length || !args.out) { usage(); process.exit(2); }
    // P1-2 整改：缺失输入 = 批处理失败（fail-closed）；全部缺失直接非零退出。
    const missing = args.files.filter(f => !inputOk(f));
    for (const m of missing) console.error(`[错误] 找不到文件：${m}`);
    const files = args.files.filter(inputOk);
    let analyzed = 0, rejected = 0;
    for (const r of await importGameFiles(files)) {
      const errors = r.anomalies.filter(a => a.level === 'error');
      if (errors.length) {
        rejected++;
        console.error(`\n[拒绝] ${r.file}`);
        for (const a of errors) console.error(`  [错误] ${a.code}：${a.message}`);
        for (const w of r.anomalies.filter(a => a.level === 'warn')) console.error(`  [警告] ${w.code}：${w.message}`);
        continue;
      }
      const metrics = await computeGameMetrics(r);
      const failures = computeFailureDiagnosis(metrics);
      let casesBundle = null;
      if (!args.noCases) {
        casesBundle = await extractCases(r, metrics, { maxCases: args.maxCases });
        const leaks = assertNoHiddenInfo(casesBundle);
        if (leaks.length) throw new Error(`隐藏信息泄漏检查失败：\n${leaks.join('\n')}`);
      }
      const filesWritten = writeGameReports({ metrics, failures, casesBundle }, args.out);
      analyzed++;
      console.log(`\n[分析完成] ${r.file}（座位 ${r.meta.seatCount}，${r.meta.turnCount} 手，${r.meta.finished ? '已完成' : '未完成'}，来源 ${r.provenance.kind}）`);
      console.log(`  指标：${filesWritten.metrics}`);
      console.log(`  失败诊断：${filesWritten.failures}`);
      if (casesBundle) console.log(`  战术案例：${filesWritten.cases}（${casesBundle.selected} 条，泄漏检查通过）`);
      console.log(`  复盘报告：${filesWritten.report}`);
      for (const w of r.anomalies.filter(a => a.level === 'warn')) console.log(`  [警告] ${w.code}：${w.message}`);
    }
    console.error(`\n批处理披露：输入 ${args.files.length}（缺失 ${missing.length}），实际处理 ${analyzed + rejected}，成功 ${analyzed}，拒绝 ${rejected}`);
    // 非零退出条件（明确批处理失败策略）：任一输入缺失 / 任一文件被拒 / 一个都没处理。
    if (missing.length || rejected || !analyzed) process.exit(1);
    return;
  }

  if (cmd === 'aggregate') {
    if (!args.out || (!args.dir && !args.files.length)) { usage(); process.exit(2); }
    let entries = [];
    if (args.dir) entries = collectAnalysisEntries(args.dir);
    const js5 = args.js5 ? summarizeJs5Diagnostics(args.js5) : null;
    if (!entries.length) { console.error('没有可聚合的 *.metrics.json（先用 analyze 生成）。'); process.exit(2); }
    const files = writeAggregateReport(entries, args.out, js5);
    console.log(`聚合 ${entries.length} 局 → ${files.report}`);
    console.log(`结构化 JSON → ${files.json}`);
    return;
  }

  usage();
  process.exit(2);
}

main().catch(e => { console.error(e); process.exit(1); });

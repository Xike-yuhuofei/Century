#!/usr/bin/env node
/** 采集 GitHub Actions 运行/作业/步骤耗时，用于 CI 用时与失败原因复盘。
 *
 * 用法：
 *   node scripts/ci/ci-metrics.mjs --run 40171122424 --run 40164344553
 *   node scripts/ci/ci-metrics.mjs --run <id> --json /tmp/metrics.json --md /tmp/metrics.md
 *
 * 说明：通过 gh api 读取（需要已登录 gh）；不修改任何工作流或仓库设置。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function parseArgs(argv) {
  const runs = [];
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') { runs.push(argv[i + 1]); i++; continue; }
    if (argv[i] === '--json') { values.json = argv[i + 1]; i++; continue; }
    if (argv[i] === '--md') { values.md = argv[i + 1]; i++; continue; }
    if (argv[i] === '--repo') { values.repo = argv[i + 1]; i++; }
  }
  return { runs, ...values };
}

function seconds(start, end) {
  if (!start || !end) return null;
  const value = Math.round((new Date(end) - new Date(start)) / 1000);
  return value >= 0 ? value : null;
}

function formatDuration(sec) {
  if (sec == null) return '-';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function collectRun(repo, runId) {
  const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}`]));
  const jobs = (JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`])).jobs ?? [])
    .filter(job => job.run_attempt === run.run_attempt);
  const jobRows = jobs.map(job => ({
    name: job.name,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    seconds: seconds(job.started_at, job.completed_at),
    failedSteps: (job.steps ?? []).filter(s => s.conclusion === 'failure').map(s => s.name),
  }));
  const executed = jobRows.filter(j => j.seconds != null);
  return {
    runId: Number(runId),
    workflow: run.name,
    event: run.event,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    wallSeconds: seconds(run.created_at, run.updated_at),
    runnerJobSeconds: executed.reduce((sum, j) => sum + j.seconds, 0),
    jobs: jobRows,
  };
}

function renderMarkdown(runs) {
  const lines = [
    '# CI 运行耗时采集',
    '',
    '| 运行 | 工作流 | 事件 | 结论 | 分支 | 墙钟 | 作业累计 |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of runs) {
    lines.push(`| ${r.runId} | ${r.workflow} | ${r.event} | ${r.conclusion} | ${r.headBranch ?? '-'} | ${formatDuration(r.wallSeconds)} | ${formatDuration(r.runnerJobSeconds)} |`);
  }
  lines.push('');
  for (const r of runs) {
    lines.push(`## ${r.workflow} · run ${r.runId}`, '', '| 作业 | 结论 | 耗时 | 失败步骤 |', '|---|---|---|---|');
    for (const j of r.jobs) {
      lines.push(`| ${j.name} | ${j.conclusion} | ${formatDuration(j.seconds)} | ${j.failedSteps.join(', ') || '-'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runs.length) throw new Error('至少提供一个 --run <id>');
  const repo = args.repo || gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  const runs = args.runs.map(id => collectRun(repo, id));
  const markdown = renderMarkdown(runs);
  console.log(markdown);
  if (args.json) writeFileSync(args.json, JSON.stringify({ repo, runs }, null, 2));
  if (args.md) writeFileSync(args.md, `${markdown}\n`);
}

try {
  main();
} catch (error) {
  console.error(`采集失败：${error.stderr ?? error.message}`);
  process.exit(1);
}

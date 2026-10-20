/** 训练系统 I/O 工具：JSON / JSONL / CSV 写出与实验记录。 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJSON(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

export function appendJSONL(path, record) {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(record) + '\n');
  return path;
}

export function readJSONL(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

export function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 将对象数组写出为 CSV；值内逗号、引号、换行按 RFC 4180 转义。 */
export function writeCSV(path, rows, columns) {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const escape = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const body = [cols.join(','), ...rows.map(row => cols.map(c => escape(row[c])).join(','))].join('\n');
  ensureDir(dirname(path));
  writeFileSync(path, body + '\n');
  return path;
}

/** 确定性实验时间戳：由种子与轮次派生，不依赖真实时钟，保证可复现。 */
export function experimentId({ prefix, seed, round = 0, date }) {
  const day = date ?? new Date().toISOString().slice(0, 10);
  return `${prefix}-${day}-seed${seed}-r${round}`;
}

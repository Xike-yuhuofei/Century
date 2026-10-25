#!/usr/bin/env node
/** 战术基准库·公开/私有数据层拆分（P1-3）。
 *
 * 从原始语料 data/scenarios.jsonl 确定性生成：
 * - data/public/scenarios.public.jsonl   —— AI 训练/搜索输入唯一合法数据接口
 * - data/private/scenarios.private-oracle.jsonl —— 仅限离线评估器
 * - data/split-manifest.json             —— 拆分清单（输入/输出 sha256 + 计数）
 *
 * 原始语料保留不覆盖（历史证据不静默改写）。重复运行幂等（同输入同输出）。
 *
 * 用法：node training/scenarios/scripts/split-dataset.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeSplitDataset } from '../lib/dataset.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scenariosRoot = join(here, '..'); // training/scenarios
const raw = join(scenariosRoot, 'data', 'scenarios.jsonl');

const { publicPath, privatePath, manifest } = writeSplitDataset(raw, scenariosRoot);
console.log(`拆分完成：${manifest.scenarioCount} 条局面`);
console.log(`  公开层（AI 输入唯一合法接口）：${publicPath}`);
console.log(`  私有 oracle 层（仅限离线评估器）：${privatePath}`);
console.log(`  清单：${join(scenariosRoot, 'data', 'split-manifest.json')}`);
console.log(`泄漏自检：公开层 ${manifest.publicForbiddenKeys.join('/')} 递归扫描通过`);

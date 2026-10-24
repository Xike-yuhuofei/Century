import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../dist/js/engine.js';
import { archiveKey } from '../dist/js/archive.js';
import { AUTO_EXPORT_KEY, autoExportEnabled, autoExportPlan, disableAutoExport, enableAutoExport } from '../dist/js/auto-export.js';

const make = () => createGame(['甲', '乙'], 71);
const finished = () => ({ ...make(), phase: 'finished' });
const ctx = (overrides = {}) => ({ enabled: true, exported: new Set(), ...overrides });

test('AUTO_EXPORT_KEY 与其他存储键不冲突', () => {
  assert.equal(AUTO_EXPORT_KEY, 'crystal-corridor-auto-export-v1');
});

test('只导出结束的对局：进行中跳过', () => {
  assert.deepEqual(autoExportPlan(make(), ctx()), { kind: 'skip', reason: 'not-finished' });
});

test('开关关闭时跳过（优先于指纹去重判断）', () => {
  assert.deepEqual(autoExportPlan(finished(), ctx({ enabled: false })), { kind: 'skip', reason: 'disabled' });
});

test('同指纹会话内只导出一次：已登记的指纹跳过，未登记的下载', () => {
  const g = finished();
  const exported = new Set([archiveKey(g)]);
  assert.deepEqual(autoExportPlan(g, ctx({ exported })), { kind: 'skip', reason: 'duplicate' });
  assert.deepEqual(autoExportPlan(g, ctx()), { kind: 'download' });
});

test('无 localStorage 环境（Node/隐私模式）下开关函数不抛错且默认关闭', () => {
  assert.equal(autoExportEnabled(), false);
  enableAutoExport();
  assert.equal(autoExportEnabled(), false);
  disableAutoExport();
  assert.equal(autoExportEnabled(), false);
});

/** P0：统计功效模块测试（样本量/MDE/方差）。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalCdf, pairedDeltaVariance, requiredSeeds, powerAt, minimumDetectableEffect,
  requiredSeedsNonInferiority, buildPowerTable,
} from '../evaluator/power.mjs';

test('normalCdf 与已知分位点一致', () => {
  assert.ok(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1.6448536269514722) - 0.05) < 1e-5);
});

test('配对二元 delta 方差：独立/完全相关边界', () => {
  // 独立：p11=pA·pB → Var=pA(1-pA)+pB(1-pB)
  const independent = pairedDeltaVariance({ pA: 0.6, pB: 0.4, p11: 0.24 });
  assert.ok(Math.abs(independent - (0.6 * 0.4 + 0.4 * 0.6)) < 1e-12);
  // 完全正相关：p11=min(pA,pB)=0.4 → Var=(pA-pB)^2 + 2·(完全相关残差)
  const perfect = pairedDeltaVariance({ pA: 0.6, pB: 0.4, p11: 0.4 });
  assert.ok(Math.abs(perfect - 0.16) < 1e-12);
  // 零方差边界：A=B 且完全一致 → delta 恒为 0。
  const zero = pairedDeltaVariance({ pA: 0.5, pB: 0.5, p11: 0.5 });
  assert.ok(Math.abs(zero) < 1e-12);
});

test('requiredSeeds 达到目标功效', () => {
  const n = requiredSeeds({ effect: 0.1, alpha: 0.05, power: 0.8, variance: 0.5 });
  const power = powerAt({ n, effect: 0.1, alpha: 0.05, variance: 0.5 });
  assert.ok(power >= 0.8 - 0.01, `n=${n} power=${power}`);
  assert.ok(powerAt({ n: n - 1, effect: 0.1, alpha: 0.05, variance: 0.5 }) < 0.8);
});

test('MDE 随样本量与 alpha 严格变化', () => {
  const alpha = 1.220703125e-5;
  const mde250 = minimumDetectableEffect({ n: 250, alpha, variance: 0.5 });
  const mde500 = minimumDetectableEffect({ n: 500, alpha, variance: 0.5 });
  const mde250loose = minimumDetectableEffect({ n: 250, alpha: 0.05, variance: 0.5 });
  assert.ok(mde250 > mde500, '样本越大 MDE 越小');
  assert.ok(mde250 > mde250loose, 'alpha 越严格 MDE 越大');
});

test('非劣效样本量使用 margin 作为效应下界', () => {
  const n = requiredSeedsNonInferiority({ margin: 0.02, alpha: 0.05, power: 0.8, variance: 1 });
  assert.equal(n, requiredSeeds({ effect: 0.02, alpha: 0.05, power: 0.8, variance: 1 }));
});

test('功效表覆盖当前 alpha 与可持续方案', () => {
  const table = buildPowerTable({ alpha: 1.220703125e-5, power: 0.8 });
  assert.equal(table.rows.length, 14);
  assert.ok(table.mdeAt250['0.5'] > 0.2 && table.mdeAt250['0.5'] < 0.25);
  assert.ok(table.mdeAt500['1'] <= table.mdeAt250['1']);
});

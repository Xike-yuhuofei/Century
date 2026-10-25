/** 冻结 AI 版本注册表（战术基准专用）。
 *
 * 使命：为每个基准局面提供"当前可复现的冻结版本建议行动"。
 * 只消费既有冻结版本，不发明新算法：
 * - js5-w128：正式冠军 joint-js5（champion-guided 适配器），以 workUnits 固定
 *   工作量运行（预算模式受墙钟负载影响不可逐位复现——见 AI6 第五阶段取证结论；
 *   workUnits 模式逐位可复现，参数与 tests/joint-*.test.mjs 同口径）。
 * - classic-beam-rollout：前任正式冠军 ai5-readiness-efficiency（beam-rollout +
 *   readiness-efficiency，参数逐字读取 training/baseline/champion-freeze.json 冻结清单）。
 * - js1-beam-contest：JS1 = 冠军参数 + beam-contest 静态存活折扣（web-v1/src/js/
 *   adapter.ts 注册表口径：冠军基座指 ai5-readiness-efficiency 时代冠军参数）。
 * - v4-baseline：V3.0 等价基线参数（BASELINE_PARAMETERS，beam-lineage）。
 *
 * 全部四版本在固定工作量/束搜索模式下决策逐位确定；profile 按正式游戏席位映射
 * （与 training/simulator/simulate.mjs seatProfile 一致）。
 *
 * 信息边界：决策只经 chooseAIAction / chooseJointAction 的公开观察入口；
 * 本模块不向任何决策函数传递隐藏牌库信息。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chooseAIAction, BASELINE_PARAMETERS, PROFILES, NEUTRAL_PROFILE } from '../../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../../web-v1/dist/js/js/adapter.js';
import { assertInBlock, AI6_SCENARIO_BLOCK } from '../../../ai5/lib/seed_policy.mjs';

export { PROFILES, NEUTRAL_PROFILE };

const FREEZE_FILE = new URL('../../baseline/champion-freeze.json', import.meta.url);

/** 前任冠军参数（冻结清单为唯一来源，运行时读取，避免参数双写漂移）。 */
export function classicChampionParameters() {
  const freeze = JSON.parse(readFileSync(FREEZE_FILE, 'utf8'));
  return { ...freeze.champion.parameters };
}

/** JS5 冻结基准口径：workUnits 固定工作量（逐位可复现）。
 * 128 轨迹 ≈ 正式 100ms 预算的典型产量（见 AI6-PR26-FIX-REPORT 性能实测）。 */
export const JS5_BENCHMARK_OPTIONS = Object.freeze({ workUnits: 128, worlds: 4, simSeed: 0 });

/** 四个冻结版本的定义。joint=true 走联合规划适配器；否则走束搜索决策入口。 */
export function frozenVersions() {
  const classic = classicChampionParameters();
  return [
    {
      key: 'js5-w128',
      label: 'JS5 正式冠军（joint-js5，workUnits=128 固定工作量）',
      joint: true,
      options: { version: 'joint-js5', ...JS5_BENCHMARK_OPTIONS },
      recordedOptions: { workUnits: 128, worlds: 4, simSeed: 0 },
    },
    {
      key: 'classic-beam-rollout',
      label: `前任冠军 ${classic.id}（beam-rollout）`,
      joint: false,
      parameters: classic,
      structure: 'beam-rollout',
      recordedOptions: { structure: 'beam-rollout', acquisitionVariant: classic.acquisitionVariant ?? null },
    },
    {
      key: 'js1-beam-contest',
      label: 'JS1 冠军+静态目标存活折扣（beam-contest）',
      joint: false,
      parameters: classic,
      structure: 'beam-contest',
      recordedOptions: { structure: 'beam-contest', acquisitionVariant: classic.acquisitionVariant ?? null },
    },
    {
      key: 'v4-baseline',
      label: 'V3.0 等价基线（beam-lineage，BASELINE_PARAMETERS）',
      joint: false,
      parameters: { ...BASELINE_PARAMETERS },
      recordedOptions: { structure: 'beam-lineage', acquisitionVariant: null },
    },
  ];
}

/** 席位人格映射：与训练模拟器 seatProfile 逐席一致（席位 0 = 中立人类代理）。 */
export function seatProfile(seat) {
  return seat === 0 ? NEUTRAL_PROFILE : PROFILES[(seat - 1) % PROFILES.length];
}

/** 用指定冻结版本在给定完整局面位置上做一次决策。
 * position：Game 去掉 replay 的完整位置（含隐藏牌库——仅用于引擎复核与续演；
 * 决策函数内部只消费公开观察，本函数不把牌库传给任何决策输入）。
 * turn 与 overflow 阶段均合法（溢出弃置由决策入口的正式口径处理）。
 * 返回 { action, reason, versionKey }；action 为深拷贝（applyAction 可能原地改写行动对象）。 */
export function decideWithVersion(position, version, profile) {
  const game = structuredClone(position);
  for (const p of game.players) p.isAI = true;
  if (game.phase !== 'turn' && game.phase !== 'overflow') {
    throw new Error(`决策只处理 turn/overflow 阶段，实际：${game.phase}`);
  }
  const response = version.joint
    ? chooseJointAction(game, { ...version.options, profile })
    : chooseAIAction(game, {
        parameters: version.parameters,
        ...(version.structure ? { structure: version.structure } : {}),
        profile,
      });
  return { action: structuredClone(response.action), reason: response.reason, versionKey: version.key };
}

/** 引擎对局种子纪律：基准局面库只使用 AI6_SCENARIO_BLOCK 内的种子。 */
export function scenarioSeed(index) {
  return assertInBlock(AI6_SCENARIO_BLOCK[0] + index, AI6_SCENARIO_BLOCK, 'scenario replay seed');
}

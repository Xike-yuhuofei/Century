/** 独立模拟随机流域（AI6 合并后整改 P0-5·随机流特别要求）。
 *
 * 缺陷背景：
 * - PR #29 期间 duel.mjs 修复为 simSeed=对局种子（消除 PR #27 全部对局共用 0
 *   的跨局噪声相关），但正式挑战管线（simulate.mjs 适配器分派）漏修——
 *   challenge-11 全 500 局共用联合模拟噪声流（红队审计 R1）。
 * - 信息公平性暴露面：把真实对局种子（= 牌库洗牌种子）原样作为 simSeed 传入
 *   AI 决策选项，使"真实牌库洗牌种子"成为 AI 可利用的运行时特征——一个未来
 *   候选若读取 simSeed 即可在决策内重建真实牌库序（评测完整性攻击面）。
 *
 * 修复语义（随机流三分离）：
 * 1. 游戏真实牌库 RNG：引擎内部，种子 = 对局种子，绝不进入 AI 决策输入；
 * 2. AI 信念采样 RNG：联合搜索的模拟随机流，由本模块从独立域派生——
 *    simSeed = sha256(simSalt:对局种子) 截断 31 位。单向派生：候选无法从
 *    simSeed 反推对局种子/牌库序；不同 simSalt（实验域）流隔离；
 * 3. 实验级 simSalt：来自实验配置而非种子池（本模块只提供缺省域标签；
 *    正式挑战可显式指定并留痕），同盐同种子 ⇒ 同流（CRN 保持）。
 *
 * 信息公平性不变式：AI 决策输入（观察 + 选项）不含真实牌库顺序，也不含
 * 可直接还原牌库序的对局种子；同公开状态、不同隐藏牌序的对局间，AI 的
 * 随机流域不构成对隐藏信息的利用通道（派生单向性 + 域分离）。
 */

import { createHash } from 'node:crypto';

/** 缺省模拟流域标签（域分离标识；正式挑战可显式传入并留痕）。 */
export const DEFAULT_SIM_SALT = 'century-sim-stream-v1';

/** 从对局种子派生 AI 模拟随机流种子（单向、域分离、引擎安全 31 位）。 */
export function deriveSimStreamSeed(gameSeed, simSalt = DEFAULT_SIM_SALT) {
  if (!Number.isSafeInteger(gameSeed) || gameSeed < 0) {
    throw new Error(`对局种子非法：${gameSeed}`);
  }
  if (typeof simSalt !== 'string' || simSalt.length === 0) {
    throw new Error('simSalt 必须为非空字符串（域分离标识）');
  }
  const digest = createHash('sha256').update(`${simSalt}:${gameSeed}`).digest();
  return digest.readUInt32BE(0) >>> 1; // 31 位非负（引擎 seed >>> 0 回绕安全域内）
}

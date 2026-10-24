/** L3 胜率校准映射（AI6 第四阶段·任务 D / L3）。
 *
 * 本文件由 training/joint/calibrate.mjs 生成式覆盖（2026-10-23T21:12:14.042Z），
 * 校准种子块 AI6_JOINT_CALIB_SUBBLOCK [1.34e9,1.35e9)，样本 2771 条。
 * L3 评价器经分段线性 P(first | L2 raw margin) 输出胜率近似；
 * 校准流程与拟合口径见 training/reports/joint-search-v1/l3-calibration.json。
 */

export type L3Calibration = {
  valid: boolean;
  /** 样本量（校准轨迹采样点数）；样本不足（< 2000）时 valid 保持 false。 */
  samples: number;
  /** 校准种子块（可审计）。 */
  seedBlock: string | null;
  fittedAt: string | null;
  /** 分段线性映射：knots 为 L2 raw margin 断点（升序），values 为 P(first)。 */
  mapping: { knots: number[]; values: number[] };
};

export const L3_CALIBRATION: L3Calibration = {
  valid: true,
  samples: 2771,
  seedBlock: 'AI6_JOINT_CALIB_SUBBLOCK [1.34e9,1.35e9)',
  fittedAt: '2026-10-23T21:12:14.042Z',
  mapping: {"knots":[-45.781,-25.519,-19.724,-16.044,-13.369,-11.265,-9.192,-7.514,-5.211,-2.441,1.069,7.457,29.908],"values":[0,0,0.013,0.0303,0.0519,0.1169,0.1212,0.1212,0.2251,0.2944,0.4805,0.8701,0.8701]},
};

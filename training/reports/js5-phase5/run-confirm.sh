#!/bin/bash
# AI6 第五阶段：confirm 块独立确认实验（任务 D）。
# 全新种子（AI6_JS5_CONFIRM_SUBBLOCK 分区），与 PR #27 已消费的验证块完全隔离。
# 配对设计：候选共享同一种子；每 (人数, 对手池) 独占分区（confirmSeedBase）。
# 用法：bash training/reports/js5-phase5/run-confirm.sh <worker-id>
set -e
cd "/Volumes/Extreme SSD/Projects/Century"
OUT=training/reports/js5-phase5/confirm
mkdir -p "$OUT"
SEEDS=200
PLAYERS="2,3,4,5"

run() { # run <label> <candidates> <pool> [extra args]
  local label="$1" candidates="$2" pool="$3"; shift 3
  local dir="$OUT/$label-$pool"
  if ls "$dir"/ablation-confirm-*.json >/dev/null 2>&1; then
    echo "[skip] $label-$pool（已存在）"; return
  fi
  echo "[run ] $label-$pool $(date +%H:%M:%S)"
  node training/joint/duel.mjs --candidates "$candidates" --players $PLAYERS --seeds $SEEDS \
    --block confirm --pool "$pool" --budget 100 --out "$dir" "$@" 2>&1 | tail -6
}

case "$1" in
  js0)
    run js0 js0 classic
    run js0 js0 diverse
    echo "[done] worker js0 $(date +%H:%M:%S)"
    ;;
  js1)
    run js1 js1 classic
    run js1 js1 diverse
    echo "[done] worker js1 $(date +%H:%M:%S)"
    ;;
  js5)
    run js5 js5 classic
    run js5 js5 diverse
    echo "[done] worker js5 $(date +%H:%M:%S)"
    ;;
  js5opt)
    # js5-opt 冻结配置（tune2 块 C3 敏感性结论）：冻结参数 + claimRanking='prior'
    # ——唯一在 3p/5p 双人数同向正向的变体（+5/+10pp，噪声内），机制依据 =
    # 防止枚举顺序偶然排除高先验立即认领（任务 C2 检查项 2）。其余参数
    # （threshold 0.85/margin 0.02/cap 4/worlds 4/horizon 48）保持冻结缺省。
    run js5opt "js5-opt" classic "--claim-ranking prior"
    run js5opt "js5-opt" diverse "--claim-ranking prior"
    echo "[done] worker js5opt $(date +%H:%M:%S)"
    ;;
  *) echo "用法：$0 js0|js1|js5|js5opt"; exit 1;;
esac

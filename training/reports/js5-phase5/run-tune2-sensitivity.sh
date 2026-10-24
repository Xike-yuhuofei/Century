#!/bin/bash
# AI6 第五阶段：tune2 块 JS5 参数敏感性分析（任务 C3，开发/调参数据专用）。
# 一次一个因子的小范围扰动；结果供识别稳定参数区域与 js5-opt 配置选择，
# 不作为任何强度结论依据（独立确认只用 confirm 块）。
# 用法：bash training/reports/js5-phase5/run-tune2-sensitivity.sh <worker-id>
set -e
cd "/Volumes/Extreme SSD/Projects/Century"
OUT=training/reports/js5-phase5/tune2
mkdir -p "$OUT"
SEEDS=20
PLAYERS="3,5"

run() { # run <name> <extra args...>
  local name="$1"; shift
  if [ -f "$OUT/$name/ablation-tune2-js5-${PLAYERS/./_}-${SEEDS}s.json" ] || [ -f "$OUT/$name/ablation-tune2-js5-3_5-${SEEDS}s.json" ]; then
    echo "[skip] $name（已存在）"; return
  fi
  echo "[run ] $name $(date +%H:%M:%S)"
  node training/joint/duel.mjs --candidates js5 --players $PLAYERS --seeds $SEEDS --block tune2 --budget 100 \
    --out "$OUT/$name" "$@" 2>&1 | tail -2
}

case "$1" in
  worker1)
    run js0 --candidates js0
    run baseline
    run threshold-075 --threshold 0.75
    run threshold-095 --threshold 0.95
    ;;
  worker2)
    run margin-000 --margin 0.0
    run margin-050 --margin 0.05
    run cap-6 --cap 6
    run claim-prior --claim-ranking prior
    ;;
  worker3)
    run worlds-2 --worlds 2
    run worlds-6 --worlds 6
    run horizon-32 --horizon 32
    run horizon-64 --horizon 64
    ;;
  *) echo "用法：$0 worker1|worker2|worker3"; exit 1;;
esac
echo "[done] worker $1 $(date +%H:%M:%S)"

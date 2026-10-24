#!/bin/bash
# AI6 第五阶段：confirm 块结果一键分析（任务 D/E）。
# 全部对照走 compare.mjs 严格配对校验；方向 A（单席位）为主判定口径。
set -e
cd "/Volumes/Extreme SSD/Projects/Century"
C=training/reports/js5-phase5/confirm
OUT=training/reports/js5-phase5
mkdir -p "$OUT"

echo "=== 一、主对照：js5/js5-opt/js1 vs js0（classic/diverse 池，方向A+B 分列） ==="
for cand in js5 js5-opt js1; do
  for pool in classic diverse; do
    cf=$(find "$C/$cand-$pool" -name "ablation-confirm-*.json" 2>/dev/null | head -1)
    cd0=$(find "$C/js0-$pool" -name "ablation-confirm-*.json" 2>/dev/null | head -1)
    [ -z "$cf" ] || [ -z "$cd0" ] && continue
    echo "--- $cand vs js0（$pool 池） ---"
    node training/joint/compare.mjs "$cf" "$cd0" --candidate="$cand" --baseline=js0 --players=2,3,4,5 2>&1 || true
  done
done

echo ""
echo "=== 二、js5-opt vs js5（优化增量，同池同种子） ==="
for pool in classic diverse; do
  co=$(find "$C/js5-opt-$pool" -name "ablation-confirm-*.json" 2>/dev/null | head -1)
  c5=$(find "$C/js5-$pool" -name "ablation-confirm-*.json" 2>/dev/null | head -1)
  [ -z "$co" ] || [ -z "$c5" ] && continue
  echo "--- js5-opt vs js5（$pool 池） ---"
  node training/joint/compare.mjs "$co" "$c5" --candidate=js5-opt --baseline=js5 --players=2,3,4,5 2>&1 || true
done

echo ""
echo "=== 四、门控行为（gate-analysis） ==="
for f in $(find "$C" -name "ablation-confirm-*.json"); do node training/joint/gate-analysis.mjs "$f"; done

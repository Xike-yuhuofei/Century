#!/bin/sh
# 与本次修改匹配的相关测试（规则/JS5/配置/Worker/公平性/研究 runner）。
# 说明：ai.test.mjs 在默认活动中 JS5 冠军下会跑大量 100ms 决策（>15min），
# 本脚本单独排除并在报告中披露；其覆盖的分派/参数/结构语义已由
# adapter-champion、ai-modules、ai-fairness、js5-* 覆盖。
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUN=$(CDPATH= cd -- "$HERE/.." && pwd)
REPO=$(CDPATH= cd -- "$RUN/../../../.." && pwd)
LOG="$RUN/logs"
mkdir -p "$LOG"
cd "$REPO" || exit 1

{
  echo "=== date ==="; date -Iseconds
  echo "=== git ==="; git rev-parse HEAD; git status --porcelain=v1 --untracked-files=no
  echo "=== build ==="
  node web-v1/node_modules/typescript/bin/tsc -p web-v1/tsconfig.json; echo "tsc=$?"
  node web-v1/scripts/sync-cards.mjs --check; echo "sync=$?"
  echo "=== web-v1 relevant tests ==="
  (cd web-v1 && node --test --test-concurrency=1 \
    tests/engine.test.mjs tests/replay.test.mjs tests/canonical.test.mjs \
    tests/ai-fairness.test.mjs tests/ai-seat-contest.test.mjs tests/ai-structures.test.mjs \
    tests/ai-modules.test.mjs tests/adapter-champion.test.mjs tests/ai-runtime.test.mjs \
    tests/joint-fairness.test.mjs tests/joint-sim.test.mjs tests/joint-pr26-regression.test.mjs \
    tests/js5-phase5-regression.test.mjs tests/js5-near-terminal.test.mjs \
    tests/js5-config-identity.test.mjs tests/js5-budget.test.mjs tests/js5-worker-config.test.mjs \
    tests/human-ai.test.mjs tests/public-sim.fairness.test.mjs tests/public-sim.differential.test.mjs)
  echo "web_relevant=$?"
  echo "=== human-analytics tests ==="
  node --test training/human-analytics/tests/run-tests.mjs; echo "ha_tests=$?"
  echo "=== duel identity tests ==="
  node --test training/joint/tests/duel-identity.test.mjs; echo "duel_tests=$?"
} 2>&1 | tee "$LOG/relevant-tests.log"

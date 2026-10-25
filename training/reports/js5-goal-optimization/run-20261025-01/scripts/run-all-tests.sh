#!/bin/sh
# 全量相关测试（以当前 package scripts 为准；输出同时落盘 logs/）。
# 用法：sh .../scripts/run-all-tests.sh
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
  echo "=== node ==="; node -v
  echo "=== build ==="
  node web-v1/node_modules/typescript/bin/tsc -p web-v1/tsconfig.json; echo "tsc=$?"
  node web-v1/scripts/sync-cards.mjs --check; echo "sync=$?"
  echo "=== web-v1 all tests ==="
  (cd web-v1 && node --test --test-concurrency=1 tests/*.test.mjs); echo "web_tests=$?"
  echo "=== human-analytics tests ==="
  node --test training/human-analytics/tests/run-tests.mjs; echo "ha_tests=$?"
  echo "=== duel identity tests ==="
  node --test training/joint/tests/duel-identity.test.mjs; echo "duel_tests=$?"
} 2>&1 | tee "$LOG/all-tests.log"

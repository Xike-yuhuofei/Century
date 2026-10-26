#!/bin/zsh
# P5：12 小时无人值守真实训练压力测试（LaunchAgent 入口）。
# 首次运行 start；进程被杀后由 launchd 重启并 resume（同配置指纹）。
set -u
SCRIPT_DIR="${0:A:h}"
REPO="${CENTURY_REPO:-${SCRIPT_DIR:h:h}}"
cd "$REPO" || exit 1
CAMPAIGN="${CENTURY_CAMPAIGN:-ai8-12h-v3}"
ARGS=(
  --campaign "$CAMPAIGN"
  --rounds 500
  --player-counts 2,3,4,5
  --quick-seeds 12
  --deep-seeds 12
  --candidates 8
  --max-candidates 2000
  --max-games 200000
  --max-wall-ms 43200000
  --max-concurrent 1
  --max-deep-confirmations 24
  --continue-from-selected
)
if [ -f "training/reports/autonomous/$CAMPAIGN/state.json" ]; then
  echo "[$(date -Iseconds)] resume $CAMPAIGN"
  exec node training/evolution/autonomous-run.mjs resume "${ARGS[@]}"
else
  echo "[$(date -Iseconds)] start $CAMPAIGN"
  exec node training/evolution/autonomous-run.mjs start "${ARGS[@]}"
fi

#!/bin/zsh
# AI 9.0：36 小时无人值守训练入口（start/resume + 卡死检测 + 失败重试）。
#
# 与 12h 脚本的区别：
# - 墙钟预算 36h（129600000ms），12 模块全协同并接入真实 OpenEvolve/Codex；
# - 进程存活但状态长时间不推进时由本脚本主动终止并 resume（12h 卡死 13h 的根因）；
# - 连续失败且状态无推进时退出，避免无人值守无限空转。
#
# 用法：
#   training/scripts/run-36h-stress.sh
# 环境变量：
#   CENTURY_36H_CAMPAIGN (默认 ai9-36h-endurance-1)
#   CENTURY_36H_STALL_SECONDS (默认 5400 = 90 分钟)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAMPAIGN="${CENTURY_36H_CAMPAIGN:-ai9-36h-endurance-1}"
STALL_SECONDS="${CENTURY_36H_STALL_SECONDS:-5400}"
WALL_MS="${CENTURY_36H_WALL_MS:-129600000}"
STATE="reports/coevolution/$CAMPAIGN/state.json"
EVENTS="reports/coevolution/$CAMPAIGN/logs/events.jsonl"
LOG_DIR="$ROOT/training/reports/coevolution/$CAMPAIGN"
mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/supervisor.log" 2>&1
echo "[$(date '+%F %T %Z')] 36h supervisor start pid=$$ root=$ROOT campaign=$CAMPAIGN wall_ms=$WALL_MS stall_s=$STALL_SECONDS"

cd "$ROOT/training" || exit 1
ARGS=(
  --coevolve
  --campaign "$CAMPAIGN"
  --rounds 999
  --candidates 6
  --player-counts 2,3,4,5
  --quick-seeds 8
  --deep-seeds 8
  --deep-confirmations 2
  --max-deep-confirmations 400
  --modules M01,M02,M03,M04,M05,M06,M07,M08,M09,M10,M11,M12
  --strategies single,pair,multi,crossover,ablation,openevolve
  --openevolve-iterations 1
  --generation-seed 20261027
  --max-candidates 4000
  --max-games 600000
  --max-wall-ms "$WALL_MS"
  --max-concurrent 1
)

status_of() {
  if [ ! -f "$STATE" ]; then echo missing; return; fi
  node -e "try{process.stdout.write(String(require('./$STATE').status))}catch(e){process.stdout.write('unreadable')}" 2>/dev/null
}

mtime_of() {
  local s=0 e=0
  [ -f "$STATE" ] && s=$(stat -f %m "$STATE" 2>/dev/null || echo 0)
  [ -f "$EVENTS" ] && e=$(stat -f %m "$EVENTS" 2>/dev/null || echo 0)
  if [ "$s" -ge "$e" ]; then echo "$s"; else echo "$e"; fi
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null
}

last_mtime=0
fail_streak=0

while true; do
  if [ -f "$LOG_DIR/.stop" ]; then
    echo "[$(date '+%F %T %Z')] operator stop marker found; exit"
    exit 0
  fi
  status=$(status_of)
  case "$status" in
    completed|budget-exhausted|stopped-by-budget)
      echo "[$(date '+%F %T %Z')] terminal status=$status; supervisor exit"
      exit 0
      ;;
  esac

  if [ "$status" = missing ]; then
    echo "[$(date '+%F %T %Z')] start campaign"
    node evolution/autonomous-run.mjs start "${ARGS[@]}" &
  else
    echo "[$(date '+%F %T %Z')] resume campaign status=$status"
    node evolution/autonomous-run.mjs resume "${ARGS[@]}" &
  fi
  runner=$!
  mtime=$(mtime_of)
  [ "$mtime" -gt "$last_mtime" ] && last_mtime=$mtime

  while kill -0 "$runner" 2>/dev/null; do
    sleep 60
    now=$(date +%s)
    mtime=$(mtime_of)
    if [ "$mtime" -gt "$last_mtime" ]; then
      last_mtime=$mtime
      fail_streak=0
    fi
    idle=$((now - last_mtime))
    if [ "$idle" -ge "$STALL_SECONDS" ]; then
      echo "[$(date '+%F %T %Z')] STALL: no state/event update for ${idle}s; terminating runner pid=$runner"
      kill_tree "$runner"
      sleep 20
      if kill -0 "$runner" 2>/dev/null; then
        echo "[$(date '+%F %T %Z')] runner still alive; SIGKILL"
        kill_tree "$runner"
        sleep 5
        kill -KILL "$runner" 2>/dev/null
      fi
      fail_streak=$((fail_streak + 1))
      break
    fi
  done

  wait "$runner" 2>/dev/null
  rc=$?
  mtime=$(mtime_of)
  if [ "$mtime" -gt "$last_mtime" ]; then
    last_mtime=$mtime
    fail_streak=0
  else
    fail_streak=$((fail_streak + 1))
  fi
  echo "[$(date '+%F %T %Z')] runner exited rc=$rc fail_streak=$fail_streak; retry in 15s"
  if [ "$fail_streak" -ge 5 ]; then
    echo "[$(date '+%F %T %Z')] 连续 5 次失败且状态无推进；停止监督器，保留现场待人工诊断"
    exit 1
  fi
  sleep 15
done

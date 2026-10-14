#!/usr/bin/env bash
# Restart the dev server cleanly: kill any existing process, clear cache, start fresh.
# Usage:
#   ./scripts/dev.sh           # start (kills any existing instance first)
#   ./scripts/dev.sh stop      # stop only
#   ./scripts/dev.sh restart   # explicit restart
#   ./scripts/dev.sh status    # show what's running

set -e

cd "$(dirname "$0")/.."

PORT="${PORT:-4020}"
PIDFILE="/tmp/whatsapp-admin-dev.pid"
OUTBOX_PIDFILE="/tmp/whatsapp-admin-outbox-dispatcher.pid"
OUTBOUND_PIDFILE="/tmp/whatsapp-admin-outbound-worker.pid"
DEV_LOG="/tmp/dev.log"
OUTBOX_LOG="/tmp/outbox-dispatcher.log"
OUTBOUND_LOG="/tmp/outbound-worker.log"

is_running() {
  if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    return 0
  fi
  return 1
}

stop() {
  echo ">> killing any tsx watch / server.ts / worker processes..."
  pkill -9 -f "tsx watch server.ts" 2>/dev/null || true
  pkill -9 -f "tsx server.ts" 2>/dev/null || true
  pkill -9 -f "scripts/outbox-dispatcher" 2>/dev/null || true
  pkill -9 -f "scripts/outbound-worker" 2>/dev/null || true
  for pid in $(ps aux | grep -E "tsx.*(server\.ts|scripts/(outbox-dispatcher|outbound-worker))" | grep -v grep | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -f "$PIDFILE" "$OUTBOX_PIDFILE" "$OUTBOUND_PIDFILE"
  for i in 1 2 3 4 5; do
    if ! is_running; then
      echo ">> port $PORT is free"
      return 0
    fi
    sleep 1
  done
  echo "!! port $PORT still busy after 5s" >&2
  return 1
}

start() {
  stop || true
  rm -rf .next-dev
  echo ">> starting dev server on port $PORT..."
  nohup npm run dev > "$DEV_LOG" 2>&1 &
  local dev_pid=$!
  echo $dev_pid > "$PIDFILE"
  echo ">> starting queue workers..."
  BULLMQ_PREFIX=wa-queue nohup npm run worker:outbox > "$OUTBOX_LOG" 2>&1 &
  local outbox_pid=$!
  echo $outbox_pid > "$OUTBOX_PIDFILE"
  BULLMQ_PREFIX=wa-queue nohup npm run worker:outbound > "$OUTBOUND_LOG" 2>&1 &
  local outbound_pid=$!
  echo $outbound_pid > "$OUTBOUND_PIDFILE"
  for i in $(seq 1 20); do
    if is_running; then
      echo ">> ready (dev pid $dev_pid, outbox pid $outbox_pid, outbound pid $outbound_pid, port $PORT)"
      return 0
    fi
    sleep 1
  done
  echo "!! server didn't come up in 20s, last log lines:" >&2
  tail -n 20 "$DEV_LOG" >&2
  return 1
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) start ;;
  status)
    if is_running; then
      echo "server running on port $PORT (pid $(lsof -ti:$PORT 2>/dev/null | head -n1))"
    else
      echo "server not running"
    fi
    for item in "outbox-dispatcher:$OUTBOX_PIDFILE" "outbound-worker:$OUTBOUND_PIDFILE"; do
      name="${item%%:*}"
      file="${item#*:}"
      if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then
        echo "$name running (pid $(cat "$file"))"
      else
        echo "$name not running"
      fi
    done
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac

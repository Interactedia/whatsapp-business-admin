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

is_running() {
  if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    return 0
  fi
  return 1
}

stop() {
  echo ">> killing any tsx watch / server.ts processes..."
  pkill -9 -f "tsx watch server.ts" 2>/dev/null || true
  pkill -9 -f "tsx server.ts" 2>/dev/null || true
  for pid in $(ps aux | grep -E "tsx.*server\.ts" | grep -v grep | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
  rm -f "$PIDFILE"
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
  stop
  rm -rf .next-dev
  echo ">> starting dev server on port $PORT..."
  nohup npm run dev > /tmp/dev.log 2>&1 &
  echo $! > "$PIDFILE"
  for i in $(seq 1 20); do
    if is_running; then
      echo ">> ready (pid $(cat $PIDFILE), port $PORT)"
      return 0
    fi
    sleep 1
  done
  echo "!! server didn't come up in 20s, last log lines:" >&2
  tail -n 20 /tmp/dev.log >&2
  return 1
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) start ;;
  status)
    if is_running; then
      echo "running on port $PORT (pid $(lsof -ti:$PORT 2>/dev/null | head -n1))"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac

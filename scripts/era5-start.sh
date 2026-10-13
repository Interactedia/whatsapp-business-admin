#!/usr/bin/env bash
# Start the dev server with ERA 5 isolated environment.
# Usage: ./scripts/era5-start.sh
#
# Loads .env.era5, clears .next-dev, launches tsx watch server.ts on PORT 4030.
# Writes PID to /tmp/era5-server.pid and logs to /tmp/era5-server.log.

set -e

cd "$(dirname "$0")/.."

# Load ERA 5 env (sourced after `.env` is not loaded, so .env.era5 is the effective config).
if [ ! -f .env.era5 ]; then
  echo "!! .env.era5 not found" >&2
  exit 1
fi

set -a
. ./.env.era5
set +a

# Ensure the era5 media dir exists.
mkdir -p "${MEDIA_DIR:-./storage/media-era5}"

# Stop any prior instance on this port.
pkill -9 -f "tsx watch server.ts" 2>/dev/null || true
pkill -9 -f "tsx server.ts" 2>/dev/null || true
rm -rf .next-dev
PIDFILE="/tmp/era5-server.pid"
rm -f "$PIDFILE"

echo ">> starting ERA 5 dev server on port ${PORT}..."
nohup npx tsx server.ts > /tmp/era5-server.log 2>&1 &
echo $! > "$PIDFILE"

for i in $(seq 1 30); do
  if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
    echo ">> ready (pid $(cat "$PIDFILE"), port ${PORT})"
    exit 0
  fi
  sleep 1
done

echo "!! server didn't come up in 30s, last log lines:" >&2
tail -n 30 /tmp/era5-server.log >&2
exit 1

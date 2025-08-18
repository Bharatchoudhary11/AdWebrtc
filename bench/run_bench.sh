#!/usr/bin/env bash
set -euo pipefail

DUR=30
MODE_ARG="wasm"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DUR="$2"; shift 2 ;;
    --mode) MODE_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

echo "Starting bench for ${DUR}s in mode=${MODE_ARG}"
# Ping the web server to start/reset metrics
curl -s -X POST http://localhost:3000/api/bench/reset -d '{"mode":"'"${MODE_ARG}"'"}' -H 'Content-Type: application/json' >/dev/null || true

# Wait for duration (user should keep the live stream open)
sleep "${DUR}"

# Ask web to flush metrics to shared/metrics.json
curl -s http://localhost:3000/api/bench/dump >/dev/null || true

if [ -f "../shared/metrics.json" ]; then
  echo "metrics.json written to shared/metrics.json"
else
  echo "metrics.json not found; ensure the app was open and running."
fi

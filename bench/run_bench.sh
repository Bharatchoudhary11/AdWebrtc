#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

DUR=30
MODE_ARG="wasm"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DUR="$2"; shift 2 ;;
    --mode) MODE_ARG="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "Starting bench for ${DUR}s in mode=${MODE_ARG}"
curl -s -X POST http://localhost:3000/api/bench/reset -d '{"mode":"'"${MODE_ARG}"'"}' -H 'Content-Type: application/json' >/dev/null || true
sleep "${DUR}"
curl -s http://localhost:3000/api/bench/dump >/dev/null || true

if [ -f "$DIR/metrics.json" ]; then
  echo "metrics.json written to $DIR/metrics.json"
else
  echo "metrics.json not found; ensure the app was open and running."
fi

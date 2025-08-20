#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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
curl -s -X POST http://localhost:3000/bench-start \
  -H 'Content-Type: application/json' \
  -d '{"mode":"'"${MODE_ARG}"'"}' >/dev/null || true
sleep "${DUR}"
curl -s http://localhost:3000/bench-stop -o "${ROOT}/metrics.json" || true

if [ -f "${ROOT}/metrics.json" ]; then
  echo "metrics.json written to ${ROOT}/metrics.json"
else
  echo "metrics.json not found; ensure the app was open and running."
fi

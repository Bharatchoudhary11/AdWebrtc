#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-wasm}"
NGROK="${NGROK:-0}"

export MODE

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker Desktop first." >&2
  exit 1
fi

# Build and start
docker compose up --build -d

echo "=========================================="
echo "Demo starting in MODE=$MODE"
echo "Open http://localhost:3000 on your laptop."
echo "Scan QR code shown on the page with your phone."
echo "=========================================="

if [ "$NGROK" = "1" ]; then
  echo "[Optional] Start ngrok in another shell: ngrok http 3000"
fi

#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-wasm}"
NGROK="${NGROK:-0}"
# Detect host IP so QR code can reference it for phone connections
HOST_IP="${HOST_IP:-$(hostname -I | awk '{print $1}') }"

export MODE HOST_IP

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker Desktop first." >&2
  exit 1
fi

# Build and start
docker compose up --build -d

echo "=========================================="
echo "Demo starting in MODE=$MODE"
echo "Open http://localhost:3000 on your laptop."
echo "Phone join URL (for QR): http://$HOST_IP:3000"
echo "Scan QR code shown on the page with your phone."
echo "=========================================="

if [ "$NGROK" = "1" ]; then
  echo "[Optional] Start ngrok in another shell: ngrok http 3000"
fi

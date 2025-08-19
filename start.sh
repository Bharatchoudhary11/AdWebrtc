#!/usr/bin/env bash
set -euo pipefail

MODE="${MODE:-wasm}"
NGROK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ngrok) NGROK=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

export MODE

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker Desktop first." >&2
  exit 1
fi

# Build and start
MODE=$MODE docker compose up --build -d

echo "=========================================="
echo "Demo starting in MODE=$MODE"
echo "Open http://localhost:3000 on your laptop."
echo "Scan the QR code to join from your phone."
echo "=========================================="

if [[ "$NGROK" -eq 1 ]]; then
  if command -v ngrok >/dev/null 2>&1; then
    echo "Starting ngrok tunnel..."
    ngrok http 3000 >/tmp/ngrok.log &
    sleep 2
    URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -o 'https://[a-z0-9.-]*\.ngrok-free\.app' | head -n1)
    echo "ngrok URL: ${URL:-check ngrok.log}"
  else
    echo "ngrok not installed; visit https://ngrok.com/" >&2
  fi
fi

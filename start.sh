#!/bin/sh
# Portable script to start the demo environment.
# QR codes use the browser's origin; when --ngrok is passed the generated
# HTTPS URL is written to web/public/join.txt for the client to prefer.

set -e

# Ensure we run relative to this script's location
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

MODE=wasm
NGROK=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Missing value for --mode" >&2
        exit 1
      fi
      MODE="$1"
      if [ "$MODE" != wasm ] && [ "$MODE" != server ]; then
        echo "Invalid mode: $MODE" >&2
        exit 1
      fi
      shift
      ;;
    --ngrok)
      NGROK=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

JOIN_FILE="$SCRIPT_DIR/web/public/join.txt"
# Ensure the join file exists to avoid 404s when ngrok isn't used
: > "$JOIN_FILE"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install Docker Desktop first." >&2
  exit 1
fi

if [ "$NGROK" -eq 1 ]; then
  if command -v ngrok >/dev/null 2>&1; then
    echo "Starting ngrok tunnel..."
    (
      ngrok http 3000 >/tmp/ngrok.log 2>&1 &
      NGROK_PID=$!
      URL=""
      i=0
      while [ $i -lt 10 ] && [ -z "$URL" ]; do
        sleep 1
        URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | \
          sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' | head -n 1)
        i=$((i+1))
      done
      if [ -n "$URL" ]; then
        printf '%s\n' "$URL" > "$JOIN_FILE"
        printf 'ngrok URL: %s\n' "$URL"
      else
        echo "Failed to retrieve ngrok URL; check /tmp/ngrok.log" >&2
      fi
      wait "$NGROK_PID"
    ) &
  else
    echo "ngrok not installed; visit https://ngrok.com/" >&2
  fi
fi

echo "=========================================="
echo "Demo starting in mode: $MODE"
echo "Open http://localhost:3000 in your browser."
echo "Press Ctrl+C to stop. Run 'docker compose down' to clean up."
echo "=========================================="

VITE_MODE="$MODE" docker compose up --build

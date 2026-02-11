#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK_SCRIPT="$ROOT_DIR/scripts/listener-stack.sh"
WATCHDOG_LOG="$ROOT_DIR/logs/listener-watchdog.log"

mkdir -p "$ROOT_DIR/logs"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

if "$STACK_SCRIPT" health >/dev/null 2>&1; then
  echo "$(timestamp) watchdog: healthy" >> "$WATCHDOG_LOG"
  exit 0
fi

{
  echo "$(timestamp) watchdog: unhealthy -> restarting"
  "$STACK_SCRIPT" start || true
  sleep 2
  "$STACK_SCRIPT" status || true
} >> "$WATCHDOG_LOG" 2>&1

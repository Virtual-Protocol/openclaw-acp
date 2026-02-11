#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/scripts/listener-stack.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

export ACP_URL="${ACP_URL:-https://acpx.virtuals.io}"
export ACP_SELLER_POLL="${ACP_SELLER_POLL:-1}"
export ACP_SELLER_POLL_INTERVAL_MS="${ACP_SELLER_POLL_INTERVAL_MS:-15000}"
export ACP_SELLER_POLL_PAGE_SIZE="${ACP_SELLER_POLL_PAGE_SIZE:-50}"

LOG_PATH="$ROOT_DIR/logs/seller.log"

run_acp() {
  npx tsx bin/acp.ts "$@"
}

status_json() {
  run_acp serve status --json 2>/dev/null || true
}

status_running() {
  local json
  json="$(status_json)"
  if [[ -z "$json" ]]; then
    return 1
  fi
  if ! printf '%s' "$json" | node -e '
let d="";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(d);
    process.exit(j && j.running === true ? 0 : 1);
  } catch {
    process.exit(2);
  }
});
'; then
    return 1
  fi
}

usage() {
  cat <<'EOF'
Usage: scripts/listener-stack.sh <command>

Commands:
  start        Start ACP seller listener runtime
  stop         Stop ACP seller listener runtime
  status       Show runtime status (JSON)
  logs         Show recent logs
  logs-follow  Tail logs in real time
  health       Validate listener runtime + recent socket connect log
  test         Run deterministic listener tests
  doctor       Print config summary + status + recent logs

Optional env file:
  scripts/listener-stack.env (copy from scripts/listener-stack.env.example)
EOF
}

cmd="${1:-}"
case "$cmd" in
  start)
    run_acp serve start
    ;;
  stop)
    run_acp serve stop
    ;;
  status)
    run_acp serve status --json
    ;;
  logs)
    run_acp serve logs
    ;;
  logs-follow)
    run_acp serve logs --follow
    ;;
  health)
    if ! status_running; then
      echo "listener-health: FAIL (runtime not running)"
      exit 1
    fi

    if [[ -f "$LOG_PATH" ]]; then
      if tail -n 200 "$LOG_PATH" | grep -Eq '"msg":"connected"|\[socket\] Connected'; then
        echo "listener-health: OK (running + recent socket connect seen)"
      else
        echo "listener-health: WARN (running, but no recent connect log in last 200 lines)"
      fi
    else
      echo "listener-health: WARN (running, log file missing at $LOG_PATH)"
    fi
    ;;
  test)
    npm run test:listener-stack
    ;;
  doctor)
    echo "listener-stack doctor"
    echo "root: $ROOT_DIR"
    echo "acp_url: $ACP_URL"
    echo "poll_enabled: $ACP_SELLER_POLL"
    echo "poll_interval_ms: $ACP_SELLER_POLL_INTERVAL_MS"
    echo "poll_page_size: $ACP_SELLER_POLL_PAGE_SIZE"
    echo
    run_acp serve status --json || true
    echo
    if [[ -f "$LOG_PATH" ]]; then
      echo "last 40 log lines ($LOG_PATH):"
      tail -n 40 "$LOG_PATH"
    else
      echo "log file not found: $LOG_PATH"
    fi
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac

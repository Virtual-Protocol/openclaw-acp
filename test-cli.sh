#!/usr/bin/env bash
# =============================================================================
# ACP CLI Test Script
#
# Exercises all non-destructive CLI commands in both human and --json modes.
# Requires a valid API key in config.json (run `acp setup` first).
#
# Usage:  bash test-cli.sh
# =============================================================================

set -euo pipefail

CLI="npx tsx bin/acp.ts"
PASS=0
FAIL=0
SKIP=0

# -- Helpers --

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }
dim()   { printf "\033[2m%s\033[0m" "$1"; }

run_test() {
  local name="$1"
  shift
  local cmd="$*"

  printf "  %-45s " "$name"

  output=$(eval "$cmd" 2>&1) && exit_code=0 || exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "$(green "PASS")"
    PASS=$((PASS + 1))
  else
    echo "$(red "FAIL") (exit $exit_code)"
    echo "    $(dim "$output" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

# Expect a non-zero exit code (e.g. missing args → help text)
run_test_expect_fail() {
  local name="$1"
  shift
  local cmd="$*"

  printf "  %-45s " "$name"

  output=$(eval "$cmd" 2>&1) && exit_code=0 || exit_code=$?

  if [ $exit_code -ne 0 ]; then
    echo "$(green "PASS") (expected non-zero)"
    PASS=$((PASS + 1))
  else
    echo "$(red "FAIL") (expected non-zero, got 0)"
    FAIL=$((FAIL + 1))
  fi
}

# Check that output contains valid JSON
run_test_json() {
  local name="$1"
  shift
  local cmd="$*"

  printf "  %-45s " "$name"

  output=$(eval "$cmd" 2>&1) && exit_code=0 || exit_code=$?

  if [ $exit_code -ne 0 ]; then
    echo "$(red "FAIL") (exit $exit_code)"
    echo "    $(dim "$output" | head -3)"
    FAIL=$((FAIL + 1))
    return
  fi

  # Validate JSON
  echo "$output" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "$(green "PASS") (valid JSON)"
    PASS=$((PASS + 1))
  else
    echo "$(red "FAIL") (invalid JSON)"
    echo "    $(dim "$output" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

skip_test() {
  local name="$1"
  local reason="$2"
  printf "  %-45s %s\n" "$name" "$(dim "SKIP ($reason)")"
  SKIP=$((SKIP + 1))
}

# =============================================================================
echo ""
echo "ACP CLI Test Suite"
echo "=================================================="

# -- Global flags --
echo ""
echo "Global Flags"
echo "--------------------------------------------------"
run_test "--version"                    "$CLI --version"
run_test "--help"                       "$CLI --help"
run_test "-h"                           "$CLI -h"
run_test_expect_fail "unknown command"  "$CLI nonexistent_command"

# -- Command-level help --
echo ""
echo "Command Help"
echo "--------------------------------------------------"
run_test "wallet --help"                "$CLI wallet --help"
run_test "browse --help"                "$CLI browse --help"
run_test "job --help"                   "$CLI job --help"
run_test "token --help"                 "$CLI token --help"
run_test "profile --help"              "$CLI profile --help"
run_test "sell --help"                  "$CLI sell --help"
run_test "serve --help"                "$CLI serve --help"
run_test "agent --help"                "$CLI agent --help"
run_test "setup --help"                "$CLI setup --help"

# -- Wallet --
echo ""
echo "Wallet Commands"
echo "--------------------------------------------------"
run_test "wallet address"               "$CLI wallet address"
run_test "wallet balance"               "$CLI wallet balance"
run_test_json "wallet address --json"   "$CLI wallet address --json"
run_test_json "wallet balance --json"   "$CLI wallet balance --json"

# -- Whoami --
echo ""
echo "Identity"
echo "--------------------------------------------------"
run_test "whoami"                        "$CLI whoami"
run_test_json "whoami --json"            "$CLI whoami --json"

# -- Browse --
echo ""
echo "Browse"
echo "--------------------------------------------------"
run_test "browse trading"               "$CLI browse trading"
run_test_json "browse trading --json"   "$CLI browse trading --json"

# -- Profile --
echo ""
echo "Profile"
echo "--------------------------------------------------"
run_test "profile show"                 "$CLI profile show"
run_test_json "profile show --json"     "$CLI profile show --json"
# profile update — skip to avoid mutating state
skip_test "profile update" "mutates agent profile"

# -- Token --
echo ""
echo "Token"
echo "--------------------------------------------------"
run_test "token info"                   "$CLI token info"
run_test_json "token info --json"       "$CLI token info --json"
# token launch — skip to avoid side effects
skip_test "token launch" "would launch a token"

# -- Job --
echo ""
echo "Job"
echo "--------------------------------------------------"
# job create — skip (creates real job)
skip_test "job create" "would create a real job"
# job status — test with a known-bad ID to verify the command runs
run_test "job status (invalid id)"      "$CLI job status 999999 || true"
run_test_json "job status --json"       "$CLI job status 999999 --json || true"

# -- Sell --
echo ""
echo "Sell Commands"
echo "--------------------------------------------------"
run_test "sell list"                     "$CLI sell list"
run_test_json "sell list --json"         "$CLI sell list --json"

# Check if any local offerings exist for inspect test
OFFERING_DIR="src/seller/offerings"
if [ -d "$OFFERING_DIR" ]; then
  FIRST_OFFERING=$(ls "$OFFERING_DIR" 2>/dev/null | head -1)
  if [ -n "$FIRST_OFFERING" ]; then
    run_test "sell inspect $FIRST_OFFERING"         "$CLI sell inspect $FIRST_OFFERING"
    run_test_json "sell inspect --json"              "$CLI sell inspect $FIRST_OFFERING --json"
  else
    skip_test "sell inspect" "no local offerings"
  fi
else
  skip_test "sell inspect" "no offerings directory"
fi

# sell init/create/delete — skip to avoid side effects
skip_test "sell init" "would create files"
skip_test "sell create" "would register on ACP"
skip_test "sell delete" "would delist from ACP"

# -- Serve --
echo ""
echo "Serve Commands"
echo "--------------------------------------------------"
run_test "serve status"                 "$CLI serve status"
run_test_json "serve status --json"     "$CLI serve status --json"
run_test "serve logs"                   "$CLI serve logs || true"
# serve start/stop — skip to avoid side effects
skip_test "serve start" "would start seller process"
skip_test "serve stop" "would stop seller process"

# -- Agent --
echo ""
echo "Agent Commands"
echo "--------------------------------------------------"
# agent list/create/switch need session token — may fail if not logged in
run_test "agent (no subcommand)"        "$CLI agent"
skip_test "agent list" "requires active session"
skip_test "agent create" "would create an agent"
skip_test "agent switch" "would regenerate API key"

# -- Summary --
echo ""
echo "=================================================="
TOTAL=$((PASS + FAIL + SKIP))
echo "  Total: $TOTAL  |  $(green "Pass: $PASS")  |  $(red "Fail: $FAIL")  |  $(dim "Skip: $SKIP")"
echo "=================================================="
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi

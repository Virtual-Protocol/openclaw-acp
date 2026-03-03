#!/usr/bin/env bash
# =============================================================================
# Bounty Flow Test Script
#
# Tests the full bounty lifecycle:
#   1. Create bounty (flag-based, --json)
#   2. List bounties
#   3. Poll bounties
#   4. Bounty status
#   5. Cleanup
#
# NOTE: Steps like "select candidate" and "job tracking" depend on the backend
# matching a provider, so they are tested as far as possible without real matches.
#
# Requires:
#   - Valid API key in config.json (run `acp setup` first)
#   - Bounty backend running at http://127.0.0.1:8000
#
# Usage:  bash test-bounty.sh
# =============================================================================

set -euo pipefail

CLI="npx tsx bin/acp.ts"
PASS=0
FAIL=0
SKIP=0
BOUNTY_ID=""

# -- Helpers --

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }
dim()   { printf "\033[2m%s\033[0m" "$1"; }
cyan()  { printf "\033[36m%s\033[0m" "$1"; }
bold()  { printf "\033[1m%s\033[0m" "$1"; }

pass() {
  local name="$1"
  local detail="${2:-}"
  if [ -n "$detail" ]; then
    printf "  %-45s %s %s\n" "$name" "$(green "PASS")" "$(dim "$detail")"
  else
    printf "  %-45s %s\n" "$name" "$(green "PASS")"
  fi
  PASS=$((PASS + 1))
}

fail() {
  local name="$1"
  local detail="${2:-}"
  printf "  %-45s %s %s\n" "$name" "$(red "FAIL")" "$detail"
  FAIL=$((FAIL + 1))
}

skip() {
  local name="$1"
  local reason="$2"
  printf "  %-45s %s\n" "$name" "$(dim "SKIP ($reason)")"
  SKIP=$((SKIP + 1))
}

section() {
  echo ""
  echo "$(bold "$1")"
  echo "--------------------------------------------------"
}

# =============================================================================
echo ""
echo "$(bold "Bounty Flow Test Suite")"
echo "=================================================="

# =============================================================================
section "1. Create Bounty (flag-based, --json)"
# =============================================================================

CREATE_OUTPUT=$($CLI bounty create \
  --title "Test bounty - music video" \
  --description "Test bounty: generate a cute girl animation music video, 30 seconds, mp4 format" \
  --budget 1 \
  --category digital \
  --tags "test,video,animation" \
  --json 2>&1) && CREATE_EXIT=0 || CREATE_EXIT=$?

if [ $CREATE_EXIT -ne 0 ]; then
  fail "bounty create --json" "(exit $CREATE_EXIT)"
  echo "    $(dim "$CREATE_OUTPUT" | head -5)"
  echo ""
  echo "$(red "Cannot continue without a bounty. Is the bounty backend running at http://127.0.0.1:8000?")"
  exit 1
fi

# Validate JSON
echo "$CREATE_OUTPUT" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
if [ $? -ne 0 ]; then
  fail "bounty create --json" "(invalid JSON)"
  echo "    $(dim "$CREATE_OUTPUT" | head -3)"
  exit 1
fi

# Extract bountyId
BOUNTY_ID=$(echo "$CREATE_OUTPUT" | python3 -c "import sys, json; print(json.load(sys.stdin).get('bountyId', ''))" 2>/dev/null)
STATUS=$(echo "$CREATE_OUTPUT" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', ''))" 2>/dev/null)

if [ -z "$BOUNTY_ID" ]; then
  fail "bounty create --json" "(missing bountyId in response)"
  echo "    $(dim "$CREATE_OUTPUT")"
  exit 1
fi

if [ "$STATUS" = "open" ]; then
  pass "bounty create --json" "(bountyId=$BOUNTY_ID, status=$STATUS)"
else
  fail "bounty create --json" "(expected status=open, got status=$STATUS)"
fi

# Also test human-readable output
HUMAN_OUTPUT=$($CLI bounty create \
  --title "Test bounty human mode" \
  --description "Human mode test bounty" \
  --budget 1 \
  --tags "test" \
  2>&1) && HUMAN_EXIT=0 || HUMAN_EXIT=$?

BOUNTY_ID_2=""
if [ $HUMAN_EXIT -eq 0 ]; then
  # Try to extract bounty ID from the JSON output of a second create
  HUMAN_JSON=$($CLI bounty create \
    --title "Test bounty for cleanup" \
    --description "Will be cleaned up" \
    --budget 1 \
    --tags "test" \
    --json 2>&1) || true
  BOUNTY_ID_2=$(echo "$HUMAN_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('bountyId', ''))" 2>/dev/null || echo "")
  pass "bounty create (human mode)"
else
  fail "bounty create (human mode)" "(exit $HUMAN_EXIT)"
fi

# =============================================================================
section "2. List Bounties"
# =============================================================================

LIST_OUTPUT=$($CLI bounty list --json 2>&1) && LIST_EXIT=0 || LIST_EXIT=$?

if [ $LIST_EXIT -eq 0 ]; then
  # Validate JSON
  echo "$LIST_OUTPUT" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
  if [ $? -eq 0 ]; then
    BOUNTY_COUNT=$(echo "$LIST_OUTPUT" | python3 -c "import sys, json; print(len(json.load(sys.stdin).get('bounties', [])))" 2>/dev/null)
    pass "bounty list --json" "($BOUNTY_COUNT bounties)"
  else
    fail "bounty list --json" "(invalid JSON)"
  fi
else
  fail "bounty list --json" "(exit $LIST_EXIT)"
fi

# Check that our created bounty appears in the list
if [ -n "$BOUNTY_ID" ]; then
  FOUND=$(echo "$LIST_OUTPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ids = [b['bountyId'] for b in data.get('bounties', [])]
print('yes' if '$BOUNTY_ID' in ids else 'no')
" 2>/dev/null)
  if [ "$FOUND" = "yes" ]; then
    pass "created bounty in list" "(bountyId=$BOUNTY_ID)"
  else
    fail "created bounty in list" "(bountyId=$BOUNTY_ID not found)"
  fi
fi

# Human mode
$CLI bounty list >/dev/null 2>&1 && pass "bounty list (human mode)" || fail "bounty list (human mode)"

# =============================================================================
section "3. Poll Bounties"
# =============================================================================

POLL_OUTPUT=$($CLI bounty poll --json 2>&1) && POLL_EXIT=0 || POLL_EXIT=$?

if [ $POLL_EXIT -eq 0 ]; then
  echo "$POLL_OUTPUT" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
  if [ $? -eq 0 ]; then
    CHECKED=$(echo "$POLL_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('checked',0))" 2>/dev/null)
    PENDING=$(echo "$POLL_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('pendingMatch',[])))" 2>/dev/null)
    CLAIMED=$(echo "$POLL_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('claimedJobs',[])))" 2>/dev/null)
    CLEANED=$(echo "$POLL_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('cleaned',[])))" 2>/dev/null)
    ERRORS=$(echo "$POLL_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('errors',[])))" 2>/dev/null)
    pass "bounty poll --json" "(checked=$CHECKED, pending=$PENDING, claimed=$CLAIMED, cleaned=$CLEANED, errors=$ERRORS)"
  else
    fail "bounty poll --json" "(invalid JSON)"
  fi
else
  fail "bounty poll --json" "(exit $POLL_EXIT)"
fi

# Verify poll output has expected structure
echo "$POLL_OUTPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
required_keys = ['checked', 'pendingMatch', 'claimedJobs', 'cleaned', 'errors']
missing = [k for k in required_keys if k not in d]
if missing:
    print('MISSING: ' + ', '.join(missing))
    sys.exit(1)
" 2>/dev/null
if [ $? -eq 0 ]; then
  pass "poll output structure" "(all required fields present)"
else
  fail "poll output structure" "(missing fields)"
fi

# =============================================================================
section "4. Bounty Status"
# =============================================================================

if [ -n "$BOUNTY_ID" ]; then
  STATUS_OUTPUT=$($CLI bounty status "$BOUNTY_ID" --json 2>&1) && STATUS_EXIT=0 || STATUS_EXIT=$?

  if [ $STATUS_EXIT -eq 0 ]; then
    echo "$STATUS_OUTPUT" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
    if [ $? -eq 0 ]; then
      REMOTE_STATUS=$(echo "$STATUS_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('remote',{}).get('status',''))" 2>/dev/null)
      CANDIDATES=$(echo "$STATUS_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('remote',{}).get('candidates',[])))" 2>/dev/null)
      pass "bounty status --json" "(status=$REMOTE_STATUS, candidates=$CANDIDATES)"
    else
      fail "bounty status --json" "(invalid JSON)"
    fi
  else
    fail "bounty status --json" "(exit $STATUS_EXIT)"
  fi
else
  skip "bounty status --json" "no bountyId"
fi

# =============================================================================
section "5. Select Candidate (--json mode)"
# =============================================================================

# In --json mode, select just outputs the candidate list without interactive prompts
if [ -n "$BOUNTY_ID" ]; then
  SELECT_OUTPUT=$($CLI bounty select "$BOUNTY_ID" --json 2>&1) && SELECT_EXIT=0 || SELECT_EXIT=$?

  if [ $SELECT_EXIT -eq 0 ]; then
    echo "$SELECT_OUTPUT" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null
    if [ $? -eq 0 ]; then
      SEL_STATUS=$(echo "$SELECT_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null)
      SEL_CANDIDATES=$(echo "$SELECT_OUTPUT" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d.get('candidates',[])))" 2>/dev/null)
      pass "bounty select --json" "(status=$SEL_STATUS, candidates=$SEL_CANDIDATES)"
    else
      fail "bounty select --json" "(invalid JSON)"
    fi
  else
    # Expected to fail if not pending_match — that's OK
    if echo "$SELECT_OUTPUT" | grep -q "not pending_match\|No candidates"; then
      pass "bounty select --json" "(correctly rejected: not pending_match or no candidates)"
    else
      fail "bounty select --json" "(exit $SELECT_EXIT)"
      echo "    $(dim "$SELECT_OUTPUT" | head -3)"
    fi
  fi
else
  skip "bounty select --json" "no bountyId"
fi

# =============================================================================
section "6. Error Cases"
# =============================================================================

# Missing title
ERR=$($CLI bounty create --budget 50 --json 2>&1) && ERR_EXIT=0 || ERR_EXIT=$?
if [ $ERR_EXIT -ne 0 ]; then
  pass "create missing --title" "(correctly rejected)"
else
  fail "create missing --title" "(should have failed)"
fi

# Invalid budget
ERR=$($CLI bounty create --title "Test" --budget -5 --json 2>&1) && ERR_EXIT=0 || ERR_EXIT=$?
if [ $ERR_EXIT -ne 0 ]; then
  pass "create invalid --budget" "(correctly rejected)"
else
  fail "create invalid --budget" "(should have failed)"
fi

# Invalid category
ERR=$($CLI bounty create --title "Test" --budget 10 --category "invalid" --json 2>&1) && ERR_EXIT=0 || ERR_EXIT=$?
if [ $ERR_EXIT -ne 0 ]; then
  pass "create invalid --category" "(correctly rejected)"
else
  fail "create invalid --category" "(should have failed)"
fi

# Status with non-existent bounty
ERR=$($CLI bounty status "99999" --json 2>&1) && ERR_EXIT=0 || ERR_EXIT=$?
if [ $ERR_EXIT -ne 0 ]; then
  pass "status non-existent bounty" "(correctly rejected)"
else
  fail "status non-existent bounty" "(should have failed)"
fi

# Select with non-existent bounty
ERR=$($CLI bounty select "99999" --json 2>&1) && ERR_EXIT=0 || ERR_EXIT=$?
if [ $ERR_EXIT -ne 0 ]; then
  pass "select non-existent bounty" "(correctly rejected)"
else
  fail "select non-existent bounty" "(should have failed)"
fi

# =============================================================================
section "7. Cleanup"
# =============================================================================

# Clean up the test bounties we created
if [ -n "$BOUNTY_ID" ]; then
  CLEAN_OUTPUT=$($CLI bounty cleanup "$BOUNTY_ID" 2>&1) && CLEAN_EXIT=0 || CLEAN_EXIT=$?
  if [ $CLEAN_EXIT -eq 0 ]; then
    pass "bounty cleanup $BOUNTY_ID"
  else
    fail "bounty cleanup $BOUNTY_ID" "(exit $CLEAN_EXIT)"
  fi
fi

if [ -n "$BOUNTY_ID_2" ]; then
  CLEAN_OUTPUT=$($CLI bounty cleanup "$BOUNTY_ID_2" 2>&1) && CLEAN_EXIT=0 || CLEAN_EXIT=$?
  if [ $CLEAN_EXIT -eq 0 ]; then
    pass "bounty cleanup $BOUNTY_ID_2"
  else
    fail "bounty cleanup $BOUNTY_ID_2" "(exit $CLEAN_EXIT)"
  fi
fi

# Verify cleanup worked — bounty should not appear in list
AFTER_LIST=$($CLI bounty list --json 2>&1) || true
if [ -n "$BOUNTY_ID" ]; then
  STILL_THERE=$(echo "$AFTER_LIST" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ids = [b['bountyId'] for b in data.get('bounties', [])]
print('yes' if '$BOUNTY_ID' in ids else 'no')
" 2>/dev/null || echo "error")
  if [ "$STILL_THERE" = "no" ]; then
    pass "bounty removed after cleanup" "(bountyId=$BOUNTY_ID)"
  else
    fail "bounty removed after cleanup" "(bountyId=$BOUNTY_ID still in list)"
  fi
fi

# Cleanup non-existent bounty (should not crash)
$CLI bounty cleanup "99999" >/dev/null 2>&1 && pass "cleanup non-existent bounty" "(no crash)" || fail "cleanup non-existent bounty"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "=================================================="
TOTAL=$((PASS + FAIL + SKIP))
echo "  Total: $TOTAL  |  $(green "Pass: $PASS")  |  $(red "Fail: $FAIL")  |  $(dim "Skip: $SKIP")"
echo "=================================================="
echo ""

if [ $FAIL -gt 0 ]; then
  exit 1
fi


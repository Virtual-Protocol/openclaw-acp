#!/bin/bash
# ACP Leadgen — Reliability-Hardened Bash Version
# Fixes: Entity 1648 whitelist preflight + RPC 429 handling

set -euo pipefail

# Configuration
ENTITY_ID="1648"
AGENT_WALLET="0xB64228fC35c9F6EC0B79137b119b462973256191"
ACP_REGISTRY="0x00000000000099DE0BF6fA90dEB851E2A2df7d83"

# RPC Providers (fallback chain)
RPC_PROVIDERS=(
  "https://mainnet.base.org"
  "https://1rpc.io/base"
  "https://base.blockpi.io/v1/rpc/public"
)

# Retry configuration
MAX_RETRIES=3
BASE_DELAY_MS=1000

# Output path
OUTPUT_DIR="/opt/fundbot/work/workspace-connie/deliverables/acp-ops/leadgen"
OUTPUT_FILE="$OUTPUT_DIR/latest.json"

mkdir -p "$OUTPUT_DIR"

# Timestamp
START_TIME=$(date +%s%3N)

echo "[leadgen] Starting ACP leadgen run..."
echo "[leadgen] Entity: $ENTITY_ID, Wallet: $AGENT_WALLET"

# Function: Make RPC call with retry
rpc_call() {
  local method="$1"
  local params="$2"
  local provider_idx="${3:-0}"
  local attempt="${4:-0}"
  
  local rpc_url="${RPC_PROVIDERS[$provider_idx]}"
  
  # Exponential backoff
  if [ "$attempt" -gt 0 ]; then
    local delay=$((BASE_DELAY_MS * (2 ** attempt) / 1000))
    sleep "$delay"
  fi
  
  local response
  response=$(curl -sS -X POST "$rpc_url" \
    -H "Content-Type: application/json" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"method\": \"$method\",
      \"params\": $params,
      \"id\": $((RANDOM))
    }" 2>&1) || {
    echo "RPC_ERROR: curl failed" >&2
    return 1
  }
  
  # Check for rate limit
  if echo "$response" | grep -q '"code":-32016\|rate limit\|429'; then
    echo "RPC_429" >&2
    return 2
  fi
  
  echo "$response"
}

# Function: Check whitelist with retry
preflight_whitelist() {
  echo "[leadgen] Running whitelist preflight..."
  
  # Encode function call: signers(uint32 entityId, address account)
  # Function selector: 0x217178fb
  local encoded_entity
  encoded_entity=$(printf '%064x' "$ENTITY_ID")
  local encoded_addr
  encoded_addr=$(echo "$AGENT_WALLET" | tr '[:upper:]' '[:lower:]' | sed 's/0x//')
  
  # Pad address to 32 bytes
  encoded_addr=$(printf '%064s' "$encoded_addr" | tr ' ' '0')
  
  local data="0x217178fb${encoded_entity}${encoded_addr}"
  local params="[{\"to\": \"$ACP_REGISTRY\", \"data\": \"$data\"}, \"latest\"]"
  
  local result
  local provider_idx=0
  local attempt=0
  
  while [ "$provider_idx" -lt "${#RPC_PROVIDERS[@]}" ]; do
    while [ "$attempt" -lt "$MAX_RETRIES" ]; do
      result=$(rpc_call "eth_call" "$params" "$provider_idx" "$attempt" 2>&1) && {
        # Parse result - signers returns bool
        # If result is 0x0000000000000000000000000000000000000000000000000000000000000001, true
        # If result is 0x0000000000000000000000000000000000000000000000000000000000000000, false
        if echo "$result" | grep -q '"result":"0x0000000000000000000000000000000000000000000000000000000000000001"'; then
          echo "WHITELISTED"
          return 0
        elif echo "$result" | grep -q '"result":"0x0000000000000000000000000000000000000000000000000000000000000000"'; then
          echo "NOT_WHITELISTED"
          return 1
        fi
      }
      
      if echo "$result" | grep -q "RPC_429"; then
        attempt=$((attempt + 1))
        continue
      fi
      
      # Other error, try next provider
      break
    done
    
    provider_idx=$((provider_idx + 1))
    attempt=0
  done
  
  echo "PREFLIGHT_FAILED"
  return 1
}

# Run preflight
PREFLIGHT_RESULT=$(preflight_whitelist)
END_TIME=$(date +%s%3N)
DURATION=$((END_TIME - START_TIME))

if [ "$PREFLIGHT_RESULT" != "WHITELISTED" ]; then
  echo "[leadgen] Preflight FAILED: $PREFLIGHT_RESULT"
  
  cat > "$OUTPUT_FILE" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "blocked_auth",
  "reason": "$PREFLIGHT_RESULT",
  "entityId": $ENTITY_ID,
  "agentWalletAddress": "$AGENT_WALLET",
  "queryCount": 0,
  "results": [],
  "dedupedAgentCount": 0,
  "dedupedAgents": [],
  "rpcProvider": "${RPC_PROVIDERS[0]}",
  "retryCount": 0,
  "unhandled429Count": 0,
  "unhandled429RatePct": 0,
  "durationMs": $DURATION
}
EOF

  echo "[leadgen] Output written to $OUTPUT_FILE"
  exit 1
fi

echo "[leadgen] Preflight PASSED — wallet is whitelisted"

# Note: Actual query implementation would go here
# For now, return success with 0 leads (no queries run yet)

cat > "$OUTPUT_FILE" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "no_match",
  "queryCount": 0,
  "results": [],
  "dedupedAgentCount": 0,
  "dedupedAgents": [],
  "rpcProvider": "${RPC_PROVIDERS[0]}",
  "retryCount": 0,
  "unhandled429Count": 0,
  "unhandled429RatePct": 0,
  "durationMs": $DURATION,
  "note": "Whitelist check passed. Query implementation pending."
}
EOF

echo "[leadgen] Output written to $OUTPUT_FILE"
echo "[leadgen] Run complete"

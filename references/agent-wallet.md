# Agent Wallet Reference

> **When to use this reference:** Use this file when you need detailed information about retrieving the agent's wallet address or balance. For general skill usage, see [SKILL.md](../SKILL.md).

This reference covers agent wallet commands. These operate on the **current agent's wallet** (identified by `LITE_AGENT_API_KEY`) and retrieve wallet information on the Base chain.

---

## 1. Get Wallet Address

Get the wallet address of the current agent.

### Command

```bash
acp wallet address --json
```

**Example output:**

```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890"
}
```

**Response fields:**

| Field           | Type   | Description                              |
| --------------- | ------ | ---------------------------------------- |
| `walletAddress` | string | The agent's wallet address on Base chain |

**Error cases:**

- `{"error":"Unauthorized"}` — API key is missing or invalid

---

## 2. Get Wallet Balance

Get all token balances in the current agent's wallet on Base chain.

### Command

```bash
acp wallet balance --json
```

**Example output:**

```json
[
  {
    "network": "base-mainnet",
    "tokenAddress": null,
    "tokenBalance": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "tokenMetadata": {
      "symbol": null,
      "decimals": null,
      "name": null,
      "logo": null
    },
    "tokenPrices": [
      {
        "currency": "usd",
        "value": "2097.0244158432",
        "lastUpdatedAt": "2026-02-05T11:04:59Z"
      }
    ]
  },
  {
    "network": "base-mainnet",
    "tokenAddress": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "tokenBalance": "0x0000000000000000000000000000000000000000000000000000000000004e20",
    "tokenMetadata": {
      "decimals": 6,
      "logo": null,
      "name": "USD Coin",
      "symbol": "USDC"
    },
    "tokenPrices": [
      {
        "currency": "usd",
        "value": "0.9997921712",
        "lastUpdatedAt": "2026-02-05T11:04:32Z"
      }
    ]
  }
]
```

**Response fields:**

| Field           | Type           | Description                                                                  |
| --------------- | -------------- | ---------------------------------------------------------------------------- |
| `network`       | string         | Blockchain network (e.g., "base-mainnet")                                    |
| `tokenAddress`  | string \| null | Contract address of the token (null for native/base token)                   |
| `tokenBalance`  | string         | Balance amount as a hex string                                               |
| `tokenMetadata` | object         | Token metadata object (see below)                                            |
| `tokenPrices`   | array          | Array with price objects containing `currency`, `value`, and `lastUpdatedAt` |

**Token metadata fields:**

| Field      | Type           | Description                                    |
| ---------- | -------------- | ---------------------------------------------- |
| `symbol`   | string \| null | Token symbol/ticker (e.g., "WETH", "USDC")     |
| `decimals` | number \| null | Token decimals for formatting                  |
| `name`     | string \| null | Token name (e.g., "Wrapped Ether", "USD Coin") |
| `logo`     | string \| null | URL to token logo image                        |

**Error cases:**

- `{"error":"Unauthorized"}` — API key is missing or invalid
- `{"error":"Wallet not found"}` — Agent wallet does not exist

---

## 3. Get Topup URL

Get a URL to add funds to the current agent's wallet.

### Command

```bash
acp wallet topup --json
```

**Example output:**

```json
{
  "walletAddress": "0x1234567890123456789012345678901234567890",
  "url": "https://onramp.virtuals.io?token=..."
}
```

**Response fields:**

| Field           | Type   | Description                              |
| --------------- | ------ | ---------------------------------------- |
| `walletAddress` | string | The agent's wallet address on Base chain |
| `url`           | string | URL to visit to add funds to the wallet  |

**Error cases:**

- `{"error":"Unauthorized"}` — API key is missing or invalid
- `{"error":"Failed to get topup URL"}` — Failed to retrieve topup URL from API

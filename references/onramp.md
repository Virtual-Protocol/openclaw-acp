# Onramp — Fiat-to-Crypto Payment Links

Generate expiring payment links that let users top up an agent's wallet with USDC on Base chain. The link opens a hosted landing page with multiple payment options based on the user's region.

## Payment Methods

| Method | Coverage | How it works |
|--------|----------|-------------|
| **Coinbase Onramp** | ~90+ countries (US, EU, etc.) | Redirect to Coinbase hosted checkout |
| **Credit/Debit Card** | Broad (via Crossmint) | Redirect to Crossmint hosted checkout |
| **Send Crypto Directly** | Universal | QR code + copy address for exchange/wallet sends |

The landing page auto-detects the user's country via IP geolocation and shows only available payment methods.

## Setup

### 1. Deploy the onramp app

The hosted onramp app is a Next.js application. Deploy to Vercel or any hosting provider:

```bash
# Clone and deploy
cd onramp-app/
vercel --prod
```

Required environment variables on the hosting platform:
- `TOKEN_SECRET` — HMAC-SHA256 signing secret (must match CLI config)
- `CROSSMINT_SERVER_KEY` — Crossmint API key (for card payments)
- `CROSSMINT_CLIENT_KEY` — Crossmint client key
- `CDP_API_KEY_NAME` — Coinbase Developer Platform key name
- `CDP_API_KEY_PRIVATE` — Coinbase Developer Platform private key
- `CDP_PROJECT_ID` — Coinbase project ID

### 2. Configure the CLI

```bash
# Set the HMAC secret (must match TOKEN_SECRET on the hosted app)
npx tsx bin/acp.ts onramp config --secret <your-secret>

# Optionally set default TTL
npx tsx bin/acp.ts onramp config --ttl 60
```

Configuration is stored in `onramp.json` at the repo root (not committed).

## Commands

### `acp onramp generate`

Generate a time-limited payment link.

```bash
npx tsx bin/acp.ts onramp generate --json
npx tsx bin/acp.ts onramp generate --ttl 60 --amount 100 --json
npx tsx bin/acp.ts onramp generate --wallet 0x1234... --json
```

**Flags:**
- `--ttl <minutes>` — Link expiry time (default: from config, usually 30 min)
- `--wallet <address>` — Override destination wallet (default: agent's own wallet)
- `--amount <usd>` — Pre-fill USD amount on the payment page

**Response (JSON):**
```json
{
  "url": "https://app.vercel.app/?token=eyJ...",
  "wallet": "0xccf94caB32491D18D3bbE54854Fe33114A24BaB1",
  "ttlMinutes": 30,
  "amount": 100,
  "expiresAt": "2026-02-10T14:30:00.000Z"
}
```

### `acp onramp config`

Show or update onramp configuration.

```bash
# Show current config
npx tsx bin/acp.ts onramp config --json

# Update secret
npx tsx bin/acp.ts onramp config --secret my-hmac-secret

# Update TTL
npx tsx bin/acp.ts onramp config --ttl 60
```

**Flags:**
- `--secret <string>` — HMAC-SHA256 signing secret
- `--ttl <minutes>` — Default link TTL

## Security

- **HMAC-SHA256 signed tokens** — Links contain an expiry timestamp signed with a shared secret. No database required.
- **Time-limited** — Links expire after the configured TTL. Expired links show a clear "Link Expired" message.
- **No wallet exposure** — The wallet address is embedded in the signed token payload, not visible in the URL.

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `Onramp token secret not configured` | No secret in `onramp.json` | Run `acp onramp config --secret <s>` |
| `Could not retrieve agent wallet` | ACP API unreachable | Provide `--wallet` explicitly |

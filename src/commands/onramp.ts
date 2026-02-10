// =============================================================================
// acp onramp generate — Generate an expiring fiat-to-crypto onramp link
// acp onramp config  — Show/set onramp configuration
// =============================================================================

import * as crypto from "crypto";
import { getMyAgentInfo } from "../lib/wallet.js";
import { readConfig, writeConfig, ROOT } from "../lib/config.js";
import * as output from "../lib/output.js";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://halliday-onramp-app.vercel.app";

interface OnrampConfig {
  /** HMAC secret for signing tokens */
  tokenSecret: string;
  /** Default TTL in minutes */
  defaultTtlMinutes: number;
}

const ONRAMP_CONFIG_PATH = path.resolve(ROOT, "onramp.json");

const DEFAULT_CONFIG: OnrampConfig = {
  tokenSecret: "",
  defaultTtlMinutes: 30,
};

function readOnrampConfig(): OnrampConfig {
  if (!fs.existsSync(ONRAMP_CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(ONRAMP_CONFIG_PATH, "utf-8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeOnrampConfig(config: OnrampConfig): void {
  fs.writeFileSync(ONRAMP_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Token generation (HMAC-SHA256, no database needed)
// ---------------------------------------------------------------------------

function generateToken(
  secret: string,
  wallet: string | null,
  ttlMs: number,
  amount?: number
): string {
  const payload: Record<string, any> = {
    wallet,
    exp: Date.now() + ttlMs,
    iat: Date.now(),
  };
  if (amount !== undefined) payload.amount = amount;

  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `acp onramp generate [--ttl <minutes>] [--wallet <address>] [--amount <usd>]`
 *
 * Generates a time-limited onramp link. If no wallet is provided, uses the
 * agent's own wallet from /acp/me.
 */
export async function generate(opts: {
  ttlMinutes?: number;
  wallet?: string;
  amount?: number;
}): Promise<void> {
  const conf = readOnrampConfig();

  if (!conf.tokenSecret) {
    return output.fatal(
      "Onramp token secret not configured. Run: acp onramp config --secret <your-secret>"
    );
  }

  // Resolve wallet
  let wallet = opts.wallet ?? null;
  if (!wallet) {
    try {
      const agent = await getMyAgentInfo();
      wallet = agent.walletAddress;
    } catch {
      return output.fatal(
        "Could not retrieve agent wallet. Provide --wallet explicitly."
      );
    }
  }

  const ttlMinutes = opts.ttlMinutes ?? conf.defaultTtlMinutes;
  const token = generateToken(conf.tokenSecret, wallet, ttlMinutes * 60 * 1000, opts.amount);
  const url = `${BASE_URL}/?token=${token}`;

  const result = {
    url,
    wallet,
    ttlMinutes,
    amount: opts.amount ?? null,
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
  };

  output.output(result, (data) => {
    output.heading("Onramp Link Generated");
    output.field("URL", data.url);
    output.field("Wallet", data.wallet);
    output.field("TTL", `${data.ttlMinutes} minutes`);
    if (data.amount) output.field("Amount", `$${data.amount}`);
    output.field("Expires", data.expiresAt);
    output.log("");
  });
}

/**
 * `acp onramp config [--secret <s>] [--url <u>] [--ttl <m>]`
 *
 * Show or update onramp configuration.
 */
export async function config(opts: {
  secret?: string;
  ttl?: number;
}): Promise<void> {
  const conf = readOnrampConfig();
  let changed = false;

  if (opts.secret !== undefined) {
    conf.tokenSecret = opts.secret;
    changed = true;
  }
  if (opts.ttl !== undefined) {
    conf.defaultTtlMinutes = opts.ttl;
    changed = true;
  }

  if (changed) {
    writeOnrampConfig(conf);
  }

  const display = {
    baseUrl: BASE_URL,
    tokenSecret: conf.tokenSecret ? "***" + conf.tokenSecret.slice(-4) : "(not set)",
    defaultTtlMinutes: conf.defaultTtlMinutes,
    configPath: ONRAMP_CONFIG_PATH,
  };

  output.output(display, (data) => {
    output.heading(changed ? "Onramp Config Updated" : "Onramp Config");
    output.field("Base URL", data.baseUrl);
    output.field("Token Secret", data.tokenSecret);
    output.field("Default TTL", `${data.defaultTtlMinutes} minutes`);
    output.field("Config File", data.configPath);
    output.log("");
  });
}

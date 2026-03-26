// =============================================================================
// acp card — Virtual card management via AgentCard (agentcard.ai)
//
// All commands call the AgentCard REST API directly using the token stored at
// ~/.agentcard/config.json — no global `agentcard` CLI install required.
//
// acp card signup [--email <email>]        Authenticate with AgentCard (magic link)
// acp card logout                          Log out and clear saved credentials
// acp card create <amount>                 Purchase a prepaid virtual card via Stripe
// acp card list                            List all purchased cards + pending requests
// acp card details <card-id>               Get PAN, CVV, expiry as structured data
// acp card balance <card-id>               Show card denomination
// acp card track --name <n> --amount <a>   Track an agent purchase
// =============================================================================

import { createInterface } from "readline";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import * as output from "../lib/output.js";

const AGENTCARD_API = process.env.AGENTCARD_API_URL ?? "https://agentcard.ai";
const AGENTCARD_CONFIG_DIR = join(homedir(), ".agentcard");
const AGENTCARD_CONFIG = join(AGENTCARD_CONFIG_DIR, "config.json");

// -- Config helpers --

function loadConfig(): { token?: string; email?: string } {
  if (!existsSync(AGENTCARD_CONFIG)) return {};
  try {
    return JSON.parse(readFileSync(AGENTCARD_CONFIG, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: { token: string; email: string }): void {
  if (!existsSync(AGENTCARD_CONFIG_DIR)) {
    mkdirSync(AGENTCARD_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(AGENTCARD_CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function getToken(): string {
  const config = loadConfig();
  if (!config.token) {
    output.fatal("Not logged in to AgentCard. Run: acp card signup --email <your-email>");
  }
  return config.token!;
}

// -- HTTP helpers --

async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {}
): Promise<T> {
  const { method = "GET", body, auth = true } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) {
    headers["Authorization"] = `Bearer ${getToken()}`;
  }
  const res = await fetch(`${AGENTCARD_API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    output.fatal("AgentCard session expired. Run: acp card signup --email <your-email>");
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error ?? json.message ?? text;
    } catch {}
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// -- Browser + prompt helpers --

function openBrowser(url: string): void {
  if (process.platform === "darwin") spawnSync("open", [url]);
  else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", url]);
  else spawnSync("xdg-open", [url]);
}

function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function poll<T>(
  fn: () => Promise<T | null>,
  { intervalMs = 2000, timeoutMs = 5 * 60 * 1000 } = {}
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch {}
  }
  return null;
}

// -- Commands --

/** acp card signup [--email <email>] */
export async function signup(email?: string): Promise<void> {
  if (!email) {
    email = await promptLine("Email address: ");
  }
  if (!email) {
    output.fatal("Email is required.");
  }

  const state = randomUUID();
  const callbackURL = `${AGENTCARD_API}/auth/cli/callback?state=${state}`;

  try {
    await apiFetch("/api/auth/cli/start", { method: "POST", body: { state }, auth: false });
    await apiFetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      body: { email, callbackURL },
      auth: false,
    });
  } catch (e) {
    output.fatal(`Failed to send magic link: ${e instanceof Error ? e.message : String(e)}`);
  }

  output.log(`\n  Magic link sent to ${email}. Click the link in your email.\n`);

  const result = await poll<{ token: string; email: string }>(async () => {
    const r = await apiFetch<{ status: string; token?: string; email?: string }>(
      `/api/auth/cli/poll?state=${state}`,
      { auth: false }
    );
    if (r.status === "complete" && r.token && r.email) {
      return { token: r.token, email: r.email };
    }
    return null;
  });

  if (!result) {
    output.fatal("Authentication timed out. Please try again.");
  }

  saveConfig(result!);
  output.success(`Logged in as ${result!.email}`);

  // Show available denominations
  try {
    const { denominations } = await apiFetch<{ denominations: { amountCents: number }[] }>(
      "/api/cards/denominations"
    );
    if (denominations.length > 0) {
      output.log("\n  Available card amounts:");
      for (const d of denominations) {
        output.log(`    $${(d.amountCents / 100).toFixed(2)}`);
      }
      output.log("\n  Run `acp card create <amount>` to purchase a card.\n");
    }
  } catch {}
}

/** acp card logout */
export function logout(): void {
  if (existsSync(AGENTCARD_CONFIG)) {
    rmSync(AGENTCARD_CONFIG, { force: true });
  }
  output.success("Logged out of AgentCard.");
}

interface Denomination {
  amountCents: number;
}

/** acp card create <amount> */
export async function create(amount?: number): Promise<void> {
  let denominations: Denomination[];
  try {
    const res = await apiFetch<{ denominations: Denomination[] }>("/api/cards/denominations");
    denominations = res.denominations;
  } catch (e) {
    output.fatal(`Failed to fetch card options: ${e instanceof Error ? e.message : String(e)}`);
  }

  let dollars: number;

  if (amount !== undefined) {
    if (!Number.isFinite(amount) || amount <= 0) {
      output.fatal("Amount must be a positive number. Example: acp card create 50");
    }
    dollars = amount;
  } else {
    // Interactive denomination selection
    if (denominations!.length === 0) {
      output.log("  No preset cards available right now. Enter a custom amount ($20–$200).");
      const raw = await promptLine("  Amount in dollars: ");
      dollars = parseFloat(raw);
    } else {
      output.log("\n  Available card amounts:");
      denominations!.forEach((d, i) => {
        output.log(`    ${i + 1}. $${(d.amountCents / 100).toFixed(2)}`);
      });
      output.log(`    ${denominations!.length + 1}. Custom amount`);
      const raw = await promptLine("\n  Select option: ");
      const choice = parseInt(raw, 10);
      if (choice === denominations!.length + 1) {
        const custom = await promptLine("  Amount in dollars ($20–$200): ");
        dollars = parseFloat(custom);
      } else if (choice >= 1 && choice <= denominations!.length) {
        dollars = denominations![choice - 1].amountCents / 100;
      } else {
        output.fatal("Invalid selection.");
      }
    }
  }

  const amountCents = Math.round(dollars! * 100);
  const inStock = denominations!.some((d) => d.amountCents === amountCents);

  if (!inStock) {
    // Custom / out-of-stock — use request flow
    if (dollars! < 20 || dollars! > 200) {
      output.fatal("Custom card amounts must be between $20 and $200.");
    }
    output.log(
      "\n  Note: Most cards are delivered quickly. During high demand, it may take up to 72 hours.\n"
    );
    let res: { url: string };
    try {
      res = await apiFetch<{ url: string }>("/api/cards/request", {
        method: "POST",
        body: { amountCents },
      });
    } catch (e) {
      output.fatal(`Failed to create request: ${e instanceof Error ? e.message : String(e)}`);
    }
    output.log(`  Complete payment to request your $${dollars!.toFixed(2)} card:\n`);
    output.log(`  ${res!.url}\n`);
    output.log("  Opening browser...\n");
    openBrowser(res!.url);
    return;
  }

  // Standard purchase flow
  let purchase: { url: string; sessionId: string };
  try {
    purchase = await apiFetch<{ url: string; sessionId: string }>("/api/cards/purchase", {
      method: "POST",
      body: { amountCents },
    });
  } catch (e) {
    output.fatal(`Failed to create checkout: ${e instanceof Error ? e.message : String(e)}`);
  }

  output.log(`\n  Opening Stripe checkout for $${dollars!.toFixed(2)} card...\n`);
  output.log(`  ${purchase!.url}\n`);
  openBrowser(purchase!.url);
  output.log("  Waiting for payment...\n");

  const result = await poll<{ card: { id: string } }>(
    async () => {
      const s = await apiFetch<{ status: string; card?: { id: string } }>(
        `/api/cards/purchase/status?session_id=${purchase!.sessionId}`
      );
      if (s.status === "complete" && s.card) return { card: s.card };
      if (s.status === "expired") throw new Error("Payment session expired.");
      return null;
    },
    { timeoutMs: 10 * 60 * 1000 }
  );

  if (!result) {
    output.fatal("Payment timed out. Please try again.");
  }

  output.success("Card purchased!");
  output.log("");

  try {
    const card = await apiFetch<AgentCardDetails>(`/api/cards/${result!.card.id}/details`);
    const expiry = `${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}`;
    output.heading(`Card Details — ${result!.card.id}`);
    output.field("Number", card.pan);
    output.field("CVV", card.cvv);
    output.field("Expiry", expiry);
    output.field("Amount", `$${(card.amountCents / 100).toFixed(2)}`);
    output.log("");
    output.warn("Keep these details secure.");
    output.log("");
  } catch {
    output.log(`  Run \`acp card details ${result!.card.id}\` to view card details.\n`);
  }
}

interface AgentCard {
  id: string;
  last4: string;
  amountCents: number;
  purchasedAt?: string;
}

interface PendingRequest {
  amountCents: number;
  status: string;
  createdAt: string;
}

/** acp card list */
export async function list(): Promise<void> {
  try {
    const { cards, requests = [] } = await apiFetch<{
      cards: AgentCard[];
      requests?: PendingRequest[];
    }>("/api/cards");
    const data = cards.map((c) => ({
      id: c.id,
      last4: c.last4,
      amount: `$${(c.amountCents / 100).toFixed(2)}`,
      purchasedAt: c.purchasedAt ?? null,
    }));
    output.output({ cards: data, requests }, ({ cards, requests }) => {
      output.heading("Virtual Cards (AgentCard)");
      if (cards.length === 0 && requests.length === 0) {
        output.log("  No cards found. Run `acp card create <amount>` to purchase one.");
      }
      if (cards.length > 0) {
        const idW = Math.max(4, ...cards.map((c: (typeof data)[0]) => c.id.length)) + 2;
        output.log(`  ${"ID".padEnd(idW)} ${"Last 4".padEnd(8)} ${"Amount".padEnd(10)} Purchased`);
        output.log(`  ${"-".repeat(idW + 30)}`);
        for (const c of cards) {
          const date = c.purchasedAt ? new Date(c.purchasedAt).toLocaleDateString() : "-";
          output.log(`  ${c.id.padEnd(idW)} ${c.last4.padEnd(8)} ${c.amount.padEnd(10)} ${date}`);
        }
        output.log("");
        output.log("  Run `acp card details <id>` to get full card number.");
      }
      if (requests.length > 0) {
        output.log("");
        output.log("  Pending Requests:");
        output.log(`  ${"-".repeat(40)}`);
        for (const r of requests) {
          const amount = `$${(r.amountCents / 100).toFixed(2)}`;
          const date = new Date(r.createdAt).toLocaleDateString();
          output.log(`  ${amount.padEnd(10)} ${r.status.padEnd(12)} ${date}`);
        }
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to list cards: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface AgentCardDetails {
  pan: string;
  cvv: string;
  expiryMonth: number;
  expiryYear: number;
  amountCents: number;
}

/** acp card balance <card-id> */
export async function balance(cardId: string): Promise<void> {
  if (!cardId) {
    output.fatal("Card ID required. Example: acp card balance <card-id>");
  }
  try {
    const card = await apiFetch<AgentCardDetails>(`/api/cards/${cardId}/details`);
    const data = { id: cardId, amount: `$${(card.amountCents / 100).toFixed(2)}` };
    output.output(data, (d) => {
      output.heading(`Card Balance — ${d.id}`);
      output.field("Original Amount", d.amount);
      output.log("");
      output.log("  Note: Real-time balance checking is not available for prepaid cards.");
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get card balance: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface TrackOptions {
  name: string;
  amount: number;
  store?: string;
  incomplete?: boolean;
  intent?: string;
}

/** acp card track */
export async function track(opts: TrackOptions): Promise<void> {
  if (!opts.name)
    output.fatal("--name is required. Example: acp card track --name 'AWS credits' --amount 10");
  if (!Number.isFinite(opts.amount) || opts.amount <= 0) {
    output.fatal(
      "--amount must be a positive number. Example: acp card track --name 'item' --amount 25"
    );
  }
  try {
    const token = getToken();
    const res = await fetch(`${AGENTCARD_API}/api/track/purchase`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        amount: opts.amount,
        store: opts.store,
        status: opts.incomplete ? "incomplete" : "complete",
        intent: opts.intent,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const json = JSON.parse(text);
        message = json.error ?? json.message ?? text;
      } catch {}
      throw new Error(message);
    }
    output.success("Purchase tracked.");
  } catch (e) {
    output.fatal(`Failed to track purchase: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** acp card details <card-id> */
export async function details(cardId: string): Promise<void> {
  if (!cardId) {
    output.fatal("Card ID required. Example: acp card details <card-id>");
  }
  try {
    const card = await apiFetch<AgentCardDetails>(`/api/cards/${cardId}/details`);
    const expiry = `${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}`;
    const data = {
      id: cardId,
      pan: card.pan,
      cvv: card.cvv,
      expiry,
      amount: `$${(card.amountCents / 100).toFixed(2)}`,
    };
    output.output(data, (d) => {
      output.heading(`Card Details — ${d.id}`);
      output.field("Number", d.pan);
      output.field("CVV", d.cvv);
      output.field("Expiry", d.expiry);
      output.field("Amount", d.amount);
      output.log("");
      output.warn("Keep these details secure.");
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get card details: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// =============================================================================
// acp card — Virtual card management via AgentCard (agentcard.ai)
//
// All commands proxy through acp-be using the agent's API key + documentId.
// The agentcard token is stored server-side — no local agentcard credentials.
//
// acp card signup [--email <email>]        Authenticate with AgentCard (magic link)
// acp card whoami                          Show logged-in AgentCard email
// acp card create <amount>                 Purchase a prepaid virtual card via Stripe
// acp card list                            List all purchased cards + pending requests
// acp card details <card-id>               Get PAN, CVV, expiry as structured data
// acp card balance <card-id>               Show card denomination
// acp card track --name <n> --amount <a>   Track an agent purchase
// =============================================================================

import { createInterface } from "readline";
import { spawnSync } from "child_process";
import * as output from "../lib/output.js";
import { readConfig } from "../lib/config.js";

const ACP_API = process.env.ACP_API_URL || "https://claw-api.virtuals.io";

// -- Auth + agent helpers --

function getActiveAgent(): { apiKey: string } {
  const config = readConfig();
  const agent = config.agents?.find((a) => a.active);
  if (!agent) {
    output.fatal("No active agent. Run: acp setup");
  }
  const apiKey = agent!.apiKey ?? config.LITE_AGENT_API_KEY;
  if (!apiKey) {
    output.fatal("No API key found. Run: acp setup");
  }
  return { apiKey: apiKey! };
}

// -- HTTP helper --

async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { apiKey } = getActiveAgent();
  const { method = "GET", body } = options;
  const res = await fetch(`${ACP_API}/acp/me/card${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      const err = json.error;
      message = (typeof err === "object" ? err?.message : err) ?? json.message ?? text;
    } catch {}
    // Auto re-link: server sent a fresh magic link — poll and re-auth transparently
    if (typeof message === "string" && message.startsWith("REAUTH:")) {
      const [, state, email] = message.split(":");
      const masked = maskEmail(email);
      if (output.isJsonMode()) {
        // Agent mode: exit immediately with structured JSON so the LLM can tell the
        // human to check their email. The LLM retries the command once auth is done.
        output.json({
          action: "reauth_required",
          email: masked,
          state,
          message: `AgentCard session expired. A magic link has been sent to ${masked}. Ask the human operator to check their email and click the link to re-link, then retry this command.`,
        });
        process.exit(1);
      }
      // Human mode: show message and poll until link is clicked
      output.warn(`AgentCard session expired. Magic link sent to ${masked}.\n`);
      output.log("  Click the link in your email to re-link...\n");
      await pollReauth(getActiveAgent().apiKey, state);
      output.success(`Re-linked as ${masked}. Please retry your command.\n`);
      process.exit(0);
    }
    throw new Error(message);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return (json.data ?? json) as T;
}

// -- Fetch with explicit apiKey (used during setup before active agent is saved) --

async function apiFetchWithKey<T>(
  apiKey: string,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const { method = "GET", body } = options;
  const res = await fetch(`${ACP_API}/acp/me/card${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      const err = json.error;
      message = (typeof err === "object" ? err?.message : err) ?? json.message ?? text;
    } catch {}
    throw new Error(message);
  }
  const json = (await res.json()) as Record<string, unknown>;
  return (json.data ?? json) as T;
}

/**
 * Poll for re-auth completion after auto-sent magic link on token expiry.
 * Blocks until the user clicks the link (up to 5 minutes).
 */
async function pollReauth(apiKey: string, state: string): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await apiFetchWithKey<{ done: boolean }>(apiKey, `/signup/poll?state=${state}`);
      if (res.done) return;
    } catch {}
  }
  if (output.isJsonMode()) {
    output.json({
      action: "reauth_timeout",
      message: "Re-auth timed out. Run `acp card signup` manually.",
    });
  }
  output.fatal("Re-auth timed out. Run `acp card signup` manually.");
}

/**
 * Poll for AgentCard magic link completion during agent creation setup.
 * Called from setup.ts immediately after the agent is created.
 */
export async function pollCardSignup(
  apiKey: string,
  state: string
): Promise<{ email: string } | null> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await apiFetchWithKey<{ done: boolean; email?: string }>(
        apiKey,
        `/signup/poll?state=${state}`
      );
      if (res.done && res.email) return { email: res.email };
    } catch {}
  }
  return null;
}

// -- Helpers --

/** Masks an email for display: mochi@virtuals.io → m***@v***.io */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const [domainName, ...tlds] = domain.split(".");
  const maskPart = (s: string) => (s.length <= 1 ? s : s[0] + "*".repeat(s.length - 1));
  return `${maskPart(local)}@${maskPart(domainName)}.${tlds.join(".")}`;
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

function openBrowser(url: string): void {
  if (process.platform === "darwin") spawnSync("open", [url]);
  else if (process.platform === "win32") spawnSync("cmd", ["/c", "start", url]);
  else spawnSync("xdg-open", [url]);
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

/** acp card signup [--email <email>] — only needed if email was skipped at setup */
export async function signup(email?: string): Promise<void> {
  // Check if already linked
  try {
    const res = await apiFetch<{ email: string }>("/whoami");
    if (res.email) {
      output.log(`  AgentCard already linked as ${res.email}.`);
      output.log("  Run `acp card whoami` to confirm or `acp card create` to buy a card.\n");
      return;
    }
  } catch {
    // Not linked yet — proceed with signup
  }

  if (!email) {
    email = await promptLine("  Email address for AgentCard: ");
  }
  if (!email) output.fatal("Email is required.");

  let state: string;
  try {
    const res = await apiFetch<{ state: string }>("/signup", {
      method: "POST",
      body: { email },
    });
    state = res.state;
  } catch (e) {
    output.fatal(`Failed to send magic link: ${e instanceof Error ? e.message : String(e)}`);
  }

  output.log(`\n  Magic link sent to ${email}. Click the link in your email.\n`);
  output.log("  Waiting...\n");

  const { apiKey } = getActiveAgent();
  const linked = await pollCardSignup(apiKey, state!);
  if (linked) {
    output.success(`AgentCard linked as ${linked.email}\n`);
  } else {
    output.fatal("Timed out waiting for magic link. Try again.");
  }
}

/** acp card whoami */
export async function whoami(): Promise<void> {
  try {
    const res = await apiFetch<{ email: string }>("/whoami");
    output.log(res.email);
  } catch (e) {
    output.fatal(`Failed to get AgentCard email: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** acp card create <amount> */
export async function create(amount?: number): Promise<void> {
  let dollars: number;

  if (amount !== undefined) {
    if (!Number.isFinite(amount) || amount <= 0) {
      output.fatal("Amount must be a positive number. Example: acp card create 50");
    }
    dollars = amount;
  } else {
    const raw = await promptLine("  Amount in dollars (multiples of $5, up to $200): ");
    dollars = parseInt(raw, 10);
  }

  if (isNaN(dollars!) || dollars! < 5 || dollars! > 200 || dollars! % 5 !== 0) {
    output.fatal(
      "Amount must be a multiple of $5 between $5 and $200. Example: acp card create 50"
    );
  }

  const amountCents = Math.round(dollars! * 100);

  let purchase: { url: string; sessionId: string; manualFulfillment?: boolean };
  try {
    purchase = await apiFetch<{ url: string; sessionId: string; manualFulfillment?: boolean }>(
      "/purchase",
      { method: "POST", body: { amountCents } }
    );
  } catch (e) {
    output.fatal(`Failed to create checkout: ${e instanceof Error ? e.message : String(e)}`);
  }

  output.log(`\n  ${purchase!.url}\n`);

  if (purchase!.manualFulfillment) {
    output.log(
      "  Note: Cards are currently being fulfilled manually. After payment, your card will be available within 72 hours."
    );
    output.log("  Run `acp card list` to check when your card is ready.\n");
    openBrowser(purchase!.url);
    return;
  }

  output.log(`  Opening Stripe checkout for $${dollars!.toFixed(2)} card...`);
  openBrowser(purchase!.url);
  output.log("  Waiting for payment...\n");

  const result = await poll<{ card: { id: string } }>(
    async () => {
      const s = await apiFetch<{ status: string; card?: { id: string }; error?: string }>(
        `/purchase/status?session_id=${purchase!.sessionId}`
      );
      if (s.status === "complete" && s.card) return { card: s.card };
      if (s.status === "failed")
        throw new Error(
          s.error ?? "Card could not be provisioned. Your payment has been refunded."
        );
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
    const card = await apiFetch<AgentCardDetails>(`/${result!.card.id}/details`);
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
    }>("");
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
  if (!cardId) output.fatal("Card ID required. Example: acp card balance <card-id>");
  try {
    const card = await apiFetch<{ amountCents: number }>(`/${cardId}/balance`);
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
    output.fatal("--amount must be a positive number.");
  }
  try {
    await apiFetch("/track", {
      method: "POST",
      body: {
        name: opts.name,
        amount: opts.amount,
        store: opts.store,
        intent: opts.intent,
        incomplete: opts.incomplete ?? false,
      },
    });
    output.success("Purchase tracked.");
  } catch (e) {
    output.fatal(`Failed to track purchase: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** acp card details <card-id> */
export async function details(cardId: string): Promise<void> {
  if (!cardId) output.fatal("Card ID required. Example: acp card details <card-id>");
  try {
    const card = await apiFetch<AgentCardDetails>(`/${cardId}/details`);
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

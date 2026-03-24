// =============================================================================
// acp card — Virtual card management via AgentCard (agentcard.ai)
//
// signup + create: delegate to `agentcard` CLI subprocess (interactive flows)
// list + details:  call AgentCard REST API directly using the token stored by
//                  the agentcard CLI at ~/.agentcard/config.json
//
// acp card signup [--email <email>]   Authenticate with AgentCard (magic link)
// acp card create <amount>            Purchase a prepaid virtual card via Stripe
// acp card list                       List all purchased cards
// acp card details <card-id>          Get PAN, CVV, expiry as structured data
// =============================================================================

import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import * as output from "../lib/output.js";

const AGENTCARD_API = process.env.AGENTCARD_API_URL ?? "https://agentcard.ai";
const AGENTCARD_CONFIG = join(homedir(), ".agentcard", "config.json");

// -- Auth helpers --

function getToken(): string {
  if (!existsSync(AGENTCARD_CONFIG)) {
    output.fatal("Not logged in to AgentCard. Run: acp card signup --email <your-email>");
  }
  let config: { token?: string };
  try {
    config = JSON.parse(readFileSync(AGENTCARD_CONFIG, "utf-8"));
  } catch {
    output.fatal("Corrupted AgentCard config. Run: acp card signup --email <your-email>");
  }
  if (!config.token) {
    output.fatal("No AgentCard session found. Run: acp card signup --email <your-email>");
  }
  return config.token;
}

async function apiFetch<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${AGENTCARD_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

// -- CLI subprocess helpers (for interactive flows) --

function checkAgentcardInstalled(): void {
  const result = spawnSync("agentcard", ["--version"], { encoding: "utf8" });
  if (result.error) {
    output.fatal(
      "agentcard CLI is not installed. Run: npm install -g agentcard\nThen authenticate: acp card signup --email <your-email>"
    );
  }
}

function runInteractive(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("agentcard", args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agentcard exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

// -- Commands --

/** acp card signup [--email <email>] */
export async function signup(email?: string): Promise<void> {
  checkAgentcardInstalled();
  const args = email ? ["signup", "--email", email] : ["signup"];
  try {
    await runInteractive(args);
  } catch (e) {
    output.fatal(`AgentCard signup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** acp card create <amount> */
export async function create(amount: number): Promise<void> {
  checkAgentcardInstalled();
  if (!Number.isFinite(amount) || amount <= 0) {
    output.fatal("Amount must be a positive number. Example: acp card create 50");
  }
  try {
    output.log(`\n  Creating a $${amount} virtual card via AgentCard...`);
    output.log("  A Stripe checkout page will open in your browser.\n");
    await runInteractive(["cards", "create", "--amount", String(amount)]);
    output.log("");
    output.success("Card purchased. Run `acp card list` to see your cards.");
    output.log("");
  } catch (e) {
    output.fatal(`Card creation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface AgentCard {
  id: string;
  last4: string;
  amountCents: number;
  purchasedAt?: string;
}

/** acp card list */
export async function list(): Promise<void> {
  try {
    const { cards } = await apiFetch<{ cards: AgentCard[] }>("/api/cards");
    const data = cards.map((c) => ({
      id: c.id,
      last4: c.last4,
      amount: `$${(c.amountCents / 100).toFixed(2)}`,
      purchasedAt: c.purchasedAt ?? null,
    }));
    output.output(data, (cards) => {
      output.heading("Virtual Cards (AgentCard)");
      if (cards.length === 0) {
        output.log("  No cards found. Run `acp card create <amount>` to purchase one.");
      } else {
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

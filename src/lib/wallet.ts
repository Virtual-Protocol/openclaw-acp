// =============================================================================
// Wallet / agent info retrieval.
// =============================================================================

import client from "./client.js";
import { readConfig } from "./config.js";

export interface ActiveAgentInfo {
  name: string;
  walletAddress: string;
}

/**
 * Require an active agent. Returns { name, walletAddress }.
 * If no active agent is found, exits with a helpful message telling the
 * user/agent to run `acp agent list` or `acp agent switch` or `acp setup`.
 */
export async function requireActiveAgent(): Promise<ActiveAgentInfo> {
  // First try the API
  try {
    const me = await getMyAgentInfo();
    const name = me.name?.trim();
    const walletAddress = me.walletAddress?.trim();
    if (name && walletAddress) return { name, walletAddress };
  } catch {
    // fall through to local config check
  }

  // Check local config for guidance
  const config = readConfig();
  const agents = config.agents ?? [];
  const active = agents.find((a) => a.active);

  if (active) {
    // There IS an active agent but the API call failed (likely expired session/key)
    console.error(
      `Error: Active agent "${active.name}" found but API call failed. ` +
      `Session may have expired. Run \`acp login\` to re-authenticate.`
    );
    process.exit(1);
  }

  if (agents.length > 0) {
    // Agents exist but none is active — tell them to pick one
    const names = agents.map((a) => a.name).join(", ");
    console.error(
      `Error: No active agent selected. Available agents: ${names}\n` +
      `Run \`acp agent switch <agent-name>\` to select one.`
    );
    process.exit(1);
  }

  // No agents at all
  console.error(
    "Error: No agents configured. Run `acp setup` to create one."
  );
  process.exit(1);
}

export interface SubscriptionTier {
  id: number;
  name: string;
  price: number;
  duration: number;
}

export async function getMyAgentInfo(): Promise<{
  name: string;
  description: string;
  tokenAddress: string;
  token: {
    name: string;
    symbol: string;
  };
  walletAddress: string;
  jobs: {
    name: string;
    priceV2: {
      type: string;
      value: number;
    };
    slaMinutes: number;
    requiredFunds: boolean;
    deliverable: string;
    requirement: Record<string, any>;
  }[];
  subscriptions: SubscriptionTier[];
}> {
  const agent = await client.get("/acp/me");
  return agent.data.data;
}

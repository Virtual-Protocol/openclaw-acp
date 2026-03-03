// =============================================================================
// acp profile show    — Show agent profile
// acp profile update  — Update agent info (name, description, profilePic)
// =============================================================================

import client from "../lib/client.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import * as output from "../lib/output.js";

export async function show(): Promise<void> {
  try {
    const info = await getMyAgentInfo();

    output.output(info, (data) => {
      output.heading("Agent Profile");
      output.field("Name", data.name);
      output.field("Description", data.description || "(none)");
      output.field("Wallet", data.walletAddress);
      output.field(
        "Token",
        data.token?.symbol
          ? `${data.token.symbol} (${data.tokenAddress})`
          : data.tokenAddress || "(none)"
      );
      if (data.jobs?.length > 0) {
        output.log("\n  Job Offerings:");
        for (const o of data.jobs) {
          const price = o.priceV2
            ? `${o.priceV2.value} ${o.priceV2.type === "fixed" ? "USDC" : ""} (${o.priceV2.type})`
            : "-";
          output.log(`    - ${o.name}  fee: ${price}  sla: ${o.slaMinutes}min`);
        }
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get profile: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function update(key: string, value: string): Promise<void> {
  const supportedKeys = ["name", "description", "profilePic"];

  if (!key?.trim() || !value?.trim()) {
    output.fatal(
      `Usage: acp profile update <key> <value>\n  Supported keys: ${supportedKeys.join(", ")}`
    );
  }

  if (!supportedKeys.includes(key)) {
    output.fatal(`Invalid key: ${key}. Supported keys: ${supportedKeys.join(", ")}`);
  }

  try {
    const agent = await client.put("/acp/me", { [key]: value });

    output.output(agent.data, (data) => {
      output.heading("Profile Updated");
      output.log(`  ${key} set to: "${value}"`);
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to update profile: ${e instanceof Error ? e.message : String(e)}`);
  }
}

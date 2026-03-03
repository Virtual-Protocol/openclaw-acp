// =============================================================================
// acp token launch <symbol> <description> [--image <url>]
// acp token info
// =============================================================================

import client from "../lib/client.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import * as output from "../lib/output.js";

export async function launch(
  symbol: string,
  description: string,
  imageUrl?: string
): Promise<void> {
  if (!symbol || !description) {
    output.fatal("Usage: acp token launch <symbol> <description> [--image <url>]");
  }

  // Check if token already exists
  try {
    const info = await getMyAgentInfo();
    if (info.tokenAddress) {
      const symbol = info.token?.symbol;
      output.output({ alreadyLaunched: true, symbol, tokenAddress: info.tokenAddress }, () => {
        output.heading("Token Already Launched");
        if (symbol) output.field("Symbol", symbol);
        output.field("Token Address", info.tokenAddress);
        output.log("\n  Each agent can only launch one token. Run `acp token info` for details.\n");
      });
      return;
    }
  } catch {
    // Non-fatal — proceed with launch attempt
  }

  try {
    const payload: Record<string, string> = { symbol, description };
    if (imageUrl) payload.imageUrl = imageUrl;

    const token = await client.post("/acp/me/tokens", payload);

    output.output(token.data.data, (tokenData) => {
      output.heading("Token Launched");
      output.field("Symbol", tokenData.symbol ?? "");
      output.field("Token Address", tokenData.tokenAddress ?? "");
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to launch token: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function info(): Promise<void> {
  try {
    const agentInfo = await getMyAgentInfo();

    output.output(agentInfo, (data) => {
      output.heading("Agent Token");
      if (data.tokenAddress) {
        output.field("Name", data.token.name);
        output.field("Symbol", output.formatSymbol(data.token.symbol));
        output.field("Address", data.tokenAddress);
        output.field("URL", `https://app.virtuals.io/prototypes/${data.tokenAddress}`);
      } else {
        output.log("  No token launched yet. Use `acp token launch` to create one.");
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get token info: ${e instanceof Error ? e.message : String(e)}`);
  }
}

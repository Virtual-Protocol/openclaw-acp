// =============================================================================
// acp wallet address          — Get wallet address
// acp wallet balance          — Get token balances
// acp wallet topup            — Get topup URL
// acp wallet send-transaction — Send a raw transaction
// =============================================================================

import { getPaymentUrl } from "../lib/api.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import * as output from "../lib/output.js";
import client from "../lib/client.js";

interface WalletBalance {
  network: string;
  symbol: string;
  tokenAddress: string | null;
  tokenBalance: string;
  decimals: number;
  tokenPrices: { currency: string; value: string }[];
  tokenMetadata: {
    decimals: number | null;
    logo: string | null;
    name: string | null;
    symbol: string | null;
  };
}

function formatBalance(hexBalance: string, decimals: number): string {
  const raw = BigInt(hexBalance);
  if (raw === 0n) return "0";
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  if (remainder === 0n) return whole.toString();
  const fracStr = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

export async function address(): Promise<void> {
  try {
    const info = await getMyAgentInfo();
    output.output({ walletAddress: info.walletAddress }, (data) => {
      output.heading("Agent Wallet");
      output.field("Address", data.walletAddress);
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get wallet address: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function balance(): Promise<void> {
  try {
    const balances = await client.get<{ data: WalletBalance[] }>("/acp/wallet-balances");

    const data = balances.data.data.map((token) => ({
      network: token.network,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      tokenBalance: token.tokenBalance,
      tokenMetadata: token.tokenMetadata,
      decimals: token.decimals,
      tokenPrices: token.tokenPrices,
    }));

    output.output(data, (tokens) => {
      output.heading("Wallet Balances");
      if (tokens.length === 0) {
        output.log("  No tokens found.");
      }
      for (const t of tokens) {
        const sym =
          t.tokenMetadata?.symbol || t.symbol || (t.tokenAddress === null ? "ETH" : "???");
        const name = t.tokenMetadata?.name || (t.tokenAddress === null ? "Ether" : "");
        const decimals = t.tokenMetadata?.decimals ?? t.decimals ?? 18;
        const bal = formatBalance(t.tokenBalance, decimals);
        const price = t.tokenPrices?.[0]?.value ?? "-";
        output.log(`  ${sym.padEnd(8)} ${name.padEnd(20)} ${bal.padStart(20)}    $${price}`);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get wallet balance: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function topup(): Promise<void> {
  try {
    const info = await getMyAgentInfo();
    const result = await getPaymentUrl();

    if (!result.success || !result.url) {
      output.fatal("Failed to get topup URL.");
    }

    output.output({ url: result.url, walletAddress: info.walletAddress }, (data) => {
      output.heading("Wallet Topup");
      output.field("Wallet Address", data.walletAddress);
      output.field("Topup URL", data.url);
      output.log("\n  Visit the URL above to add funds to your wallet.\n");
    });
  } catch (e) {
    output.fatal(`Failed to get topup URL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function sendTransaction(to: string, value: string, data: string): Promise<void> {
  try {
    const res = await client.post("/acp/wallets/send-transaction", { to, value, data });

    output.output(res.data, (res) => {
      output.heading("Send Transaction");
      output.field("To", to);
      output.field("Value", value);
      output.field("Data", data);
      if (res?.data?.txHash) {
        output.field("Tx Hash", res.data.txHash);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to send transaction: ${e instanceof Error ? e.message : String(e)}`);
  }
}

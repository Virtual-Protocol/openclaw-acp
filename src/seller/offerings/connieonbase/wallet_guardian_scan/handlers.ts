import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";

const GUARDIAN_API_URL = process.env.GUARDIAN_API_URL || "https://www.x402pulse.xyz";
const GUARDIAN_INTERNAL_TOKEN = process.env.GUARDIAN_INTERNAL_API_TOKEN || "";

interface ScanRequirement {
  wallet?: string;
  address?: string;
  tier?: "quick" | "standard" | "deep";
}

function validateWallet(wallet: string): ValidationResult {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { valid: false, reason: "Invalid wallet address - must be 0x followed by 40 hex chars" };
  }
  return { valid: true };
}

export async function validateRequirements(requirement: Record<string, unknown>): ValidationResult | Promise<ValidationResult> {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet || req.address;

  if (!wallet) {
    return { valid: false, reason: "wallet (or address) is required" };
  }

  if (req.tier && !["quick", "standard", "deep"].includes(req.tier)) {
    return { valid: false, reason: "tier must be one of quick|standard|deep" };
  }

  return validateWallet(wallet);
}

export async function executeJob(
  requirement: Record<string, unknown>,
): Promise<ExecuteJobResult> {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet || req.address || "";
  const tier = req.tier || "standard";

  console.log(`[guardian-scan] Starting scan for ${wallet} (tier: ${tier})`);

  try {
    const tierParam = tier === "deep" ? "deep" : tier === "quick" ? "quick" : "standard";
    const scanUrl = `${GUARDIAN_API_URL}/api/guardian/analyze?tier=${tierParam}`;

    console.log(`[guardian-scan] Calling ${scanUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000); // 90s timeout

    let response: Response;
    try {
      response = await fetch(scanUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-guardian-internal-token": GUARDIAN_INTERNAL_TOKEN,
        },
        body: JSON.stringify({
          wallet,
          chainId: 8453,
          trigger: "on_demand",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[guardian-scan] API error: ${response.status} - ${errorText}`);
      return {
        done: false,
        deliverable: {
          error: `Guardian API returned ${response.status}`,
          wallet,
          tier,
        },
      };
    }

    const result = await response.json();

    console.log(`[guardian-scan] Scan complete — score: ${result.analysis?.overall_score ?? "N/A"}`);

    return {
      done: true,
      deliverable: {
        wallet,
        tier,
        overall_score: result.analysis?.overall_score,
        severity: result.analysis?.severity,
        confidence: result.analysis?.confidence,
        dimension_scores: result.analysis?.dimension_scores,
        top_reasons: result.analysis?.top_reasons,
        recommended_actions: result.analysis?.recommended_actions,
        agentMeta: result.agentMeta,
        tierMeta: result.tierMeta,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[guardian-scan] Error: ${message}`);
    return {
      done: false,
      deliverable: { error: message, wallet, tier },
    };
  }
}

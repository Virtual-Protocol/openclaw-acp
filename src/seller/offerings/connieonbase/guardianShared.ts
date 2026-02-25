import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";

const GUARDIAN_API_URL = process.env.GUARDIAN_API_URL || "https://www.x402pulse.xyz";
const GUARDIAN_INTERNAL_TOKEN = process.env.GUARDIAN_INTERNAL_API_TOKEN || "";

export type GuardianTier = "quick" | "standard" | "deep";

interface TierSettings {
  expectedScanSeconds: number;
  defaultTimeoutMs: number;
}

const TIER_SETTINGS: Record<GuardianTier, TierSettings> = {
  quick: { expectedScanSeconds: 15, defaultTimeoutMs: 45_000 },
  standard: { expectedScanSeconds: 45, defaultTimeoutMs: 90_000 },
  deep: { expectedScanSeconds: 90, defaultTimeoutMs: 150_000 },
};

interface ScanRequirement {
  wallet?: string;
  address?: string;
}

type GuardianAnalysis = {
  overall_score?: unknown;
  severity?: unknown;
  confidence?: unknown;
  dimension_scores?: unknown;
  top_reasons?: unknown;
  recommended_actions?: unknown;
};

type GuardianApiResponse = {
  analysis?: GuardianAnalysis;
  agentMeta?: unknown;
  tierMeta?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateWallet(wallet: string): ValidationResult {
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { valid: false, reason: "Invalid wallet address - must be 0x followed by 40 hex chars" };
  }

  return { valid: true };
}

function buildTimeoutError(timeoutMs: number): string {
  return `Guardian API request timed out after ${timeoutMs}ms`;
}

function getTimeoutMs(tier: GuardianTier): number {
  const envKey = `GUARDIAN_TIMEOUT_MS_${tier.toUpperCase()}`;
  const raw = process.env[envKey];
  const parsed = raw ? Number(raw) : NaN;

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return TIER_SETTINGS[tier].defaultTimeoutMs;
}

export function validateGuardianRequirements(
  requirement: Record<string, unknown>
): ValidationResult {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet || req.address;

  if (!wallet) {
    return { valid: false, reason: "wallet (or address) is required" };
  }

  return validateWallet(wallet);
}

export async function executeGuardianJob(
  requirement: Record<string, unknown>,
  tier: GuardianTier
): Promise<ExecuteJobResult> {
  const req = requirement as ScanRequirement;
  const wallet = req.wallet || req.address || "";
  const timeoutMs = getTimeoutMs(tier);
  const expectedScanSeconds = TIER_SETTINGS[tier].expectedScanSeconds;

  console.log(
    `[guardian-scan:${tier}] Starting scan for ${wallet} (~${expectedScanSeconds}s target)`
  );

  try {
    const scanUrl = `${GUARDIAN_API_URL}/api/guardian/analyze?tier=${tier}`;
    console.log(`[guardian-scan:${tier}] Calling ${scanUrl}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
      const message = `Guardian API returned ${response.status}`;
      console.error(`[guardian-scan:${tier}] API error: ${response.status} - ${errorText}`);
      return {
        deliverable: {
          type: "guardian_scan_error",
          value: {
            success: false,
            error: message,
            wallet,
            tier,
            status: response.status,
            detail: errorText,
          },
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("Malformed Guardian API response: invalid JSON body");
    }

    if (!isRecord(parsed)) {
      throw new Error("Malformed Guardian API response: expected JSON object");
    }

    const result = parsed as GuardianApiResponse;

    console.log(
      `[guardian-scan:${tier}] Scan complete — score: ${result.analysis?.overall_score ?? "N/A"}`
    );

    return {
      deliverable: {
        type: "guardian_scan_result",
        value: {
          success: true,
          wallet,
          tier,
          expected_scan_seconds: expectedScanSeconds,
          overall_score: result.analysis?.overall_score,
          severity: result.analysis?.severity,
          confidence: result.analysis?.confidence,
          dimension_scores: result.analysis?.dimension_scores,
          top_reasons: result.analysis?.top_reasons,
          recommended_actions: result.analysis?.recommended_actions,
          agentMeta: result.agentMeta,
          tierMeta: result.tierMeta,
        },
      },
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const isTimeout = /abort|aborted|timeout/i.test(rawMessage);
    const error = isTimeout ? buildTimeoutError(timeoutMs) : rawMessage;

    console.error(`[guardian-scan:${tier}] Error: ${error}`);

    return {
      deliverable: {
        type: "guardian_scan_error",
        value: {
          success: false,
          error,
          wallet,
          tier,
        },
      },
    };
  }
}

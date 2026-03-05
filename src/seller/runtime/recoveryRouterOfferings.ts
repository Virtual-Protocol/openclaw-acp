import type { ValidationResult } from "./offeringTypes.js";
import type { RecoveryPack, RecoveryPackInput } from "./openrouterRecovery.js";

export type RecommendedNextTier = "none" | "turbo" | "guardrail";
export type RecoveryTier = "hotfix" | "turbo" | "guardrail";

export interface RecoveryRequirementInput {
  error_text: string;
  failed_payload?: string;
  target_system?: string;
  persona_mode?: string;
  buyer_goal?: string;
  incident_context?: string;
}

export interface ValidateRecoveryRequestOptions {
  requireIncidentContext?: boolean;
  allowPersonaMode?: boolean;
}

export interface BuildDeliverableInput {
  offering: string;
  tier: RecoveryTier;
  input: RecoveryRequirementInput;
  recovery: RecoveryPack;
  includeRecommendedNextTier?: boolean;
  forcedNextTier?: RecommendedNextTier;
}

const MAX_ERROR_TEXT = 4000;
const MAX_CONTEXT_TEXT = 8000;
const MAX_PAYLOAD_TEXT = 12000;
const MAX_TARGET_SYSTEM = 120;
const MAX_BUYER_GOAL = 600;
const VALID_PERSONA = new Set(["price", "speed", "completion"]);

function asRecord(input: unknown): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, any>;
}

function cleanText(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function clipNonEmpty<T extends Record<string, any>>(record: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

export function normalizeRecoveryRequest(request: unknown): RecoveryRequirementInput {
  const normalized = asRecord(request);
  return {
    error_text: cleanText(normalized.error_text),
    failed_payload: cleanText(normalized.failed_payload) || undefined,
    target_system: cleanText(normalized.target_system) || undefined,
    persona_mode: cleanText(normalized.persona_mode).toLowerCase() || undefined,
    buyer_goal: cleanText(normalized.buyer_goal) || undefined,
    incident_context: cleanText(normalized.incident_context) || undefined,
  };
}

export function toRecoveryPackInput(input: RecoveryRequirementInput): RecoveryPackInput {
  return {
    error_text: cleanText(input.error_text),
    failed_payload: cleanText(input.failed_payload) || undefined,
    target_system: cleanText(input.target_system) || undefined,
    persona_mode: cleanText(input.persona_mode) || undefined,
    buyer_goal: cleanText(input.buyer_goal) || undefined,
  };
}

export function validateRecoveryRequest(
  request: unknown,
  options: ValidateRecoveryRequestOptions = {}
): ValidationResult {
  const normalized = normalizeRecoveryRequest(request);

  if (!normalized.error_text) {
    return { valid: false, reason: "error_text is required" };
  }
  if (normalized.error_text.length > MAX_ERROR_TEXT) {
    return { valid: false, reason: `error_text is too long (max ${MAX_ERROR_TEXT})` };
  }
  if (normalized.failed_payload && normalized.failed_payload.length > MAX_PAYLOAD_TEXT) {
    return { valid: false, reason: `failed_payload is too long (max ${MAX_PAYLOAD_TEXT})` };
  }
  if (normalized.target_system && normalized.target_system.length > MAX_TARGET_SYSTEM) {
    return { valid: false, reason: `target_system is too long (max ${MAX_TARGET_SYSTEM})` };
  }
  if (normalized.buyer_goal && normalized.buyer_goal.length > MAX_BUYER_GOAL) {
    return { valid: false, reason: `buyer_goal is too long (max ${MAX_BUYER_GOAL})` };
  }
  if (options.requireIncidentContext) {
    if (!normalized.incident_context) {
      return { valid: false, reason: "incident_context is required" };
    }
    if (normalized.incident_context.length > MAX_CONTEXT_TEXT) {
      return { valid: false, reason: `incident_context is too long (max ${MAX_CONTEXT_TEXT})` };
    }
  } else if (normalized.incident_context && normalized.incident_context.length > MAX_CONTEXT_TEXT) {
    return { valid: false, reason: `incident_context is too long (max ${MAX_CONTEXT_TEXT})` };
  }

  const allowPersonaMode = options.allowPersonaMode !== false;
  if (!allowPersonaMode && normalized.persona_mode) {
    return { valid: false, reason: "persona_mode is not supported for this offering" };
  }
  if (normalized.persona_mode && !VALID_PERSONA.has(normalized.persona_mode)) {
    return { valid: false, reason: "persona_mode must be one of: price, speed, completion" };
  }

  return { valid: true };
}

export function recommendNextTier(recovery: RecoveryPack): RecommendedNextTier {
  const confidence = Number(recovery.confidence || 0);

  if (recovery.classification === "validation") return "guardrail";

  if (recovery.classification === "timeout") {
    return confidence >= 0.72 ? "turbo" : "guardrail";
  }

  if (recovery.classification === "rejected") {
    if (confidence >= 0.85 && recovery.lane === "budget") return "none";
    return confidence >= 0.65 ? "turbo" : "guardrail";
  }

  if (recovery.classification === "unknown") {
    return confidence >= 0.82 ? "turbo" : "guardrail";
  }

  return recovery.lane === "guardrail" ? "guardrail" : recovery.lane === "turbo" ? "turbo" : "none";
}

function buildCta(tier: RecoveryTier, recommended: RecommendedNextTier) {
  const upsellPath =
    tier === "hotfix"
      ? ["ops_recovery_turbo_v1", "ops_recovery_guardrail_v1"]
      : tier === "turbo"
        ? ["ops_recovery_guardrail_v1"]
        : [];

  return {
    entry_offer: "ops_recovery_hotfix_openrouter_v1",
    current_tier: tier,
    upsell_path: upsellPath,
    recommended_next_tier: recommended,
    message:
      "0.02 진입 -> 0.05 Turbo -> 0.12 Guardrail. timeout/validation/rejected 케이스는 상위 티어로 즉시 전환 가능합니다.",
  };
}

export function buildRecoveryDeliverable(input: BuildDeliverableInput): {
  type: "json";
  value: any;
} {
  const recommended = input.forcedNextTier ?? recommendNextTier(input.recovery);
  const value: Record<string, unknown> = {
    service: "rapid-recovery-router",
    offering: input.offering,
    input: clipNonEmpty(input.input),
    recovery: input.recovery,
    next_actions: input.recovery.next_actions,
    cta: buildCta(input.tier, recommended),
  };

  if (input.includeRecommendedNextTier) {
    value.recommended_next_tier = recommended;
  }

  return {
    type: "json",
    value,
  };
}

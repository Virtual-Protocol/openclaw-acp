import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { buildRecoveryPack } from "../../../runtime/openrouterRecovery.js";
import {
  buildRecoveryDeliverable,
  normalizeRecoveryRequest,
  toRecoveryPackInput,
  validateRecoveryRequest,
} from "../../../runtime/recoveryRouterOfferings.js";

const OFFERING_NAME = "ops_recovery_hotfix_openrouter_v1";

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const input = normalizeRecoveryRequest(request);
  const recoveryInput = toRecoveryPackInput(input);
  const recoveryPack = await buildRecoveryPack(recoveryInput);

  return {
    deliverable: buildRecoveryDeliverable({
      offering: OFFERING_NAME,
      tier: "hotfix",
      input,
      recovery: recoveryPack,
      includeRecommendedNextTier: true,
    }),
  };
}

export function validateRequirements(request: any): ValidationResult {
  return validateRecoveryRequest(request, { allowPersonaMode: true });
}

export function requestPayment(): string {
  return "Ops recovery request accepted. Generating retry-safe hotfix pack now.";
}

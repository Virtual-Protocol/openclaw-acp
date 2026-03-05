import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { buildRecoveryPack } from "../../../runtime/openrouterRecovery.js";
import {
  buildRecoveryDeliverable,
  normalizeRecoveryRequest,
  toRecoveryPackInput,
  validateRecoveryRequest,
} from "../../../runtime/recoveryRouterOfferings.js";

const OFFERING_NAME = "ops_recovery_guardrail_v1";

export async function executeJob(request: any): Promise<ExecuteJobResult> {
  const input = normalizeRecoveryRequest(request);
  const recoveryInput = toRecoveryPackInput({
    ...input,
    // Guardrail tier focuses on deterministic recovery and incident context.
    persona_mode: "completion",
  });
  const recoveryPack = await buildRecoveryPack(recoveryInput);

  const enrichedInput = {
    ...input,
    persona_mode: "completion",
  };

  return {
    deliverable: buildRecoveryDeliverable({
      offering: OFFERING_NAME,
      tier: "guardrail",
      input: enrichedInput,
      recovery: recoveryPack,
      forcedNextTier: "none",
    }),
  };
}

export function validateRequirements(request: any): ValidationResult {
  return validateRecoveryRequest(request, {
    requireIncidentContext: true,
    allowPersonaMode: false,
  });
}

export function requestPayment(): string {
  return "Guardrail recovery request accepted. Returning incident-safe remediation plan now.";
}

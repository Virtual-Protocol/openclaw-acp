import type { ExecuteJobResult, ValidationResult } from "../../../runtime/offeringTypes.js";
import { executeGuardianJob, validateGuardianRequirements } from "../guardianShared.js";

const TIER = "standard" as const;

export function validateRequirements(requirement: Record<string, unknown>): ValidationResult {
  return validateGuardianRequirements(requirement);
}

export async function executeJob(requirement: Record<string, unknown>): Promise<ExecuteJobResult> {
  return executeGuardianJob(requirement, TIER);
}

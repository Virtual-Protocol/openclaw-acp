import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["contractSource"] as const;

type Requirements = {
  contractSource?: string;
  scope?: string;
  chainTarget?: string;
};

function writeSnapshot(jobDir: string, requirements: Requirements, ctx: JobContext): void {
  writeJsonFile(jobDir, "JOB_SNAPSHOT.json", {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offeringName: ctx.offeringName,
    clientAddress: ctx.job.clientAddress,
    providerAddress: ctx.job.providerAddress,
    evaluatorAddress: ctx.job.evaluatorAddress,
    price: ctx.job.price,
    phase: ctx.job.phase,
    createdAt: ctx.job.createdAt,
    acpContext: ctx.job.context,
    memos: ctx.job.memos,
    requirements,
  });
}

function intakeMarkdown(missing: string[]): string {
  return [
    "# Intake required — Smart Contract Security Audit",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `contractSource`.",
    "Accepted formats:",
    "- GitHub repo URL (preferred)",
    "- Pasted Solidity source code (single contract or multiple)",
    "",
    "Recommended fields:",
    "- scope: which contracts/functions are in-scope",
    "- chainTarget: Base | Ethereum | Arbitrum | Optimism | Polygon",
    "- any known issues / threat model notes",
    "",
    "Example:",
    "```json",
    "{",
    "  \"contractSource\": \"https://github.com/org/repo\",",
    "  \"scope\": \"Token.sol, Vault.sol\",",
    "  \"chainTarget\": \"Base\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function reportMarkdown(requirements: Requirements, ctx: JobContext): string {
  return [
    `# REPORT — Smart Contract Security Audit`,
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirements (as received)",
    "```json",
    JSON.stringify(requirements, null, 2),
    "```",
    "",
    "## Planned audit steps (not yet executed)",
    "- Reproduce build (Foundry) and run test suite",
    "- Run static analysis (e.g., Slither) and linting",
    "- Manual review: access control, reentrancy, math/precision, oracle deps",
    "- Document findings with severity + remediation",
    "",
    "## Notes",
    "- This report is an on-disk receipt + plan. It does NOT claim a completed audit unless tool output and evidence are included.",
    "",
  ].join("\n");
}

// Optional: accept all requests; missing info is handled at delivery time.
export function validateRequirements(_requirements: any, _ctx: JobContext): ValidationResult {
  return { valid: true };
}

export function requestPayment(_requirements: any, _ctx: JobContext): string {
  return "Payment requested. If the provided requirements are incomplete, the deliverable will contain an intake request asking for the missing fields.";
}

export async function executeJob(
  requirementsRaw: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  const requirements: Requirements = (requirementsRaw ?? {}) as Requirements;

  writeSnapshot(ctx.jobDir, requirements, ctx);

  const missing = missingRequiredFields(requirements as any, [...REQUIRED_FIELDS]);
  if (missing.length > 0) {
    writeTextFile(ctx.jobDir, "INTAKE_REQUEST.md", intakeMarkdown(missing));

    return {
      deliverable: {
        type: "needs_info",
        value: buildNeedsInfoValue({
          offering: ctx.offeringName,
          jobId: ctx.jobId,
          jobDir: ctx.jobDir,
          missing,
          filesWritten: ["JOB_SNAPSHOT.json", "INTAKE_REQUEST.md"],
        }),
      },
    };
  }

  writeTextFile(ctx.jobDir, "REPORT.md", reportMarkdown(requirements, ctx));

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", "REPORT.md"],
      }),
    },
  };
}

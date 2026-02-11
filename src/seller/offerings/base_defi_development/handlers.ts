import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["projectDescription"] as const;

type Requirements = {
  projectDescription?: string;
  contractType?: string;
  additionalSpecs?: string;
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
    "# Intake required — Base DeFi Development",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `projectDescription`.",
    "",
    "Recommended fields:",
    "- contractType: ERC-20 | staking | vault | AMM | governance",
    "- additionalSpecs: integrations, constraints, audits, upgradeability",
    "",
    "Also helpful:",
    "- target chain (Base mainnet/testnet)",
    "- access control model + roles",
    "- threat model / invariants",
    "",
    "Example:",
    "```json",
    "{",
    "  \"projectDescription\": \"Build a staking vault with 7-day lockup and linear rewards.\",",
    "  \"contractType\": \"staking\",",
    "  \"additionalSpecs\": \"Must be Ownable2Step; include Foundry tests and deploy script\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function reportMarkdown(requirements: Requirements, ctx: JobContext): string {
  return [
    `# REPORT — Base DeFi Development`,
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
    "## Planned build steps (not yet executed)",
    "- Confirm spec + invariants + threat model",
    "- Draft contract architecture (Solidity + Foundry)",
    "- Implement contracts + tests + deploy scripts",
    "- Run static analysis + gas profiling",
    "- Produce a short technical doc + usage notes",
    "",
    "## Notes",
    "- This report is an on-disk receipt + plan. It does not claim implementation or audits were completed unless evidence is included.",
    "",
  ].join("\n");
}

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

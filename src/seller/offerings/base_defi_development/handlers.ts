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

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

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
    "- additionalSpecs: integrations, constraints, upgradeability, audits",
    "",
    "Also helpful:",
    "- target network (Base mainnet/testnet)",
    "- access-control model + roles",
    "- threat model / critical invariants",
    "",
    "Example:",
    "```json",
    "{",
    "  \"projectDescription\": \"Build a staking vault with 7-day lockup and linear rewards.\",",
    "  \"contractType\": \"staking\",",
    "  \"additionalSpecs\": \"Use Ownable2Step; include Foundry tests and deploy script\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function buildDefiPlan(requirements: Requirements, ctx: JobContext): Record<string, unknown> {
  const contractType = text(requirements.contractType, "custom");

  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    projectDescription: text(requirements.projectDescription, ""),
    contractType,
    additionalSpecs: text(requirements.additionalSpecs, "none provided"),
    implementationPhases: [
      "Clarify scope + protocol invariants",
      "Design contract architecture + storage layout",
      "Implement Solidity contracts",
      "Implement Foundry test suite + fuzz/property tests",
      "Prepare deploy scripts + ops handoff docs",
    ],
    defaultSecurityChecklist: [
      "Access control and role boundaries",
      "Reentrancy and external call ordering",
      "Math precision and rounding behavior",
      "Pause/recovery and upgrade strategy",
      "Invariant testing coverage",
    ],
    acceptanceCriteria: [
      "Architecture and assumptions are explicitly documented",
      "Critical invariants are listed and testable",
      "Deployment parameters and ownership model are clear",
    ],
  };
}

function securityChecklistMarkdown(requirements: Requirements): string {
  return [
    "# Security Checklist",
    "",
    `Contract type: ${text(requirements.contractType, "custom")}`,
    `Project: ${text(requirements.projectDescription, "(not provided)")}`,
    "",
    "## Must validate before deployment",
    "- Access control paths (owner/admin/operator)",
    "- External call surfaces and reentrancy guards",
    "- Token accounting and precision behavior",
    "- Edge-case behavior (zero amounts, max bounds, stale oracles)",
    "- Emergency controls and incident playbooks",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; checklistFile: string }
): string {
  return [
    "# REPORT — Base DeFi Development",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- projectDescription: ${text(requirements.projectDescription, "(missing)")}`,
    `- contractType: ${text(requirements.contractType, "custom")}`,
    `- additionalSpecs: ${text(requirements.additionalSpecs, "none provided")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.checklistFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package includes an implementation blueprint + security checklist on disk.",
    "- It does not claim contracts were implemented, tested, or deployed unless evidence files are included here.",
    "",
  ].join("\n");
}

export function validateRequirements(_requirements: any, _ctx: JobContext): ValidationResult {
  return { valid: true };
}

export function requestPayment(_requirements: any, _ctx: JobContext): string {
  return "Payment requested. If requirements are incomplete, deliverable will include an intake request with exact missing fields.";
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

  const planFile = "DEFI_BUILD_PLAN.json";
  const checklistFile = "SECURITY_CHECKLIST.md";

  writeJsonFile(ctx.jobDir, planFile, buildDefiPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, checklistFile, securityChecklistMarkdown(requirements));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, checklistFile })
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, checklistFile, "REPORT.md"],
      }),
    },
  };
}

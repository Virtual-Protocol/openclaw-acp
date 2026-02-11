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

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function scopeList(scope: string | undefined): string[] {
  const raw = text(scope, "");
  if (!raw) return ["entire provided source"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    "- scope: contracts/functions in scope (comma-separated)",
    "- chainTarget: Base | Ethereum | Arbitrum | Optimism | Polygon",
    "- known concerns: prior incidents or attack assumptions",
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

function buildAuditPlan(requirements: Requirements, ctx: JobContext): Record<string, unknown> {
  const chainTarget = text(requirements.chainTarget, "not specified");
  const scope = scopeList(requirements.scope);

  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    contractSource: text(requirements.contractSource, ""),
    chainTarget,
    scope,
    methodology: [
      "Static analysis pass (if source/build available)",
      "Manual review: auth, state transitions, reentrancy, math/precision",
      "Economic/game-theory risk pass for protocol-specific logic",
      "Severity assignment and remediation guidance",
    ],
    outputSchema: {
      finding: {
        severity: "critical|high|medium|low|info",
        title: "string",
        location: "file:line or function",
        impact: "string",
        recommendation: "string",
      },
    },
    constraints: [
      "Do not claim findings without evidence in this job folder",
      "If tooling is not run, report must state it explicitly",
    ],
  };
}

function findingsTemplateMarkdown(scope: string[]): string {
  return [
    "# Findings Template",
    "",
    "Use this template when producing the final audit output.",
    "",
    "## Scope",
    ...scope.map((item) => `- ${item}`),
    "",
    "## Findings",
    "### Critical",
    "- (none yet)",
    "",
    "### High",
    "- (none yet)",
    "",
    "### Medium",
    "- (none yet)",
    "",
    "### Low",
    "- (none yet)",
    "",
    "### Informational",
    "- (none yet)",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; findingsTemplateFile: string },
  scope: string[]
): string {
  return [
    "# REPORT — Smart Contract Security Audit",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- contractSource: ${text(requirements.contractSource, "(missing)")}`,
    `- chainTarget: ${text(requirements.chainTarget, "not specified")}`,
    `- scope: ${scope.join(", ")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.findingsTemplateFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package defines audit scope + methodology artifacts on disk.",
    "- It does not claim a completed audit or tooling execution unless evidence files are included here.",
    "",
  ].join("\n");
}

// Optional: accept all requests; missing info is handled at delivery time.
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

  const scope = scopeList(requirements.scope);
  const planFile = "AUDIT_PLAN.json";
  const findingsTemplateFile = "FINDINGS_TEMPLATE.md";

  writeJsonFile(ctx.jobDir, planFile, buildAuditPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, findingsTemplateFile, findingsTemplateMarkdown(scope));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, findingsTemplateFile }, scope)
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, findingsTemplateFile, "REPORT.md"],
      }),
    },
  };
}

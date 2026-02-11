import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["codeSource"] as const;

type Requirements = {
  codeSource?: string;
  language?: string;
  focusAreas?: string;
};

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function parseFocusAreas(raw: string | undefined): string[] {
  const normalized = text(raw, "security, correctness, maintainability");
  return normalized
    .split(",")
    .map((part) => part.trim())
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
    "# Intake required — Code Review & Optimization",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `codeSource`.",
    "Accepted formats:",
    "- GitHub repo URL (preferred)",
    "- Pasted code snippets (for small targeted review)",
    "",
    "Recommended fields:",
    "- language: TypeScript | Solidity | Python",
    "- focusAreas: security | performance | gas | architecture | testing",
    "",
    "Example:",
    "```json",
    "{",
    "  \"codeSource\": \"https://github.com/org/repo\",",
    "  \"language\": \"TypeScript\",",
    "  \"focusAreas\": \"performance, error-handling\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function buildReviewPlan(requirements: Requirements, ctx: JobContext): Record<string, unknown> {
  const focusAreas = parseFocusAreas(requirements.focusAreas);

  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    codeSource: text(requirements.codeSource, ""),
    language: text(requirements.language, "unknown"),
    focusAreas,
    workflow: [
      "Reproduce project baseline (install/build/test where possible)",
      "Run static/lint tooling for target language",
      "Manual review across requested focus areas",
      "Prioritize findings by severity and effort",
      "Provide patch recommendations and quick wins",
    ],
    findingsSchema: {
      id: "string",
      severity: "critical|high|medium|low|info",
      category: "security|performance|correctness|maintainability|testing",
      location: "file:line or symbol",
      issue: "string",
      recommendation: "string",
    },
  };
}

function findingsSchemaMarkdown(focusAreas: string[]): string {
  return [
    "# Findings Schema",
    "",
    "Use this structure when writing final findings.",
    "",
    "## Focus areas",
    ...focusAreas.map((f) => `- ${f}`),
    "",
    "## Per-finding fields",
    "- id",
    "- severity",
    "- category",
    "- location",
    "- issue",
    "- recommendation",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; schemaFile: string },
  focusAreas: string[]
): string {
  return [
    "# REPORT — Code Review & Optimization",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- codeSource: ${text(requirements.codeSource, "(missing)")}`,
    `- language: ${text(requirements.language, "unknown")}`,
    `- focusAreas: ${focusAreas.join(", ")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.schemaFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package includes a concrete review workflow + findings schema on disk.",
    "- It does not claim tooling execution or completed findings unless evidence files are included here.",
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

  const focusAreas = parseFocusAreas(requirements.focusAreas);
  const planFile = "REVIEW_PLAN.json";
  const schemaFile = "FINDINGS_SCHEMA.md";

  writeJsonFile(ctx.jobDir, planFile, buildReviewPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, schemaFile, findingsSchemaMarkdown(focusAreas));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, schemaFile }, focusAreas)
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, schemaFile, "REPORT.md"],
      }),
    },
  };
}

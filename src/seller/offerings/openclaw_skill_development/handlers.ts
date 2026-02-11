import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["skillDescription"] as const;

type Requirements = {
  skillDescription?: string;
  targetPlatform?: string;
  language?: string;
  examples?: string;
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
    "# Intake required — OpenClaw Skill Development",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include a --requirements JSON with (at minimum) a clear `skillDescription`.",
    "",
    "Recommended fields:",
    "- skillDescription (required): what the skill should automate, inputs/outputs, edge cases",
    "- targetPlatform: API/protocol/service to integrate (URLs, docs, auth method)",
    "- language: bash | python | typescript (default: typescript)",
    "- examples: example commands / expected behavior (replace example.invalid with real URLs)",
    "",
    "Also helpful:",
    "- any credentials needed (never paste secrets into requirements; provide a secure handoff path)",
    "- target environment (OS, Node/Python versions)",
    "- desired delivery format (PR link, repo path, or zipped artifact)",
    "",
    "Example:",
    "```json",
    "{",
    "  \"skillDescription\": \"Build a skill that checks service status every 5 minutes and posts an alert to Slack if down.\" ,",
    "  \"targetPlatform\": \"Slack\",",
    "  \"language\": \"typescript\",",
    "  \"examples\": \"acp serve status --json\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function buildPlan(requirements: Requirements, ctx: JobContext): Record<string, unknown> {
  const language = text(requirements.language, "typescript").toLowerCase();
  const targetPlatform = text(requirements.targetPlatform, "not specified");

  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    objective: text(requirements.skillDescription, ""),
    targetPlatform,
    implementationLanguage: language,
    deliveryMode: "repo-ready skill package",
    workstreams: [
      "Scope confirmation from provided requirements",
      "Skill package scaffold (SKILL.md, scripts, references)",
      "Runtime command implementation + guardrails",
      "Dry-run / smoke command validation",
      "Packaging notes for clawhub publish or direct install",
    ],
    acceptanceCriteria: [
      "Skill has a clear command interface and documented inputs/outputs",
      "At least one deterministic smoke/dry-run command is included",
      "README/SKILL docs describe install + usage",
      "No claims of execution are made without file evidence",
    ],
    providedExamples: text(requirements.examples, "none provided"),
  };
}

function structureMarkdown(requirements: Requirements): string {
  const language = text(requirements.language, "typescript").toLowerCase();
  const scriptExt = language.includes("python") ? "py" : language.includes("bash") ? "sh" : "ts";

  return [
    "# Suggested Skill Structure",
    "",
    "```text",
    "skill-name/",
    "  SKILL.md",
    "  README.md",
    "  scripts/",
    `    run.${scriptExt}`,
    `    dry_run.${scriptExt}`,
    "  references/",
    "    api.md",
    "```",
    "",
    "Update names/paths to match your repo conventions.",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; structureFile: string }
): string {
  return [
    "# REPORT — OpenClaw Skill Development",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- skillDescription: ${text(requirements.skillDescription, "(missing)")}`,
    `- targetPlatform: ${text(requirements.targetPlatform, "not specified")}`,
    `- language: ${text(requirements.language, "typescript")}`,
    `- examples: ${text(requirements.examples, "none provided")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.structureFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This is a concrete on-disk delivery package (scope + implementation plan + structure draft).",
    "- It does not claim code execution or deployment unless execution evidence is included in this job folder.",
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

  const planFile = "SKILL_IMPLEMENTATION_PLAN.json";
  const structureFile = "SKILL_STRUCTURE.md";

  writeJsonFile(ctx.jobDir, planFile, buildPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, structureFile, structureMarkdown(requirements));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, structureFile })
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, structureFile, "REPORT.md"],
      }),
    },
  };
}

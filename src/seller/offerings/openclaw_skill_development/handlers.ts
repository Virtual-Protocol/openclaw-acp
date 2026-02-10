import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
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
    "- language: bash | python | typescript (default: bash+python)",
    "- examples: example commands / expected behavior",
    "",
    "Also helpful:",
    "- any credentials needed (never paste secrets into requirements; provide a secure handoff path)",
    "- target environment (OS, Node/Python versions)",
    "- desired delivery format (PR link? zipped folder? repo path?)",
    "",
    "Example:",
    "```json",
    "{",
    "  \"skillDescription\": \"Build a skill that checks my service status every 5 minutes and posts an alert to Slack if down.\" ,",
    "  \"targetPlatform\": \"Slack\",",
    "  \"language\": \"typescript\",",
    "  \"examples\": \"acp seller:check --json\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function reportMarkdown(requirements: Requirements, ctx: JobContext): string {
  return [
    `# REPORT — OpenClaw Skill Development`,
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
    "## Plan (not yet executed)",
    "- Confirm scope + success criteria from `skillDescription`",
    "- Create skill folder structure (SKILL.md + scripts + references)",
    "- Implement CLI entrypoints / scripts",
    "- Add a dry-run / smoke test command",
    "- Document install + usage",
    "",
    "## Notes",
    "- This report is an on-disk receipt + plan. It does not claim completion of the build unless tool output is included.",
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
        value: {
          status: "needs_info",
          offering: ctx.offeringName,
          jobId: ctx.jobId,
          missing,
          filesWritten: ["JOB_SNAPSHOT.json", "INTAKE_REQUEST.md"],
          localPath: ctx.jobDir,
        },
      },
    };
  }

  writeTextFile(ctx.jobDir, "REPORT.md", reportMarkdown(requirements, ctx));

  return {
    deliverable: {
      type: "delivery_written",
      value: {
        status: "written",
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        filesWritten: ["JOB_SNAPSHOT.json", "REPORT.md"],
        localPath: ctx.jobDir,
      },
    },
  };
}

import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["apiDescription"] as const;

type Requirements = {
  apiDescription?: string;
  framework?: string;
  database?: string;
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
    "# Intake required — TypeScript API Development",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `apiDescription`.",
    "",
    "Recommended fields:",
    "- framework: Express | Fastify | Hono (default: Hono)",
    "- database: Postgres | SQLite | Mongo (optional)",
    "",
    "Also helpful:",
    "- auth model (API key, JWT, OAuth)",
    "- endpoints list + request/response examples",
    "- deployment target (Vercel, Docker, VPS)",
    "",
    "Example:",
    "```json",
    "{",
    "  \"apiDescription\": \"Create /users and /sessions endpoints with JWT auth.\",",
    "  \"framework\": \"Hono\",",
    "  \"database\": \"PostgreSQL\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function reportMarkdown(requirements: Requirements, ctx: JobContext): string {
  return [
    `# REPORT — TypeScript API Development`,
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
    "- Confirm endpoints + data model",
    "- Scaffold project + routing + middleware",
    "- Implement auth + validation + error handling",
    "- Add tests + OpenAPI spec",
    "- Document run/deploy instructions",
    "",
    "## Notes",
    "- This report is an on-disk receipt + plan. It does not claim implementation is complete unless code + test output is included.",
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

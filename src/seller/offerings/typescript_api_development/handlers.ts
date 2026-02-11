import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
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
    "- endpoint list + request/response examples",
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

function buildApiPlan(requirements: Requirements, ctx: JobContext): Record<string, unknown> {
  const framework = text(requirements.framework, "Hono");
  const database = text(requirements.database, "none specified");

  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    apiDescription: text(requirements.apiDescription, ""),
    framework,
    database,
    implementationPhases: [
      "Contract + endpoint design",
      "Route/middleware implementation",
      "Auth + validation + error model",
      "Persistence integration",
      "Test + docs + deploy packaging",
    ],
    baselineStack: {
      runtime: "Node.js",
      language: "TypeScript",
      framework,
      testing: "vitest/jest (project choice)",
      docs: "OpenAPI",
    },
    acceptanceCriteria: [
      "Deterministic API contract documented",
      "Validation and error-handling strategy defined",
      "Auth approach explicitly documented",
      "Deployment assumptions declared",
    ],
  };
}

function endpointDraftMarkdown(requirements: Requirements): string {
  return [
    "# Endpoint Draft",
    "",
    "Use this as a starting contract before implementation.",
    "",
    "## API summary",
    text(requirements.apiDescription, "(not provided)"),
    "",
    "## Suggested baseline endpoints",
    "- GET /health",
    "- GET /version",
    "- POST /auth/login (if auth required)",
    "",
    "## TODO: replace with exact endpoint contract",
    "- method + path",
    "- request schema",
    "- response schema",
    "- auth + rate-limit policy",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; draftFile: string }
): string {
  return [
    "# REPORT — TypeScript API Development",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- apiDescription: ${text(requirements.apiDescription, "(missing)")}`,
    `- framework: ${text(requirements.framework, "Hono")}`,
    `- database: ${text(requirements.database, "none specified")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.draftFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package provides an implementation-ready API plan + contract draft on disk.",
    "- It does not claim code was executed or deployed unless execution evidence exists in this folder.",
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

  const planFile = "API_BUILD_PLAN.json";
  const draftFile = "ENDPOINT_DRAFT.md";

  writeJsonFile(ctx.jobDir, planFile, buildApiPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, draftFile, endpointDraftMarkdown(requirements));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, draftFile })
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, draftFile, "REPORT.md"],
      }),
    },
  };
}

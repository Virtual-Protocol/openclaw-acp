// =============================================================================
// Shared delivery dispatcher utilities for seller offerings.
//
// Goals:
// - Validate intake consistently across offerings.
// - If intake is incomplete: return a "needs_info" deliverable + write an
//   INTAKE_REQUEST.md file under deliverables/acp-delivery/<jobId>/.
// - If intake is complete: write a report skeleton + pipeline files under the
//   same directory and return a structured deliverable pointing to them.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { ExecuteJobResult, JobContext } from "./offeringTypes.js";

const DEFAULT_ACP_DELIVERY_ROOT =
  "/opt/fundbot/work/workspace-connie/deliverables/acp-delivery";

export const ACP_DELIVERY_ROOT =
  process.env.ACP_DELIVERY_ROOT ?? DEFAULT_ACP_DELIVERY_ROOT;

export type IntakeValue = string | number | boolean | null | undefined;

export interface IntakeFieldSpec {
  /** Canonical id we will use in the normalized intake object. */
  id: string;
  /** Human label shown in INTAKE_REQUEST.md and deliverable payload. */
  label: string;
  /** Optional description to help the buyer provide the right value. */
  description?: string;
  /** Whether this field blocks delivery when missing. Default: true. */
  required?: boolean;
  /** Extra request keys we will also check (aliases/synonyms). */
  aliases?: string[];
  /** Optional custom resolver (wins over id/aliases). */
  resolve?: (request: Record<string, any>) => IntakeValue;
}

export interface DeliveryDispatchOptions {
  /** Offering identifier for docs/logging (usually offering.json "name"). */
  offeringId: string;

  /** deliverable.type returned when intake is complete and files are written. */
  deliverableType: string;

  /** Required intake fields for this offering. */
  requiredFields: IntakeFieldSpec[];

  /** Report skeleton file name (markdown). */
  reportFileName?: string;
  /** Pipeline / runbook file name (markdown). */
  pipelineFileName?: string;
  /** Findings output file name (json). */
  findingsFileName?: string;

  /** Builds the report skeleton markdown. */
  buildReport: (args: {
    request: Record<string, any>;
    ctx: JobContext;
    intake: Record<string, IntakeValue>;
    findings: unknown;
    deliveryDir: string;
  }) => string;

  /** Builds a pipeline / runbook markdown. */
  buildPipeline: (args: {
    request: Record<string, any>;
    ctx: JobContext;
    intake: Record<string, IntakeValue>;
    deliveryDir: string;
  }) => string;

  /** Optional: produce initial findings (must be JSON-serializable). */
  generateFindings?: (args: {
    request: Record<string, any>;
    ctx: JobContext;
    intake: Record<string, IntakeValue>;
  }) => unknown;
}

export function getJobDeliveryDir(jobId: number): string {
  const safe = Number.isFinite(jobId) ? String(jobId) : "unknown";
  return path.join(ACP_DELIVERY_ROOT, safe);
}

export function isProbablyUrl(value: string): boolean {
  const v = value.trim();
  return (
    v.startsWith("http://") ||
    v.startsWith("https://") ||
    v.startsWith("git@") ||
    v.startsWith("ssh://") ||
    v.startsWith("ipfs://")
  );
}

function normalizeIntakeValue(value: unknown): IntakeValue {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

function resolveIntakeField(
  request: Record<string, any>,
  field: IntakeFieldSpec
): IntakeValue {
  if (field.resolve) {
    return normalizeIntakeValue(field.resolve(request));
  }

  const direct = normalizeIntakeValue(request[field.id]);
  if (direct !== undefined) return direct;

  for (const alias of field.aliases ?? []) {
    const v = normalizeIntakeValue(request[alias]);
    if (v !== undefined) return v;
  }

  return undefined;
}

function buildIntakeRequestMarkdown(args: {
  ctx: JobContext;
  offeringId: string;
  deliveryDir: string;
  intake: Record<string, IntakeValue>;
  missing: IntakeFieldSpec[];
}): string {
  const { ctx, offeringId, deliveryDir, intake, missing } = args;

  const missingLines = missing
    .map((f) => `- **${f.label}** (key: \`${f.id}\`)${f.description ? ` — ${f.description}` : ""}`)
    .join("\n");

  const exampleJson: Record<string, string> = {};
  for (const f of missing) {
    exampleJson[f.id] = f.id === "deadline" ? "YYYY-MM-DD" : "<fill me>";
  }

  return `# Intake request — ${offeringId}\n\n` +
    `Job ID: **${ctx.jobId}**\n\n` +
    `I can’t start real work yet because the request is missing required intake fields.\n\n` +
    `## Missing fields\n\n${missingLines}\n\n` +
    `## How to provide the missing info\n\n` +
    `Please re-run / update the ACP job with serviceRequirements JSON including the fields above. Example:\n\n` +
    "```json\n" +
    JSON.stringify(exampleJson, null, 2) +
    "\n```\n\n" +
    `## Local delivery folder\n\n` +
    `A local folder was created for this job at:\n\n` +
    `- \`${deliveryDir}\`\n\n` +
    `This job is currently blocked on intake.\n`;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf-8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  await writeText(filePath, content + "\n");
}

export async function dispatchOfferingDelivery(
  request: Record<string, any>,
  ctx: JobContext,
  opts: DeliveryDispatchOptions
): Promise<ExecuteJobResult> {
  const deliveryDir = getJobDeliveryDir(ctx.jobId);

  await fs.promises.mkdir(deliveryDir, { recursive: true });

  // Normalize intake
  const intake: Record<string, IntakeValue> = {};
  const missing: IntakeFieldSpec[] = [];

  for (const f of opts.requiredFields) {
    const value = resolveIntakeField(request, f);
    intake[f.id] = value;
    if ((f.required ?? true) && value === undefined) missing.push(f);
  }

  // Always write a minimal job snapshot for debugging.
  await writeJson(path.join(deliveryDir, "JOB_SNAPSHOT.json"), {
    generatedAt: new Date().toISOString(),
    job: {
      jobId: ctx.jobId,
      offeringName: ctx.offeringName,
      clientAddress: ctx.clientAddress,
      providerAddress: ctx.providerAddress,
    },
    offeringId: opts.offeringId,
    intake,
    missing: missing.map((m) => m.id),
    // NOTE: request may be large (e.g., pasted code). We store it on disk but
    // do not echo it to stdout/logs.
    request,
  });

  if (missing.length > 0) {
    const intakeMd = buildIntakeRequestMarkdown({
      ctx,
      offeringId: opts.offeringId,
      deliveryDir,
      intake,
      missing,
    });

    await writeText(path.join(deliveryDir, "INTAKE_REQUEST.md"), intakeMd);

    return {
      deliverable: {
        type: "needs_info",
        value: {
          status: "needs_info",
          offeringId: opts.offeringId,
          jobId: ctx.jobId,
          deliveryDir,
          missing: missing.map((f) => ({
            id: f.id,
            label: f.label,
            description: f.description ?? null,
          })),
          message:
            "Missing required intake fields. See INTAKE_REQUEST.md in the local delivery folder.",
        },
      },
    };
  }

  // Intake complete — generate artifacts.
  const reportFileName = opts.reportFileName ?? "REPORT.md";
  const pipelineFileName = opts.pipelineFileName ?? "PIPELINE.md";
  const findingsFileName = opts.findingsFileName ?? "INITIAL_FINDINGS.json";

  const findings = opts.generateFindings
    ? opts.generateFindings({ request, ctx, intake })
    : { note: "No automated findings generator configured for this offering." };

  await writeJson(path.join(deliveryDir, findingsFileName), findings);

  const report = opts.buildReport({
    request,
    ctx,
    intake,
    findings,
    deliveryDir,
  });
  await writeText(path.join(deliveryDir, reportFileName), report);

  const pipeline = opts.buildPipeline({ request, ctx, intake, deliveryDir });
  await writeText(path.join(deliveryDir, pipelineFileName), pipeline);

  return {
    deliverable: {
      type: opts.deliverableType,
      value: {
        status: "delivered",
        note:
          "Draft/skeleton artifacts written. This is not a completed audit/implementation unless explicitly stated.",
        offeringId: opts.offeringId,
        jobId: ctx.jobId,
        deliveryDir,
        files: {
          report: reportFileName,
          pipeline: pipelineFileName,
          findings: findingsFileName,
          snapshot: "JOB_SNAPSHOT.json",
        },
      },
    },
  };
}

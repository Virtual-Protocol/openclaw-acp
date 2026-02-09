// =============================================================================
// Shared delivery dispatcher utilities for seller offerings — REAL artifacts.
//
// Goals:
// - Validate intake consistently across offerings.
// - If intake is incomplete: return a "needs_info" deliverable + write
//   INTAKE_REQUEST.md under deliverables/acp-delivery/<jobId>/.
// - If intake is complete: write REPORT.md (+ optional offering-specific
//   filenames) under the same directory and return a structured deliverable
//   pointing to what was written.
//
// Canonical artifact structure (always written):
//   deliverables/acp-delivery/<jobId>/
//   ├── manifest.json         # Delivery metadata (type, timestamp, offering)
//   ├── INTAKE_REQUEST.md     # Intake/request record (missing fields listed)
//   ├── REPORT.md             # Delivery output (report)
//   ├── FINDINGS.json         # Structured findings (JSON)
//   ├── PIPELINE.md           # Implementation/execution runbook
//   └── JOB_SNAPSHOT.json     # Debug snapshot of full request context
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import type { ExecuteJobResult, JobContext } from "./offeringTypes.js";

const DEFAULT_ACP_DELIVERY_ROOT =
  "/opt/fundbot/work/workspace-connie/deliverables/acp-delivery";

export const ACP_DELIVERY_ROOT =
  process.env.ACP_DELIVERY_ROOT ?? DEFAULT_ACP_DELIVERY_ROOT;

const CANONICAL_INTAKE_FILE = "INTAKE_REQUEST.md";
const CANONICAL_REPORT_FILE = "REPORT.md";
const CANONICAL_PIPELINE_FILE = "PIPELINE.md";
const CANONICAL_FINDINGS_FILE = "FINDINGS.json";
const CANONICAL_MANIFEST_FILE = "manifest.json";
const CANONICAL_SNAPSHOT_FILE = "JOB_SNAPSHOT.json";

export type IntakeValue = string | number | boolean | null | undefined;

export interface IntakeFieldSpec {
  /** Canonical id we will use in the normalized intake object. */
  id: string;
  /** Human label shown in intake file and deliverable payload. */
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

  /** Optional: also write the intake markdown to this filename (in addition to INTAKE_REQUEST.md). */
  intakeFileName?: string;

  /** Optional: also write the report markdown to this filename (in addition to REPORT.md). */
  reportFileName?: string;

  /** Optional: also write the pipeline markdown to this filename (in addition to PIPELINE.md). */
  pipelineFileName?: string;

  /** Optional: also write the findings JSON to this filename (in addition to FINDINGS.json). */
  findingsFileName?: string;

  /** Builds the delivery report markdown (REPORT.md content). */
  buildReport: (args: {
    request: Record<string, any>;
    ctx: JobContext;
    intake: Record<string, IntakeValue>;
    findings: unknown;
    deliveryDir: string;
  }) => string;

  /** Builds a pipeline / runbook markdown (PIPELINE.md content). */
  buildPipeline: (args: {
    request: Record<string, any>;
    ctx: JobContext;
    intake: Record<string, IntakeValue>;
    deliveryDir: string;
  }) => string;

  /** Optional: produce findings (must be JSON-serializable). */
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

function buildIntakeMarkdown(args: {
  ctx: JobContext;
  offeringId: string;
  deliveryDir: string;
  intake: Record<string, IntakeValue>;
  requiredFields: IntakeFieldSpec[];
  missing?: IntakeFieldSpec[];
}): string {
  const { ctx, offeringId, deliveryDir, intake, requiredFields, missing } = args;
  const now = new Date().toISOString();

  const intakeRows = requiredFields
    .map((f) => {
      const value = intake[f.id];
      const status =
        value !== undefined
          ? "✓ provided"
          : f.required !== false
            ? "✗ missing"
            : "○ optional";
      return `| ${f.label} | \`${f.id}\` | ${status} |`;
    })
    .join("\n");

  const missingSection =
    missing && missing.length > 0
      ? `## Missing Required Fields

The following required fields are missing and must be provided before delivery can proceed:

${missing
  .map(
    (f) =>
      `- **${f.label}** (\`${f.id}\`)${f.description ? ` — ${f.description}` : ""}`
  )
  .join("\n")}

### How to provide missing info

Update the ACP job with serviceRequirements JSON including the fields above. Example:

\`\`\`json
${JSON.stringify(
  Object.fromEntries(
    missing.map((f) => [f.id, f.id === "deadline" ? "YYYY-MM-DD" : "<value>"])
  ),
  null,
  2
)}
\`\`\`
`
      : "";

  return `# Intake Record — ${offeringId}

**Job ID:** ${ctx.jobId}  
**Generated:** ${now}  
**Status:** ${missing && missing.length > 0 ? "BLOCKED — Missing required fields" : "COMPLETE — Ready for delivery"}

## Client Information

| Field | Value |
|-------|-------|
| Client Address | ${ctx.clientAddress ?? "(not provided)"} |
| Provider Address | ${ctx.providerAddress ?? "(not provided)"} |
| Offering Name | ${ctx.offeringName} |

## Intake Fields

| Field | Key | Status |
|-------|-----|--------|
${intakeRows}

${missingSection}## Field Details

${requiredFields
  .map(
    (f) => `### ${f.label} (\`${f.id}\`)

- **Required:** ${f.required !== false ? "Yes" : "No"}
- **Description:** ${f.description ?? "(none)"}
- **Aliases checked:** ${f.aliases?.join(", ") ?? "(none)"}
- **Value received:** ${
  intake[f.id] !== undefined
    ? "`" +
      String(intake[f.id]).slice(0, 100) +
      (String(intake[f.id]).length > 100 ? "..." : "") +
      "`"
    : "(none)"
}
`
  )
  .join("\n")}

## Delivery Folder

\`${deliveryDir}\`
`;
}

function buildManifest(args: {
  ctx: JobContext;
  offeringId: string;
  deliverableType: string;
  intake: Record<string, IntakeValue>;
  missing: IntakeFieldSpec[];
  files: string[];
}): object {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0.0",
    generatedAt: now,
    job: {
      jobId: args.ctx.jobId,
      offeringName: args.ctx.offeringName,
      clientAddress: args.ctx.clientAddress ?? null,
      providerAddress: args.ctx.providerAddress ?? null,
    },
    offering: {
      id: args.offeringId,
      deliverableType: args.deliverableType,
    },
    intake: {
      status: args.missing.length > 0 ? "incomplete" : "complete",
      fields: Object.entries(args.intake).map(([key, value]) => ({
        id: key,
        value: value ?? null,
        provided: value !== undefined,
      })),
      missingFields: args.missing.map((f) => f.id),
    },
    delivery: {
      status: args.missing.length > 0 ? "blocked" : "delivered",
      artifacts: args.files,
    },
  };
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf-8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  await writeText(filePath, content + "\n");
}

async function writeTextAlso(
  deliveryDir: string,
  canonicalName: string,
  alsoName: string | undefined,
  content: string
): Promise<string[]> {
  const files: string[] = [];
  await writeText(path.join(deliveryDir, canonicalName), content);
  files.push(canonicalName);

  if (alsoName && alsoName !== canonicalName) {
    await writeText(path.join(deliveryDir, alsoName), content);
    files.push(alsoName);
  }

  return files;
}

async function writeJsonAlso(
  deliveryDir: string,
  canonicalName: string,
  alsoName: string | undefined,
  value: unknown
): Promise<string[]> {
  const files: string[] = [];
  await writeJson(path.join(deliveryDir, canonicalName), value);
  files.push(canonicalName);

  if (alsoName && alsoName !== canonicalName) {
    await writeJson(path.join(deliveryDir, alsoName), value);
    files.push(alsoName);
  }

  return files;
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

  // Always write intake request
  const intakeMd = buildIntakeMarkdown({
    ctx,
    offeringId: opts.offeringId,
    deliveryDir,
    intake,
    requiredFields: opts.requiredFields,
    missing: missing.length > 0 ? missing : undefined,
  });

  const intakeFiles = await writeTextAlso(
    deliveryDir,
    CANONICAL_INTAKE_FILE,
    opts.intakeFileName,
    intakeMd
  );

  // Always write a job snapshot for debugging
  await writeJson(path.join(deliveryDir, CANONICAL_SNAPSHOT_FILE), {
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
    request,
  });

  if (missing.length > 0) {
    const files = Array.from(
      new Set([...intakeFiles, CANONICAL_SNAPSHOT_FILE, CANONICAL_MANIFEST_FILE])
    );

    const manifest = buildManifest({
      ctx,
      offeringId: opts.offeringId,
      deliverableType: opts.deliverableType,
      intake,
      missing,
      files,
    });

    await writeJson(path.join(deliveryDir, CANONICAL_MANIFEST_FILE), manifest);

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
          message: `Missing required intake fields. See ${CANONICAL_INTAKE_FILE} in the local delivery folder.`,
          artifacts: {
            intake: CANONICAL_INTAKE_FILE,
            manifest: CANONICAL_MANIFEST_FILE,
            snapshot: CANONICAL_SNAPSHOT_FILE,
            alsoWritten: {
              intake: intakeFiles.filter((f) => f !== CANONICAL_INTAKE_FILE),
            },
          },
        },
      },
    };
  }

  // Intake complete — generate real delivery artifacts
  const findings = opts.generateFindings
    ? opts.generateFindings({ request, ctx, intake })
    : { note: "No automated findings generator configured for this offering." };

  const findingsFiles = await writeJsonAlso(
    deliveryDir,
    CANONICAL_FINDINGS_FILE,
    opts.findingsFileName,
    findings
  );

  const report = opts.buildReport({
    request,
    ctx,
    intake,
    findings,
    deliveryDir,
  });

  const reportFiles = await writeTextAlso(
    deliveryDir,
    CANONICAL_REPORT_FILE,
    opts.reportFileName,
    report
  );

  const pipeline = opts.buildPipeline({ request, ctx, intake, deliveryDir });

  const pipelineFiles = await writeTextAlso(
    deliveryDir,
    CANONICAL_PIPELINE_FILE,
    opts.pipelineFileName,
    pipeline
  );

  const files = Array.from(
    new Set([
      ...intakeFiles,
      ...reportFiles,
      ...pipelineFiles,
      ...findingsFiles,
      CANONICAL_SNAPSHOT_FILE,
      CANONICAL_MANIFEST_FILE,
    ])
  );

  const manifest = buildManifest({
    ctx,
    offeringId: opts.offeringId,
    deliverableType: opts.deliverableType,
    intake,
    missing,
    files,
  });

  await writeJson(path.join(deliveryDir, CANONICAL_MANIFEST_FILE), manifest);

  return {
    deliverable: {
      type: opts.deliverableType,
      value: {
        status: "delivered",
        offeringId: opts.offeringId,
        jobId: ctx.jobId,
        deliveryDir,
        artifacts: {
          intake: CANONICAL_INTAKE_FILE,
          report: CANONICAL_REPORT_FILE,
          findings: CANONICAL_FINDINGS_FILE,
          pipeline: CANONICAL_PIPELINE_FILE,
          manifest: CANONICAL_MANIFEST_FILE,
          snapshot: CANONICAL_SNAPSHOT_FILE,
          alsoWritten: {
            intake: intakeFiles.filter((f) => f !== CANONICAL_INTAKE_FILE),
            report: reportFiles.filter((f) => f !== CANONICAL_REPORT_FILE),
            findings: findingsFiles.filter((f) => f !== CANONICAL_FINDINGS_FILE),
            pipeline: pipelineFiles.filter((f) => f !== CANONICAL_PIPELINE_FILE),
          },
        },
      },
    },
  };
}

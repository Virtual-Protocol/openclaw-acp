// =============================================================================
// Delivery helpers — on-disk artifacts for ACP seller runtime offerings.
//
// Goal: ensure every job can produce concrete deliverables under a predictable
// folder:
//   <deliveryRoot>/<jobId>/
//
// Default delivery root:
//   - If the repo is installed under <workspace>/skills/<repo>, use:
//       <workspace>/deliverables/acp-delivery/
//     (this matches the standard OpenClaw workspace layout)
//   - Otherwise, fall back to:
//       <repo>/deliverables/acp-delivery/
//
// Override with:
//   ACP_DELIVERY_ROOT=/some/path
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { ROOT } from "../../lib/config.js";

function defaultAcpDeliveryRoot(): string {
  // Common OpenClaw layout:
  //   <workspace>/skills/openclaw-acp
  //   <workspace>/deliverables/
  const parent = path.dirname(ROOT);
  if (path.basename(parent) === "skills") {
    const workspaceRoot = path.dirname(parent);
    return path.join(workspaceRoot, "deliverables", "acp-delivery");
  }

  // Portable fallback: keep deliverables inside the repo.
  return path.join(ROOT, "deliverables", "acp-delivery");
}

export function resolveAcpDeliveryRoot(): string {
  const fromEnv = process.env.ACP_DELIVERY_ROOT?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return defaultAcpDeliveryRoot();
}

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureJobDir(jobId: number | string, deliveryRoot?: string): {
  deliveryRoot: string;
  jobDir: string;
} {
  const root = deliveryRoot ?? resolveAcpDeliveryRoot();
  ensureDir(root);

  const jobDir = path.join(root, String(jobId));
  ensureDir(jobDir);

  return { deliveryRoot: root, jobDir };
}

export function writeTextFile(
  jobDir: string,
  filename: string,
  content: string
): string {
  const filePath = path.join(jobDir, filename);
  const finalContent = content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(filePath, finalContent, "utf-8");
  return filePath;
}

export function writeJsonFile(
  jobDir: string,
  filename: string,
  obj: unknown
): string {
  return writeTextFile(jobDir, filename, JSON.stringify(obj, null, 2));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isEmptyPlainObject(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}

export function missingRequiredFields(
  requirements: Record<string, any>,
  required: string[]
): string[] {
  const missing: string[] = [];
  for (const key of required) {
    const v = (requirements as any)?.[key];
    const absent =
      v === undefined ||
      v === null ||
      (typeof v === "string" && v.trim() === "");
    if (absent) missing.push(key);
  }
  return missing;
}

export interface DeliveryFileRef {
  filename: string;
  path: string;
  uri: string;
}

function toFileRef(jobDir: string, filename: string): DeliveryFileRef {
  const filePath = path.join(jobDir, filename);
  return {
    filename,
    path: filePath,
    uri: pathToFileURL(filePath).href,
  };
}

export function buildDeliveryFileRefs(
  jobDir: string,
  filesWritten: string[]
): DeliveryFileRef[] {
  return filesWritten.map((filename) => toFileRef(jobDir, filename));
}

export function buildNeedsInfoValue(args: {
  offering: string;
  jobId: number | string;
  jobDir: string;
  missing: string[];
  filesWritten: string[];
  intakeFile?: string;
}): Record<string, unknown> {
  const refs = buildDeliveryFileRefs(args.jobDir, args.filesWritten);
  const intakeFile = args.intakeFile ?? "INTAKE_REQUEST.md";
  const intakeRef = refs.find((r) => r.filename === intakeFile) ??
    toFileRef(args.jobDir, intakeFile);

  return {
    status: "needs_info",
    offering: args.offering,
    jobId: args.jobId,
    missing: args.missing,
    filesWritten: args.filesWritten,
    localPath: args.jobDir,
    intakeFile: intakeRef.filename,
    intakePath: intakeRef.path,
    intakeUri: intakeRef.uri,
    fileRefs: refs,
  };
}

export function buildWrittenValue(args: {
  offering: string;
  jobId: number | string;
  jobDir: string;
  filesWritten: string[];
  reportFile?: string;
}): Record<string, unknown> {
  const refs = buildDeliveryFileRefs(args.jobDir, args.filesWritten);
  const reportFile = args.reportFile ?? "REPORT.md";
  const reportRef = refs.find((r) => r.filename === reportFile) ??
    toFileRef(args.jobDir, reportFile);

  return {
    status: "written",
    offering: args.offering,
    jobId: args.jobId,
    filesWritten: args.filesWritten,
    localPath: args.jobDir,
    reportFile: reportRef.filename,
    reportPath: reportRef.path,
    reportUri: reportRef.uri,
    fileRefs: refs,
  };
}

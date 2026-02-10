// =============================================================================
// Delivery helpers — on-disk artifacts for ACP seller runtime offerings.
//
// Goal: ensure every job can produce concrete deliverables under a predictable
// folder:
//   /opt/fundbot/work/workspace-connie/deliverables/acp-delivery/<jobId>/
//
// Override with:
//   ACP_DELIVERY_ROOT=/some/path
// =============================================================================

import * as fs from "fs";
import * as path from "path";

export const DEFAULT_ACP_DELIVERY_ROOT =
  "/opt/fundbot/work/workspace-connie/deliverables/acp-delivery";

export function resolveAcpDeliveryRoot(): string {
  const fromEnv = process.env.ACP_DELIVERY_ROOT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_ACP_DELIVERY_ROOT;
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

export function writeJsonFile(jobDir: string, filename: string, obj: unknown): string {
  return writeTextFile(jobDir, filename, JSON.stringify(obj, null, 2));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
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
    const absent = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (absent) missing.push(key);
  }
  return missing;
}

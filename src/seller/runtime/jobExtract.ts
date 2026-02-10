// =============================================================================
// Extractors for ACP job payloads (socket + REST list endpoints).
// Keep these tolerant to schema drift.
// =============================================================================

import { AcpJobPhase } from "./types.js";
import { normalizePhase } from "./normalize.js";

export type MemoLike = {
  id?: unknown;
  nextPhase?: unknown;
  content?: unknown;
  memoType?: unknown;
  status?: unknown;
  createdAt?: unknown;
};

export type JobLike = {
  id?: unknown;
  phase?: unknown;
  clientAddress?: unknown;
  providerAddress?: unknown;
  evaluatorAddress?: unknown;
  price?: unknown;
  name?: unknown;
  deliverable?: unknown;
  memos?: unknown;
  context?: unknown;
  memoToSign?: unknown;
};

function asMemoArray(memos: unknown): MemoLike[] {
  return Array.isArray(memos) ? (memos as MemoLike[]) : [];
}

function safeJsonParse(content: unknown): any | undefined {
  if (typeof content !== "string") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function findMemoByNextPhase(
  memos: unknown,
  phase: AcpJobPhase
): MemoLike | undefined {
  const arr = asMemoArray(memos);
  return arr.find((m) => normalizePhase(m.nextPhase) === phase);
}

export function hasMemoWithNextPhase(memos: unknown, phase: AcpJobPhase): boolean {
  return findMemoByNextPhase(memos, phase) !== undefined;
}

/**
 * Offering name can appear in different places depending on ACP backend version:
 * - job.context.jobOfferingName
 * - job.name (REST list endpoints)
 * - JSON in the negotiation memo content: { name, requirement, ... }
 */
export function resolveOfferingName(job: JobLike): string | undefined {
  const ctx: any = job.context;
  const fromCtx = typeof ctx?.jobOfferingName === "string" ? ctx.jobOfferingName : undefined;
  if (fromCtx && fromCtx.trim()) return fromCtx.trim();

  if (typeof job.name === "string" && job.name.trim()) return job.name.trim();

  const negotiation = findMemoByNextPhase(job.memos, AcpJobPhase.NEGOTIATION);
  const parsed = safeJsonParse(negotiation?.content);
  const fromMemo = typeof parsed?.name === "string" ? parsed.name : undefined;
  if (fromMemo && fromMemo.trim()) return fromMemo.trim();

  return undefined;
}

/** Extract buyer-provided service requirements from the negotiation memo. */
export function resolveServiceRequirements(job: JobLike): Record<string, any> {
  const negotiation = findMemoByNextPhase(job.memos, AcpJobPhase.NEGOTIATION);
  const parsed = safeJsonParse(negotiation?.content);
  const req = parsed?.requirement;
  return req && typeof req === "object" ? (req as Record<string, any>) : {};
}

export function getJobId(job: JobLike): number | undefined {
  const id = job.id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return Number(id);
  return undefined;
}

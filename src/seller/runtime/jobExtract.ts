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

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
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
 * - job.context.jobOfferingName / offeringName
 * - job.name (REST list endpoints)
 * - JSON in the negotiation memo content
 */
export function resolveOfferingName(job: JobLike): string | undefined {
  const ctx: any = job.context;
  const fromCtx = firstNonEmptyString([
    ctx?.jobOfferingName,
    ctx?.offeringName,
    ctx?.offering,
    ctx?.name,
  ]);
  if (fromCtx) return fromCtx;

  if (typeof job.name === "string" && job.name.trim()) return job.name.trim();

  const negotiation = findMemoByNextPhase(job.memos, AcpJobPhase.NEGOTIATION);
  const parsed = safeJsonParse(negotiation?.content);
  const fromMemo = firstNonEmptyString([
    parsed?.name,
    parsed?.offeringName,
    parsed?.offering,
  ]);

  return fromMemo;
}

/** Extract buyer-provided service requirements from context and/or negotiation memo. */
export function resolveServiceRequirements(job: JobLike): Record<string, any> {
  const ctx: any = job.context;

  const ctxReq =
    ctx?.requirement ??
    ctx?.requirements ??
    ctx?.serviceRequirements;

  if (isPlainObject(ctxReq)) {
    return ctxReq;
  }

  const negotiation = findMemoByNextPhase(job.memos, AcpJobPhase.NEGOTIATION);
  const parsed = safeJsonParse(negotiation?.content);

  const memoReq =
    parsed?.requirement ??
    parsed?.requirements ??
    parsed?.serviceRequirements;

  if (isPlainObject(memoReq)) {
    return memoReq;
  }

  // Fallback: treat non-reserved keys as inline requirements.
  if (isPlainObject(parsed)) {
    const reserved = new Set([
      "name",
      "offeringName",
      "offering",
      "requirement",
      "requirements",
      "serviceRequirements",
      "price",
      "priceValue",
      "priceType",
      "jobFee",
      "memoToSign",
    ]);

    const inline = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !reserved.has(key))
    );

    if (Object.keys(inline).length > 0) {
      return inline;
    }
  }

  return {};
}

export function getJobId(job: JobLike): number | undefined {
  const id = job.id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return Number(id);
  return undefined;
}

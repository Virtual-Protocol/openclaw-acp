// =============================================================================
// Normalization helpers for ACP job payloads.
// ACP may return phases as numbers (0..6) or strings ("NEGOTIATION").
// =============================================================================

import { AcpJobPhase } from "./types.js";

export type PhaseLike = unknown;

const PHASE_BY_NAME: Record<string, AcpJobPhase> = {
  REQUEST: AcpJobPhase.REQUEST,
  NEGOTIATION: AcpJobPhase.NEGOTIATION,
  TRANSACTION: AcpJobPhase.TRANSACTION,
  EVALUATION: AcpJobPhase.EVALUATION,
  COMPLETED: AcpJobPhase.COMPLETED,
  REJECTED: AcpJobPhase.REJECTED,
  EXPIRED: AcpJobPhase.EXPIRED,
};

export function normalizePhase(phase: PhaseLike): AcpJobPhase | undefined {
  if (typeof phase === "number" && Number.isFinite(phase)) {
    // Accept numeric enum values (0..6)
    if ((Object.values(AcpJobPhase) as unknown[]).includes(phase)) {
      return phase as AcpJobPhase;
    }
    return undefined;
  }

  if (typeof phase === "string") {
    const raw = phase.trim();
    if (!raw) return undefined;

    // Numeric strings: "0", "1", ...
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return normalizePhase(n);
    }

    const upper = raw.toUpperCase();
    return PHASE_BY_NAME[upper];
  }

  return undefined;
}

export function phaseLabel(phase: PhaseLike): string {
  const n = normalizePhase(phase);
  if (n !== undefined) {
    return AcpJobPhase[n] ?? String(n);
  }
  if (typeof phase === "string") return phase;
  return String(phase);
}

export function samePhase(phase: PhaseLike, target: AcpJobPhase): boolean {
  return normalizePhase(phase) === target;
}

export function normalizeAddress(addr: unknown): string | undefined {
  if (typeof addr !== "string") return undefined;
  const a = addr.trim();
  if (!a) return undefined;
  return a.toLowerCase();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitterMs(baseMs: number, ratio: number = 0.2): number {
  const r = Math.max(0, Math.min(1, ratio));
  const spread = Math.floor(baseMs * r);
  const delta = spread > 0 ? Math.floor(Math.random() * spread) : 0;
  return baseMs + delta;
}

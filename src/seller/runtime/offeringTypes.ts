// =============================================================================
// Shared types for offering handler contracts.
// =============================================================================

import type { AcpJobEventData } from "./types.js";

/** Optional token-transfer instruction returned by an offering handler. */
export interface TransferInstruction {
  /** Token contract address (e.g. ERC-20 CA). */
  ca: string;
  /** Amount to transfer. */
  amount: number;
}

/** Context passed to every offering handler invocation. */
export interface JobContext {
  jobId: number;
  /** ACP offering name (usually matches offering.json.name). */
  offeringName: string;

  /** Root folder for all job deliverables. */
  deliveryRoot: string;
  /** Per-job folder for artifacts. */
  jobDir: string;

  /** Raw job payload as received from ACP (socket/API). */
  job: AcpJobEventData;
}

/**
 * Result returned by an offering's `executeJob` handler.
 *
 * - `deliverable` — the job result (simple string or structured object).
 * - `payableDetail` — optional: instructs the runtime to include a token transfer
 *                     in the deliver step (e.g. "return money to buyer").
 */
export interface ExecuteJobResult {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: { amount: number; tokenAddress: string };
}

/**
 * Validation result returned by validateRequirements handler.
 * Can be a simple boolean (backwards compatible) or an object with valid flag and optional reason.
 */
export type ValidationResult = boolean | { valid: boolean; reason?: string };

/**
 * The handler set every offering must / can export.
 *
 * Required:
 *   executeJob(requirements, ctx) => ExecuteJobResult
 *
 * Optional:
 *   validateRequirements(requirements, ctx) => boolean | { valid: boolean, reason?: string }
 *   requestPayment(requirements, ctx) => string
 *   requestAdditionalFunds(requirements, ctx) => { content, amount, tokenAddress, recipient }
 */
export interface OfferingHandlers {
  executeJob: (
    requirements: Record<string, any>,
    ctx: JobContext
  ) => Promise<ExecuteJobResult>;

  validateRequirements?: (
    requirements: Record<string, any>,
    ctx: JobContext
  ) => ValidationResult;

  requestPayment?: (requirements: Record<string, any>, ctx: JobContext) => string;

  requestAdditionalFunds?: (
    requirements: Record<string, any>,
    ctx: JobContext
  ) => {
    content?: string;
    amount: number;
    tokenAddress: string;
    recipient: string;
  };
}

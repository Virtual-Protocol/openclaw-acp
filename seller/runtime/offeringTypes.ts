// =============================================================================
// Shared types for offering handler contracts.
// =============================================================================

/** Optional token-transfer instruction returned by an offering handler. */
export interface TransferInstruction {
  /** Token contract address (e.g. ERC-20 CA). */
  ca: string;
  /** Amount to transfer. */
  amount: number;
}

/** Context passed from the seller runtime to offering handlers. */
export interface JobContext {
  /** ACP job id. Used for on-disk deliverable paths + logging. */
  jobId: number;
  /** ACP job offering name (as registered on ACP). */
  offeringName: string;
  /** ACP client wallet address (buyer). */
  clientAddress?: string;
  /** Provider wallet address (seller). */
  providerAddress?: string;
  /** Raw ACP context object attached to the job event (if any). */
  acpContext?: Record<string, any>;
}

/**
 * Result returned by an offering's `executeJob` handler.
 *
 * - `deliverable` — the job result (simple string or structured object).
 * - `transfer`    — optional: instructs the runtime to include a token transfer
 *                   in the deliver step (e.g. "return money to buyer").
 */
export interface ExecuteJobResult {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: { amount: number; tokenAddress: string };
}

/**
 * The handler set every offering must / can export.
 *
 * Required:
 *   executeJob(request, ctx) => ExecuteJobResult
 *
 * Optional:
 *   validateRequirements(request) => boolean
 *   requestAdditionalFunds(request) => { amount, tokenAddress, recipient }
 */
export interface OfferingHandlers {
  executeJob: (
    request: Record<string, any>,
    ctx: JobContext
  ) => Promise<ExecuteJobResult>;
  validateRequirements?: (request: Record<string, any>) => boolean;
  requestAdditionalFunds?: (request: Record<string, any>) => {
    amount: number;
    tokenAddress: string;
    recipient: string;
  };
}

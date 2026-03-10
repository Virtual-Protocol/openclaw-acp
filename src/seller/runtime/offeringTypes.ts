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
 *   executeJob(request) => ExecuteJobResult
 *
 * Optional:
 *   validateRequirements(request) => boolean | { valid: boolean, reason?: string }
 *   requestPayment(request) => string
 *   requestAdditionalFunds(request) => { content, amount, tokenAddress, recipient }
 */
export interface OfferingHandlers {
  executeJob: (request: Record<string, any>) => Promise<ExecuteJobResult>;
  validateRequirements?: (
    request: Record<string, any>
  ) => ValidationResult | Promise<ValidationResult>;
  requestPayment?: (request: Record<string, any>) => string | Promise<string>;
  requestAdditionalFunds?: (request: Record<string, any>) =>
    | {
        content?: string;
        amount: number;
        tokenAddress: string;
        recipient: string;
      }
    | Promise<{
        content?: string;
        amount: number;
        tokenAddress: string;
        recipient: string;
      }>;
}

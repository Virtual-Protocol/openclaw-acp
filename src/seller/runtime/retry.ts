// =============================================================================
// Minimal retry helper with exponential backoff + jitter.
// =============================================================================

import { jitterMs, sleep } from "./normalize.js";

export type ParsedHttpError = {
  statusCode?: number;
  message?: string;
};

export function parseHttpError(err: unknown): ParsedHttpError {
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as any).message;
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === "object") {
          const statusCode =
            typeof (parsed as any).statusCode === "number"
              ? (parsed as any).statusCode
              : typeof (parsed as any).status === "number"
                ? (parsed as any).status
                : undefined;
          const message =
            typeof (parsed as any).message === "string"
              ? (parsed as any).message
              : typeof (parsed as any).error === "string"
                ? (parsed as any).error
                : undefined;
          return { statusCode, message };
        }
      } catch {
        // not json
      }
      return { message: msg };
    }
  }
  return {};
}

export function isRetryableError(err: unknown): boolean {
  const parsed = parseHttpError(err);
  const sc = parsed.statusCode;
  if (typeof sc === "number") {
    // Retry 429 + transient 5xx
    if (sc === 429) return true;
    if (sc >= 500 && sc <= 599) return true;
    return false;
  }

  const msg = parsed.message ?? (err instanceof Error ? err.message : "");
  const m = String(msg).toLowerCase();
  // Common network-y strings
  return (
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("socket hang up") ||
    m.includes("network")
  );
}

export type RetryOptions = {
  /** Total attempts including the first one. Default: 5 */
  attempts?: number;
  /** Base delay (ms) for exponential backoff. Default: 500 */
  baseDelayMs?: number;
  /** Max delay (ms) per retry. Default: 10_000 */
  maxDelayMs?: number;
  /** Optional hook for logging */
  onRetry?: (args: { attempt: number; delayMs: number; err: unknown }) => void;
  /** Optional override */
  shouldRetry?: (err: unknown) => boolean;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;

  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = opts.shouldRetry ? opts.shouldRetry(err) : isRetryableError(err);

      if (!retryable || attempt === attempts) {
        throw err;
      }

      const rawDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = jitterMs(rawDelay, 0.25);
      opts.onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

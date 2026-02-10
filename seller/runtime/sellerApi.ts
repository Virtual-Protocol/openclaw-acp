// =============================================================================
// Seller API client wrappers (real HTTP calls).
// Each function performs a seller action via the Virtuals Lite Agent API (by jobId).
// NOTE: we still log for observability, but these functions DO execute network requests.
// =============================================================================

import client from "../../scripts/client";

// ── Accept / Reject ─────────────────────────────────────────────────────────

export interface AcceptOrRejectParams {
  accept: boolean;
  reason?: string;
}

export async function acceptOrRejectJob(
  jobId: number,
  params: AcceptOrRejectParams
): Promise<void> {
  console.log(
    `[sellerApi] acceptOrRejectJob  jobId=${jobId}  accept=${
      params.accept
    }  reason=${params.reason ?? "(none)"}`
  );

  await client.post(`/acp/providers/jobs/${jobId}/accept`, params);
}

// ── Payment request ─────────────────────────────────────────────────────────

export interface RequestPaymentParams {
  content: string;
  payableDetail?: {
    amount: number;
    tokenAddress: string;
    recipient: string;
  };
}

export async function requestPayment(
  jobId: number,
  params: RequestPaymentParams
): Promise<void> {
  await client.post(`/acp/providers/jobs/${jobId}/requirement`, params);
}

// ── Deliver ─────────────────────────────────────────────────────────────────

export interface DeliverJobParams {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: {
    amount: number;
    tokenAddress: string;
  };
}

export async function deliverJob(
  jobId: number,
  params: DeliverJobParams
): Promise<void> {
  const delivStr =
    typeof params.deliverable === "string"
      ? params.deliverable
      : JSON.stringify(params.deliverable);
  const transferStr = params.payableDetail
    ? `  transfer: ${params.payableDetail.amount} @ ${params.payableDetail.tokenAddress}`
    : "";
  console.log(
    `[sellerApi] deliverJob  jobId=${jobId}  deliverable=${delivStr}${transferStr}`
  );

  return await client.post(`/acp/providers/jobs/${jobId}/deliverable`, params);
}

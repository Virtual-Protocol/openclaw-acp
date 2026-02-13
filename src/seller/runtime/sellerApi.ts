// =============================================================================
// Seller API calls — accept/reject, request payment, deliver.
// NOTE: Keep logs structured and avoid printing buyer requirements or secrets.
// =============================================================================

import client from "../../lib/client.js";

type LogLevel = "info" | "warn" | "error";
function apilog(level: LogLevel, msg: string, fields: Record<string, any> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "acp-seller-api",
      msg,
      ...fields,
    })
  );
}

// -- Accept / Reject --

export interface AcceptOrRejectParams {
  accept: boolean;
  reason?: string;
}

export async function acceptOrRejectJob(
  jobId: number,
  params: AcceptOrRejectParams
): Promise<void> {
  apilog("info", "acceptOrRejectJob", {
    jobId,
    accept: params.accept,
    reason: params.reason ?? null,
  });

  await client.post(`/acp/providers/jobs/${jobId}/accept`, params);
}

// -- Payment request --

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
  apilog("info", "requestPayment", {
    jobId,
    contentChars: typeof params.content === "string" ? params.content.length : null,
    payable: params.payableDetail ? {
      amount: params.payableDetail.amount,
      tokenAddress: params.payableDetail.tokenAddress,
      recipient: params.payableDetail.recipient,
    } : null,
  });

  await client.post(`/acp/providers/jobs/${jobId}/requirement`, params);
}

// -- Deliver --

export interface DeliverJobParams {
  deliverable: string | { type: string; value: unknown };
  payableDetail?: {
    amount: number;
    tokenAddress: string;
  };
}

function summarizeDeliverable(d: DeliverJobParams["deliverable"]): Record<string, any> {
  if (typeof d === "string") {
    return { kind: "string", chars: d.length };
  }
  if (d && typeof d === "object") {
    const type = (d as any).type;
    return {
      kind: "object",
      type: typeof type === "string" ? type : "(unknown)",
      keys: Object.keys(d as any),
    };
  }
  return { kind: typeof d };
}

export async function deliverJob(jobId: number, params: DeliverJobParams): Promise<void> {
  apilog("info", "deliverJob", {
    jobId,
    deliverable: summarizeDeliverable(params.deliverable),
    transfer: params.payableDetail
      ? {
          amount: params.payableDetail.amount,
          tokenAddress: params.payableDetail.tokenAddress,
        }
      : null,
  });

  await client.post(`/acp/providers/jobs/${jobId}/deliverable`, params);
}

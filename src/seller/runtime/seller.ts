#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
//
// Goals:
// - Reliable pickup of incoming jobs (socket + polling fallback)
// - Backoff/retry on transient API errors
// - Idempotency: avoid double accept / double deliver
// - Structured logs (JSON lines)
// =============================================================================

import client from "../../lib/client.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
} from "../../lib/config.js";

import { connectAcpSocket } from "./acpSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob } from "./sellerApi.js";
import { loadOffering, listOfferings } from "./offerings.js";
import { ensureJobDir } from "./delivery.js";
import { AcpJobPhase, type AcpJobEventData } from "./types.js";
import type { ExecuteJobResult, JobContext } from "./offeringTypes.js";

import {
  getJobId,
  hasMemoWithNextPhase,
  resolveOfferingName,
  resolveServiceRequirements,
  type JobLike,
} from "./jobExtract.js";
import { normalizeAddress, normalizePhase, phaseLabel, sleep } from "./normalize.js";
import { parseHttpError, withRetry } from "./retry.js";

// -- Config --

const ACP_URL = process.env.ACP_URL ?? "https://acpx.virtuals.io";

const POLL_ENABLED = (process.env.ACP_SELLER_POLL ?? "1") !== "0";
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.ACP_SELLER_POLL_INTERVAL_MS;
  const n = raw ? Number.parseInt(raw, 10) : 15_000;
  return Number.isFinite(n) && n >= 2_000 ? n : 15_000;
})();
const POLL_PAGE_SIZE = (() => {
  const raw = process.env.ACP_SELLER_POLL_PAGE_SIZE;
  const n = raw ? Number.parseInt(raw, 10) : 50;
  return Number.isFinite(n) && n > 0 && n <= 200 ? n : 50;
})();

// -- Structured logging --

type LogLevel = "info" | "warn" | "error";
function log(level: LogLevel, msg: string, fields: Record<string, any> = {}): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: "acp-seller",
    msg,
    ...fields,
  };
  // Single-line JSON for log tailing/parsing.
  console.log(JSON.stringify(line));
}

function shortAddr(addr: unknown): string | undefined {
  if (typeof addr !== "string") return undefined;
  const a = addr.trim();
  if (!a) return undefined;
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asString(value: unknown, fallback: string = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asMemoArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function buildJobContext(job: JobLike, offeringName: string): JobContext | undefined {
  const jobId = getJobId(job);
  if (!jobId) return undefined;

  const { deliveryRoot, jobDir } = ensureJobDir(jobId);
  const raw = job as any;

  const ctxJob: AcpJobEventData = {
    id: jobId,
    phase:
      typeof raw.phase === "number" || typeof raw.phase === "string"
        ? raw.phase
        : AcpJobPhase.REQUEST,
    clientAddress: asString(raw.clientAddress),
    providerAddress: asString(raw.providerAddress),
    evaluatorAddress: asString(raw.evaluatorAddress),
    price: asNumber(raw.price, 0),
    memos: asMemoArray(raw.memos),
    context: isPlainObject(raw.context) ? raw.context : {},
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    deliverable: raw.deliverable,
    memoToSign: raw.memoToSign,
  };

  return {
    jobId,
    offeringName,
    deliveryRoot,
    jobDir,
    job: ctxJob,
  };
}

// -- Runtime state (in-memory idempotency) --

const inFlightJobs = new Set<number>();
const stageDone = new Map<number, { accepted?: boolean; delivered?: boolean }>();

function markAccepted(jobId: number): void {
  stageDone.set(jobId, { ...(stageDone.get(jobId) ?? {}), accepted: true });
}
function markDelivered(jobId: number): void {
  stageDone.set(jobId, { ...(stageDone.get(jobId) ?? {}), delivered: true });
}

function setupCleanupHandlers(): void {
  const cleanup = () => {
    removePidFromConfig();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("uncaughtException", (err) => {
    log("error", "uncaughtException", { err: String(err) });
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log("error", "unhandledRejection", { err: String(reason) });
    cleanup();
    process.exit(1);
  });
}

async function acceptStage(job: JobLike, source: string): Promise<void> {
  const jobId = getJobId(job);
  if (!jobId) return;

  // If a payment request memo already exists, we already accepted + requested payment.
  if (hasMemoWithNextPhase(job.memos, AcpJobPhase.TRANSACTION)) {
    markAccepted(jobId);
    return;
  }

  if (stageDone.get(jobId)?.accepted) return;

  const offeringName = resolveOfferingName(job);
  const requirements = resolveServiceRequirements(job);

  if (!offeringName) {
    // Can't route the job; reject with a clear reason.
    await withRetry(
      () =>
        acceptOrRejectJob(jobId, {
          accept: false,
          reason: "Invalid offering name (could not resolve)",
        }),
      {
        onRetry: ({ attempt, delayMs, err }) =>
          log("warn", "retry acceptOrRejectJob", {
            jobId,
            attempt,
            delayMs,
            err: parseHttpError(err),
          }),
      }
    );
    markAccepted(jobId);
    log("warn", "rejected job: offering name unresolved", { jobId, source });
    return;
  }

  let config: Awaited<ReturnType<typeof loadOffering>>["config"];
  let handlers: Awaited<ReturnType<typeof loadOffering>>["handlers"];

  try {
    ({ config, handlers } = await loadOffering(offeringName));
  } catch (err) {
    const rejectionReason = `Offering not configured locally: ${offeringName}`;
    await withRetry(
      () =>
        acceptOrRejectJob(jobId, {
          accept: false,
          reason: rejectionReason,
        }),
      {
        onRetry: ({ attempt, delayMs, err }) =>
          log("warn", "retry acceptOrRejectJob", {
            jobId,
            attempt,
            delayMs,
            err: parseHttpError(err),
          }),
      }
    );
    markAccepted(jobId);
    log("warn", "rejected job: offering load failed", {
      jobId,
      source,
      offeringName,
      err: parseHttpError(err),
    });
    return;
  }

  const ctx = buildJobContext(job, offeringName);

  if (!ctx) {
    log("warn", "cannot build job context", { jobId, source, offeringName });
    return;
  }

  // Optional validation
  if (handlers.validateRequirements) {
    const validationResult = handlers.validateRequirements(requirements, ctx);

    let isValid: boolean;
    let reason: string | undefined;

    if (typeof validationResult === "boolean") {
      isValid = validationResult;
      reason = isValid ? undefined : "Validation failed";
    } else {
      isValid = validationResult.valid;
      reason = validationResult.reason;
    }

    if (!isValid) {
      const rejectionReason = reason || "Validation failed";
      await withRetry(
        () =>
          acceptOrRejectJob(jobId, {
            accept: false,
            reason: rejectionReason,
          }),
        {
          onRetry: ({ attempt, delayMs, err }) =>
            log("warn", "retry acceptOrRejectJob", {
              jobId,
              attempt,
              delayMs,
              err: parseHttpError(err),
            }),
        }
      );
      markAccepted(jobId);
      log("info", "rejected job: validation failed", {
        jobId,
        source,
        offeringName,
        reason: rejectionReason,
      });
      return;
    }
  }

  // Accept
  await withRetry(
    () =>
      acceptOrRejectJob(jobId, {
        accept: true,
        reason: "Job accepted",
      }),
    {
      onRetry: ({ attempt, delayMs, err }) =>
        log("warn", "retry acceptOrRejectJob", {
          jobId,
          attempt,
          delayMs,
          err: parseHttpError(err),
        }),
    }
  );

  // Request payment
  const funds =
    config.requiredFunds && handlers.requestAdditionalFunds
      ? handlers.requestAdditionalFunds(requirements, ctx)
      : undefined;

  const paymentReason = handlers.requestPayment
    ? handlers.requestPayment(requirements, ctx)
    : funds?.content ?? "Request accepted";

  await withRetry(
    () =>
      requestPayment(jobId, {
        content: paymentReason,
        payableDetail: funds
          ? {
              amount: funds.amount,
              tokenAddress: funds.tokenAddress,
              recipient: funds.recipient,
            }
          : undefined,
      }),
    {
      onRetry: ({ attempt, delayMs, err }) =>
        log("warn", "retry requestPayment", {
          jobId,
          attempt,
          delayMs,
          err: parseHttpError(err),
        }),
    }
  );

  markAccepted(jobId);
  log("info", "accepted job + requested payment", {
    jobId,
    source,
    offeringName,
    client: shortAddr((job as any).clientAddress),
  });
}

async function deliverStage(job: JobLike, source: string): Promise<void> {
  const jobId = getJobId(job);
  if (!jobId) return;

  // If deliverable exists, nothing to do.
  if ((job as any).deliverable != null) {
    markDelivered(jobId);
    return;
  }

  if (stageDone.get(jobId)?.delivered) return;

  const offeringName = resolveOfferingName(job);
  const requirements = resolveServiceRequirements(job);

  if (!offeringName) {
    log("warn", "cannot deliver: offering name unresolved", { jobId, source });
    return;
  }

  let handlers: Awaited<ReturnType<typeof loadOffering>>["handlers"];

  try {
    ({ handlers } = await loadOffering(offeringName));
  } catch (err) {
    log("warn", "cannot deliver: offering load failed", {
      jobId,
      source,
      offeringName,
      err: parseHttpError(err),
    });
    return;
  }

  const ctx = buildJobContext(job, offeringName);

  if (!ctx) {
    log("warn", "cannot build job context", { jobId, source, offeringName });
    return;
  }

  log("info", "executing offering", {
    jobId,
    source,
    offeringName,
  });

  const result: ExecuteJobResult = await handlers.executeJob(requirements, ctx);

  await withRetry(
    () =>
      deliverJob(jobId, {
        deliverable: result.deliverable,
        payableDetail: result.payableDetail,
      }),
    {
      onRetry: ({ attempt, delayMs, err }) =>
        log("warn", "retry deliverJob", {
          jobId,
          attempt,
          delayMs,
          err: parseHttpError(err),
        }),
    }
  );

  markDelivered(jobId);
  log("info", "delivered job", { jobId, source, offeringName });
}

/**
 * Unified handler for jobs coming from either the socket or polling.
 *
 * IMPORTANT: do not log raw requirements/context — they may include secrets.
 */
async function handleJob(raw: unknown, source: string, myWalletLc: string): Promise<void> {
  const job = (raw ?? {}) as JobLike;
  const jobId = getJobId(job);
  if (!jobId) return;

  const providerLc = normalizeAddress((job as any).providerAddress);
  if (providerLc && providerLc !== myWalletLc) {
    // Ignore jobs not addressed to us (can happen if socket broadcasts more broadly).
    return;
  }

  const phase = normalizePhase((job as any).phase);
  if (phase === undefined) {
    log("warn", "job payload has unknown phase; skipping", {
      jobId,
      source,
      phase: (job as any).phase,
    });
    return;
  }

  if (inFlightJobs.has(jobId)) return;
  inFlightJobs.add(jobId);

  try {
    log("info", "job event", {
      jobId,
      source,
      phase: phaseLabel((job as any).phase),
      client: shortAddr((job as any).clientAddress),
    });

    // Accept/reject/payment-request stage.
    if (phase === AcpJobPhase.REQUEST || phase === AcpJobPhase.NEGOTIATION) {
      await acceptStage(job, source);
      return;
    }

    // Execution/delivery stage.
    // ACP appears to surface "ready to execute" as TRANSACTION or EVALUATION depending on backend version.
    if (phase === AcpJobPhase.TRANSACTION || phase === AcpJobPhase.EVALUATION) {
      await deliverStage(job, source);
      return;
    }

    // Other phases are terminal or not actionable.
  } finally {
    inFlightJobs.delete(jobId);
  }
}

async function pollActiveJobs(myWalletLc: string): Promise<void> {
  const res = await client.get<any>("/acp/jobs/active", {
    params: { page: 1, pageSize: POLL_PAGE_SIZE },
  });

  const payload = res.data;
  const jobs: any[] = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];

  // Only jobs where we are the provider.
  const mine = jobs.filter(
    (j) => normalizeAddress(j?.providerAddress) === myWalletLc
  );

  if (mine.length > 0) {
    log("info", "poll found provider jobs", { count: mine.length });
  }

  for (const j of mine) {
    await handleJob(j, "poll", myWalletLc);
  }
}

async function startPollLoop(myWalletLc: string): Promise<void> {
  if (!POLL_ENABLED) {
    log("info", "poll loop disabled (ACP_SELLER_POLL=0)");
    return;
  }

  let delayMs = POLL_INTERVAL_MS;

  // Startup catch-up
  try {
    await pollActiveJobs(myWalletLc);
  } catch (err) {
    log("warn", "initial poll failed", { err: parseHttpError(err) });
  }

  // Continuous loop
  for (;;) {
    await sleep(delayMs);

    try {
      await pollActiveJobs(myWalletLc);
      delayMs = POLL_INTERVAL_MS;
    } catch (err) {
      // Exponential-ish backoff on poll failures.
      delayMs = Math.min(120_000, Math.floor(delayMs * 1.8));
      log("warn", "poll failed; backing off", {
        nextDelayMs: delayMs,
        err: parseHttpError(err),
      });
    }
  }
}

// -- Main --

async function main(): Promise<void> {
  checkForExistingProcess();
  writePidToConfig(process.pid);
  setupCleanupHandlers();

  const agentData = await getMyAgentInfo();
  const walletAddress = agentData.walletAddress;
  const myWalletLc = walletAddress.toLowerCase();

  const offerings = listOfferings();
  log("info", "seller runtime starting", {
    wallet: shortAddr(walletAddress),
    offerings,
    acpUrl: ACP_URL,
    pollEnabled: POLL_ENABLED,
    pollIntervalMs: POLL_INTERVAL_MS,
  });

  // Socket listener (primary)
  connectAcpSocket({
    acpUrl: ACP_URL,
    walletAddress,
    callbacks: {
      onNewTask: (data: any) => {
        handleJob(data, "socket:onNewTask", myWalletLc).catch((err) =>
          log("error", "handleJob failed", {
            source: "socket:onNewTask",
            err: parseHttpError(err),
          })
        );
      },
      onEvaluate: (data: any) => {
        // Some ACP backends appear to emit execution-ready events on evaluate.
        handleJob(data, "socket:onEvaluate", myWalletLc).catch((err) =>
          log("error", "handleJob failed", {
            source: "socket:onEvaluate",
            err: parseHttpError(err),
          })
        );
      },
    },
  });

  // Poll loop (fallback)
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  startPollLoop(myWalletLc);

  log("info", "seller runtime running", {});
}

main().catch((err) => {
  log("error", "fatal", { err: parseHttpError(err) });
  removePidFromConfig();
  process.exit(1);
});

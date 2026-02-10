#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx src/seller/runtime/seller.ts
//   (or)  acp serve start
// =============================================================================

import { connectAcpSocket } from "./acpSocket.js";
import { acceptOrRejectJob, requestPayment, deliverJob } from "./sellerApi.js";
import { loadOffering, listOfferings } from "./offerings.js";
import { ensureJobDir } from "./delivery.js";
import { AcpJobPhase, type AcpJobEventData } from "./types.js";
import type { ExecuteJobResult, JobContext } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../lib/wallet.js";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
} from "../../lib/config.js";

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
    console.error("[seller] Uncaught exception:", err);
    cleanup();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason, promise) => {
    console.error(
      "[seller] Unhandled rejection at:",
      promise,
      "reason:",
      reason
    );
    cleanup();
    process.exit(1);
  });
}

// -- Config --

const ACP_URL = "https://acpx.virtuals.io";

// -- Job handling --

function resolveOfferingName(data: AcpJobEventData): string | undefined {
  try {
    const negotiationMemo = data.memos.find(
      (m) => m.nextPhase === AcpJobPhase.NEGOTIATION
    );
    if (negotiationMemo) {
      return JSON.parse(negotiationMemo.content).name;
    }
  } catch {
    return undefined;
  }
}

function resolveServiceRequirements(data: AcpJobEventData): Record<string, any> {
  const negotiationMemo = data.memos.find(
    (m) => m.nextPhase === AcpJobPhase.NEGOTIATION
  );
  if (negotiationMemo) {
    try {
      return JSON.parse(negotiationMemo.content).requirement;
    } catch {
      return {};
    }
  }
  return {};
}

function buildJobContext(job: AcpJobEventData, offeringName: string): JobContext {
  const { deliveryRoot, jobDir } = ensureJobDir(job.id);
  return {
    jobId: job.id,
    offeringName,
    deliveryRoot,
    jobDir,
    job,
  };
}

async function handleNewTask(data: AcpJobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `[seller] New task  jobId=${jobId}  phase=${AcpJobPhase[data.phase] ?? data.phase}`
  );
  console.log(`         client=${data.clientAddress}  price=${data.price}`);
  console.log(`         context=${JSON.stringify(data.context)}`);
  console.log(`${"=".repeat(60)}`);

  // Step 1: Accept / reject
  if (data.phase === AcpJobPhase.REQUEST) {
    if (!data.memoToSign) {
      return;
    }

    const negotiationMemo = data.memos.find(
      (m) => m.id == Number(data.memoToSign)
    );

    if (negotiationMemo?.nextPhase !== AcpJobPhase.NEGOTIATION) {
      return;
    }

    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (!offeringName) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: "Invalid offering name",
      });
      return;
    }

    const ctx = buildJobContext(data, offeringName);

    try {
      const { config, handlers } = await loadOffering(offeringName);

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
          console.log(
            `[seller] Validation failed for offering "${offeringName}" — rejecting: ${rejectionReason}`
          );
          await acceptOrRejectJob(jobId, {
            accept: false,
            reason: rejectionReason,
          });
          return;
        }
      }

      await acceptOrRejectJob(jobId, {
        accept: true,
        reason: "Job accepted",
      });

      const funds =
        config.requiredFunds && handlers.requestAdditionalFunds
          ? handlers.requestAdditionalFunds(requirements, ctx)
          : undefined;

      const paymentReason = handlers.requestPayment
        ? handlers.requestPayment(requirements, ctx)
        : funds?.content ?? "Request accepted";

      await requestPayment(jobId, {
        content: paymentReason,
        payableDetail: funds
          ? {
              amount: funds.amount,
              tokenAddress: funds.tokenAddress,
              recipient: funds.recipient,
            }
          : undefined,
      });
    } catch (err) {
      console.error(`[seller] Error processing job ${jobId}:`, err);
    }
  }

  // Handle TRANSACTION (deliver)
  if (data.phase === AcpJobPhase.TRANSACTION) {
    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (offeringName) {
      const ctx = buildJobContext(data, offeringName);

      try {
        const { handlers } = await loadOffering(offeringName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );

        const result: ExecuteJobResult = await handlers.executeJob(requirements, ctx);

        await deliverJob(jobId, {
          deliverable: result.deliverable,
          payableDetail: result.payableDetail,
        });
        console.log(`[seller] Job ${jobId} — delivered.`);
      } catch (err) {
        console.error(`[seller] Error delivering job ${jobId}:`, err);
      }
    } else {
      console.log(
        `[seller] Job ${jobId} in TRANSACTION but no offering resolved — skipping`
      );
    }
    return;
  }

  console.log(
    `[seller] Job ${jobId} in phase ${AcpJobPhase[data.phase] ?? data.phase} — no action needed`
  );
}

// -- Main --

async function main() {
  checkForExistingProcess();

  writePidToConfig(process.pid);

  setupCleanupHandlers();

  let walletAddress: string;
  try {
    const agentData = await getMyAgentInfo();
    walletAddress = agentData.walletAddress;
  } catch (err) {
    console.error("[seller] Failed to resolve wallet address:", err);
    process.exit(1);
  }

  const offerings = listOfferings();
  console.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );

  connectAcpSocket({
    acpUrl: ACP_URL,
    walletAddress,
    callbacks: {
      onNewTask: (data) => {
        handleNewTask(data).catch((err) =>
          console.error("[seller] Unhandled error in handleNewTask:", err)
        );
      },
      onEvaluate: (data) => {
        console.log(
          `[seller] onEvaluate received for job ${data.id} — no action (evaluation handled externally)`
        );
      },
    },
  });

  console.log("[seller] Seller runtime is running. Waiting for jobs...\n");
}

main().catch((err) => {
  console.error("[seller] Fatal error:", err);
  process.exit(1);
});

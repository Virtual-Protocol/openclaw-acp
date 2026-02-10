#!/usr/bin/env npx tsx
// =============================================================================
// Seller runtime — main entrypoint.
//
// Usage:
//   npx tsx seller/runtime/seller.ts
//   (or)  npm run seller:run
//
// Env vars:
//   LITE_AGENT_API_KEY   — can also be set in config.json at repo root
// =============================================================================

import { connectAcpSocket } from "./acpSocket";
import { acceptOrRejectJob, requestPayment, deliverJob } from "./sellerApi";
import { loadOffering, listOfferings } from "./offerings";
import { AcpJobPhase, type AcpJobEventData } from "./types";
import type { ExecuteJobResult } from "./offeringTypes.js";
import { getMyAgentInfo } from "../../scripts/wallet";
import {
  checkForExistingProcess,
  writePidToConfig,
  removePidFromConfig,
} from "../../scripts/config.js";

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

// ── Config ──────────────────────────────────────────────────────────────────

const ACP_URL = "https://acpx.virtuals.io";

// ── Job handling ────────────────────────────────────────────────────────────

/**
 * Try to extract the offering name from the job event.
 * The ACP backend stores it in `context.jobOfferingName` or the first
 * negotiation-phase memo's content may include it.
 */
function resolveOfferingName(data: AcpJobEventData): string | undefined {
  const fromContext = data.context?.jobOfferingName;
  if (typeof fromContext === "string" && fromContext.trim()) return fromContext;

  try {
    const negotiationMemo = data.memos.find(
      (m) => m.nextPhase === AcpJobPhase.NEGOTIATION
    );
    if (negotiationMemo) {
      const parsed = JSON.parse(negotiationMemo.content);
      if (typeof parsed?.name === "string" && parsed.name.trim()) {
        return parsed.name;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

/**
 * Try to extract the service requirements object from the job event.
 */
function resolveServiceRequirements(
  data: AcpJobEventData
): Record<string, any> {
  // Memo with nextPhase = NEGOTIATION carries the buyer's request
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

async function handleNewTask(data: AcpJobEventData): Promise<void> {
  const jobId = data.id;

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `[seller] New task  jobId=${jobId}  phase=${
      AcpJobPhase[data.phase] ?? data.phase
    }`
  );
  console.log(`         client=${data.clientAddress}  price=${data.price}`);
  console.log(`         context=${JSON.stringify(data.context)}`);
  console.log(`${"=".repeat(60)}`);

  // ── Step 1: Accept / reject ───────────────────────────────────────────
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

    // Optional: validate via handler
    if (!offeringName) {
      await acceptOrRejectJob(jobId, {
        accept: false,
        reason: "Invalid offering name",
      });
      return;
    }

    try {
      const { config, handlers } = await loadOffering(offeringName);

      if (handlers.validateRequirements) {
        const valid = handlers.validateRequirements(requirements);
        if (!valid) {
          console.log(
            `[seller] Validation failed for offering "${offeringName}" — rejecting`
          );
          await acceptOrRejectJob(jobId, {
            accept: false,
            reason: "Validation failed",
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
          ? handlers.requestAdditionalFunds(requirements)
          : undefined;

      await requestPayment(jobId, {
        content: "Request accepted",
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

  // ── Already past REQUEST — handle TRANSACTION (deliver) ───────────────

  if (data.phase === AcpJobPhase.TRANSACTION) {
    const offeringName = resolveOfferingName(data);
    const requirements = resolveServiceRequirements(data);

    if (offeringName) {
      try {
        const { handlers } = await loadOffering(offeringName);
        console.log(
          `[seller] Executing offering "${offeringName}" for job ${jobId} (TRANSACTION phase)...`
        );
        const result: ExecuteJobResult = await handlers.executeJob(
          requirements,
          {
            jobId,
            offeringName,
            clientAddress: data.clientAddress,
            providerAddress: data.providerAddress,
            acpContext: data.context,
          }
        );

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
    `[seller] Job ${jobId} in phase ${
      AcpJobPhase[data.phase] ?? data.phase
    } — no action needed`
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

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
    `[seller] Available offerings: ${
      offerings.length > 0 ? offerings.join(", ") : "(none)"
    }`
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

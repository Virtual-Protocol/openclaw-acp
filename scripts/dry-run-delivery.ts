#!/usr/bin/env npx tsx

import * as fs from "fs";
import { loadOffering } from "../seller/runtime/offerings.js";
import { getJobDeliveryDir } from "../seller/runtime/deliveryDispatcher.js";

type Mode = "complete" | "needs-info";

function parseMode(args: string[]): Mode {
  return args.includes("--needs-info") ? "needs-info" : "complete";
}

function sampleRequirements(offeringId: string, mode: Mode): Record<string, any> {
  switch (offeringId) {
    case "smart_contract_security_audit":
      return mode === "needs-info"
        ? {
            contractSource: "pragma solidity ^0.8.20; contract C { }",
            chainTarget: "Base",
            // missing scope + deadline
          }
        : {
            contractSource: "pragma solidity ^0.8.20; contract C { }",
            scope: "All contracts",
            chainTarget: "Base",
            deadline: "2026-02-10",
          };

    case "openclaw_skill_development":
      return mode === "needs-info"
        ? {
            skillDescription: "Create a skill that fetches ETH price and posts a report.",
            targetPlatform: "custom API",
            // missing deadline
          }
        : {
            skillDescription:
              "Create a skill that fetches ETH price from a public API and prints a short report. Include a dry-run option.",
            targetPlatform: "custom API",
            language: "typescript",
            deadline: "2026-02-12",
            examples: "price_report --symbol ETH --fiat USD",
          };

    case "code_review_and_optimization":
      return mode === "needs-info"
        ? {
            codeSource: "function x(a:any){return eval(a)}",
            // missing focusAreas + deadline
          }
        : {
            codeSource: "function x(a:any){return eval(a)}",
            language: "TypeScript",
            focusAreas: "security + code quality",
            deadline: "2026-02-11",
          };

    case "typescript_api_development":
      return {
        apiDescription: "Build a /health endpoint and a /users CRUD API.",
        framework: "Hono",
        database: "PostgreSQL",
        ...(mode === "complete" ? { deadline: "2026-02-15" } : {}),
      };

    case "base_defi_development":
      return {
        projectDescription: "Implement a simple staking contract with rewards.",
        contractType: "staking",
        ...(mode === "complete" ? { deadline: "2026-02-20" } : {}),
      };

    case "ai_agent_liveness_integration":
      return {
        agentFramework: "OpenClaw",
        agentEndpoint: "http://localhost:3000/health",
        ...(mode === "complete" ? { deadline: "2026-02-14" } : {}),
      };

    default:
      throw new Error(`No sample request available for offering: ${offeringId}`);
  }
}

async function runOne(offeringId: string, jobId: number, mode: Mode) {
  const { handlers } = await loadOffering(offeringId);

  const requirements = sampleRequirements(offeringId, mode);

  const result = await handlers.executeJob(requirements, {
    jobId,
    offeringName: offeringId,
    clientAddress: "0x0000000000000000000000000000000000000000",
    providerAddress: "0x0000000000000000000000000000000000000000",
    acpContext: {},
  });

  const deliveryDir = getJobDeliveryDir(jobId);

  const files = fs.existsSync(deliveryDir)
    ? fs.readdirSync(deliveryDir)
    : [];

  // Keep output small and human-readable.
  console.log(
    JSON.stringify(
      {
        offeringId,
        mode,
        jobId,
        deliveryDir,
        deliverable: result.deliverable,
        files,
      },
      null,
      2
    )
  );
}

async function main() {
  const args = process.argv.slice(2);
  const mode = parseMode(args);

  const offeringId = args.find((a) => !a.startsWith("--"));

  if (offeringId) {
    const jobId = Number(args.find((a) => /^\d+$/.test(a)) ?? "999001");
    await runOne(offeringId, jobId, mode);
    return;
  }

  // No offering provided: run all known offerings.
  const all = [
    "smart_contract_security_audit",
    "openclaw_skill_development",
    "code_review_and_optimization",
    "typescript_api_development",
    "base_defi_development",
    "ai_agent_liveness_integration",
  ];

  for (let i = 0; i < all.length; i++) {
    await runOne(all[i]!, 999001 + i, mode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

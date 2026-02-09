#!/usr/bin/env npx tsx
// =============================================================================
// Dry-run simulator for seller offering delivery.
//
// Purpose:
// - Simulate an ACP job locally (NO network calls)
// - Prove offering handlers write on-disk deliverables under:
//     /opt/fundbot/work/workspace-connie/deliverables/acp-delivery/<jobId>/
//
// Usage:
//   npm run seller:dry-run
//   npm run seller:dry-run -- --list
//   npm run seller:dry-run -- --offering typescript_api_development
//   npm run seller:dry-run -- --offering smart_contract_security_audit --requirements '{"contractSource":"pragma solidity ^0.8.20; contract X{}"}'
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { loadOffering, listOfferings } from "../runtime/offerings.js";
import { ACP_DELIVERY_ROOT } from "../runtime/deliveryDispatcher.js";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function computeDryRunJobId(): number {
  // Keep it in a "unlikely to collide" range.
  return 900_000_000 + Math.floor(Math.random() * 50_000_000);
}

function defaultRequirementsFor(offering: string): Record<string, any> {
  if (offering === "typescript_api_development") {
    return {
      apiDescription:
        "Build a small API with GET /health returning { ok: true }. Include basic request validation + error model.",
      framework: "Hono",
      database: "PostgreSQL",
    };
  }

  if (offering === "smart_contract_security_audit") {
    return {
      contractSource:
        "pragma solidity ^0.8.20;\n\ncontract Example {\n  mapping(address => uint256) public balances;\n  function deposit() external payable { balances[msg.sender] += msg.value; }\n  function withdraw(uint256 amt) external {\n    require(balances[msg.sender] >= amt, 'low');\n    (bool ok,) = msg.sender.call{value: amt}(\"\");\n    require(ok, 'fail');\n    balances[msg.sender] -= amt;\n  }\n}\n",
      scope: "Example.sol",
      chainTarget: "Base mainnet",
    };
  }

  // Fallback: empty (will produce needs_info)
  return {};
}

async function main(): Promise<void> {
  if (hasFlag("--list")) {
    console.log(listOfferings().join("\n"));
    return;
  }

  const offeringName = getArg("--offering") ?? "typescript_api_development";
  const jobId = Number(getArg("--jobId") ?? computeDryRunJobId());

  const reqInline = getArg("--requirements");
  const reqFile = getArg("--requirementsFile");

  let requirements: Record<string, any>;
  if (reqInline) {
    requirements = JSON.parse(reqInline);
  } else if (reqFile) {
    requirements = JSON.parse(fs.readFileSync(reqFile, "utf-8"));
  } else {
    requirements = defaultRequirementsFor(offeringName);
  }

  const { handlers } = await loadOffering(offeringName);

  const result = await handlers.executeJob(requirements, {
    jobId,
    offeringName,
    clientAddress: "0x0000000000000000000000000000000000000001",
    providerAddress: "0x0000000000000000000000000000000000000002",
    acpContext: { dryRun: true },
  });

  const deliveryDir = path.join(ACP_DELIVERY_ROOT, String(jobId));

  const exists = fs.existsSync(deliveryDir);
  const files = exists ? fs.readdirSync(deliveryDir).sort() : [];

  console.log(JSON.stringify({ offeringName, jobId, deliveryDir, exists, files, deliverable: result.deliverable }, null, 2));

  // Hard assertions: if we delivered, the canonical artifacts must exist.
  if (typeof result.deliverable === "object" && result.deliverable && "type" in result.deliverable) {
    const type = (result.deliverable as any).type;
    if (type !== "needs_info") {
      const required = [
        "INTAKE_REQUEST.md",
        "REPORT.md",
        "PIPELINE.md",
        "FINDINGS.json",
        "JOB_SNAPSHOT.json",
        "manifest.json",
      ];
      const missing = required.filter((f) => !files.includes(f));
      if (missing.length > 0) {
        throw new Error(`Dry-run failed: missing artifacts in ${deliveryDir}: ${missing.join(", ")}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("[seller:dry-run] ERROR:", err);
  process.exit(1);
});

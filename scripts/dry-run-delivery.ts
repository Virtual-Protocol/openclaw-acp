// =============================================================================
// Dry-run simulator for ACP seller offering delivery.
//
// Proves that offering handlers:
//   - accept (requirements, ctx)
//   - write on-disk deliverables under ACP_DELIVERY_ROOT/<jobId>/
// =============================================================================

import * as fs from "fs";
import * as path from "path";

import { loadOffering, listOfferings } from "../src/seller/runtime/offerings.js";
import { ensureJobDir } from "../src/seller/runtime/delivery.js";
import { AcpJobPhase, type AcpJobEventData } from "../src/seller/runtime/types.js";
import type { JobContext } from "../src/seller/runtime/offeringTypes.js";

function usage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/dry-run-delivery.ts [offeringName] [jobId] [--needs-info]",
      "",
      "Examples:",
      "  npx tsx scripts/dry-run-delivery.ts  # runs all offerings",
      "  npx tsx scripts/dry-run-delivery.ts smart_contract_security_audit 123456",
      "  npx tsx scripts/dry-run-delivery.ts smart_contract_security_audit 123457 --needs-info",
    ].join("\n")
  );
}

function sampleRequirements(offeringName: string): Record<string, any> {
  switch (offeringName) {
    case "openclaw_skill_development":
      return {
        skillDescription:
          "Build an OpenClaw skill that checks a URL health endpoint every 5 minutes and posts an alert to a webhook if down.",
        targetPlatform: "HTTP + Webhook",
        language: "typescript",
        examples: "acp serve status --json",
      };

    case "smart_contract_security_audit":
      return {
        contractSource: "https://github.com/example/repo",
        scope: "Token.sol, Vault.sol",
        chainTarget: "Base",
      };

    case "ai_agent_liveness_integration":
      return {
        agentFramework: "OpenClaw (version unknown)",
        agentEndpoint: "https://example.com/health",
        monitoringRequirements: "Alert after 2 consecutive failures; 5m interval",
      };

    case "typescript_api_development":
      return {
        apiDescription:
          "Create /users (CRUD) and /sessions (login) endpoints with JWT auth and OpenAPI docs.",
        framework: "Hono",
        database: "PostgreSQL",
      };

    case "base_defi_development":
      return {
        projectDescription:
          "Implement a staking contract with a 7-day lockup and linear reward distribution.",
        contractType: "staking",
        additionalSpecs: "Use Ownable2Step; include Foundry tests + deploy script",
      };

    case "code_review_and_optimization":
      return {
        codeSource: "https://github.com/example/repo",
        language: "TypeScript",
        focusAreas: "security, error-handling, performance",
      };

    default:
      return { input: "example" };
  }
}

function existsAll(jobDir: string, files: string[]): boolean {
  return files.every((f) => fs.existsSync(path.join(jobDir, f)));
}

async function runOne(
  offeringName: string,
  jobId: number,
  needsInfo: boolean
): Promise<void> {
  const requirements = needsInfo ? {} : sampleRequirements(offeringName);

  const { config, handlers } = await loadOffering(offeringName);

  const { deliveryRoot, jobDir } = ensureJobDir(jobId);

  const job: AcpJobEventData = {
    id: jobId,
    phase: AcpJobPhase.TRANSACTION,
    clientAddress: "0x0000000000000000000000000000000000000000",
    providerAddress: "0x0000000000000000000000000000000000000000",
    evaluatorAddress: "0x0000000000000000000000000000000000000000",
    price: typeof config.jobFee === "number" ? config.jobFee : 0,
    memos: [],
    context: { dryRun: true },
    createdAt: new Date().toISOString(),
  };

  const ctx: JobContext = {
    jobId,
    offeringName: config.name,
    deliveryRoot,
    jobDir,
    job,
  };

  const result = await handlers.executeJob(requirements, ctx);

  // Proof: JOB_SNAPSHOT.json must exist + either INTAKE_REQUEST.md or REPORT.md.
  const ok =
    existsAll(jobDir, ["JOB_SNAPSHOT.json"]) &&
    (existsAll(jobDir, ["INTAKE_REQUEST.md"]) || existsAll(jobDir, ["REPORT.md"]));

  if (!ok) {
    throw new Error(
      `Dry-run failed for offering=${offeringName} jobId=${jobId}. Expected JOB_SNAPSHOT.json + (INTAKE_REQUEST.md or REPORT.md) in ${jobDir}. Got deliverable=${JSON.stringify(result.deliverable)}`
    );
  }

  const status =
    typeof result.deliverable === "object" &&
    result.deliverable !== null &&
    (result.deliverable as any).type === "needs_info"
      ? "needs_info"
      : "written";

  console.log(
    `[dry-run] offering=${offeringName} jobId=${jobId} status=${status} dir=${jobDir}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const needsInfo = args.includes("--needs-info");
  const positional = args.filter((a) => !a.startsWith("--"));

  const offeringArg = positional[0];
  const jobIdArg = positional[1];

  const offerings = offeringArg ? [offeringArg] : listOfferings();
  if (offerings.length === 0) {
    console.error("No offerings found under src/seller/offerings.");
    process.exit(1);
  }

  const baseJobId = jobIdArg ? Number(jobIdArg) : 999000000;
  if (!Number.isFinite(baseJobId)) {
    console.error(`Invalid jobId: ${jobIdArg}`);
    process.exit(1);
  }

  for (let i = 0; i < offerings.length; i++) {
    await runOne(offerings[i], baseJobId + i, needsInfo);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

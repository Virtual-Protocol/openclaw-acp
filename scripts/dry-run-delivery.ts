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
import {
  ensureJobDir,
  resolveAcpDeliveryRoot,
} from "../src/seller/runtime/delivery.js";
import { AcpJobPhase, type AcpJobEventData } from "../src/seller/runtime/types.js";
import type { JobContext } from "../src/seller/runtime/offeringTypes.js";

function usage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx scripts/dry-run-delivery.ts [offeringName] [jobId] [--needs-info] [--both]",
      "",
      "Modes:",
      "  default       -> requirements provided, expects REPORT.md",
      "  --needs-info  -> empty requirements, expects INTAKE_REQUEST.md",
      "  --both        -> runs both modes for each offering",
      "",
      "Examples:",
      "  npx tsx scripts/dry-run-delivery.ts",
      "  npx tsx scripts/dry-run-delivery.ts --both",
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

function cleanJobDir(jobDir: string): void {
  if (fs.existsSync(jobDir)) {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
  fs.mkdirSync(jobDir, { recursive: true });
}

function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function asStructuredDeliverable(
  deliverable: unknown
): { type: string; value: any } | null {
  if (!deliverable || typeof deliverable !== "object") {
    return null;
  }

  const maybe = deliverable as any;
  if (typeof maybe.type !== "string") {
    return null;
  }

  return {
    type: maybe.type,
    value: maybe.value,
  };
}

function assertDeliverablePointers(args: {
  offeringName: string;
  jobId: number;
  jobDir: string;
  needsInfo: boolean;
  deliverable: unknown;
}): void {
  const structured = asStructuredDeliverable(args.deliverable);
  if (!structured) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. Expected structured deliverable with type/value.`
    );
  }

  const value = structured.value as Record<string, any>;
  const pointerKey = args.needsInfo ? "intakePath" : "reportPath";
  const uriKey = args.needsInfo ? "intakeUri" : "reportUri";
  const primaryFile = args.needsInfo ? "INTAKE_REQUEST.md" : "REPORT.md";
  const expectedPrimaryPath = path.join(args.jobDir, primaryFile);

  if (value?.[pointerKey] !== expectedPrimaryPath) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. Expected ${pointerKey}=${expectedPrimaryPath}, got=${String(
        value?.[pointerKey]
      )}`
    );
  }

  if (typeof value?.[uriKey] !== "string" || !String(value[uriKey]).startsWith("file://")) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. Missing/invalid ${uriKey}.`
    );
  }

  const refs = value?.fileRefs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. Missing fileRefs array in deliverable value.`
    );
  }

  const hasPrimaryRef = refs.some(
    (r: any) =>
      r &&
      typeof r === "object" &&
      r.filename === primaryFile &&
      r.path === expectedPrimaryPath &&
      typeof r.uri === "string" &&
      r.uri.startsWith("file://")
  );

  if (!hasPrimaryRef) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. fileRefs missing pointer for ${primaryFile}.`
    );
  }
}

function requiredFieldsFromOfferingConfig(config: Record<string, any>): string[] {
  const required = config?.requirement?.required;
  if (!Array.isArray(required)) {
    return [];
  }

  return required
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function assertClearIntakePrompt(args: {
  offeringName: string;
  jobId: number;
  jobDir: string;
  deliverable: unknown;
  expectedMissingFields: string[];
}): void {
  const intakePath = path.join(args.jobDir, "INTAKE_REQUEST.md");
  const intake = readTextFile(intakePath);
  const intakeLower = intake.toLowerCase();

  if (!intakeLower.includes("intake required")) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. INTAKE_REQUEST.md must clearly label intake requirements.`
    );
  }

  if (
    !intakeLower.includes("missing required field") &&
    !intakeLower.includes("missing field")
  ) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. INTAKE_REQUEST.md must list missing fields.`
    );
  }

  if (
    !intakeLower.includes("create a new job") &&
    !intakeLower.includes("create a new acp job")
  ) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. INTAKE_REQUEST.md must instruct buyer to create a new job with requirements.`
    );
  }

  const structured = asStructuredDeliverable(args.deliverable);
  const missingFromDeliverable = Array.isArray(structured?.value?.missing)
    ? structured!.value.missing
        .filter((field: unknown): field is string => typeof field === "string")
        .map((field: string) => field.trim())
        .filter((field: string) => field.length > 0)
    : [];

  if (missingFromDeliverable.length === 0) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. needs_info deliverable must include missing[] fields.`
    );
  }

  const schemaMissing = args.expectedMissingFields.filter(
    (field) => !missingFromDeliverable.includes(field)
  );
  if (schemaMissing.length > 0) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. missing[] is missing required schema fields: ${schemaMissing.join(", ")}`
    );
  }

  for (const field of missingFromDeliverable) {
    if (!intake.includes(field)) {
      throw new Error(
        `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. INTAKE_REQUEST.md does not mention missing field "${field}".`
      );
    }
  }
}

function assertReportIsConcrete(args: {
  offeringName: string;
  jobId: number;
  jobDir: string;
}): void {
  const reportPath = path.join(args.jobDir, "REPORT.md");
  const report = readTextFile(reportPath);

  if (!/^#\s*REPORT\b/im.test(report)) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. REPORT.md must include a REPORT heading.`
    );
  }

  if (!/delivery package written/i.test(report)) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. REPORT.md must list written artifacts.`
    );
  }

  if (!new RegExp(`\\b${String(args.jobId)}\\b`).test(report)) {
    throw new Error(
      `Dry-run failed for offering=${args.offeringName} jobId=${args.jobId}. REPORT.md should include the jobId for traceability.`
    );
  }
}

async function runOne(
  offeringName: string,
  jobId: number,
  needsInfo: boolean
): Promise<void> {
  const requirements = needsInfo ? {} : sampleRequirements(offeringName);

  const { config, handlers } = await loadOffering(offeringName);
  const schemaRequiredFields = requiredFieldsFromOfferingConfig(
    config as Record<string, any>
  );

  const expectedRoot = resolveAcpDeliveryRoot();
  const { deliveryRoot, jobDir } = ensureJobDir(jobId, expectedRoot);

  if (path.resolve(deliveryRoot) !== path.resolve(expectedRoot)) {
    throw new Error(
      `Dry-run failed for offering=${offeringName} jobId=${jobId}. deliveryRoot mismatch: expected=${expectedRoot} actual=${deliveryRoot}`
    );
  }

  // Ensure each run is isolated and cannot pass due to stale artifacts.
  cleanJobDir(jobDir);

  const job: AcpJobEventData = {
    id: jobId,
    phase: AcpJobPhase.TRANSACTION,
    clientAddress: "0x0000000000000000000000000000000000000000",
    providerAddress: "0x0000000000000000000000000000000000000000",
    evaluatorAddress: "0x0000000000000000000000000000000000000000",
    price: typeof config.jobFee === "number" ? config.jobFee : 0,
    memos: [],
    context: { dryRun: true, mode: needsInfo ? "needs_info" : "written" },
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

  const expectedFiles = needsInfo
    ? ["JOB_SNAPSHOT.json", "INTAKE_REQUEST.md"]
    : ["JOB_SNAPSHOT.json", "REPORT.md"];

  if (!existsAll(jobDir, expectedFiles)) {
    throw new Error(
      `Dry-run failed for offering=${offeringName} jobId=${jobId}. Missing expected files=${JSON.stringify(
        expectedFiles
      )} in ${jobDir}. Got deliverable=${JSON.stringify(result.deliverable)}`
    );
  }

  if (!needsInfo) {
    const writtenFiles = fs
      .readdirSync(jobDir)
      .filter((name) => fs.statSync(path.join(jobDir, name)).isFile());

    const extraArtifacts = writtenFiles.filter(
      (name) => name !== "JOB_SNAPSHOT.json" && name !== "REPORT.md"
    );

    if (extraArtifacts.length === 0) {
      throw new Error(
        `Dry-run failed for offering=${offeringName} jobId=${jobId}. Expected at least one offering-specific artifact beyond JOB_SNAPSHOT.json and REPORT.md.`
      );
    }
  }

  const expectedType = needsInfo ? "needs_info" : "delivery_written";
  const structured = asStructuredDeliverable(result.deliverable);
  const actualType = structured?.type ?? "string";

  if (actualType !== expectedType) {
    throw new Error(
      `Dry-run failed for offering=${offeringName} jobId=${jobId}. Expected deliverable.type=${expectedType}, got=${actualType}`
    );
  }

  assertDeliverablePointers({
    offeringName,
    jobId,
    jobDir,
    needsInfo,
    deliverable: result.deliverable,
  });

  if (needsInfo) {
    assertClearIntakePrompt({
      offeringName,
      jobId,
      jobDir,
      deliverable: result.deliverable,
      expectedMissingFields: schemaRequiredFields,
    });
  } else {
    assertReportIsConcrete({
      offeringName,
      jobId,
      jobDir,
    });
  }

  console.log(
    [
      `[dry-run] offering=${offeringName}`,
      `jobId=${jobId}`,
      `mode=${needsInfo ? "needs_info" : "written"}`,
      `status=ok`,
      `dir=${jobDir}`,
    ].join(" ")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }

  const needsInfo = args.includes("--needs-info");
  const both = args.includes("--both");
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

  const modes = both ? [false, true] : [needsInfo];

  let cursor = 0;
  for (const offeringName of offerings) {
    for (const modeNeedsInfo of modes) {
      const jobId = baseJobId + cursor;
      cursor += 1;
      await runOne(offeringName, jobId, modeNeedsInfo);
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

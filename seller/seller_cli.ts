import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import { type JobOfferingData, type PriceV2 } from "../scripts/api.js";
import { createJobOffering, deleteJobOffering } from "../scripts/api.js";
import {
  readConfig,
  isProcessRunning,
  removePidFromConfig,
} from "../scripts/config.js";
import { getMyAgentInfo } from "../scripts/wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");

interface OfferingJson {
  name: string;
  description: string;
  jobFee: number;
  /** ACP-specific fields (optional — used when registering with ACP) */
  priceV2?: PriceV2;
  slaMinutes?: number;
  requiredFunds: boolean;
  requirement?: Record<string, any>;
  deliverable?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateOfferingJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`offering.json not found at ${filePath}`);
    return result;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to read offering.json: ${err}`);
    return result;
  }

  let json: any;
  try {
    json = JSON.parse(content);
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON in offering.json: ${err}`);
    return result;
  }

  // Validate required fields
  if (!json.name || typeof json.name !== "string") {
    result.valid = false;
    result.errors.push('offering.json must have a "name" field (string)');
  } else if (json.name.trim() === "") {
    result.valid = false;
    result.errors.push('"name" field cannot be empty');
  }

  if (!json.description || typeof json.description !== "string") {
    result.valid = false;
    result.errors.push(
      'offering.json must have a "description" field (string)'
    );
  } else if (json.description.trim() === "") {
    result.valid = false;
    result.errors.push('"description" field cannot be empty');
  }

  if (json.jobFee === undefined || json.jobFee === null) {
    result.valid = false;
    result.errors.push('offering.json must have a "jobFee" field (number)');
  } else if (typeof json.jobFee !== "number") {
    result.valid = false;
    result.errors.push('"jobFee" must be a number');
  } else if (json.jobFee < 0) {
    result.valid = false;
    result.errors.push('"jobFee" must be a non-negative number');
  }

  if (json.requiredFunds === undefined || json.requiredFunds === null) {
    result.valid = false;
    result.errors.push(
      'offering.json must have a "requiredFunds" field (boolean) — explicitly set true or false'
    );
  } else if (typeof json.requiredFunds !== "boolean") {
    result.valid = false;
    result.errors.push('"requiredFunds" must be a boolean');
  }

  return result;
}

function validateHandlers(
  filePath: string,
  requiredFunds?: boolean
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`handlers.ts not found at ${filePath}`);
    return result;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    result.valid = false;
    result.errors.push(`Failed to read handlers.ts: ${err}`);
    return result;
  }

  // Check for required executeJob function
  const executeJobPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function/,
    /export\s*\{\s*[^}]*executeJob[^}]*\}/,
  ];

  const hasExecuteJob = executeJobPatterns.some((pattern) =>
    pattern.test(content)
  );

  if (!hasExecuteJob) {
    result.valid = false;
    result.errors.push(
      'handlers.ts must export an "executeJob" function. Expected signature: async function executeJob(request: any): Promise<string>'
    );
  }

  // Check for optional handlers and provide info
  const validateRequirementsPatterns = [
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/,
    /export\s+const\s+validateRequirements\s*=/,
    /export\s*\{\s*[^}]*validateRequirements[^}]*\}/,
  ];

  const requestAdditionalFundsPatterns = [
    /export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/,
    /export\s+const\s+requestAdditionalFunds\s*=/,
    /export\s*\{\s*[^}]*requestAdditionalFunds[^}]*\}/,
  ];

  const hasValidateRequirements = validateRequirementsPatterns.some((pattern) =>
    pattern.test(content)
  );

  const hasRequestAdditionalFunds = requestAdditionalFundsPatterns.some(
    (pattern) => pattern.test(content)
  );

  if (!hasValidateRequirements) {
    result.warnings.push(
      'Optional: "validateRequirements" handler not found. Add it if you need to validate job requests.'
    );
  }

  if (requiredFunds === true && !hasRequestAdditionalFunds) {
    result.valid = false;
    result.errors.push(
      '"requiredFunds" is true in offering.json, so handlers.ts must export "requestAdditionalFunds"'
    );
  }

  if (requiredFunds === false && hasRequestAdditionalFunds) {
    result.valid = false;
    result.errors.push(
      '"requiredFunds" is false in offering.json, so handlers.ts must NOT export "requestAdditionalFunds"'
    );
  }

  return result;
}

/**
 * Build the ACP job-offering payload from an offering.json object.
 * Fields like priceV2, slaMinutes, etc. can be specified directly in the
 * offering.json; otherwise sensible defaults derived from jobFee are used.
 */
function buildAcpPayload(json: OfferingJson): JobOfferingData {
  return {
    name: json.name,
    description: json.description,
    priceV2: json.priceV2 ?? { type: "fixed", value: json.jobFee },
    slaMinutes: json.slaMinutes ?? 5,
    requiredFunds: json.requiredFunds,
    requirement: json.requirement ?? {},
    deliverable: json.deliverable ?? "string",
  };
}

function resolveOfferingDir(offeringName: string): string {
  return path.resolve(__dirname, "offerings", offeringName);
}

function ensureOfferingDirExists(offeringsDir: string, offeringName: string) {
  if (!fs.existsSync(offeringsDir)) {
    console.error(`❌ Error: Offering directory not found: ${offeringsDir}`);
    console.error(
      `\n   Create it with: mkdir -p seller/offerings/${offeringName}`
    );
    process.exit(1);
  }

  if (!fs.statSync(offeringsDir).isDirectory()) {
    console.error(`❌ Error: ${offeringsDir} is not a directory`);
    process.exit(1);
  }
}

async function startSellerProcess(): Promise<void> {
  const pid = findSellerPid();
  if (pid !== undefined) {
    return;
  }

  const sellerScript = path.resolve(__dirname, "runtime", "seller.ts");
  const tsxBin = path.resolve(PROJECT_ROOT, "node_modules", ".bin", "tsx");
  const sellerProcess = spawn(tsxBin, [sellerScript], {
    detached: true,
    stdio: "ignore",
    cwd: PROJECT_ROOT,
  });

  if (!sellerProcess.pid) {
    console.error("   ❌ Failed to start seller process\n");
    return;
  }

  sellerProcess.unref();

  console.log("Seller process started. Run `npm run seller:check` to verify.\n");
}

async function createOffering(offeringName: string) {
  const offeringsDir = resolveOfferingDir(offeringName);

  console.log(`\n📦 Validating offering: "${offeringName}"\n`);
  console.log(`   Directory: ${offeringsDir}\n`);

  ensureOfferingDirExists(offeringsDir, offeringName);

  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate offering.json
  console.log("📄 Checking offering.json...");
  const offeringJsonPath = path.join(offeringsDir, "offering.json");
  const jsonResult = validateOfferingJson(offeringJsonPath);
  allErrors.push(...jsonResult.errors);
  allWarnings.push(...jsonResult.warnings);

  if (jsonResult.valid) {
    const json = JSON.parse(fs.readFileSync(offeringJsonPath, "utf-8"));
    console.log(`   ✅ Valid - Name: "${json.name}"`);
    console.log(`              Description: "${json.description}"`);
    console.log(`              Job Fee: ${json.jobFee}`);
    console.log(`              Required Funds: ${json.requiredFunds}`);
  } else {
    console.log("   ❌ Invalid");
  }

  // Validate handlers.ts
  console.log("\n📄 Checking handlers.ts...");
  const handlersPath = path.join(offeringsDir, "handlers.ts");
  const parsedOffering: OfferingJson | null = jsonResult.valid
    ? (JSON.parse(fs.readFileSync(offeringJsonPath, "utf-8")) as OfferingJson)
    : null;
  const handlersResult = validateHandlers(
    handlersPath,
    parsedOffering?.requiredFunds
  );
  allErrors.push(...handlersResult.errors);
  allWarnings.push(...handlersResult.warnings);

  if (handlersResult.valid) {
    console.log("   ✅ Valid - executeJob handler found");
  } else {
    console.log("   ❌ Invalid");
  }

  // Print summary
  console.log("\n" + "─".repeat(50));

  if (allWarnings.length > 0) {
    console.log("\n⚠️  Warnings:");
    allWarnings.forEach((warning) => console.log(`   • ${warning}`));
  }

  if (allErrors.length > 0) {
    console.log("\n❌ Errors:");
    allErrors.forEach((error) => console.log(`   • ${error}`));
    console.log("\n❌ Validation failed. Please fix the errors above.\n");
    process.exit(1);
  }

  console.log("\n✅ Validation passed! Offering is ready for submission.\n");

  // --- Register with ACP ---
  const json: OfferingJson = JSON.parse(
    fs.readFileSync(offeringJsonPath, "utf-8")
  );
  const acpPayload = buildAcpPayload(json);

  console.log("🚀 Registering offering with ACP network...");
  const result = await createJobOffering(acpPayload);

  if (result.success) {
    console.log("   ✅ Offering successfully registered with ACP.\n");
  } else {
    console.error("   ❌ Failed to register offering with ACP.\n");
    process.exit(1);
  }

  await startSellerProcess();
}

async function deleteOffering(offeringName: string) {
  const offeringsDir = resolveOfferingDir(offeringName);

  console.log(`\n🗑️  Delisting offering: "${offeringName}"\n`);
  console.log(`   Directory: ${offeringsDir}\n`);

  ensureOfferingDirExists(offeringsDir, offeringName);

  console.log("🚀 Delisting offering from ACP network...");
  const result = await deleteJobOffering(offeringName);

  if (result.success) {
    console.log("   ✅ Offering successfully delisted from ACP.\n");
  } else {
    console.error("   ❌ Failed to delist offering from ACP.\n");
    process.exit(1);
  }
}

// ── Process discovery ────────────────────────────────────────────────────────

/**
 * Scan OS processes for a running seller runtime as a fallback when
 * config.json has no SELLER_PID or a stale one. Returns the PID if found.
 */
function findSellerProcessFromOS(): number | undefined {
  try {
    const output = execSync(
      'ps ax -o pid,command | grep "seller/runtime/seller.ts" | grep -v grep',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    for (const line of output.trim().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const pid = parseInt(trimmed.split(/\s+/)[0], 10);
      if (!isNaN(pid) && pid !== process.pid) {
        return pid;
      }
    }
  } catch {
    // grep returns exit code 1 when no matches — that's fine
  }
  return undefined;
}

/**
 * Find the seller process PID. Checks config.json first, then falls back
 * to scanning OS processes.
 */
function findSellerPid(): number | undefined {
  const config = readConfig();

  // Try config.json first
  if (config.SELLER_PID !== undefined && isProcessRunning(config.SELLER_PID)) {
    return config.SELLER_PID;
  }

  // Clean up stale PID if present
  if (config.SELLER_PID !== undefined) {
    removePidFromConfig();
  }

  // Fallback: scan OS processes
  return findSellerProcessFromOS();
}

// ── Stop ─────────────────────────────────────────────────────────────────────

function stopSeller(): void {
  const pid = findSellerPid();

  if (pid === undefined) {
    console.log("No seller process running.");
    return;
  }

  console.log(`Stopping seller process (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch (err: any) {
    console.error(`Failed to send SIGTERM to PID ${pid}: ${err.message}`);
    return;
  }

  // Wait briefly and verify
  let stopped = false;
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    while (Date.now() - start < 200) {
      /* busy wait 200ms */
    }
    if (!isProcessRunning(pid)) {
      stopped = true;
      break;
    }
  }

  if (stopped) {
    removePidFromConfig();
    console.log(`✅ Seller process (PID ${pid}) stopped.`);
  } else {
    console.error(
      `⚠️  Process (PID ${pid}) did not stop within 2 seconds. You may need to kill it manually: kill -9 ${pid}`
    );
  }
}

// ── Check ────────────────────────────────────────────────────────────────────

interface LocalOffering {
  dirName: string;
  name: string;
  description: string;
  jobFee: number;
  requiredFunds: boolean;
  requirement?: Record<string, any>;
}

function listLocalOfferings(): LocalOffering[] {
  const offeringsRoot = path.resolve(__dirname, "offerings");
  if (!fs.existsSync(offeringsRoot)) return [];

  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const configPath = path.join(offeringsRoot, d.name, "offering.json");
      if (!fs.existsSync(configPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return {
          dirName: d.name,
          name: json.name ?? d.name,
          description: json.description ?? "",
          jobFee: json.jobFee ?? 0,
          requiredFunds: json.requiredFunds ?? false,
          requirement: json.requirement,
        } as LocalOffering;
      } catch {
        return null;
      }
    })
    .filter((o): o is LocalOffering => o !== null);
}

function detectHandlers(offeringDir: string): string[] {
  const handlersPath = path.resolve(
    __dirname,
    "offerings",
    offeringDir,
    "handlers.ts"
  );
  if (!fs.existsSync(handlersPath)) return [];

  const content = fs.readFileSync(handlersPath, "utf-8");
  const found: string[] = [];

  if (/export\s+(async\s+)?function\s+executeJob\s*\(/.test(content)) {
    found.push("executeJob");
  }
  if (
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/.test(content)
  ) {
    found.push("validateRequirements");
  }
  if (
    /export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/.test(content)
  ) {
    found.push("requestAdditionalFunds");
  }

  return found;
}

function getProcessStatus(): { running: boolean; pid?: number } {
  const pid = findSellerPid();
  if (pid !== undefined) {
    return { running: true, pid };
  }
  return { running: false };
}

function getStatusLabel(isListed: boolean, processRunning: boolean): string {
  if (isListed && processRunning) {
    return "✅ Active (listed + process running)";
  } else if (isListed && !processRunning) {
    return "⚠️  Listed on ACP but process not running";
  } else {
    return "⏹  Delisted (local only)";
  }
}

async function fetchAcpOfferingNames(): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const agentInfo = await getMyAgentInfo();
    for (const o of agentInfo.jobOfferings ?? []) {
      names.add(o.name);
    }
  } catch {
    console.log(
      "   ⚠️  Could not fetch ACP registration status (API error)\n"
    );
  }
  return names;
}

async function checkAll(): Promise<void> {
  const status = getProcessStatus();
  console.log("\n📡 Seller Process");
  console.log("─".repeat(50));
  if (status.running) {
    console.log(`   Status:  ✅ Running (PID ${status.pid})`);
  } else {
    console.log("   Status:  ⏹  Not running");
  }

  const acpOfferingNames = await fetchAcpOfferingNames();
  const localOfferings = listLocalOfferings();

  console.log("\n📦 Job Offerings");
  console.log("─".repeat(50));

  if (localOfferings.length === 0) {
    console.log("   No local offerings found in seller/offerings/\n");
    return;
  }

  for (const offering of localOfferings) {
    const isListed = acpOfferingNames.has(offering.name);
    const statusLabel = getStatusLabel(isListed, status.running);

    console.log(`\n   ${offering.name}`);
    console.log(`     Description:    ${offering.description}`);
    console.log(`     Job Fee:        ${offering.jobFee} USDC`);
    console.log(`     Required Funds: ${offering.requiredFunds}`);
    console.log(`     Status:         ${statusLabel}`);
  }

  console.log("");
}

async function checkSingle(offeringName: string): Promise<void> {
  const offeringDir = resolveOfferingDir(offeringName);
  ensureOfferingDirExists(offeringDir, offeringName);

  const configPath = path.join(offeringDir, "offering.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      `❌ offering.json not found in seller/offerings/${offeringName}/`
    );
    process.exit(1);
  }

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    console.error(`❌ Failed to parse offering.json`);
    process.exit(1);
  }

  const acpOfferingNames = await fetchAcpOfferingNames();
  const isListed = acpOfferingNames.has(json.name);
  const status = getProcessStatus();
  const statusLabel = getStatusLabel(isListed, status.running);

  const handlers = detectHandlers(offeringName);

  console.log(`\n📦 Offering: ${json.name}`);
  console.log("─".repeat(50));
  console.log(`   Description:    ${json.description}`);
  console.log(`   Job Fee:        ${json.jobFee} USDC`);
  console.log(`   Required Funds: ${json.requiredFunds}`);
  console.log(`   Status:         ${statusLabel}`);
  console.log(`   Handlers:       ${handlers.join(", ") || "(none found)"}`);

  if (json.requirement) {
    console.log(`   Requirement Schema:`);
    const reqStr = JSON.stringify(json.requirement, null, 4)
      .split("\n")
      .map((line) => `     ${line}`)
      .join("\n");
    console.log(reqStr);
  }

  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage:");
    console.error('  npm run offering:create -- "<offering_name>"');
    console.error('  npm run offering:delete -- "<offering_name>"');
    console.error("  npm run seller:run");
    console.error("  npm run seller:stop");
    console.error("  npm run seller:check");
    console.error('  npm run seller:check -- "<offering_name>"');
    process.exit(1);
  }

  const action = args[0];
  const offeringName = args[1];

  switch (action) {
    case "create":
      if (!offeringName) {
        console.error('Usage: npm run offering:create -- "<offering_name>"');
        process.exit(1);
      }
      await createOffering(offeringName);
      break;
    case "delete":
      if (!offeringName) {
        console.error('Usage: npm run offering:delete -- "<offering_name>"');
        process.exit(1);
      }
      await deleteOffering(offeringName);
      break;
    case "stop":
      stopSeller();
      break;
    case "check":
      if (offeringName) {
        await checkSingle(offeringName);
      } else {
        await checkAll();
      }
      break;
    default:
      console.error(`❌ Unknown action: "${action}"`);
      console.error(
        '   Supported actions: "create", "delete", "stop", "check"'
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

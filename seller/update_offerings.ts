import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { type JobOfferingData, type PriceV2 } from "../scripts/api.js";
import { createJobOffering, deleteJobOffering } from "../scripts/api.js";
import { readConfig, isProcessRunning } from "../scripts/config.js";

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
      'handlers.ts must export an "executeJob" function. Expected signature: async function executeJob(requirements: any, ctx: JobContext): Promise<ExecuteJobResult>'
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
  const config = readConfig();

  if (config.SELLER_PID !== undefined && isProcessRunning(config.SELLER_PID)) {
    return;
  }

  const sellerProcess = spawn("npm", ["run", "seller:run"], {
    detached: true,
    stdio: "ignore",
    cwd: PROJECT_ROOT,
  });

  const pid = sellerProcess.pid;
  if (!pid) {
    console.error("   ❌ Failed to start seller process\n");
    return;
  }

  sellerProcess.unref();

  console.log(`Seller process started (PID: ${pid})\n`);
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

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npm run offering:create -- <offering-name>");
    console.error("       npm run offering:delete -- <offering-name>");
    process.exit(1);
  }

  const action = args[0];
  const offeringName = args[1];

  switch (action) {
    case "create":
      await createOffering(offeringName);
      break;
    case "delete":
      await deleteOffering(offeringName);
      break;
    default:
      console.error(`❌ Unknown action: "${action}"`);
      console.error('   Supported actions: "create", "delete"');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

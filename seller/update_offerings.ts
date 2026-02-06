import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface OfferingJson {
  name: string;
  description: string;
  jobFee: number;
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
    result.errors.push('offering.json must have a "description" field (string)');
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

  return result;
}

function validateHandlers(filePath: string): ValidationResult {
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

  if (!hasRequestAdditionalFunds) {
    result.warnings.push(
      'Optional: "requestAdditionalFunds" handler not found. Add it if jobs require additional funds from clients.'
    );
  }

  return result;
}

function resolveOfferingDir(offeringName: string): string {
  return path.resolve(__dirname, "offerings", offeringName);
}

function ensureOfferingDirExists(offeringsDir: string, offeringName: string) {
  if (!fs.existsSync(offeringsDir)) {
    console.error(`❌ Error: Offering directory not found: ${offeringsDir}`);
    console.error(`\n   Create it with: mkdir -p offerings/${offeringName}`);
    process.exit(1);
  }

  if (!fs.statSync(offeringsDir).isDirectory()) {
    console.error(`❌ Error: ${offeringsDir} is not a directory`);
    process.exit(1);
  }
}

function createOffering(offeringName: string) {
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
  } else {
    console.log("   ❌ Invalid");
  }

  // Validate handlers.ts
  console.log("\n📄 Checking handlers.ts...");
  const handlersPath = path.join(offeringsDir, "handlers.ts");
  const handlersResult = validateHandlers(handlersPath);
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

  // TODO: Add actual ACP registration logic here
  console.log("🚀 Registering offering with ACP network...");
  console.log("   (ACP registration not yet implemented)\n");
}

function deleteOffering(offeringName: string) {
  const offeringsDir = resolveOfferingDir(offeringName);

  console.log(`\n🗑️  Delisting offering: "${offeringName}"\n`);
  console.log(`   Directory: ${offeringsDir}\n`);

  ensureOfferingDirExists(offeringsDir, offeringName);

  // TODO: Add actual ACP delisting logic here
  console.log("🚀 Delisting offering from ACP network...");
  console.log("   (ACP delisting not yet implemented)\n");
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: npm run offering:create -- <offering-name>"
    );
    console.error(
      "       npm run offering:delete -- <offering-name>"
    );
    process.exit(1);
  }

  const action = args[0];
  const offeringName = args[1];

  switch (action) {
    case "create":
      createOffering(offeringName);
      break;
    case "delete":
      deleteOffering(offeringName);
      break;
    default:
      console.error(`❌ Unknown action: "${action}"`);
      console.error('   Supported actions: "create", "delete"');
      process.exit(1);
  }
}

main();

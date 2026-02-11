// =============================================================================
// acp sell init <name>     — Scaffold a new offering
// acp sell create <name>   — Validate + register offering on ACP
// acp sell delete <name>   — Delist offering from ACP
// acp sell list            — Show all offerings with status
// acp sell inspect <name>  — Detailed view of single offering
//
// acp sell resource init <name>     — Scaffold a new resource
// acp sell resource create <name>   — Validate + register resource on ACP
// acp sell resource delete <name>   — Delete resource from ACP
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as output from "../lib/output.js";
import { createJobOffering, deleteJobOffering, upsertResourceApi, deleteResourceApi, type JobOfferingData, type PriceV2, type Resource } from "../lib/api.js";
import { getMyAgentInfo } from "../lib/wallet.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Offerings live at src/seller/offerings/ */
const OFFERINGS_ROOT = path.resolve(__dirname, "..", "seller", "offerings");

/** Resources live at src/seller/resources/ */
const RESOURCES_ROOT = path.resolve(__dirname, "..", "seller", "resources");

interface OfferingJson {
  name: string;
  description: string;
  jobFee: number;
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

function resolveOfferingDir(offeringName: string): string {
  return path.resolve(OFFERINGS_ROOT, offeringName);
}

function validateOfferingJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`offering.json not found at ${filePath}`);
    return result;
  }

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON in offering.json: ${err}`);
    return result;
  }

  if (!json.name || typeof json.name !== "string" || json.name.trim() === "") {
    result.valid = false;
    result.errors.push('"name" field is required (non-empty string)');
  }
  if (!json.description || typeof json.description !== "string" || json.description.trim() === "") {
    result.valid = false;
    result.errors.push('"description" field is required (non-empty string)');
  }
  if (json.jobFee === undefined || json.jobFee === null) {
    result.valid = false;
    result.errors.push('"jobFee" field is required (number)');
  } else if (typeof json.jobFee !== "number" || json.jobFee < 0) {
    result.valid = false;
    result.errors.push('"jobFee" must be a non-negative number');
  }
  if (json.requiredFunds === undefined || json.requiredFunds === null) {
    result.valid = false;
    result.errors.push('"requiredFunds" field is required (boolean)');
  } else if (typeof json.requiredFunds !== "boolean") {
    result.valid = false;
    result.errors.push('"requiredFunds" must be a boolean');
  }

  return result;
}

function validateHandlers(filePath: string, requiredFunds?: boolean): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`handlers.ts not found at ${filePath}`);
    return result;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  const executeJobPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function/,
    /export\s*\{\s*[^}]*executeJob[^}]*\}/,
  ];

  const hasExecuteJob = executeJobPatterns.some((p) => p.test(content));
  if (!hasExecuteJob) {
    result.valid = false;
    result.errors.push('handlers.ts must export an "executeJob" function');
  }

  const executeJobWithCtxPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(\s*[\s\S]*?,\s*[\s\S]*?\)/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(\s*[\s\S]*?,\s*[\s\S]*?\)\s*=>/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function\s*\(\s*[\s\S]*?,\s*[\s\S]*?\)/,
  ];

  if (hasExecuteJob && !executeJobWithCtxPatterns.some((p) => p.test(content))) {
    result.valid = false;
    result.errors.push('handlers.ts executeJob must accept both (requirements, ctx) parameters');
  }

  const hasValidate = [
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/,
    /export\s+const\s+validateRequirements\s*=/,
    /export\s*\{\s*[^}]*validateRequirements[^}]*\}/,
  ].some((p) => p.test(content));

  const hasFunds = [
    /export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/,
    /export\s+const\s+requestAdditionalFunds\s*=/,
    /export\s*\{\s*[^}]*requestAdditionalFunds[^}]*\}/,
  ].some((p) => p.test(content));

  if (!hasValidate) {
    result.warnings.push('Optional: "validateRequirements" handler not found.');
  }
  if (requiredFunds === true && !hasFunds) {
    result.valid = false;
    result.errors.push('"requiredFunds" is true — handlers.ts must export "requestAdditionalFunds"');
  }
  if (requiredFunds === false && hasFunds) {
    result.valid = false;
    result.errors.push('"requiredFunds" is false — handlers.ts must NOT export "requestAdditionalFunds"');
  }

  return result;
}

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

// -- Init: scaffold a new offering --

export async function init(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell init <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (fs.existsSync(dir)) {
    output.fatal(`Offering directory already exists: ${dir}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const offeringJson = {
    name: offeringName,
    description: "Describe what this service does",
    jobFee: 1,
    requiredFunds: false,
    requirement: {
      type: "object",
      properties: {
        input: { type: "string", description: "Required primary input for this service" },
      },
      required: ["input"],
    },
  };

  fs.writeFileSync(
    path.join(dir, "offering.json"),
    JSON.stringify(offeringJson, null, 2) + "\n"
  );

  const handlersTemplate = `import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import { buildNeedsInfoValue, buildWrittenValue, writeJsonFile, writeTextFile, missingRequiredFields } from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["input"] as const;

export async function executeJob(requirementsRaw: any, ctx: JobContext): Promise<ExecuteJobResult> {
  const requirements = (requirementsRaw ?? {}) as Record<string, any>;

  // Always write a reproducible snapshot.
  writeJsonFile(ctx.jobDir, "JOB_SNAPSHOT.json", {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offeringName: ctx.offeringName,
    clientAddress: ctx.job.clientAddress,
    providerAddress: ctx.job.providerAddress,
    evaluatorAddress: ctx.job.evaluatorAddress,
    price: ctx.job.price,
    phase: ctx.job.phase,
    createdAt: ctx.job.createdAt,
    acpContext: ctx.job.context,
    memos: ctx.job.memos,
    requirements,
  });

  // Keep REQUIRED_FIELDS in sync with offering.json.requirement.required[].
  const missing = missingRequiredFields(requirements, [...REQUIRED_FIELDS]);

  if (missing.length > 0) {
    const intake = [
      "# Intake required",
      "",
      "Missing required field(s): " + missing.join(", "),
      "",
      "Please create a new ACP job and include --requirements JSON with the missing fields.",
      "",
      "Example:",
      "",
      "\`\`\`json",
      "{ \\\"input\\\": \\\"...\\\" }",
      "\`\`\`",
      "",
    ].join("\\n");

    writeTextFile(ctx.jobDir, "INTAKE_REQUEST.md", intake);

    return {
      deliverable: {
        type: "needs_info",
        value: buildNeedsInfoValue({
          offering: ctx.offeringName,
          jobId: ctx.jobId,
          jobDir: ctx.jobDir,
          missing,
          filesWritten: ["JOB_SNAPSHOT.json", "INTAKE_REQUEST.md"],
        }),
      },
    };
  }

  const deliveryPlanFile = "DELIVERY_PLAN.json";
  writeJsonFile(ctx.jobDir, deliveryPlanFile, {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    requirements,
    phases: ["scope", "implementation", "validation", "handoff"],
  });

  const report = [
    "# REPORT",
    "",
    "## Request summary",
    "- offering: " + ctx.offeringName,
    "- jobId: " + String(ctx.jobId),
    "- generatedAt: " + new Date().toISOString(),
    "",
    "## Requirements (as received)",
    "\`\`\`json",
    JSON.stringify(requirements, null, 2),
    "\`\`\`",
    "",
    "## Delivery package written",
    "- JOB_SNAPSHOT.json",
    "- " + deliveryPlanFile,
    "",
    "## Compliance note",
    "- Do not claim execution, tests, or audits unless evidence files are written in this job folder.",
    "",
  ].join("\\n");

  writeTextFile(ctx.jobDir, "REPORT.md", report);

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", deliveryPlanFile, "REPORT.md"],
      }),
    },
  };
}

// Optional: validate incoming requests
export function validateRequirements(_requirements: any, _ctx: JobContext): ValidationResult {
  // Return { valid: true } to accept, or { valid: false, reason: "explanation" } to reject.
  return { valid: true };
}

// Optional: provide a custom payment request reason.
export function requestPayment(_requirements: any, _ctx: JobContext): string {
  return "Payment requested. If requirements are incomplete, the deliverable will include an intake request.";
}
`;

  fs.writeFileSync(path.join(dir, "handlers.ts"), handlersTemplate);

  output.output({ created: dir }, () => {
    output.heading("Offering Scaffolded");
    output.log(`  Created: src/seller/offerings/${offeringName}/`);
    output.log(`    - offering.json  (edit name, description, fee, requirements)`);
    output.log(`    - handlers.ts    (implement executeJob)`);
    output.log(`\n  Next: edit the files, then run: acp sell create ${offeringName}\n`);
  });
}

// -- Create: validate + register --

export async function create(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell create <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    output.fatal(
      `Offering directory not found: ${dir}\n  Create it with: acp sell init ${offeringName}`
    );
  }

  output.log(`\nValidating offering: "${offeringName}"\n`);

  const allErrors: string[] = [];
  const allWarnings: string[] = [];

  // Validate offering.json
  output.log("  Checking offering.json...");
  const jsonPath = path.join(dir, "offering.json");
  const jsonResult = validateOfferingJson(jsonPath);
  allErrors.push(...jsonResult.errors);
  allWarnings.push(...jsonResult.warnings);

  let parsedOffering: OfferingJson | null = null;
  if (jsonResult.valid) {
    parsedOffering = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    output.log(`    Valid — Name: "${parsedOffering!.name}"`);
    output.log(`             Fee: ${parsedOffering!.jobFee} USDC`);
    output.log(`             Funds required: ${parsedOffering!.requiredFunds}`);
  } else {
    output.log("    Invalid");
  }

  // Validate handlers.ts
  output.log("\n  Checking handlers.ts...");
  const handlersPath = path.join(dir, "handlers.ts");
  const handlersResult = validateHandlers(handlersPath, parsedOffering?.requiredFunds);
  allErrors.push(...handlersResult.errors);
  allWarnings.push(...handlersResult.warnings);

  if (handlersResult.valid) {
    output.log("    Valid — executeJob handler found");
  } else {
    output.log("    Invalid");
  }

  output.log("\n" + "-".repeat(50));

  if (allWarnings.length > 0) {
    output.log("\n  Warnings:");
    allWarnings.forEach((w) => output.log(`    - ${w}`));
  }

  if (allErrors.length > 0) {
    output.log("\n  Errors:");
    allErrors.forEach((e) => output.log(`    - ${e}`));
    output.fatal("\n  Validation failed. Fix the errors above.");
  }

  output.log("\n  Validation passed!\n");

  // Register with ACP
  const json: OfferingJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const acpPayload = buildAcpPayload(json);

  output.log("  Registering offering with ACP...");
  const result = await createJobOffering(acpPayload);

  if (result.success) {
    output.log("    Offering registered successfully.\n");
  } else {
    output.fatal("  Failed to register offering with ACP.");
  }

  // Start seller if not running
  output.log("  Tip: Run `acp serve start` to begin accepting jobs.\n");
}

// -- Delete: delist offering --

export async function del(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell delete <offering_name>");
  }

  output.log(`\n  Delisting offering: "${offeringName}"...\n`);

  const result = await deleteJobOffering(offeringName);

  if (result.success) {
    output.log("  Offering delisted from ACP. Local files remain.\n");
  } else {
    output.fatal("  Failed to delist offering from ACP.");
  }
}

// -- List: show all offerings with status --

interface LocalOffering {
  dirName: string;
  name: string;
  description: string;
  jobFee: number;
  requiredFunds: boolean;
}

function listLocalOfferings(): LocalOffering[] {
  if (!fs.existsSync(OFFERINGS_ROOT)) return [];

  return fs
    .readdirSync(OFFERINGS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const configPath = path.join(OFFERINGS_ROOT, d.name, "offering.json");
      if (!fs.existsSync(configPath)) return null;
      try {
        const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return {
          dirName: d.name,
          name: json.name ?? d.name,
          description: json.description ?? "",
          jobFee: json.jobFee ?? 0,
          requiredFunds: json.requiredFunds ?? false,
        };
      } catch {
        return null;
      }
    })
    .filter((o): o is LocalOffering => o !== null);
}

interface AcpOffering {
  name: string;
  priceV2?: { type: string; value: number };
  slaMinutes?: number;
  requiredFunds?: boolean;
}

async function fetchAcpOfferings(): Promise<AcpOffering[]> {
  try {
    const agentInfo = await getMyAgentInfo();
    return agentInfo.jobs ?? [];
  } catch {
    // API error — can't determine ACP status
    return [];
  }
}

function acpOfferingNames(acpOfferings: AcpOffering[]): Set<string> {
  return new Set(acpOfferings.map((o) => o.name));
}

export async function list(): Promise<void> {
  const acpOfferings = await fetchAcpOfferings();
  const acpNames = acpOfferingNames(acpOfferings);
  const localOfferings = listLocalOfferings();
  const localNames = new Set(localOfferings.map((o) => o.name));

  const localData = localOfferings.map((o) => ({
    ...o,
    listed: acpNames.has(o.name),
    acpOnly: false as const,
  }));

  // ACP-only offerings: listed on ACP but no local directory
  const acpOnlyData = acpOfferings
    .filter((o) => !localNames.has(o.name))
    .map((o) => ({
      dirName: "",
      name: o.name,
      description: "",
      jobFee: o.priceV2?.value ?? 0,
      requiredFunds: o.requiredFunds ?? false,
      listed: true,
      acpOnly: true as const,
    }));

  const data = [...localData, ...acpOnlyData];

  output.output(data, (offerings) => {
    output.heading("Job Offerings");

    if (offerings.length === 0) {
      output.log("  No offerings found. Run `acp sell init <name>` to create one.\n");
      return;
    }

    for (const o of offerings) {
      const status = o.acpOnly
        ? "Listed on ACP (no local files)"
        : o.listed
          ? "Listed"
          : "Local only";
      output.log(`\n  ${o.name}`);
      if (!o.acpOnly) {
        output.field("    Description", o.description);
      }
      output.field("    Fee", `${o.jobFee} USDC`);
      output.field("    Funds required", String(o.requiredFunds));
      output.field("    Status", status);
      if (o.acpOnly) {
        output.log("    Tip: Run `acp sell delete " + o.name + "` to delist from ACP");
      }
    }
    output.log("");
  });
}

// -- Inspect: detailed view --

function detectHandlers(offeringDir: string): string[] {
  const handlersPath = path.join(OFFERINGS_ROOT, offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) return [];

  const content = fs.readFileSync(handlersPath, "utf-8");
  const found: string[] = [];

  if (/export\s+(async\s+)?function\s+executeJob\s*\(/.test(content)) {
    found.push("executeJob");
  }
  if (/export\s+(async\s+)?function\s+validateRequirements\s*\(/.test(content)) {
    found.push("validateRequirements");
  }
  if (/export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/.test(content)) {
    found.push("requestAdditionalFunds");
  }

  return found;
}

export async function inspect(offeringName: string): Promise<void> {
  if (!offeringName) {
    output.fatal("Usage: acp sell inspect <offering_name>");
  }

  const dir = resolveOfferingDir(offeringName);
  const configPath = path.join(dir, "offering.json");

  if (!fs.existsSync(configPath)) {
    output.fatal(`Offering not found: ${offeringName}`);
  }

  const json = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const acpOfferings = await fetchAcpOfferings();
  const isListed = acpOfferingNames(acpOfferings).has(json.name);
  const handlers = detectHandlers(offeringName);

  const data = {
    ...json,
    listed: isListed,
    handlers,
  };

  output.output(data, (d) => {
    output.heading(`Offering: ${d.name}`);
    output.field("Description", d.description);
    output.field("Fee", `${d.jobFee} USDC`);
    output.field("Funds required", String(d.requiredFunds));
    output.field("Status", d.listed ? "Listed on ACP" : "Local only");
    output.field("Handlers", d.handlers.join(", ") || "(none)");
    if (d.requirement) {
      output.log("\n  Requirement Schema:");
      output.log(
        JSON.stringify(d.requirement, null, 4)
          .split("\n")
          .map((line: string) => `    ${line}`)
          .join("\n")
      );
    }
    output.log("");
  });
}

// =============================================================================
// Resource Management
// =============================================================================

function resolveResourceDir(resourceName: string): string {
  return path.resolve(RESOURCES_ROOT, resourceName);
}

function validateResourceJson(filePath: string): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (!fs.existsSync(filePath)) {
    result.valid = false;
    result.errors.push(`resources.json not found at ${filePath}`);
    return result;
  }

  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    result.valid = false;
    result.errors.push(`Invalid JSON in resources.json: ${err}`);
    return result;
  }

  if (!json.name || typeof json.name !== "string" || json.name.trim() === "") {
    result.valid = false;
    result.errors.push('"name" field is required (non-empty string)');
  }
  if (!json.description || typeof json.description !== "string" || json.description.trim() === "") {
    result.valid = false;
    result.errors.push('"description" field is required (non-empty string)');
  }
  if (!json.url || typeof json.url !== "string" || json.url.trim() === "") {
    result.valid = false;
    result.errors.push('"url" field is required (non-empty string)');
  }
  if (json.params !== undefined && json.params !== null) {
    if (typeof json.params !== "object" || Array.isArray(json.params)) {
      result.valid = false;
      result.errors.push('"params" field must be an object if provided');
    }
  }

  return result;
}

// -- Resource Init: scaffold a new resource --

export async function resourceInit(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource init <resource_name>");
  }

  const dir = resolveResourceDir(resourceName);
  if (fs.existsSync(dir)) {
    output.fatal(`Resource directory already exists: ${dir}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const resourceJson = {
    name: resourceName,
    description: "Describe what this resource provides",
    url: "https://api.example.invalid/endpoint (replace with actual API URL)",
  };

  fs.writeFileSync(
    path.join(dir, "resources.json"),
    JSON.stringify(resourceJson, null, 2) + "\n"
  );

  output.output({ created: dir }, () => {
    output.heading("Resource Scaffolded");
    output.log(`  Created: src/seller/resources/${resourceName}/`);
    output.log(`    - resources.json  (edit name, description, url, params)`);
    output.log(`\n  Next: edit the file, then run: acp sell resource create ${resourceName}\n`);
  });
}

// -- Resource Create: validate + register --

export async function resourceCreate(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource create <resource_name>");
  }

  const dir = resolveResourceDir(resourceName);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    output.fatal(
      `Resource directory not found: ${dir}\n  Create it with: acp sell resource init ${resourceName}`
    );
  }

  output.log(`\nValidating resource: "${resourceName}"\n`);

  const jsonPath = path.join(dir, "resources.json");
  const validation = validateResourceJson(jsonPath);

  if (!validation.valid) {
    output.log("  Errors:");
    validation.errors.forEach((e) => output.log(`    - ${e}`));
    output.fatal("\n  Validation failed. Fix the errors above.");
  }

  if (validation.warnings.length > 0) {
    output.log("  Warnings:");
    validation.warnings.forEach((w) => output.log(`    - ${w}`));
  }

  output.log("  Validation passed!\n");

  // Register with ACP
  const json: any = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const resource: Resource = {
    name: json.name,
    description: json.description,
    url: json.url,
    params: json.params,
  };

  output.log("  Registering resource with ACP...");
  const result = await upsertResourceApi(resource);

  if (result.success) {
    output.log("    Resource registered successfully.\n");
  } else {
    output.fatal("  Failed to register resource with ACP.");
  }
}

// -- Resource Delete: delete resource --

export async function resourceDelete(resourceName: string): Promise<void> {
  if (!resourceName) {
    output.fatal("Usage: acp sell resource delete <resource_name>");
  }

  output.log(`\n  Deleting resource: "${resourceName}"...\n`);

  const result = await deleteResourceApi(resourceName);

  if (result.success) {
    output.log("  Resource deleted from ACP.\n");
  } else {
    output.fatal("  Failed to delete resource from ACP.");
  }
}

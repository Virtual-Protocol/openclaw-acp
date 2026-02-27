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
import {
  createJobOffering,
  deleteJobOffering,
  upsertResourceApi,
  deleteResourceApi,
  createSubscription,
  deleteSubscription,
  type JobOfferingData,
  type PriceV2,
  type Resource,
} from "../lib/api.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import { formatPrice } from "../lib/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Offerings live at src/seller/offerings/ */
const OFFERINGS_ROOT = path.resolve(__dirname, "..", "seller", "offerings");

/** Resources live at src/seller/resources/ */
const RESOURCES_ROOT = path.resolve(__dirname, "..", "seller", "resources");

interface InlineSubscriptionTier {
  name: string;
  price: number;    // USDC
  duration: number; // days
}

interface OfferingJson {
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  priceV2?: PriceV2;
  slaMinutes?: number;
  requiredFunds: boolean;
  requirement?: Record<string, any>;
  deliverable?: string;
  subscriptionTiers?: InlineSubscriptionTier[];
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
    result.errors.push(
      'offering.json: "name" is required — set to a non-empty string matching the directory name'
    );
  }
  if (
    !json.description ||
    typeof json.description !== "string" ||
    json.description.trim() === ""
  ) {
    result.valid = false;
    result.errors.push(
      'offering.json: "description" is required — describe what this service does for buyers'
    );
  }
  if (json.jobFee === undefined || json.jobFee === null) {
    result.valid = false;
    // Validate jobFee presence, type, and value based on jobFeeType
    if (json.jobFee === undefined || json.jobFee === null) {
      result.valid = false;
      result.errors.push(
        'offering.json: "jobFee" is required — set to a number (see "jobFeeType" docs)'
      );
    } else if (typeof json.jobFee !== "number") {
      result.valid = false;
      result.errors.push('offering.json: "jobFee" must be a number');
    }

    if (json.jobFeeType === undefined || json.jobFeeType === null) {
      result.valid = false;
      result.errors.push(
        'offering.json: "jobFeeType" is required ("fixed" or "percentage")'
      );
    } else if (
      json.jobFeeType !== "fixed" &&
      json.jobFeeType !== "percentage"
    ) {
      result.valid = false;
      result.errors.push(
        'offering.json: "jobFeeType" must be either "fixed" or "percentage"'
      );
    }

    // Additional validation if both jobFee is a number and jobFeeType is set
    if (typeof json.jobFee === "number" && json.jobFeeType) {
      if (json.jobFeeType === "fixed") {
        if (json.jobFee < 0) {
          result.valid = false;
          result.errors.push(
            'offering.json: "jobFee" must be a non-negative number (fee in USDC per job) for fixed fee type'
          );
        }
        if (json.jobFee === 0) {
          result.warnings.push(
            'offering.json: "jobFee" is 0; jobs will pay no fee to seller'
          );
        }
      } else if (json.jobFeeType === "percentage") {
        if (json.jobFee < 0.001 || json.jobFee > 0.99) {
          result.valid = false;
          result.errors.push(
            'offering.json: "jobFee" must be >= 0.001 and <= 0.99 (value in decimals, eg. 50% = 0.5) for percentage fee type'
          );
        }
      }
    }
  }
  if (json.requiredFunds === undefined || json.requiredFunds === null) {
    result.valid = false;
    result.errors.push(
      'offering.json: "requiredFunds" is required — set to true if the job needs additional token transfer beyond the fee, false otherwise'
    );
  } else if (typeof json.requiredFunds !== "boolean") {
    result.valid = false;
    result.errors.push('offering.json: "requiredFunds" must be true or false');
  }

  if (json.subscriptionTiers !== undefined) {
    if (!Array.isArray(json.subscriptionTiers)) {
      result.valid = false;
      result.errors.push('offering.json: "subscriptionTiers" must be an array of tier objects');
    } else {
      for (let i = 0; i < json.subscriptionTiers.length; i++) {
        const tier = json.subscriptionTiers[i];
        if (typeof tier !== "object" || tier === null) {
          result.valid = false;
          result.errors.push(`offering.json: subscriptionTiers[${i}] must be an object with {name, price, duration}`);
          continue;
        }
        if (!tier.name || typeof tier.name !== "string" || tier.name.trim() === "") {
          result.valid = false;
          result.errors.push(`offering.json: subscriptionTiers[${i}].name is required (non-empty string)`);
        }
        if (tier.price == null || typeof tier.price !== "number" || tier.price <= 0) {
          result.valid = false;
          result.errors.push(`offering.json: subscriptionTiers[${i}].price must be a positive number (USDC)`);
        }
        if (tier.duration == null || typeof tier.duration !== "number" || tier.duration <= 0) {
          result.valid = false;
          result.errors.push(`offering.json: subscriptionTiers[${i}].duration must be a positive number (days)`);
        }
      }
      const names = json.subscriptionTiers
        .filter((t: any) => typeof t === "object" && t?.name)
        .map((t: any) => t.name);
      const dupes = names.filter((n: string, i: number) => names.indexOf(n) !== i);
      if (dupes.length > 0) {
        result.valid = false;
        result.errors.push(`offering.json: duplicate subscription tier names: ${[...new Set(dupes)].join(", ")}`);
      }
    }
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

  const content = fs.readFileSync(filePath, "utf-8");

  const executeJobPatterns = [
    /export\s+(async\s+)?function\s+executeJob\s*\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?\(/,
    /export\s+const\s+executeJob\s*=\s*(async\s*)?function/,
    /export\s*\{\s*[^}]*executeJob[^}]*\}/,
  ];

  if (!executeJobPatterns.some((p) => p.test(content))) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: must export an "executeJob" function — this is the required handler that runs your service logic'
    );
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
    result.warnings.push(
      'handlers.ts: optional "validateRequirements" handler not found — requests will be accepted without validation'
    );
  }
  if (requiredFunds === true && !hasFunds) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: "requiredFunds" is true in offering.json — must export "requestAdditionalFunds" to specify the token transfer details'
    );
  }
  if (requiredFunds === false && hasFunds) {
    result.valid = false;
    result.errors.push(
      'handlers.ts: "requiredFunds" is false in offering.json — must NOT export "requestAdditionalFunds" (remove it, or set requiredFunds to true)'
    );
  }

  return result;
}

function buildAcpPayload(json: OfferingJson): JobOfferingData {
  return {
    name: json.name,
    description: json.description,
    priceV2: json.priceV2 ?? { type: json.jobFeeType, value: json.jobFee },
    slaMinutes: json.slaMinutes ?? 5,
    requiredFunds: json.requiredFunds,
    requirement: json.requirement ?? {},
    deliverable: json.deliverable ?? "string",
    ...(json.subscriptionTiers?.length && {
      subscriptionTiers: json.subscriptionTiers.map((t) => t.name),
    }),
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

  const offeringJson: Record<string, unknown> = {
    name: offeringName,
    description: "",
    jobFee: null,
    jobFeeType: null,
    requiredFunds: null,
    requirement: {},
  };

  fs.writeFileSync(
    path.join(dir, "offering.json"),
    JSON.stringify(offeringJson, null, 2) + "\n"
  );

  const handlersTemplate = `import type { ExecuteJobResult, ValidationResult } from "../../runtime/offeringTypes.js";

// Required: implement your service logic here
export async function executeJob(request: any): Promise<ExecuteJobResult> {
  // TODO: Implement your service
  return { deliverable: "TODO: Return your result" };
}

// Optional: validate incoming requests
export function validateRequirements(request: any): ValidationResult {
  // Return { valid: true } to accept, or { valid: false, reason: "explanation" } to reject
  return { valid: true };
}

// Optional: provide custom payment request message
export function requestPayment(request: any): string {
  // Return a custom message/reason for the payment request
  return "Request accepted";
}
`;

  fs.writeFileSync(path.join(dir, "handlers.ts"), handlersTemplate);

  output.output({ created: dir }, () => {
    output.heading("Offering Scaffolded");
    output.log(`  Created: src/seller/offerings/${offeringName}/`);
    output.log(
      `    - offering.json  (edit name, description, fee, feeType, requirements)`
    );
    output.log(`    - handlers.ts    (implement executeJob)`);
    output.log(
      `\n  Next: edit the files, then run: acp sell create ${offeringName}\n`
    );
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
    if (parsedOffering!.subscriptionTiers?.length) {
      output.log(`             Subscription tiers: ${parsedOffering!.subscriptionTiers.map((t) => `${t.name} (${t.price} USDC, ${t.duration}d)`).join(", ")}`);
    }
  } else {
    output.log("    Invalid");
  }

  // Validate handlers.ts
  output.log("\n  Checking handlers.ts...");
  const handlersPath = path.join(dir, "handlers.ts");
  const handlersResult = validateHandlers(
    handlersPath,
    parsedOffering?.requiredFunds
  );
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

  // Sync subscription tiers with backend
  if (parsedOffering?.subscriptionTiers?.length) {
    output.log("\n  Syncing subscription tiers...");
    try {
      const agentInfo = await getMyAgentInfo();
      const existingTiers = agentInfo.subscriptions ?? [];

      for (const tier of parsedOffering.subscriptionTiers) {
        const existing = existingTiers.find((t) => t.name === tier.name);
        if (existing) {
          const durationSeconds = tier.duration * 86400;
          if (existing.price !== tier.price || existing.duration !== durationSeconds) {
            await deleteSubscription(tier.name);
            await createSubscription({ name: tier.name, price: tier.price, duration: tier.duration });
            output.log(`    Updated tier "${tier.name}" (${tier.price} USDC, ${tier.duration} days)`);
          } else {
            output.log(`    Tier "${tier.name}" already exists — no change`);
          }
        } else {
          await createSubscription({ name: tier.name, price: tier.price, duration: tier.duration });
          output.log(`    Created tier "${tier.name}" (${tier.price} USDC, ${tier.duration} days)`);
        }
      }
    } catch (err) {
      allErrors.push(
        `Failed to sync subscription tiers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
  jobFeeType: "fixed" | "percentage";
  requiredFunds: boolean;
  subscriptionTiers?: InlineSubscriptionTier[];
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
          jobFeeType: json.jobFeeType ?? "fixed",
          requiredFunds: json.requiredFunds ?? false,
          ...(json.subscriptionTiers && { subscriptionTiers: json.subscriptionTiers }),
        } as LocalOffering;
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
      jobFeeType: o.priceV2?.type ?? "fixed",
      requiredFunds: o.requiredFunds ?? false,
      listed: true,
      acpOnly: true as const,
    }));

  const data = [...localData, ...acpOnlyData];

  output.output(data, (offerings) => {
    output.heading("Job Offerings");

    if (offerings.length === 0) {
      output.log(
        "  No offerings found. Run `acp sell init <name>` to create one.\n"
      );
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
      output.field("    Fee", `${formatPrice(o.jobFee, o.jobFeeType)}`);
      output.field("    Funds required", String(o.requiredFunds));
      if (o.subscriptionTiers?.length) {
        output.field("    Subscription tiers", o.subscriptionTiers.map((t: InlineSubscriptionTier) => `${t.name} (${t.price} USDC, ${t.duration}d)`).join(", "));
      }
      output.field("    Status", status);
      if (o.acpOnly) {
        output.log(
          "    Tip: Run `acp sell delete " + o.name + "` to delist from ACP"
        );
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
  if (
    /export\s+(async\s+)?function\s+validateRequirements\s*\(/.test(content)
  ) {
    found.push("validateRequirements");
  }
  if (/export\s+(async\s+)?function\s+requestPayment\s*\(/.test(content)) {
    found.push("requestPayment");
  }
  if (
    /export\s+(async\s+)?function\s+requestAdditionalFunds\s*\(/.test(content)
  ) {
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
    if (d.subscriptionTiers?.length) {
      output.field("Subscription Tiers", d.subscriptionTiers.map((t: InlineSubscriptionTier) => `${t.name} (${t.price} USDC, ${t.duration}d)`).join(", "));
    }
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
  if (
    !json.description ||
    typeof json.description !== "string" ||
    json.description.trim() === ""
  ) {
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
    description: "TODO: Describe what this resource provides",
    url: "https://api.example.com/endpoint",
  };

  fs.writeFileSync(
    path.join(dir, "resources.json"),
    JSON.stringify(resourceJson, null, 2) + "\n"
  );

  output.output({ created: dir }, () => {
    output.heading("Resource Scaffolded");
    output.log(`  Created: src/seller/resources/${resourceName}/`);
    output.log(`    - resources.json  (edit name, description, url, params)`);
    output.log(
      `\n  Next: edit the file, then run: acp sell resource create ${resourceName}\n`
    );
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

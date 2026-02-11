// =============================================================================
// Dynamic loader for seller offerings (offering.json + handlers.ts).
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { OfferingHandlers } from "./offeringTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The parsed offering.json config. */
export interface OfferingConfig {
  name: string;
  description: string;
  jobFee: number;
  jobFeeType: "fixed" | "percentage";
  requiredFunds: boolean;

  // Extra fields are allowed (priceV2, requirement schema, etc.)
  [key: string]: unknown;
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: OfferingHandlers;
}

function offeringsBaseDir(): string {
  return path.resolve(__dirname, "..", "offerings");
}

/**
 * Resolve an offering directory by either:
 *  - direct directory match (legacy)
 *  - OR scanning offering.json.name (ACP-compatible)
 */
function resolveOfferingDir(offeringName: string): string {
  const base = offeringsBaseDir();
  const direct = path.join(base, offeringName);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    return direct;
  }

  if (!fs.existsSync(base)) {
    throw new Error(`Offerings directory not found: ${base}`);
  }

  // Scan offering.json files to find a matching config.name.
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const dirName of dirs) {
    const configPath = path.join(base, dirName, "offering.json");
    if (!fs.existsSync(configPath)) continue;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config?.name === offeringName) {
        return path.join(base, dirName);
      }
    } catch {
      // ignore malformed offering.json
    }
  }

  throw new Error(
    `Offering not found: ${offeringName}. Expected either ${direct} or an offering.json with {"name":"${offeringName}"}.`
  );
}

/**
 * Load a named offering from `src/seller/offerings/<dir>/`.
 * Expects `offering.json` and `handlers.ts` in that directory.
 */
export async function loadOffering(offeringName: string): Promise<LoadedOffering> {
  const offeringDir = resolveOfferingDir(offeringName);

  // offering.json
  const configPath = path.join(offeringDir, "offering.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`offering.json not found: ${configPath}`);
  }
  const config: OfferingConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  // handlers.ts (dynamically imported)
  const handlersPath = path.join(offeringDir, "handlers.ts");
  if (!fs.existsSync(handlersPath)) {
    throw new Error(`handlers.ts not found: ${handlersPath}`);
  }

  const handlers = (await import(handlersPath)) as OfferingHandlers;

  if (typeof handlers.executeJob !== "function") {
    throw new Error(
      `handlers.ts for offering "${offeringName}" must export an executeJob function`
    );
  }

  return { config, handlers };
}

/**
 * List all available offering directory names (subdirectories under offerings/).
 */
export function listOfferings(): string[] {
  const base = offeringsBaseDir();
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

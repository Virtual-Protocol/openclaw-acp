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
  requiredFunds: boolean;
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: OfferingHandlers;
}

/**
 * Load a named offering from `seller/offerings/<name>/`.
 * Expects `offering.json` and `handlers.ts` in that directory.
 */
export async function loadOffering(
  offeringName: string
): Promise<LoadedOffering> {
  // seller/runtime/ is two levels inside seller/ — offerings live at seller/offerings/
  const offeringsRoot = path.resolve(
    __dirname,
    "..",
    "offerings",
    offeringName
  );

  // offering.json
  const configPath = path.join(offeringsRoot, "offering.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`offering.json not found: ${configPath}`);
  }
  const config: OfferingConfig = JSON.parse(
    fs.readFileSync(configPath, "utf-8")
  );

  // handlers.ts (dynamically imported)
  const handlersPath = path.join(offeringsRoot, "handlers.ts");
  if (!fs.existsSync(handlersPath)) {
    throw new Error(`handlers.ts not found: ${handlersPath}`);
  }

  const handlers = (await import(handlersPath)) as OfferingHandlers;

  if (typeof handlers.executeJob !== "function") {
    throw new Error(
      `handlers.ts in "${offeringName}" must export an executeJob function`
    );
  }

  return { config, handlers };
}

/**
 * List all available offering names (subdirectories under seller/offerings/).
 */
export function listOfferings(): string[] {
  const offeringsRoot = path.resolve(__dirname, "..", "offerings");
  if (!fs.existsSync(offeringsRoot)) return [];
  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

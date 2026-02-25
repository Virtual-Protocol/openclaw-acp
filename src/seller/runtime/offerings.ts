// =============================================================================
// Dynamic loader for seller offerings.
// Offerings are stored per-agent: src/seller/offerings/<agent-name>/<offering>/
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
}

export interface LoadedOffering {
  config: OfferingConfig;
  handlers: OfferingHandlers;
}

function resolveOfferingsRoot(agentDirName: string): string {
  return path.resolve(__dirname, "..", "offerings", agentDirName);
}

/**
 * Load a named offering from `src/seller/offerings/<agentDirName>/<name>/`.
 * Expects `offering.json` and `handlers.ts` in that directory.
 */
export async function loadOffering(
  offeringName: string,
  agentDirName: string
): Promise<LoadedOffering> {
  const offeringDir = path.resolve(resolveOfferingsRoot(agentDirName), offeringName);

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
    throw new Error(`handlers.ts in "${offeringName}" must export an executeJob function`);
  }

  return { config, handlers };
}

/**
 * List all available offering names for a given agent.
 */
export function listOfferings(agentDirName: string): string[] {
  const offeringsRoot = resolveOfferingsRoot(agentDirName);
  if (!fs.existsSync(offeringsRoot)) return [];
  return fs
    .readdirSync(offeringsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function logOfferingsStatus(
  agentDirName: string,
  offerings: string[],
  logger: Pick<typeof console, "log" | "warn"> = console
): void {
  if (offerings.length === 0) {
    logger.warn(`[seller] WARNING: No offerings discovered for agent dir "${agentDirName}"`);
  }

  logger.log(
    `[seller] Available offerings: ${offerings.length > 0 ? offerings.join(", ") : "(none)"}`
  );
}

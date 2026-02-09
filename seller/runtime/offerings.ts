// =============================================================================
// Dynamic loader for seller offerings (offering.json + handlers.ts).
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { OfferingHandlers } from "./offeringTypes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OFFERINGS_ROOT = path.resolve(__dirname, "..", "offerings");

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

function safeReadOfferingConfig(configPath: string): OfferingConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as OfferingConfig;
  } catch {
    return null;
  }
}

function resolveOfferingDir(offeringName: string): string {
  // 1) Direct folder match (legacy behavior)
  const direct = path.join(OFFERINGS_ROOT, offeringName);
  if (fs.existsSync(path.join(direct, "offering.json"))) {
    return direct;
  }

  // 2) Match by offering.json "name" (ACP jobOfferingName)
  if (!fs.existsSync(OFFERINGS_ROOT)) {
    throw new Error(`offerings directory not found: ${OFFERINGS_ROOT}`);
  }

  const dirs = fs
    .readdirSync(OFFERINGS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const d of dirs) {
    const candidate = path.join(OFFERINGS_ROOT, d.name, "offering.json");
    if (!fs.existsSync(candidate)) continue;

    const cfg = safeReadOfferingConfig(candidate);
    if (cfg?.name === offeringName) {
      return path.join(OFFERINGS_ROOT, d.name);
    }
  }

  const available = dirs
    .map((d) => {
      const cfg = safeReadOfferingConfig(
        path.join(OFFERINGS_ROOT, d.name, "offering.json")
      );
      return cfg?.name ? `${cfg.name} (dir: ${d.name})` : d.name;
    })
    .join(", ");

  throw new Error(
    `Offering not found for name "${offeringName}". Available offerings: ${available}`
  );
}

/**
 * Load a named offering from `seller/offerings/<dir>/`.
 *
 * The ACP backend uses the offering's registered name (offering.json "name").
 * We support both:
 *   - passing the offering directory name, or
 *   - passing the ACP offering name (recommended).
 */
export async function loadOffering(offeringName: string): Promise<LoadedOffering> {
  const offeringDir = resolveOfferingDir(offeringName);

  // offering.json
  const configPath = path.join(offeringDir, "offering.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`offering.json not found: ${configPath}`);
  }

  const config = safeReadOfferingConfig(configPath);
  if (!config) {
    throw new Error(`Failed to parse offering.json: ${configPath}`);
  }

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
 * List all available offering names.
 *
 * We return the ACP-registered offering names when offering.json is present,
 * falling back to directory names.
 */
export function listOfferings(): string[] {
  if (!fs.existsSync(OFFERINGS_ROOT)) return [];

  return fs
    .readdirSync(OFFERINGS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const cfg = safeReadOfferingConfig(
        path.join(OFFERINGS_ROOT, d.name, "offering.json")
      );
      return cfg?.name ?? d.name;
    });
}

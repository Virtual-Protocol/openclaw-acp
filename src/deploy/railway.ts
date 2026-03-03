// =============================================================================
// Railway CLI wrapper.
// Thin wrapper over the `railway` binary using child_process.
// Railway v4 stores config globally at ~/.railway/config.json, keyed by
// project path. We read/write that to manage per-agent project linking.
// =============================================================================

import { execSync, execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ROOT } from "../lib/config.js";
import type { RailwayProjectConfig } from "../lib/config.js";

const EXEC_OPTS = { cwd: ROOT, encoding: "utf-8" as const };
const RAILWAY_GLOBAL_CONFIG = path.resolve(os.homedir(), ".railway", "config.json");

// -- Global config helpers (Railway v4 format) --

interface RailwayGlobalProject {
  projectPath: string;
  name: string;
  project: string;
  environment: string;
  environmentName: string;
  service: string | null;
}

interface RailwayGlobalConfig {
  projects: Record<string, RailwayGlobalProject>;
  user?: { token: string };
  linkedFunctions?: unknown;
}

function readGlobalConfig(): RailwayGlobalConfig | undefined {
  try {
    const content = fs.readFileSync(RAILWAY_GLOBAL_CONFIG, "utf-8");
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function writeGlobalConfig(config: RailwayGlobalConfig): void {
  const dir = path.dirname(RAILWAY_GLOBAL_CONFIG);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(RAILWAY_GLOBAL_CONFIG, JSON.stringify(config, null, 2) + "\n");
}

// -- Project linking --

/** Read the Railway project config for the current working directory. */
export function readRailwayConfig(): RailwayProjectConfig | undefined {
  const global = readGlobalConfig();
  if (!global?.projects) return undefined;

  const entry = global.projects[ROOT];
  if (entry?.project && entry?.environment) {
    return { project: entry.project, environment: entry.environment };
  }
  return undefined;
}

/**
 * Write a Railway project link so subsequent CLI commands target this project.
 * Updates the global ~/.railway/config.json with an entry for ROOT.
 */
export function writeRailwayConfig(config: RailwayProjectConfig): void {
  const global = readGlobalConfig() ?? { projects: {} };
  if (!global.projects) global.projects = {};

  // Preserve existing entry fields, update project + environment
  const existing = global.projects[ROOT];
  global.projects[ROOT] = {
    projectPath: ROOT,
    name: existing?.name ?? "",
    project: config.project,
    environment: config.environment,
    environmentName: existing?.environmentName ?? "production",
    service: existing?.service ?? null,
  };

  writeGlobalConfig(global);
}

// -- CLI checks --

export function checkCli(): { installed: boolean; version?: string } {
  try {
    const version = execSync("railway --version", {
      ...EXEC_OPTS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

export function isLoggedIn(): boolean {
  try {
    execSync("railway whoami", {
      ...EXEC_OPTS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// -- Project management --

export function login(): void {
  try {
    execSync("railway login --browserless", {
      ...EXEC_OPTS,
      stdio: "inherit",
    });
  } catch {
    // Fall back to browser-based login if --browserless fails
    execSync("railway login", { ...EXEC_OPTS, stdio: "inherit" });
  }
}

export function initProject(name?: string): void {
  const cmd = name ? `railway init --name "${name}"` : "railway init";
  execSync(cmd, { ...EXEC_OPTS, stdio: "inherit" });
}

/** Link the named service so subsequent CLI commands (variables, logs, etc.) target it. */
export function linkService(name: string): void {
  execSync(`railway service link ${name}`, {
    ...EXEC_OPTS,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Check if a service is currently linked. */
export function hasLinkedService(): boolean {
  try {
    const status = execSync("railway status", {
      ...EXEC_OPTS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return !status.includes("Service: None");
  } catch {
    return false;
  }
}

// -- Variables --

export function setVariable(key: string, value: string): void {
  execFileSync("railway", ["variables", "set", `${key}=${value}`], {
    ...EXEC_OPTS,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function deleteVariable(key: string): void {
  execFileSync("railway", ["variables", "delete", key], {
    ...EXEC_OPTS,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function listVariables(): string {
  return execSync("railway variables", {
    ...EXEC_OPTS,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// -- Deployment --

export function up(): void {
  execSync("railway up --detach", { ...EXEC_OPTS, stdio: "inherit" });
}

export function getStatus(): string {
  return execSync("railway status", {
    ...EXEC_OPTS,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

// -- Log filtering --

export interface LogFilter {
  offering?: string;
  job?: string;
  level?: string;
}

function hasActiveFilter(filter: LogFilter): boolean {
  return !!(filter.offering || filter.job || filter.level);
}

function matchesFilter(line: string, filter: LogFilter): boolean {
  const lower = line.toLowerCase();
  if (filter.offering && !lower.includes(filter.offering.toLowerCase())) return false;
  if (filter.job && !line.includes(filter.job)) return false;
  if (filter.level && !lower.includes(filter.level.toLowerCase())) return false;
  return true;
}

export function streamLogs(follow: boolean, filter: LogFilter = {}): void {
  const active = hasActiveFilter(filter);

  // Railway v4: `railway logs` streams by default.
  // Use `--lines N` to fetch historical (non-streaming) logs.
  if (follow) {
    const child = spawn("railway", ["logs"], {
      cwd: ROOT,
      stdio: active ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (active && child.stdout) {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (matchesFilter(line, filter)) {
            process.stdout.write(line + "\n");
          }
        }
      });
    }
    process.on("SIGINT", () => {
      child.kill();
    });
    child.on("close", () => process.exit(0));
    child.unref();
    child.ref();
  } else {
    if (active) {
      const raw = execSync("railway logs --lines 50", {
        ...EXEC_OPTS,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = raw.split("\n");
      for (const line of lines) {
        if (matchesFilter(line, filter)) {
          process.stdout.write(line + "\n");
        }
      }
    } else {
      execSync("railway logs --lines 50", { ...EXEC_OPTS, stdio: "inherit" });
    }
  }
}

export function down(): void {
  execSync("railway down --yes", { ...EXEC_OPTS, stdio: "inherit" });
}

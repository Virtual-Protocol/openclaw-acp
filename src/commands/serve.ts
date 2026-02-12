// =============================================================================
// acp serve start   — Start seller runtime (daemonized)
// acp serve stop    — Stop seller runtime
// acp serve status  — Show runtime process info
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as output from "../lib/output.js";
import { getMyAgentInfo } from "../lib/wallet.js";
import {
  findSellerPid,
  isProcessRunning,
  removePidFromConfig,
  getActiveAgent,
  sanitizeAgentName,
  ROOT,
  LOGS_DIR,
} from "../lib/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -- Start --

const SELLER_LOG_PATH = path.resolve(LOGS_DIR, "seller.log");

function getOfferingsRoot(): string {
  const agent = getActiveAgent();
  const agentDir = agent ? sanitizeAgentName(agent.name) : "default";
  return path.resolve(ROOT, "src", "seller", "offerings", agentDir);
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function offeringHasLocalFiles(offeringName: string): boolean {
  const dir = path.join(getOfferingsRoot(), offeringName);
  return (
    fs.existsSync(path.join(dir, "handlers.ts")) &&
    fs.existsSync(path.join(dir, "offering.json"))
  );
}

export async function start(): Promise<void> {
  const pid = findSellerPid();
  if (pid !== undefined) {
    output.log(`  Seller already running (PID ${pid}).`);
    return;
  }

  // Warn if no offerings are listed on ACP, or if any registered offering is missing local handlers.ts or offering.json
  try {
    const agentInfo = await getMyAgentInfo();
    if (!agentInfo.jobs || agentInfo.jobs.length === 0) {
      output.warn(
        "No offerings registered on ACP. Run `acp sell create <name>` first.\n"
      );
    } else {
      const missing = agentInfo.jobs
        .filter((job) => !offeringHasLocalFiles(job.name))
        .map((job) => job.name);
      if (missing.length > 0) {
        output.warn(
          `No local offering files for ${
            missing.length
          } offering(s) registered on ACP: ${missing.join(", ")}. ` +
            `Each needs handlers.ts and offering.json in the agent's offerings directory, or jobs for these offerings will fail at runtime.\n`
        );
      }
    }
  } catch {
    // Non-fatal — proceed with starting anyway
  }

  const sellerScript = path.resolve(
    __dirname,
    "..",
    "seller",
    "runtime",
    "seller.ts"
  );
  const tsxBin = path.resolve(ROOT, "node_modules", ".bin", "tsx");

  ensureLogsDir();
  const logFd = fs.openSync(SELLER_LOG_PATH, "a");

  const sellerProcess = spawn(tsxBin, [sellerScript], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
  });

  if (!sellerProcess.pid) {
    fs.closeSync(logFd);
    output.fatal("Failed to start seller process.");
  }

  sellerProcess.unref();
  fs.closeSync(logFd);

  output.output({ pid: sellerProcess.pid, status: "started" }, () => {
    output.heading("Seller Started");
    output.field("PID", sellerProcess.pid!);
    output.field("Log", SELLER_LOG_PATH);
    output.log("\n  Run `acp serve status` to verify.");
    output.log("  Run `acp serve logs` to tail output.\n");
  });
}

// -- Stop --

export async function stop(): Promise<void> {
  const pid = findSellerPid();

  if (pid === undefined) {
    output.log("  No seller process running.");
    return;
  }

  output.log(`  Stopping seller process (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");
  } catch (err: any) {
    output.fatal(`Failed to send SIGTERM to PID ${pid}: ${err.message}`);
  }

  // Wait and verify
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
    output.output({ pid, status: "stopped" }, () => {
      output.log(`  Seller process (PID ${pid}) stopped.\n`);
    });
  } else {
    output.error(
      `Process (PID ${pid}) did not stop within 2 seconds. Try: kill -9 ${pid}`
    );
  }
}

// -- Status --

export async function status(): Promise<void> {
  const pid = findSellerPid();
  const running = pid !== undefined;

  output.output({ running, pid: pid ?? null }, () => {
    output.heading("Seller Runtime");
    if (running) {
      output.field("Status", "Running");
      output.field("PID", pid!);
    } else {
      output.field("Status", "Not running");
    }
    output.log("\n  Run `acp sell list` to see offerings.\n");
  });
}

// -- Logs --

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
  if (filter.offering && !lower.includes(filter.offering.toLowerCase()))
    return false;
  if (filter.job && !line.includes(filter.job)) return false;
  if (filter.level && !lower.includes(filter.level.toLowerCase()))
    return false;
  return true;
}

export async function logs(
  follow: boolean = false,
  filter: LogFilter = {}
): Promise<void> {
  if (!fs.existsSync(SELLER_LOG_PATH)) {
    output.log(
      "  No log file found. Start the seller first: `acp serve start`\n"
    );
    return;
  }

  const active = hasActiveFilter(filter);

  if (follow) {
    const tail = spawn("tail", ["-f", SELLER_LOG_PATH], {
      stdio: active ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (active && tail.stdout) {
      let buffer = "";
      tail.stdout.on("data", (chunk: Buffer) => {
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

    // Keep running until user hits Ctrl+C
    await new Promise<void>((resolve) => {
      tail.on("close", () => resolve());
      process.on("SIGINT", () => {
        tail.kill();
        resolve();
      });
    });
  } else {
    // Show the last 50 lines (or last 50 matching lines if filtered)
    const content = fs.readFileSync(SELLER_LOG_PATH, "utf-8");
    const lines = content.split("\n");
    const filtered = active
      ? lines.filter((l: string) => matchesFilter(l, filter))
      : lines;
    const last50 = filtered.slice(-51).join("\n"); // -51 because trailing newline
    if (last50.trim()) {
      output.log(last50);
    } else {
      output.log(
        active
          ? "  No log lines matched the filter.\n"
          : "  Log file is empty.\n"
      );
    }
  }
}

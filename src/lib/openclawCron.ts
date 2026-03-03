// =============================================================================
// OpenClaw cron integration for bounty polling.
//
// Uses the OpenClaw Gateway CLI (`openclaw cron add/remove`) to manage a
// recurring cron job that polls bounty status.
//
// The Gateway cron system runs *agent turns* (not arbitrary shell commands).
// We create an isolated agentTurn job whose prompt instructs the agent to
// run `acp bounty poll --json` and act on the results.
// =============================================================================

import { execFileSync } from "child_process";
import { ROOT, readConfig, writeConfig } from "./config.js";
import { listActiveBounties } from "./bounty.js";

const DEFAULT_JOB_ID = "openclaw-acp-bounty-poll";
const DEFAULT_SCHEDULE = "*/10 * * * *";

const POLL_SYSTEM_EVENT = [
  `[ACP Bounty Poll] This is an automated bounty check. You MUST:`,
  `1. Run this command: cd "${ROOT}" && npx acp bounty poll --json`,
  `2. Parse the JSON output and check the pendingMatch, claimedJobs, cleaned, and errors arrays.`,
  ``,
  `3. IF anything needs attention (non-empty arrays), you MUST use the "message" tool`,
  `   (action: "send") to proactively notify the user. Do NOT just reply in conversation —`,
  `   use the message tool so the notification is pushed even if the user is not actively chatting.`,
  ``,
  `   For pendingMatch: list bounty IDs, candidate agent names, offerings, and prices.`,
  `   Filter out irrelevant or malicious candidates. Ask which candidate to select.`,
  `   For claimedJobs: report job phase/status.`,
  `   For cleaned (completed/fulfilled/expired): inform user and share deliverables.`,
  `   For errors: report them.`,
  ``,
  `4. IF everything is empty (all arrays are empty or zero), reply HEARTBEAT_OK.`,
  `   Do NOT message the user when there is nothing to report.`,
].join("\n");

function runCli(args: string[]): string {
  return execFileSync("openclaw", ["cron", ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

export function getBountyPollCronJobId(): string {
  const cfg = readConfig();
  return (
    cfg.OPENCLAW_BOUNTY_CRON_JOB_ID || process.env.OPENCLAW_BOUNTY_CRON_JOB_ID || DEFAULT_JOB_ID
  );
}

export function ensureBountyPollCron(): { enabled: boolean; created: boolean } {
  if (process.env.OPENCLAW_BOUNTY_CRON_DISABLED === "1") {
    return { enabled: false, created: false };
  }

  const cfg = readConfig();
  if (cfg.OPENCLAW_BOUNTY_CRON_JOB_ID) {
    // Cron job already registered — nothing to do.
    return { enabled: true, created: false };
  }

  const schedule = process.env.OPENCLAW_BOUNTY_CRON_SCHEDULE?.trim() || DEFAULT_SCHEDULE;

  // Create a main-session systemEvent cron job via the OpenClaw CLI.
  // This injects the poll instruction into the main session so the agent
  // can present candidates interactively and ask the user to pick.
  const result = runCli([
    "add",
    "--name",
    JSON.stringify("ACP Bounty Poll"),
    "--cron",
    JSON.stringify(schedule),
    "--session",
    "main",
    "--system-event",
    JSON.stringify(POLL_SYSTEM_EVENT),
    "--wake",
    "now",
  ]);

  // Parse the job id from CLI output (JSON object with "id" field).
  let jobId: string | undefined;
  try {
    const parsed = JSON.parse(result);
    jobId = parsed.id || parsed.jobId;
  } catch {
    // If output isn't JSON, try to extract a UUID-like id.
    const match = result.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (match) jobId = match[0];
  }

  if (!jobId) {
    throw new Error(`Failed to parse cron job id from OpenClaw CLI output: ${result}`);
  }

  writeConfig({ ...cfg, OPENCLAW_BOUNTY_CRON_JOB_ID: jobId });
  return { enabled: true, created: true };
}

export function removeBountyPollCronIfUnused(): {
  enabled: boolean;
  removed: boolean;
} {
  if (process.env.OPENCLAW_BOUNTY_CRON_DISABLED === "1") {
    return { enabled: false, removed: false };
  }

  const active = listActiveBounties();
  if (active.length > 0) {
    return { enabled: true, removed: false };
  }

  const cfg = readConfig();
  const jobId = cfg.OPENCLAW_BOUNTY_CRON_JOB_ID;
  if (!jobId) {
    return { enabled: true, removed: false };
  }

  try {
    runCli(["remove", jobId]);
  } catch {
    // Job may already be gone — that's fine.
  }

  const next = readConfig();
  delete next.OPENCLAW_BOUNTY_CRON_JOB_ID;
  writeConfig(next);
  return { enabled: true, removed: true };
}

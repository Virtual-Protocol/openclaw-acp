// =============================================================================
// acp agent list    — Show all agents (fetches from server, auto-login if needed)
// acp agent switch  — Switch active agent (regenerates API key, auto-login if needed)
// acp agent create  — Create a new agent (auto-login if needed)
// =============================================================================

import readline from "readline";
import * as output from "../lib/output.js";
import {
  readConfig,
  writeConfig,
  getActiveAgent,
  findAgentByName,
  activateAgent,
  findSellerPid,
  isProcessRunning,
  removePidFromConfig,
  type AgentEntry,
} from "../lib/config.js";
import {
  ensureSession,
  fetchAgents,
  createAgentApi,
  regenerateApiKey,
  syncAgentsToConfig,
} from "../lib/auth.js";

function redactApiKey(key: string | undefined): string {
  if (!key || key.length < 8) return "(not available)";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes" || a === "");
    });
  });
}

function killSellerProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  // Wait up to 2 seconds for process to stop
  for (let i = 0; i < 10; i++) {
    const start = Date.now();
    while (Date.now() - start < 200) { /* busy wait */ }
    if (!isProcessRunning(pid)) {
      removePidFromConfig();
      return true;
    }
  }
  return false;
}

/**
 * Check if seller runtime is running. If so, warn the user and ask for
 * confirmation to stop it. Returns true if it's safe to proceed (no seller
 * running, or seller was stopped). Returns false if the user cancelled.
 * Calls output.fatal (exits) if the seller could not be killed.
 */
export async function stopSellerIfRunning(): Promise<boolean> {
  const sellerPid = findSellerPid();
  if (sellerPid === undefined) return true;

  const active = getActiveAgent();
  const activeName = active ? `"${active.name}"` : "the current agent";

  let offeringNames: string[] = [];
  try {
    const { getMyAgentInfo } = await import("../lib/wallet.js");
    const info = await getMyAgentInfo();
    offeringNames = (info.jobs ?? []).map((j: any) => j.name);
  } catch {
    // Non-fatal — just won't show offering names
  }

  const offeringsLine = offeringNames.length > 0
    ? `\n  Active Job Offerings being served: ${offeringNames.join(", ")}\n`
    : "";
  output.warn(
    `Seller runtime process is running (PID ${sellerPid}) for ${activeName}. ` +
    `It must be stopped before switching agents, because the runtime ` +
    `is tied to the current agent's API key.${offeringsLine}\n`
  );
  const ok = await confirmPrompt("  Stop the seller runtime process and continue? (Y/n): ");
  if (!ok) {
    return false;
  }
  output.log(`  Stopping seller runtime (PID ${sellerPid})...`);
  const stopped = killSellerProcess(sellerPid);
  if (stopped) {
    output.log(`  Seller runtime stopped.\n`);
    return true;
  }
  output.fatal(
    `Could not stop seller process (PID ${sellerPid}). Try: kill -9 ${sellerPid}`
  );
  return false; // unreachable (fatal exits), but satisfies TS
}

function displayAgents(agents: AgentEntry[]): void {
  output.heading("Agents");
  for (const a of agents) {
    const marker = a.active ? output.colors.green(" (active)") : "";
    output.log(`  ${output.colors.bold(a.name)}${marker}`);
    output.log(`    ${output.colors.dim("Wallet")}  ${a.walletAddress}`);
    if (a.apiKey) {
      output.log(`    ${output.colors.dim("API Key")} ${redactApiKey(a.apiKey)}`);
    }
    output.log("");
  }
}

export async function list(): Promise<void> {
  const sessionToken = await ensureSession();
  let agents: AgentEntry[];

  try {
    const serverAgents = await fetchAgents(sessionToken);
    agents = syncAgentsToConfig(serverAgents);
  } catch (e) {
    output.warn(
      `Could not fetch agents from server: ${e instanceof Error ? e.message : String(e)}`
    );
    output.log("  Showing locally saved agents.\n");
    agents = readConfig().agents ?? [];
  }

  if (agents.length === 0) {
    output.output({ agents: [] }, () => {
      output.log("  No agents found. Run `acp agent create <name>` to create one.\n");
    });
    return;
  }

  output.output(
    agents.map((a) => ({
      name: a.name,
      id: a.id,
      walletAddress: a.walletAddress,
      active: a.active,
    })),
    () => displayAgents(agents)
  );
}

export async function switchAgent(name: string): Promise<void> {
  if (!name) {
    output.fatal("Usage: acp agent switch <name>");
  }

  // Check the agent exists locally (must have run `agent list` at least once)
  const target = findAgentByName(name);
  if (!target) {
    const config = readConfig();
    const names = (config.agents ?? []).map((a) => a.name).join(", ");
    output.fatal(
      `Agent "${name}" not found. Run \`acp agent list\` first. Available: ${names || "(none)"}`
    );
  }

  // Stop seller runtime if running (API key will change)
  const proceed = await stopSellerIfRunning();
  if (!proceed) {
    output.log("  Agent switch cancelled.\n");
    return;
  }

  // Regenerate API key (requires auth)
  const sessionToken = await ensureSession();

  output.log(`  Switching to ${target.name}...\n`);
  try {
    const result = await regenerateApiKey(sessionToken, target.walletAddress);
    activateAgent(target.id, result.apiKey);

    output.output(
      { switched: true, name: target.name, walletAddress: target.walletAddress },
      () => {
        output.success(`Switched to agent: ${target.name}`);
        output.log(`    Wallet:  ${target.walletAddress}`);
        output.log(`    API Key: ${redactApiKey(result.apiKey)} (regenerated)\n`);
      }
    );
  } catch (e) {
    output.fatal(
      `Failed to switch agent: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

export async function create(name: string): Promise<void> {
  if (!name) {
    output.fatal("Usage: acp agent create <name>");
  }

  // Stop seller runtime if running (API key will change)
  const proceed = await stopSellerIfRunning();
  if (!proceed) {
    output.log("  Agent creation cancelled.\n");
    return;
  }

  const sessionToken = await ensureSession();

  try {
    const result = await createAgentApi(sessionToken, name);
    if (!result?.apiKey) {
      output.fatal("Create agent failed — no API key returned.");
    }

    // Add to local config and activate
    const config = readConfig();
    const updatedAgents: AgentEntry[] = (config.agents ?? []).map((a) => ({
      ...a,
      active: false,
      apiKey: undefined, // clear other agents' keys
    }));
    const newAgent: AgentEntry = {
      id: result.id,
      name: result.name || name,
      walletAddress: result.walletAddress,
      apiKey: result.apiKey,
      active: true,
    };
    updatedAgents.push(newAgent);

    writeConfig({
      ...config,
      LITE_AGENT_API_KEY: result.apiKey,
      agents: updatedAgents,
    });

    output.output(
      {
        created: true,
        name: newAgent.name,
        id: newAgent.id,
        walletAddress: newAgent.walletAddress,
      },
      () => {
        output.success(`Agent created: ${newAgent.name}`);
        output.log(`    Wallet:  ${newAgent.walletAddress}`);
        output.log(`    API Key: ${redactApiKey(newAgent.apiKey)} (saved to config.json)\n`);
      }
    );
  } catch (e) {
    output.fatal(
      `Create agent failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

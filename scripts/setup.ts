#!/usr/bin/env -S npx tsx
/**
 * Interactive setup for OpenClaw ACP skill.
 * Run: npm run setup
 *
 * Step 1: 3-legged OAuth — get login link → user completes → check auth-status → then create agent, generate API key, store it.
 */

import readline from "readline";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import dotenv from "dotenv";
import axios, { type AxiosInstance } from "axios";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONFIG_JSON_PATH = path.join(ROOT, "config.json");
const ENV_KEYS = {
  LITE_AGENT_API_KEY: "LITE_AGENT_API_KEY",
  SESSION_TOKEN: "SESSION_TOKEN",
};

const SESSION_TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

interface AuthUrlResponse {
  authUrl: string;
  requestId: string;
}

interface AuthStatusResponse {
  token: string;
}

interface CreateAgentResponse {
  id: string;
  name: string;
  apiKey: string;
  walletAddress: string;
}

/** Axios instance for unauthenticated endpoints (auth-url, auth-status). */
const API_URL = "https://acpx.virtuals.io";
function apiClient(): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: { "Content-Type": "application/json" },
  });
}

/** Axios instance for session-authenticated endpoints (create agent, generate API key). */
function apiClientWithSession(sessionToken: string): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

interface SessionTokenConfig {
  token: string;
  expiry: string;
}

interface SetupConfig {
  SESSION_TOKEN?: SessionTokenConfig;
  LITE_AGENT_API_KEY?: string;
  [key: string]: unknown;
}

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

/** Redact sensitive values (API keys) for safe stdout logging */
function redactApiKey(key: string): string {
  if (!key || key.length < 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function log(msg: string): void {
  console.log(msg);
}

function logStep(step: number, title: string): void {
  log(`\n--- Step ${step}: ${title} ---\n`);
}

async function getAuthUrl(): Promise<AuthUrlResponse> {
  const { data } = await apiClient().get<{ data: AuthUrlResponse }>(
    "/api/auth/lite/auth-url"
  );
  return data.data;
}

async function getAuthStatus(requestId: string): Promise<AuthStatusResponse> {
  const { data } = await apiClient().get<{ data: AuthStatusResponse }>(
    `/api/auth/lite/auth-status?requestId=${requestId}`
  );
  return data.data;
}

async function createAgent(
  sessionToken: string,
  agentName: string
): Promise<CreateAgentResponse> {
  const { data } = await apiClientWithSession(sessionToken).post<{
    data: CreateAgentResponse;
  }>("/api/agents/lite/key", {
    data: {
      name: agentName.trim(),
    },
  });
  return data.data;
}

function readConfigJson(): SetupConfig {
  if (!fs.existsSync(CONFIG_JSON_PATH)) return {};
  try {
    const raw = fs.readFileSync(CONFIG_JSON_PATH, "utf8");
    const config = JSON.parse(raw) as unknown;
    return config && typeof config === "object" ? (config as SetupConfig) : {};
  } catch {
    return {};
  }
}

function writeConfigJson(updates: Partial<SetupConfig>): void {
  const existing = readConfigJson();
  const merged = { ...existing, ...updates };
  fs.writeFileSync(CONFIG_JSON_PATH, JSON.stringify(merged, null, 2), "utf8");
}

function getValidSessionToken(): string | null {
  const config = readConfigJson();
  const st = config?.SESSION_TOKEN;
  if (!st?.token || !st?.expiry) return null;
  if (new Date(st.expiry) <= new Date()) return null;
  return st.token;
}

function storeSessionToken(token: string): void {
  const expiry = new Date(Date.now() + SESSION_TOKEN_EXPIRY_MS).toISOString();
  writeConfigJson({ [ENV_KEYS.SESSION_TOKEN]: { token, expiry } });
}

function hasApiKeyConfigured(): boolean {
  if (process.env[ENV_KEYS.LITE_AGENT_API_KEY]?.trim()) return true;
  const config = readConfigJson();
  const key = config?.[ENV_KEYS.LITE_AGENT_API_KEY];
  return typeof key === "string" && key.trim().length > 0;
}

function runLaunchMyToken(
  symbol: string,
  description: string,
  imageUrl?: string
): Promise<void> {
  const args = [
    "tsx",
    "scripts/index.ts",
    "launch_my_token",
    symbol,
    description,
  ];
  if (imageUrl) args.push(imageUrl);
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}`))
    );
  });
}

async function main(): Promise<void> {
  log("\n🔧 OpenClaw ACP skill — setup\n");

  const existingSession = getValidSessionToken();
  if (existingSession) {
    log(
      "✓ Valid session found in config.json (not expired), skipping login.\n"
    );
  } else {
    logStep(1, "Log in to app.virtuals.io");
    let authDone = false;
    while (!authDone) {
      let authUrl: string;
      let requestId: string;
      try {
        const auth = await getAuthUrl();
        authUrl = auth.authUrl;
        requestId = auth.requestId;
      } catch (e) {
        log(
          `⚠ Could not get login link: ${
            e instanceof Error ? e.message : String(e)
          }\n`
        );
        await question("Press Enter to retry or Ctrl+C to exit.");
        continue;
      }
      log(`Login link ${authUrl} (OpenClaw: Display the link to the user)\n`);
      log("Press ENTER when you have completed the login.\n");
      await question("");
      try {
        const status = await getAuthStatus(requestId);
        if (status.token) {
          storeSessionToken(status.token);
          log(
            "✓ Login success. Session stored in config.json (expiry 30 minutes).\n"
          );
          authDone = true;
        } else {
          log("Login incomplete. Press ENTER to retry or Ctrl+C to exit.\n");
          await question("");
        }
      } catch (e) {
        log(
          `Login check failed: ${
            e instanceof Error ? e.message : String(e)
          }. Press ENTER to retry or Ctrl+C to exit.\n`
        );
        await question("");
      }
    }
  }

  logStep(2, "Create agent");
  const agentName = (await question("Enter agent name: ")).trim();
  if (agentName.trim().length > 0) {
    log(`Agent name: ${agentName}\n`);
    const sessionToken = getValidSessionToken();
    if (sessionToken) {
      try {
        const result = await createAgent(sessionToken, agentName);

        if (result?.apiKey) {
          writeConfigJson({ [ENV_KEYS.LITE_AGENT_API_KEY]: result.apiKey });
          log(
            `✓ Agent created.\n  Wallet address: ${
              result.walletAddress
            }\n  API key: ${redactApiKey(
              result.apiKey
            )} (saved to config.json)\n`
          );
        } else {
          log(`⚠ Create agent failed. Please try again.\n`);
        }
      } catch (e) {
        log(
          `⚠ Create agent failed: ${
            e instanceof Error ? e.message : String(e)
          }\n`
        );
      }
    } else {
      log("⚠ No valid session token. Complete Step 1 (login) first.\n");
    }
  }

  logStep(3, "Launch your agent token (optional)");
  log(
    "🚀 Tokenize your agent to unlock funding and revenue streams:\n" +
      "   • Capital formation — raise funds for your agent's development and compute costs\n" +
      "   • Revenue generation — earn from trading fees and taxes, automatically sent to your agent wallet\n" +
      "   • Enhanced capabilities — use earned funds to procure services from other agents on ACP\n" +
      "   • Value accrual — your token gains value as your agent's capabilities and attention grow\n" +
      "\n   Each agent can launch one unique token. This is optional and can be done anytime.\n"
  );
  if (!hasApiKeyConfigured()) {
    log(
      `LITE_AGENT_API_KEY is not set. Add it to config.json or .env, then run setup again or: npx tsx scripts/index.ts launch_my_token "<symbol>" "<description>"\n`
    );
  } else {
    const launch = (
      await question("Would you like to launch your agent token now? (Y/n): ")
    )
      .trim()
      .toLowerCase();
    if (launch === "y" || launch === "yes" || launch === "") {
      const symbol = (await question("Token symbol (e.g. MYAGENT): ")).trim();
      const description = (await question("Token description: ")).trim();
      const imageUrl = (
        await question("Image URL (optional, press Enter to skip): ")
      ).trim();
      if (!symbol || !description) {
        log("Symbol and description are required. Skipping token launch.\n");
      } else {
        try {
          await runLaunchMyToken(symbol, description, imageUrl || undefined);
          log("\n✓ Token launched successfully!\n");
        } catch (e) {
          log(
            '\n⚠ Token launch failed. You can try again later: npx tsx scripts/index.ts launch_my_token "<symbol>" "<description>"\n'
          );
        }
      }
    }
  }

  log(
    "Setup finished. You can use the skill with: npx tsx scripts/index.ts <tool> [params]\n"
  );
  rl.close();
}

main().catch((e) => {
  console.error(e);
  rl.close();
  process.exit(1);
});

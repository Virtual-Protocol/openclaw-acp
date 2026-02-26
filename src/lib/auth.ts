// =============================================================================
// Auth + Agent management API (acpx.virtuals.io)
// Shared by setup.ts, agent.ts, and any command needing session-based APIs.
// =============================================================================

import axios, { type AxiosInstance } from "axios";
import * as output from "./output.js";
import { openUrl } from "./open.js";
import { readConfig, writeConfig, type AgentEntry } from "./config.js";
import client from "./client.js";

const API_URL = process.env.ACP_AUTH_URL || "https://acpx.virtuals.io";

// -- Response types --

export interface AuthUrlResponse {
  authUrl: string;
  requestId: string;
}

export interface AuthStatusResponse {
  token: string;
}

/** Returned by list agents — no API key (never exposed after creation). */
export interface AgentInfoResponse {
  id: string;
  name: string;
  walletAddress: string;
}

/** Returned by create agent — API key shown once. */
export interface AgentKeyResponse {
  id: string;
  name: string;
  apiKey: string;
  walletAddress: string;
}

/** Returned by regenerate — fresh API key for an existing agent. */
export interface RegenerateKeyResponse {
  apiKey: string;
}

// -- HTTP clients --

function apiClient(): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: { "Content-Type": "application/json" },
  });
}

function apiClientWithSession(sessionToken: string): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}

// -- Session token --

/** Decode the exp claim from a JWT without verifying the signature. */
function getJwtExpiry(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // @ts-ignore
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1000); // exp is seconds since epoch
    }
    return null;
  } catch {
    return null;
  }
}

export function getValidSessionToken(): string | null {
  const config = readConfig();
  const token = config?.SESSION_TOKEN?.token;
  if (!token) return null;

  const expiry = getJwtExpiry(token);
  if (!expiry || expiry <= new Date()) return null;
  return token;
}

export function storeSessionToken(token: string): void {
  const config = readConfig();
  writeConfig({ ...config, SESSION_TOKEN: { token } });
}

// -- Auth API --

export async function getAuthUrl(): Promise<AuthUrlResponse> {
  const { data } = await apiClient().get<{ data: AuthUrlResponse }>("/api/auth/lite/auth-url");
  return data.data;
}

export async function getAuthStatus(requestId: string): Promise<AuthStatusResponse | null> {
  const { data } = await apiClient().get<{ data: AuthStatusResponse }>(
    "/api/auth/lite/auth-status",
    { params: { requestId } }
  );
  return data?.data ?? null;
}

// -- Agent API --

/** Fetch all agents belonging to the authenticated user. No API keys returned. */
export async function fetchAgents(sessionToken: string): Promise<AgentInfoResponse[]> {
  const { data } = await apiClientWithSession(sessionToken).get<{
    data: AgentInfoResponse[];
  }>("/api/agents/lite");
  return data.data;
}

/** Create a new agent for the authenticated user. API key returned once. */
export async function createAgentApi(
  sessionToken: string,
  agentName: string
): Promise<AgentKeyResponse> {
  const { data } = await apiClientWithSession(sessionToken).post<{
    data: AgentKeyResponse;
  }>("/api/agents/lite/key", {
    data: { name: agentName.trim() },
  });
  return data.data;
}

/** Regenerate the API key for an existing agent. Returns a fresh key. */
export async function regenerateApiKey(
  sessionToken: string,
  walletAddress: string
): Promise<RegenerateKeyResponse> {
  const { data } = await apiClientWithSession(sessionToken).post<{
    data: RegenerateKeyResponse;
  }>(`/api/agents/lite/${walletAddress}/regenerate-api`);
  return data.data;
}

export async function isAgentApiKeyValid(apiKey: string): Promise<boolean> {
  return await client
    .get("/acp/me", {
      headers: {
        "x-api-key": apiKey,
      },
    })
    .then(() => true)
    .catch(() => false);
}

// -- Login (polling-based, no stdin required) --

/** How often to poll the auth status endpoint (ms). */
const AUTH_POLL_INTERVAL_MS = 5_000;

/** How long to wait for the user to authenticate before timing out (ms). */
const AUTH_TIMEOUT_MS = 5 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Login flow. Opens browser / prints link, then polls until authenticated
 * or timed out. No stdin interaction required — works in any runtime.
 */
export async function interactiveLogin(): Promise<void> {
  let auth: AuthUrlResponse;
  try {
    auth = await getAuthUrl();
  } catch (e) {
    output.fatal(`Could not get login link: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { authUrl, requestId } = auth;
  openUrl(authUrl);

  output.output(
    {
      action: "open_url",
      url: authUrl,
      message: "Authenticate at this URL to continue.",
    },
    () => {
      output.log(`  Opening browser...`);
      output.log(`  Login link: ${authUrl}\n`);
      output.log(`  Waiting for authentication (timeout: ${AUTH_TIMEOUT_MS / 1_000}s)...\n`);
    }
  );

  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  let elapsed = 0;

  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS);
    elapsed += AUTH_POLL_INTERVAL_MS;

    try {
      const status = await getAuthStatus(requestId);
      if (status?.token) {
        storeSessionToken(status.token);
        output.output(
          {
            status: "authenticated",
            message: "Login success. Session stored.",
          },
          () => output.success("Login success. Session stored.\n")
        );
        return;
      }
    } catch (err) {
      // Auth not ready yet or transient error — keep polling
    }

    // Progress indicator every 15s (3 polls)
    if (elapsed % 15_000 === 0) {
      const remaining = Math.round((deadline - Date.now()) / 1_000);
      output.log(`  Still waiting... (${remaining}s remaining)`);
    }
  }

  output.fatal(
    `Authentication timed out after ${AUTH_TIMEOUT_MS / 1_000}s. Run \`acp login\` to try again.`
  );
}

/**
 * Ensure we have a valid session token. If expired/missing, auto-prompts login.
 * Returns the valid session token, or calls process.exit if login fails.
 */
export async function ensureSession(): Promise<string> {
  const existing = getValidSessionToken();
  if (existing) return existing;

  output.warn("Session expired or not found. Logging in...\n");
  await interactiveLogin();

  const token = getValidSessionToken();
  if (!token) {
    output.fatal("Login failed. Cannot continue.");
  }
  return token;
}

// -- Agent sync --

/**
 * Merge server agents into local config. Returns the merged list.
 * Server does NOT return API keys — only id, name, walletAddress.
 * Local API keys (from create/regenerate) are preserved.
 */
export function syncAgentsToConfig(serverAgents: AgentInfoResponse[]): AgentEntry[] {
  const config = readConfig();
  const localAgents = config.agents ?? [];

  const localMap = new Map<string, AgentEntry>();
  for (const a of localAgents) {
    localMap.set(a.id, a);
  }

  const merged: AgentEntry[] = serverAgents.map((s) => {
    const local = localMap.get(s.id);
    return {
      id: s.id,
      name: s.name,
      walletAddress: s.walletAddress,
      apiKey: local?.apiKey, // preserve local key if we have one
      active: local?.active ?? false,
    };
  });

  writeConfig({ ...config, agents: merged });
  return merged;
}

#!/usr/bin/env npx tsx
/**
 * ACP Skill — CLI only.
 *
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import axios from "axios";

// Resolve paths from script location so CLI works when run from any cwd (e.g. by OpenClaw)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load config from config.json
const configPath = path.join(ROOT, "config.json");
let CONFIG: Record<string, unknown> = {};
if (fs.existsSync(configPath)) {
  try {
    CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!process.env.LITE_AGENT_API_KEY) {
      const key = CONFIG?.LITE_AGENT_API_KEY;
      if (typeof key === "string" && key.trim())
        process.env.LITE_AGENT_API_KEY = key as string;
    }
  } catch {
    // ignore
  }
}

// Claw Bounty fallback configuration
const CLAWBOUNTY_API_URL = (CONFIG.CLAWBOUNTY_API_URL as string) || "https://clawbounty.io";
const AGENT_NAME = (CONFIG.AGENT_NAME as string) || "Unknown Agent";

/**
 * Interfaces
 */
interface IAgents {
  id: string;
  name: string;
  walletAddress: string;
  description: string;
  jobOfferings: {
    name: string;
    price: number;
    priceType: string;
    requirement: string;
  }[];
}

interface IWalletBalances {
  network: string;
  symbol: string;
  tokenAddress: string;
  tokenBalance: string;
  decimals: number;
  tokenPrices: { usd: number }[];
  tokenMetadata: {
    decimals: number | null;
    logo: string | null;
    name: string | null;
    symbol: string | null;
  };
}

type ToolHandler = {
  validate: (args: string[]) => string | null;
  run: (args: string[]) => Promise<unknown>;
};

/**
 * Output Helpers
 */
const out = (data: unknown): void => {
  console.log(JSON.stringify(data));
};

const cliErr = (message: string): never => {
  out({ error: message });
  process.exit(1);
};

/**
 * API Client
 */
const client = axios.create({
  baseURL: "https://claw-api.virtuals.io",
  headers: {
    "x-api-key": process.env.LITE_AGENT_API_KEY,
  },
});

client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      throw new Error(JSON.stringify(error.response.data));
    }
    throw error;
  }
);

/**
 * Start Api Functions
 */
async function browseAgents(query: string) {
  const agents = await client.get<{ data: IAgents[] }>(
    `/acp/agents?query=${query}`
  );
  if (!agents || agents.data.data.length === 0) {
    return cliErr("No agents found");
  }
  const formattedAgents = agents.data.data.map((agent) => ({
    id: agent.id,
    name: agent.name,
    walletAddress: agent.walletAddress,
    description: agent.description,
    jobOfferings: (agent.jobOfferings || []).map((job) => ({
      name: job.name,
      price: job.price,
      priceType: job.priceType,
      requirement: job.requirement,
    })),
  }));
  return out(formattedAgents);
}

async function executeAcpJob(
  agentWalletAddress: string,
  jobOfferingName: string,
  serviceRequirements: Record<string, unknown>
) {
  const job = await client.post<{ data: { jobId: number } }>("/acp/jobs", {
    providerWalletAddress: agentWalletAddress,
    jobOfferingName,
    serviceRequirements,
  });
  return out(job.data);
}

async function pollJob(jobId: number) {
  const job = await client.get(`/acp/jobs/${jobId}`);
  if (!job) {
    return cliErr(`Job not found: ${jobId}`);
  }
  return out(job.data);
}

async function getWalletAddress() {
  const wallet = await client.get("/acp/me");
  return out(wallet.data.data);
}

async function getWalletBalance() {
  const balances = await client.get<{ data: IWalletBalances[] }>(
    "/acp/wallet-balances"
  );

  return out(
    balances.data.data.map((token) => ({
      network: token.network,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      tokenBalance: token.tokenBalance,
      tokenMetadata: token.tokenMetadata,
      decimals: token.decimals,
      tokenPrices: token.tokenPrices,
    }))
  );
}

async function launchMyToken(
  symbol: string,
  description: string,
  imageUrl?: string
) {
  const token = await client.post("/acp/me/tokens", {
    symbol,
    description,
    imageUrl,
  });
  return out(token.data);
}

async function getMyToken() {
  const token = await client.get("/acp/me/tokens");
  return out(token.data);
}

/**
 * Job Status Detection for Bounty Fallback
 */
interface JobData {
  data: {
    jobId: number;
    phase: string;
    expiry: number;
    deliverable: unknown;
    memos: Array<{
      id: number;
      content: string;
      nextPhase: string;
      status: string;
      signedReason: string | null;
    }>;
    providerName?: string;
    providerWallet?: string;
    jobOfferingName?: string;
    serviceRequirements?: Record<string, unknown>;
  };
}

type JobStatus = "pending" | "success" | "failed" | "stuck" | "rejected";

function detectJobStatus(job: JobData): { status: JobStatus; reason: string } {
  const { phase, expiry, memos } = job.data;
  const now = Date.now();
  
  // Check if job expired
  if (expiry && expiry * 1000 < now) {
    return { status: "failed", reason: "Job expired" };
  }
  
  // Check for rejected memos
  const rejected = memos.find(m => m.status === "REJECTED");
  if (rejected) {
    return { status: "rejected", reason: rejected.signedReason || "Provider rejected the job" };
  }
  
  // Check for completion
  if (phase === "COMPLETED") {
    return { status: "success", reason: "Job completed successfully" };
  }
  
  // Check for stuck in EVALUATION with PENDING memo for too long
  if (phase === "EVALUATION") {
    const pendingMemo = memos.find(m => m.status === "PENDING" && m.nextPhase === "EVALUATION");
    if (pendingMemo) {
      // If there's an undefined in memo content, it's likely broken
      if (pendingMemo.content?.includes("undefined")) {
        return { status: "stuck", reason: "Job stuck with invalid data" };
      }
    }
  }
  
  return { status: "pending", reason: `Job in progress (${phase})` };
}

/**
 * Claw Bounty Fallback Integration
 * When ACP jobs fail, automatically escalate to clawbounty.io
 */
interface BountyPostResult {
  success: boolean;
  bounty_id?: number;
  bounty_url?: string;
  message: string;
  acp_match?: {
    found: boolean;
    agents: Array<{ name: string; wallet_address: string }>;
  };
}

async function postBountyFallback(
  title: string,
  description: string,
  requirements: string,
  budget: number,
  category: "digital" | "physical" = "digital",
  callbackUrl?: string
): Promise<BountyPostResult> {
  try {
    const response = await axios.post(`${CLAWBOUNTY_API_URL}/api/bounties/`, {
      poster_name: AGENT_NAME,
      poster_callback_url: callbackUrl,
      title,
      description,
      requirements,
      budget,
      category,
      tags: "acp-fallback,automated"
    });
    
    const data = response.data;
    
    if (data.action === "acp_available") {
      return {
        success: true,
        message: data.message,
        acp_match: data.acp_match
      };
    }
    
    return {
      success: true,
      bounty_id: data.bounty?.id,
      bounty_url: `${CLAWBOUNTY_API_URL}/bounties/${data.bounty?.id}`,
      message: data.message
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to post bounty: ${msg}`
    };
  }
}

async function pollJobWithFallback(
  jobId: number,
  fallbackBudget: number = 50,
  callbackUrl?: string
) {
  const job = await client.get<JobData>(`/acp/jobs/${jobId}`);
  if (!job) {
    return cliErr(`Job not found: ${jobId}`);
  }
  
  const { status, reason } = detectJobStatus(job.data);
  
  if (status === "success" || status === "pending") {
    // Job ok or still running - no fallback needed
    return out({
      job: job.data,
      fallback_triggered: false,
      status,
      reason
    });
  }
  
  // Job failed/stuck/rejected - post bounty fallback
  const jobData = job.data.data;
  const title = `[ACP Fallback] ${jobData.jobOfferingName || "Job"} - ${jobData.providerName || "Unknown"}`;
  const description = `ACP job #${jobId} ${status}. Reason: ${reason}\n\nOriginal job details:\n- Provider: ${jobData.providerName || "Unknown"}\n- Service: ${jobData.jobOfferingName || "Unknown"}\n- Requirements: ${JSON.stringify(jobData.serviceRequirements || {})}`;
  const requirements = JSON.stringify(jobData.serviceRequirements || {});
  
  const bountyResult = await postBountyFallback(
    title,
    description,
    requirements,
    fallbackBudget,
    "digital",
    callbackUrl
  );
  
  return out({
    job: job.data,
    fallback_triggered: true,
    status,
    reason,
    bounty: bountyResult
  });
}

/**
 * Tools Registry
 */
const TOOLS: Record<string, ToolHandler> = {
  browse_agents: {
    validate: (args) =>
      !args[0]?.trim() ? 'Usage: browse_agents "<query>"' : null,
    run: async (args) => {
      return await browseAgents(args[0]!.trim());
    },
  },
  execute_acp_job: {
    validate: (args) => {
      if (!args[0]?.trim() || !args[1]?.trim())
        return 'Usage: execute_acp_job "<agentWalletAddress>" "<jobOfferingName>" \'<serviceRequirementsJson>\'';
      if (args[2]) {
        try {
          JSON.parse(args[2]);
        } catch {
          return "Invalid serviceRequirements JSON (third argument)";
        }
      }
      return null;
    },
    run: async (args) => {
      const serviceRequirements = args[2]
        ? (JSON.parse(args[2]) as Record<string, unknown>)
        : {};
      return await executeAcpJob(
        args[0]!.trim(),
        args[1]!.trim(),
        serviceRequirements
      );
    },
  },
  poll_job: {
    validate: (args) => {
      if (!args[0]?.trim()) return 'Usage: poll_job "<jobId>"';
      return null;
    },
    run: async (args) => {
      return await pollJob(Number(args[0]!.trim()));
    },
  },
  poll_with_fallback: {
    validate: (args) => {
      if (!args[0]?.trim()) return 'Usage: poll_with_fallback "<jobId>" [budget] [callbackUrl]';
      return null;
    },
    run: async (args) => {
      const budget = args[1] ? parseFloat(args[1]) : 50;
      const callbackUrl = args[2]?.trim() || undefined;
      return await pollJobWithFallback(Number(args[0]!.trim()), budget, callbackUrl);
    },
  },
  post_bounty: {
    validate: (args) => {
      if (!args[0]?.trim() || !args[1]?.trim() || !args[2]?.trim())
        return 'Usage: post_bounty "<title>" "<description>" <budget> [requirements] [category] [callbackUrl]';
      return null;
    },
    run: async (args) => {
      const title = args[0]!.trim();
      const description = args[1]!.trim();
      const budget = parseFloat(args[2]!);
      const requirements = args[3]?.trim() || "";
      const category = (args[4]?.trim() as "digital" | "physical") || "digital";
      const callbackUrl = args[5]?.trim() || undefined;
      const result = await postBountyFallback(title, description, requirements, budget, category, callbackUrl);
      return out(result);
    },
  },
  get_wallet_address: {
    validate: () => null,
    run: async () => {
      return await getWalletAddress();
    },
  },
  get_wallet_balance: {
    validate: () => null,
    run: async () => {
      return await getWalletBalance();
    },
  },
  launch_my_token: {
    validate: (args) => {
      if (!args[0]?.trim() || !args[1]?.trim())
        return 'Usage: launch_my_token "<symbol>" "<description>" ["<imageUrl>"]';
      return null;
    },
    run: async (args) => {
      return await launchMyToken(
        args[0]!.trim(),
        args[1]!.trim(),
        args[2]?.trim()
      );
    },
  },
  get_my_token: {
    validate: () => null,
    run: async () => {
      return await getMyToken();
    },
  },
};

const AVAILABLE_TOOLS = Object.keys(TOOLS).join(", ");

/**
 * Cli Entry
 */
async function runCli(): Promise<void> {
  const liteAgentApiKey = process.env.LITE_AGENT_API_KEY;
  if (!liteAgentApiKey) {
    cliErr(
      "LITE_AGENT_API_KEY is not set. Run npm run setup and add your API key to config.json or .env"
    );
  }

  const [, , tool = "", ...args] = process.argv;
  const handler = TOOLS[tool];
  if (!handler) {
    cliErr(
      `Invalid tool usage. These are the available tools: ${AVAILABLE_TOOLS}`
    );
  }
  const err = handler.validate(args);
  if (err) cliErr(err);
  await handler.run(args);
}

const toolArg = process.argv[2] ?? "";

if (toolArg in TOOLS) {
  runCli().catch((e) => {
    out({ error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
} else {
  cliErr(
    `Invalid tool usage. These are the available tools: ${AVAILABLE_TOOLS}`
  );
}

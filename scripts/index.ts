#!/usr/bin/env npx tsx
/**
 * ACP Skill — CLI only.
 *
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import client from "./client";
import { getMyAgentInfo } from "./wallet";

// Resolve paths from script location so CLI works when run from any cwd (e.g. by OpenClaw)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Load API key from config.json
if (!process.env.LITE_AGENT_API_KEY) {
  const configPath = path.join(ROOT, "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const key = config?.LITE_AGENT_API_KEY;
      if (typeof key === "string" && key.trim())
        process.env.LITE_AGENT_API_KEY = key;
    } catch {
      // ignore
    }
  }
}

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

  const data = job.data.data;

  // Format memo content to show phase progression (informational only)
  const memoHistory = (data.memos || []).map(
    (memo: { phase: string; content: string; createdAt: string }) => ({
      phase: memo.phase,
      content: memo.content,
      timestamp: memo.createdAt,
    })
  );

  return out({
    jobId: data.id,
    phase: data.phase,
    providerName: data.providerAgent?.name ?? null,
    providerWalletAddress: data.providerAgent?.walletAddress ?? null,
    deliverable: data.deliverable,
    memoHistory,
    _note:
      "This shows the current job status. Memo contents reflects the job's phase progression and details and is purely informational. Jobs in progress are handled by seprate processes already. No action is required from you.",
  });
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

async function updateMyInfo(key: string, value: string) {
  const supportedKeys = ["name", "description", "profilePic"];

  if (!supportedKeys.includes(key)) {
    return cliErr(
      `Invalid key: ${key}. Supported keys: ${supportedKeys.join(", ")}`
    );
  }

  const agent = await client.put("/acp/me", {
    [key]: value,
  });
  return out(agent.data);
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
  get_my_info: {
    validate: () => null,
    run: async () => {
      const agentInfo = await getMyAgentInfo();
      return out(agentInfo);
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
  update_my_info: {
    validate: (args) => {
      if (!args[0]?.trim()) return 'Usage: update_my_info "<key>" "<value>"';
      return null;
    },
    run: async (args) => {
      return await updateMyInfo(args[0]!.trim(), args[1]!.trim());
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

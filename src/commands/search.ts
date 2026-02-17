// =============================================================================
// acp search <query> — Search agents with filters & reranking
// =============================================================================

import axios from "axios";
import * as output from "../lib/output.js";

const SEARCH_URL =
  process.env.SEARCH_URL || "http://acpx.virtuals.io/api/agents/v5/search";

// -- Types --

export interface SearchOptions {
  mode?: "hybrid" | "vector" | "keyword";
  contains?: string;
  match?: "all" | "any";
  performanceWeight?: number;
  similarityCutoff?: number;
  sparseCutoff?: number;
}

interface AgentMetrics {
  successfulJobCount: number | null;
  successRate: number | null;
  uniqueBuyerCount: number | null;
  minsFromLastOnlineTime: number | null;
  isOnline: boolean;
}

interface AgentJob {
  id: number;
  name: string;
  description: string;
  type: string;
  price: number;
  priceV2: { type: string; value: number };
  requiredFunds: boolean;
  slaMinutes: number;
  requirement: Record<string, unknown>;
  deliverable: Record<string, unknown>;
}

interface AgentResource {
  name: string;
  description?: string;
  url?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Agent {
  id: number;
  name: string;
  description: string;
  contractAddress: string;
  walletAddress: string;
  twitterHandle: string;
  profilePic: string;
  tokenAddress: string | null;
  cluster: string | null;
  category: string | null;
  symbol: string | null;
  virtualAgentId: number | null;
  isVirtualAgent: boolean;
  metrics: AgentMetrics;
  jobs: AgentJob[];
  resources: AgentResource[];
}

// -- Defaults (server-side, documented here for help text & summary) --

export const SEARCH_DEFAULTS = {
  mode: "hybrid" as const,
  performanceWeight: 0.97,
  similarityCutoff: 0.5,
  sparseCutoff: 0.0,
  match: "all" as const,
};

// -- Friendly mode → API searchMode mapping --

const MODE_MAP: Record<string, string> = {
  hybrid: "hybrid",
  vector: "dense",
  keyword: "sparse",
};

// -- Build query params --

function buildParams(query: string, opts: SearchOptions): Record<string, string> {
  const params: Record<string, string> = { query };
  params.claw = "true";

  // Search mode
  if (opts.mode) {
    const apiMode = MODE_MAP[opts.mode];
    if (!apiMode) {
      output.fatal(`Invalid search mode "${opts.mode}". Use: hybrid, vector, keyword`);
    }
    params.searchMode = apiMode;
  }

  // String filters
  if (opts.contains) params.fullTextFilter = opts.contains;
  if (opts.match) params.fullTextMatch = opts.match;

  // Reranking (always on)
  if (opts.performanceWeight !== undefined)
    params.performanceWeight = String(opts.performanceWeight);
  params.similarityCutoff = String(opts.similarityCutoff ?? SEARCH_DEFAULTS.similarityCutoff);
  if (opts.sparseCutoff !== undefined)
    params.sparseCutoff = String(opts.sparseCutoff);

  return params;
}

// -- Table formatting --

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatTable(agents: Agent[]): void {
  const header = {
    rank: "#",
    name: "Name",
    id: "ID",
    category: "Category",
    rate: "Success",
    jobs: "Jobs",
    buyers: "Buyers",
    online: "Online",
  };

  // Column widths
  const w = {
    rank: 4,
    name: 20,
    id: 6,
    category: 16,
    rate: 9,
    jobs: 6,
    buyers: 8,
    online: 6,
  };

  const row = (r: typeof header) =>
    `  ${r.rank.toString().padStart(w.rank)}  ` +
    `${truncate(r.name, w.name).padEnd(w.name)}  ` +
    `${r.id.toString().padEnd(w.id)}  ` +
    `${truncate(r.category, w.category).padEnd(w.category)}  ` +
    `${r.rate.toString().padStart(w.rate)}  ` +
    `${r.jobs.toString().padStart(w.jobs)}  ` +
    `${r.buyers.toString().padStart(w.buyers)}  ` +
    `${r.online.toString().padEnd(w.online)}`;

  // Header
  output.log(output.colors.dim(row(header)));

  // Rows
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    output.log(
      row({
        rank: String(i + 1),
        name: a.name,
        id: String(a.id),
        category: a.category ?? "-",
        rate: a.metrics.successRate != null ? `${a.metrics.successRate.toFixed(1)}%` : "-",
        jobs: a.metrics.successfulJobCount != null ? String(a.metrics.successfulJobCount) : "-",
        buyers: a.metrics.uniqueBuyerCount != null ? String(a.metrics.uniqueBuyerCount) : "-",
        online: a.metrics.isOnline ? "Yes" : "No",
      })
    );
  }
}

// -- Settings summary --

function formatSummary(opts: SearchOptions): string {
  const parts: string[] = [];

  // Mode
  parts.push(`mode=${opts.mode ?? SEARCH_DEFAULTS.mode}`);

  // Rerank
  const pw = opts.performanceWeight ?? SEARCH_DEFAULTS.performanceWeight;
  parts.push(`rerank weight=${pw}`);

  // Active filters
  const filters: string[] = [];
  if (opts.contains) {
    const m = opts.match ?? SEARCH_DEFAULTS.match;
    filters.push(`contains="${opts.contains}" (match=${m})`);
  }
  parts.push(filters.join(", "));

  return parts.join(" · ");
}

// -- Main search function --

export async function search(query: string, opts: SearchOptions): Promise<void> {
  if (!query.trim()) {
    output.fatal("Usage: acp search <query>\n  Run `acp search --help` for all options.");
  }

  // Validate: --match requires --contains
  if (opts.match && !opts.contains) {
    output.fatal("--match requires --contains");
  }

  const params = buildParams(query, opts);

  try {
    const response = await axios.get<{ data: Agent[] }>(SEARCH_URL, { params });
    const data = response.data?.data;

    // Handle the known SQL-error quirk for empty results
    if (!data || !Array.isArray(data) || data.length === 0) {
      output.output([], () => {
        output.log(`\n  No agents found for "${query}".`);
        output.log("");
      });
      return;
    }

    output.output(data, (agents: Agent[]) => {
      output.heading(`Search results for "${query}"`);
      output.log(output.colors.dim(`  ${formatSummary(opts)}`));
      output.log("");
      formatTable(agents);
      output.log(
        output.colors.dim(`\n  ${agents.length} result${agents.length === 1 ? "" : "s"}`)
      );
      output.log("");
    });
  } catch (e: unknown) {
    // Handle the SQL-error quirk (empty WHERE IN ())
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("syntax") || msg.includes("SQL")) {
      output.output([], () => {
        output.log(`\n  No agents found for "${query}".`);
        output.log("");
      });
      return;
    }
    output.fatal(`Search failed: ${msg}`);
  }
}

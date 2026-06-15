#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  calculateUpsellConversion,
  isExternalClient,
  offeringConversions,
  type RevenueJobRecord,
} from "../src/seller/runtime/revenueSprintGuards.js";

type CompletedJob = {
  id: number;
  price?: number;
  priceType?: string;
  clientAddress?: string;
  providerAddress?: string;
  phase?: string;
  name?: string;
  deliverable?: unknown;
};

type JobDetailMemo = {
  nextPhase?: string;
  createdAt?: string;
};

type JobDetailResponse = {
  id: number;
  memos?: JobDetailMemo[];
};

type LeadBountyLedgerRow = {
  dateKey?: string;
  spentUsdc?: number;
  created?: boolean;
  selected?: boolean;
};

type CliOptions = {
  windowHours: number;
  outputJson?: string;
  outputCsv?: string;
};

const DEFAULT_API_URL = process.env.ACP_API_URL || "https://claw-api.virtuals.io";
const COMPLETED_PAGE_SIZE = 100;
const DEFAULT_INTERNAL_WALLETS = [
  "0xbB8aAB015De360f01a25373be320A73cD19f319E", // delivery-orchestrator-hub
  "0x79d4Cdb36cf5394A2d825F01BFD3a43a6A612Ce7", // virtual-outreach-orchestrator
];
const LEAD_LEDGER_PATH = path.resolve(
  process.cwd(),
  "logs",
  "rapid_recovery_lead_bounty_ledger.json"
);

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { windowHours: 24 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--window-hours") {
      const next = Number(argv[i + 1]);
      if (!Number.isFinite(next) || next <= 0) {
        throw new Error("--window-hours must be a positive number");
      }
      out.windowHours = next;
      i += 1;
      continue;
    }
    if (token === "--output-json") {
      const next = argv[i + 1];
      if (!next) throw new Error("--output-json requires a path");
      out.outputJson = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (token === "--output-csv") {
      const next = argv[i + 1];
      if (!next) throw new Error("--output-csv requires a path");
      out.outputCsv = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function readConfigKey(): string {
  if (process.env.LITE_AGENT_API_KEY?.trim()) return process.env.LITE_AGENT_API_KEY.trim();

  const configPath = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error("LITE_AGENT_API_KEY missing and config.json not found");
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const key = String(raw?.LITE_AGENT_API_KEY || "").trim();
  if (!key) throw new Error("LITE_AGENT_API_KEY is missing");
  return key;
}

async function apiGet<T>(apiKey: string, endpoint: string): Promise<T> {
  const res = await fetch(`${DEFAULT_API_URL}${endpoint}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ACP API ${endpoint} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T };
  return (json.data ?? json) as T;
}

async function listCompletedJobs(apiKey: string): Promise<CompletedJob[]> {
  const rows: CompletedJob[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const batch = await apiGet<CompletedJob[]>(
      apiKey,
      `/acp/jobs/completed?page=${page}&pageSize=${COMPLETED_PAGE_SIZE}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < COMPLETED_PAGE_SIZE) break;
  }
  return rows;
}

function lowerWallet(address: string): string {
  return String(address || "")
    .trim()
    .toLowerCase();
}

function parseInternalWallets(providerWallet: string): Set<string> {
  const envWallets = String(
    process.env.INTERNAL_WALLETS || process.env.RAPID_INTERNAL_WALLETS || ""
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const wallets = new Set(
    [...DEFAULT_INTERNAL_WALLETS, ...envWallets, providerWallet]
      .map((wallet) => lowerWallet(wallet))
      .filter(Boolean)
  );
  return wallets;
}

function getMemoTimestamp(memos: JobDetailMemo[] | undefined, phase: string): string | undefined {
  if (!Array.isArray(memos)) return undefined;
  const hits = memos.filter((memo) => String(memo.nextPhase || "").toUpperCase() === phase);
  return hits.at(-1)?.createdAt;
}

function parseDeliverableTier(deliverable: unknown): string | undefined {
  if (!deliverable || typeof deliverable !== "object") return undefined;
  const root = deliverable as Record<string, any>;
  const value = root.value && typeof root.value === "object" ? root.value : root;
  if (value && typeof value.recommended_next_tier === "string") {
    return value.recommended_next_tier;
  }
  return undefined;
}

function safeNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function dateKeyFromIso(iso?: string): string | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(2));
}

function readLeadLedger(): LeadBountyLedgerRow[] {
  if (!fs.existsSync(LEAD_LEDGER_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LEAD_LEDGER_PATH, "utf8"));
    return Array.isArray(parsed) ? (parsed as LeadBountyLedgerRow[]) : [];
  } catch {
    return [];
  }
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0)
    return "date,external_jobs,external_usdc,internal_jobs,internal_usdc,lead_spend_usdc\n";
  const columns = Object.keys(rows[0]);
  const escaped = (value: unknown) => {
    const raw = String(value ?? "");
    if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escaped(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = readConfigKey();

  const me = await apiGet<{ name: string; walletAddress: string }>(apiKey, "/acp/me");
  const providerWallet = lowerWallet(me.walletAddress);
  const internalWallets = parseInternalWallets(providerWallet);

  const completed = await listCompletedJobs(apiKey);
  const providerJobs = completed.filter(
    (job) =>
      String(job.phase || "").toUpperCase() === "COMPLETED" &&
      lowerWallet(job.providerAddress || "") === providerWallet
  );

  const details = await Promise.all(
    providerJobs.map(async (job) => {
      const detail = await apiGet<JobDetailResponse>(apiKey, `/acp/jobs/${job.id}`);
      const completedAt = getMemoTimestamp(detail.memos, "COMPLETED");
      const transactionAt = getMemoTimestamp(detail.memos, "TRANSACTION");
      const processingSeconds =
        completedAt && transactionAt
          ? Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(transactionAt)) / 1000))
          : null;
      return {
        ...job,
        completedAt,
        processingSeconds,
      };
    })
  );

  const jobs: RevenueJobRecord[] = details
    .map((job) => ({
      id: job.id,
      offeringName: String(job.name || ""),
      clientAddress: String(job.clientAddress || ""),
      priceUsdc: safeNumber(job.price),
      completedAtIso: job.completedAt,
      recommendedNextTier: parseDeliverableTier(job.deliverable),
    }))
    .filter((job) => Boolean(job.completedAtIso));

  const externalJobs = jobs.filter((job) => isExternalClient(job.clientAddress, internalWallets));
  const internalJobs = jobs.filter((job) => !isExternalClient(job.clientAddress, internalWallets));

  const now = Date.now();
  const startWindow = now - options.windowHours * 60 * 60 * 1000;
  const start24h = now - 24 * 60 * 60 * 1000;
  const start7d = now - 7 * 24 * 60 * 60 * 1000;

  const inWindowExternal = externalJobs.filter(
    (job) => Date.parse(job.completedAtIso || "") >= startWindow
  );
  const in24hExternal = externalJobs.filter(
    (job) => Date.parse(job.completedAtIso || "") >= start24h
  );
  const in7dExternal = externalJobs.filter(
    (job) => Date.parse(job.completedAtIso || "") >= start7d
  );
  const in24hInternal = internalJobs.filter(
    (job) => Date.parse(job.completedAtIso || "") >= start24h
  );

  const externalProcessingTimes = details
    .filter(
      (job) =>
        isExternalClient(String(job.clientAddress || ""), internalWallets) &&
        Number.isFinite(Date.parse(job.completedAt || "")) &&
        Date.parse(job.completedAt || "") >= start24h &&
        Number.isFinite(Number(job.processingSeconds))
    )
    .map((job) => Number(job.processingSeconds));

  const offering24h = offeringConversions(in24hExternal, start24h);
  const offering7d = offeringConversions(in7dExternal, start7d);
  const upsell24h = calculateUpsellConversion(in24hExternal, start24h);
  const upsell7d = calculateUpsellConversion(in7dExternal, start7d);

  const representativeCase = [...in24hExternal]
    .sort(
      (a, b) =>
        b.priceUsdc - a.priceUsdc ||
        String(b.completedAtIso).localeCompare(String(a.completedAtIso))
    )
    .at(0);

  const leadLedger = readLeadLedger();
  const dayRows = new Map<
    string,
    {
      date: string;
      external_jobs: number;
      external_usdc: number;
      internal_jobs: number;
      internal_usdc: number;
      lead_spend_usdc: number;
      lead_bounties_created: number;
      lead_auto_selected: number;
    }
  >();

  for (let i = 0; i < 7; i += 1) {
    const ts = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dayRows.set(ts, {
      date: ts,
      external_jobs: 0,
      external_usdc: 0,
      internal_jobs: 0,
      internal_usdc: 0,
      lead_spend_usdc: 0,
      lead_bounties_created: 0,
      lead_auto_selected: 0,
    });
  }

  for (const job of externalJobs) {
    const key = dateKeyFromIso(job.completedAtIso);
    if (!key || !dayRows.has(key)) continue;
    const row = dayRows.get(key)!;
    row.external_jobs += 1;
    row.external_usdc += job.priceUsdc;
  }
  for (const job of internalJobs) {
    const key = dateKeyFromIso(job.completedAtIso);
    if (!key || !dayRows.has(key)) continue;
    const row = dayRows.get(key)!;
    row.internal_jobs += 1;
    row.internal_usdc += job.priceUsdc;
  }

  for (const entry of leadLedger) {
    const key = String(entry.dateKey || "");
    if (!dayRows.has(key)) continue;
    const row = dayRows.get(key)!;
    row.lead_spend_usdc += safeNumber(entry.spentUsdc);
    if (entry.created) row.lead_bounties_created += 1;
    if (entry.selected) row.lead_auto_selected += 1;
  }

  const daily = [...dayRows.values()]
    .map((row) => ({
      ...row,
      external_usdc: Number(row.external_usdc.toFixed(6)),
      internal_usdc: Number(row.internal_usdc.toFixed(6)),
      lead_spend_usdc: Number(row.lead_spend_usdc.toFixed(6)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const report = {
    generatedAt: new Date().toISOString(),
    windowHours: options.windowHours,
    agent: {
      name: me.name,
      walletAddress: me.walletAddress,
    },
    internalWallets: [...internalWallets],
    external_jobs_window: inWindowExternal.length,
    external_usdc_window: Number(
      inWindowExternal.reduce((sum, job) => sum + job.priceUsdc, 0).toFixed(6)
    ),
    external_jobs_24h: in24hExternal.length,
    external_usdc_24h: Number(
      in24hExternal.reduce((sum, job) => sum + job.priceUsdc, 0).toFixed(6)
    ),
    external_jobs_7d: in7dExternal.length,
    external_usdc_7d: Number(in7dExternal.reduce((sum, job) => sum + job.priceUsdc, 0).toFixed(6)),
    avg_processing_seconds_24h: avg(externalProcessingTimes),
    representative_success_case_24h: representativeCase
      ? {
          jobId: representativeCase.id,
          offering: representativeCase.offeringName,
          priceUsdc: representativeCase.priceUsdc,
          recommendedNextTier: representativeCase.recommendedNextTier || "none",
        }
      : null,
    offering_conversion_24h: offering24h,
    offering_conversion_7d: offering7d,
    upsell_conversion_24h: upsell24h,
    upsell_conversion_7d: upsell7d,
    lead_cost_performance_24h: {
      spend_usdc: Number(
        daily
          .filter((row) => row.date === new Date(now).toISOString().slice(0, 10))
          .reduce((sum, row) => sum + row.lead_spend_usdc, 0)
          .toFixed(6)
      ),
      bounties_created: daily
        .filter((row) => row.date === new Date(now).toISOString().slice(0, 10))
        .reduce((sum, row) => sum + row.lead_bounties_created, 0),
      auto_selected: daily
        .filter((row) => row.date === new Date(now).toISOString().slice(0, 10))
        .reduce((sum, row) => sum + row.lead_auto_selected, 0),
    },
    daily,
  };

  if (options.outputJson) {
    fs.mkdirSync(path.dirname(options.outputJson), { recursive: true });
    fs.writeFileSync(options.outputJson, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.outputCsv) {
    fs.mkdirSync(path.dirname(options.outputCsv), { recursive: true });
    fs.writeFileSync(options.outputCsv, toCsv(daily));
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

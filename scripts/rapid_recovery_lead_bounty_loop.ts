#!/usr/bin/env npx tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { decideLeadBountyActivation } from "../src/seller/runtime/revenueSprintGuards.js";

type CliOptions = {
  dailyBudgetCapUsdc: number;
  maxDailyBounties: number;
  autoSelectPriceCapUsdc: number;
  dryRun: boolean;
};

type Candidate = Record<string, unknown>;

type LedgerRow = {
  at: string;
  dateKey: string;
  created: boolean;
  selected: boolean;
  bountyId?: string;
  candidateId?: number;
  spentUsdc: number;
  reason?: string;
  halted?: boolean;
};

type KpiReport = {
  daily?: Array<{ date: string; external_jobs: number }>;
};

const ACP_API_URL = process.env.ACP_API_URL || "https://claw-api.virtuals.io";
const BOUNTY_API_URL = process.env.ACP_BOUNTY_API_URL || "https://bounty.virtuals.io/api/v1";
const LEDGER_PATH = path.resolve(process.cwd(), "logs", "rapid_recovery_lead_bounty_ledger.json");
const HALT_STATE_PATH = path.resolve(
  process.cwd(),
  "logs",
  "rapid_recovery_lead_bounty_state.json"
);
const DEMAND_KEYWORDS = [
  "timeout",
  "validation",
  "rejected",
  "retry payload",
  "recovery",
  "hotfix",
];

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    dailyBudgetCapUsdc: 0.1,
    maxDailyBounties: 1,
    autoSelectPriceCapUsdc: 0.1,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--daily-budget-cap") {
      const next = Number(argv[i + 1]);
      if (!Number.isFinite(next) || next <= 0) throw new Error("--daily-budget-cap must be > 0");
      out.dailyBudgetCapUsdc = next;
      i += 1;
      continue;
    }
    if (token === "--max-daily-bounties") {
      const next = Number(argv[i + 1]);
      if (!Number.isFinite(next) || next <= 0) throw new Error("--max-daily-bounties must be > 0");
      out.maxDailyBounties = Math.round(next);
      i += 1;
      continue;
    }
    if (token === "--auto-select-price-cap") {
      const next = Number(argv[i + 1]);
      if (!Number.isFinite(next) || next <= 0)
        throw new Error("--auto-select-price-cap must be > 0");
      out.autoSelectPriceCapUsdc = next;
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function readApiKey(): string {
  if (process.env.LITE_AGENT_API_KEY?.trim()) return process.env.LITE_AGENT_API_KEY.trim();
  const configPath = path.resolve(process.cwd(), "config.json");
  if (!fs.existsSync(configPath)) throw new Error("LITE_AGENT_API_KEY missing");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const key = String(config?.LITE_AGENT_API_KEY || "").trim();
  if (!key) throw new Error("LITE_AGENT_API_KEY missing");
  return key;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function yesterdayKey(now = new Date()): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function loadKpiDaily(): KpiReport {
  const output = execFileSync(
    "npx",
    ["tsx", "scripts/rapid_recovery_kpi_report.ts", "--window-hours", "72"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return JSON.parse(output) as KpiReport;
}

function scoreCandidateRelevance(candidate: Candidate): number {
  const haystack = JSON.stringify(candidate).toLowerCase();
  let score = 0;
  for (const keyword of DEMAND_KEYWORDS) {
    if (haystack.includes(keyword.toLowerCase())) score += 1;
  }
  return score;
}

function candidatePrice(candidate: Candidate): number {
  const raw =
    candidate.price ??
    candidate.job_offering_price ??
    candidate.jobOfferingPrice ??
    candidate.jobFee;
  const num = Number(raw);
  return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY;
}

function candidateField(candidate: Candidate, fields: string[]): string {
  for (const field of fields) {
    const value = candidate[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function apiPostJson(
  url: string,
  apiKey: string,
  payload: unknown
): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function apiGetJson(url: string, apiKey: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function appendLedger(entry: LedgerRow) {
  const rows = readJsonFile<LedgerRow[]>(LEDGER_PATH, []);
  rows.push(entry);
  writeJsonFile(LEDGER_PATH, rows.slice(-1000));
}

function setHalt(reason: string) {
  writeJsonFile(HALT_STATE_PATH, {
    halted: true,
    reason,
    at: new Date().toISOString(),
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const nowIso = new Date().toISOString();
  const dayKey = todayKey();
  const previousDay = yesterdayKey();
  const apiKey = readApiKey();
  const me = await apiGetJson(`${ACP_API_URL}/acp/me`, apiKey);
  const myWallet = String((me?.data ?? me)?.walletAddress || "").toLowerCase();

  const haltState = readJsonFile<{ halted?: boolean; reason?: string }>(HALT_STATE_PATH, {});
  if (haltState.halted) {
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: `halted: ${haltState.reason || "unknown"}` }, null, 2)}\n`
    );
    return;
  }

  const kpi = loadKpiDaily();
  const yesterdayExternalJobs =
    kpi.daily?.find((row) => row.date === previousDay)?.external_jobs ?? 0;

  const ledger = readJsonFile<LedgerRow[]>(LEDGER_PATH, []);
  const todayRows = ledger.filter((row) => row.dateKey === dayKey);
  const dailyBudgetUsedUsdc = Number(
    todayRows.reduce((sum, row) => sum + Number(row.spentUsdc || 0), 0).toFixed(6)
  );
  const dailyCreatedCount = todayRows.filter((row) => row.created).length;

  const decision = decideLeadBountyActivation({
    yesterdayExternalJobs,
    dailyBudgetUsedUsdc,
    dailyBudgetCapUsdc: options.dailyBudgetCapUsdc,
    dailyCreatedCount,
    maxDailyBounties: options.maxDailyBounties,
  });

  if (!decision.enabled) {
    appendLedger({
      at: nowIso,
      dateKey: dayKey,
      created: false,
      selected: false,
      spentUsdc: 0,
      reason: decision.reason,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          skipped: true,
          reason: decision.reason,
          yesterdayExternalJobs,
          dailyBudgetUsedUsdc,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const remainingCap = Math.max(0, options.dailyBudgetCapUsdc - dailyBudgetUsedUsdc);
  const budget = Number(Math.min(remainingCap, options.autoSelectPriceCapUsdc).toFixed(6));
  if (budget <= 0) {
    appendLedger({
      at: nowIso,
      dateKey: dayKey,
      created: false,
      selected: false,
      spentUsdc: 0,
      reason: "remaining budget is zero",
    });
    process.stdout.write(
      `${JSON.stringify({ skipped: true, reason: "remaining budget is zero" }, null, 2)}\n`
    );
    return;
  }

  const bountyPayload = {
    title: "ACP ops demand phrase hunt (timeout/validation/rejected/retry payload)",
    description:
      "Collect high-performing demand phrases and failure patterns from ACP seller ops teams. Return concise patterns for timeout/validation/rejected/retry payload issues.",
    budget,
    category: "digital",
    tags: "acp,ops,recovery,timeout,validation,rejected,retry payload",
  };

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          action: "create-bounty-and-auto-select",
          bountyPayload,
          budget,
          remainingCap,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const created = await apiPostJson(`${BOUNTY_API_URL}/bounties/`, apiKey, bountyPayload);
  const createBody = created?.data ?? created;
  const bountyNode =
    createBody?.bounty && typeof createBody.bounty === "object" ? createBody.bounty : createBody;
  const bountyId = String(
    bountyNode?.id ?? bountyNode?.bounty_id ?? bountyNode?.bountyId ?? createBody?.id ?? ""
  );
  const posterSecret = String(
    createBody?.poster_secret ??
      createBody?.posterSecret ??
      createBody?.data?.poster_secret ??
      createBody?.data?.posterSecret ??
      ""
  );

  if (!bountyId || !posterSecret) {
    setHalt("bounty create response missing id/poster_secret");
    appendLedger({
      at: nowIso,
      dateKey: dayKey,
      created: false,
      selected: false,
      spentUsdc: 0,
      reason: "invalid bounty create response",
      halted: true,
    });
    throw new Error("Invalid bounty create response");
  }

  const matchStatusRaw = await apiGetJson(
    `${BOUNTY_API_URL}/bounties/${encodeURIComponent(bountyId)}/match-status`,
    apiKey
  );
  const matchStatus = matchStatusRaw?.data ?? matchStatusRaw;
  const candidates = Array.isArray(matchStatus?.candidates)
    ? (matchStatus.candidates as Candidate[])
    : [];

  const candidateCap = Math.min(options.autoSelectPriceCapUsdc, remainingCap);
  const relevantCandidates = candidates
    .map((candidate) => {
      const wallet = candidateField(candidate, [
        "agent_wallet",
        "agentWallet",
        "agent_wallet_address",
        "agentWalletAddress",
        "walletAddress",
        "providerWalletAddress",
        "provider_address",
      ]).toLowerCase();
      return {
        candidate,
        relevance: scoreCandidateRelevance(candidate),
        price: candidatePrice(candidate),
        wallet,
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.price) &&
        row.price <= candidateCap &&
        row.relevance > 0 &&
        row.wallet &&
        row.wallet !== myWallet
    )
    .sort((a, b) => b.relevance - a.relevance || a.price - b.price);

  let selected = false;
  let selectedCandidateId: number | undefined;
  let spentUsdc = 0;

  if (relevantCandidates.length > 0) {
    const best = relevantCandidates[0];
    const candidate = best.candidate;
    const candidateId = Number(candidate.id);
    const wallet = candidateField(candidate, [
      "agent_wallet",
      "agentWallet",
      "agent_wallet_address",
      "agentWalletAddress",
      "walletAddress",
      "providerWalletAddress",
      "provider_address",
    ]);
    const offering = candidateField(candidate, [
      "job_offering",
      "jobOffering",
      "offeringName",
      "jobOfferingName",
      "offering_name",
      "name",
    ]);

    if (!wallet || !offering || !Number.isFinite(candidateId)) {
      setHalt("relevant candidate missing wallet/offering/id");
      appendLedger({
        at: nowIso,
        dateKey: dayKey,
        created: true,
        selected: false,
        bountyId,
        spentUsdc: 0,
        reason: "candidate missing required fields",
        halted: true,
      });
      throw new Error("Candidate missing required fields for auto-select");
    }

    try {
      const jobResponse = await apiPostJson(`${ACP_API_URL}/acp/jobs`, apiKey, {
        providerWalletAddress: wallet,
        jobOfferingName: offering,
        serviceRequirements: {
          goal: "Collect demand phrases for timeout/validation/rejected/retry payload offers",
          output_format: "top 5 phrases + top 5 pain patterns + top 3 objection lines",
        },
      });
      const jobData = jobResponse?.data ?? jobResponse;
      const acpJobId = String(jobData?.data?.jobId ?? jobData?.jobId ?? "");
      if (!acpJobId) {
        throw new Error("failed to create ACP job for selected candidate");
      }

      await apiPostJson(
        `${BOUNTY_API_URL}/bounties/${encodeURIComponent(bountyId)}/confirm-match`,
        apiKey,
        {
          poster_secret: posterSecret,
          candidate_id: candidateId,
          acp_job_id: acpJobId,
        }
      );

      selected = true;
      selectedCandidateId = candidateId;
      spentUsdc = Number(best.price.toFixed(6));
    } catch (error) {
      setHalt("auto-select job creation failed");
      appendLedger({
        at: nowIso,
        dateKey: dayKey,
        created: true,
        selected: false,
        bountyId,
        spentUsdc: 0,
        reason:
          error instanceof Error
            ? `auto-select failed: ${error.message}`
            : "auto-select failed: unknown error",
        halted: true,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            created: true,
            selected: false,
            bountyId,
            halted: true,
            reason: error instanceof Error ? error.message : String(error),
          },
          null,
          2
        )}\n`
      );
      return;
    }
  }

  const row: LedgerRow = {
    at: nowIso,
    dateKey: dayKey,
    created: true,
    selected,
    bountyId,
    candidateId: selectedCandidateId,
    spentUsdc,
    reason: selected ? "auto-selected" : "no relevant candidate within cap",
  };
  appendLedger(row);

  process.stdout.write(
    `${JSON.stringify(
      {
        created: true,
        selected,
        bountyId,
        candidateId: selectedCandidateId ?? null,
        spentUsdc,
        budgetCap: options.dailyBudgetCapUsdc,
        remainingCap,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

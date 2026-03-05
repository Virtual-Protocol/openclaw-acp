#!/usr/bin/env npx tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

type KpiReport = {
  external_jobs_24h?: number;
  avg_processing_seconds_24h?: number;
  representative_success_case_24h?: {
    offering?: string;
    priceUsdc?: number;
    recommendedNextTier?: string;
  } | null;
};

type CliOptions = {
  kpiJsonPath?: string;
  dryRun: boolean;
};

const DEFAULT_API_URL = process.env.ACP_API_URL || "https://claw-api.virtuals.io";
const LOG_PATH = path.resolve(process.cwd(), "logs", "rapid_recovery_profile_updates.jsonl");

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--kpi-json") {
      const next = argv[i + 1];
      if (!next) throw new Error("--kpi-json requires a file path");
      out.kpiJsonPath = path.resolve(process.cwd(), next);
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
  if (!fs.existsSync(configPath)) {
    throw new Error("LITE_AGENT_API_KEY missing and config.json not found");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const key = String(config?.LITE_AGENT_API_KEY || "").trim();
  if (!key) throw new Error("LITE_AGENT_API_KEY is missing");
  return key;
}

function loadKpi(options: CliOptions): KpiReport {
  if (options.kpiJsonPath) {
    const raw = JSON.parse(fs.readFileSync(options.kpiJsonPath, "utf8"));
    return raw as KpiReport;
  }
  const output = execFileSync(
    "npx",
    ["tsx", "scripts/rapid_recovery_kpi_report.ts", "--window-hours", "24"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return JSON.parse(output) as KpiReport;
}

function buildDescription(kpi: KpiReport): string {
  const externalJobs = Number(kpi.external_jobs_24h || 0);
  const avgSeconds = Number(kpi.avg_processing_seconds_24h || 0);
  const success = kpi.representative_success_case_24h;
  const successLine = success
    ? `${success.offering || "unknown"} ${Number(success.priceUsdc || 0).toFixed(2)} USDC / next=${success.recommendedNextTier || "none"}`
    : "none";

  return [
    "timeout | validation | rejected | retry payload",
    "입력 1줄 -> 복구결과 3종(JSON) 즉시 반환",
    `최근 24h 외부 유료건수: ${externalJobs}건`,
    `평균 처리시간: ${avgSeconds}s`,
    `대표 성공 케이스: ${successLine}`,
    "CTA: 0.02 진입 -> 0.05 Turbo -> 0.12 Guardrail",
  ].join("\n");
}

async function updateProfileDescription(apiKey: string, description: string) {
  const response = await fetch(`${DEFAULT_API_URL}/acp/me`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ description }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to update profile: ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json();
}

function appendLog(record: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const kpi = loadKpi(options);
  const description = buildDescription(kpi);
  const apiKey = readApiKey();

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, description }, null, 2)}\n`);
    return;
  }

  const result = await updateProfileDescription(apiKey, description);
  appendLog({
    at: new Date().toISOString(),
    external_jobs_24h: kpi.external_jobs_24h ?? 0,
    avg_processing_seconds_24h: kpi.avg_processing_seconds_24h ?? 0,
    representative_success_case_24h: kpi.representative_success_case_24h ?? null,
    updated: true,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        updated: true,
        description,
        result,
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

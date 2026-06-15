#!/usr/bin/env npx tsx

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

type CliOptions = {
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

function runStep(command: string, args: string[], cwd: string) {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim();
}

function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const nowKey = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const kpiJson = path.resolve(cwd, "logs", `rapid_recovery_kpi_${nowKey}.json`);
  const kpiCsv = path.resolve(cwd, "logs", `rapid_recovery_kpi_${nowKey}.csv`);

  const summary: Record<string, unknown> = {
    executedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    steps: [],
  };

  const steps: Array<{ name: string; command: string; output?: unknown; error?: string }> = [];

  const pushStep = (name: string, command: string, fn: () => string) => {
    try {
      const output = fn();
      steps.push({ name, command, output: output ? parseMaybeJson(output) : "" });
    } catch (error) {
      steps.push({
        name,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  pushStep(
    "openrouter_free_apply_deploy",
    options.dryRun
      ? "node scripts/openrouter_free_daily_check.mjs"
      : "node scripts/openrouter_free_daily_check.mjs --apply --deploy",
    () =>
      options.dryRun
        ? runStep("node", ["scripts/openrouter_free_daily_check.mjs"], cwd)
        : runStep("node", ["scripts/openrouter_free_daily_check.mjs", "--apply", "--deploy"], cwd)
  );

  pushStep(
    "kpi_report",
    `npx tsx scripts/rapid_recovery_kpi_report.ts --window-hours 24 --output-json ${kpiJson} --output-csv ${kpiCsv}`,
    () =>
      runStep(
        "npx",
        [
          "tsx",
          "scripts/rapid_recovery_kpi_report.ts",
          "--window-hours",
          "24",
          "--output-json",
          kpiJson,
          "--output-csv",
          kpiCsv,
        ],
        cwd
      )
  );

  pushStep(
    "profile_daily_update",
    options.dryRun
      ? `npx tsx scripts/rapid_recovery_profile_daily_update.ts --kpi-json ${kpiJson} --dry-run`
      : `npx tsx scripts/rapid_recovery_profile_daily_update.ts --kpi-json ${kpiJson}`,
    () =>
      options.dryRun
        ? runStep(
            "npx",
            [
              "tsx",
              "scripts/rapid_recovery_profile_daily_update.ts",
              "--kpi-json",
              kpiJson,
              "--dry-run",
            ],
            cwd
          )
        : runStep(
            "npx",
            ["tsx", "scripts/rapid_recovery_profile_daily_update.ts", "--kpi-json", kpiJson],
            cwd
          )
  );

  pushStep(
    "lead_bounty_loop",
    options.dryRun
      ? "npx tsx scripts/rapid_recovery_lead_bounty_loop.ts --dry-run"
      : "npx tsx scripts/rapid_recovery_lead_bounty_loop.ts",
    () =>
      options.dryRun
        ? runStep("npx", ["tsx", "scripts/rapid_recovery_lead_bounty_loop.ts", "--dry-run"], cwd)
        : runStep("npx", ["tsx", "scripts/rapid_recovery_lead_bounty_loop.ts"], cwd)
  );

  pushStep(
    "telegram_outbound",
    options.dryRun
      ? "npx tsx scripts/rapid_recovery_telegram_outbound.ts --dry-run"
      : "npx tsx scripts/rapid_recovery_telegram_outbound.ts",
    () =>
      options.dryRun
        ? runStep("npx", ["tsx", "scripts/rapid_recovery_telegram_outbound.ts", "--dry-run"], cwd)
        : runStep("npx", ["tsx", "scripts/rapid_recovery_telegram_outbound.ts"], cwd)
  );

  summary.steps = steps;
  summary.ok = steps.every((step) => !step.error);

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

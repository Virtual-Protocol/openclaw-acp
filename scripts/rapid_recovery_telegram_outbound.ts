#!/usr/bin/env npx tsx

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  checkTelegramGlobalStop,
  decideTelegramSend,
  type TelegramGuardrailPolicy,
  type TelegramSendRecord,
  type TelegramState,
} from "../src/seller/runtime/revenueSprintGuards.js";

type CliOptions = {
  targetsFile: string;
  dailySendCap: number;
  cooldownHours: number;
  maxConsecutiveFailures: number;
  rejectRateThreshold: number;
  rejectRateSampleMin: number;
  bannedKeywords: string[];
  dryRun: boolean;
};

type TargetRow = {
  chatId: string;
  name?: string;
};

type SendLogRow = {
  who: string;
  when: string;
  template: string;
  version: string;
  result: string;
  reason?: string;
};

const DEFAULT_TARGETS = path.resolve(process.cwd(), "data", "rapid_recovery_telegram_targets.json");
const STATE_PATH = path.resolve(process.cwd(), "logs", "rapid_recovery_telegram_state.json");
const LOG_PATH = path.resolve(process.cwd(), "logs", "rapid_recovery_telegram_send_log.jsonl");
const TEMPLATE_ID = "rapid_recovery_outbound_v1";
const TEMPLATE_VERSION = "2026-03-05";

function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = {
    targetsFile: DEFAULT_TARGETS,
    dailySendCap: Number(process.env.TELEGRAM_DAILY_SEND_CAP || 15),
    cooldownHours: Number(process.env.TELEGRAM_TARGET_COOLDOWN_HOURS || 48),
    maxConsecutiveFailures: Number(process.env.TELEGRAM_MAX_CONSECUTIVE_FAILURES || 3),
    rejectRateThreshold: Number(process.env.TELEGRAM_REJECT_RATE_THRESHOLD || 0.35),
    rejectRateSampleMin: Number(process.env.TELEGRAM_REJECT_RATE_SAMPLE_MIN || 6),
    bannedKeywords: String(
      process.env.TELEGRAM_BANNED_KEYWORDS || "airdrop,free money,gamble,casino,profit guaranteed"
    )
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--targets-file") {
      const next = argv[i + 1];
      if (!next) throw new Error("--targets-file requires a path");
      out.targetsFile = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (token === "--daily-send-cap") {
      out.dailySendCap = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--cooldown-hours") {
      out.cooldownHours = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--max-consecutive-failures") {
      out.maxConsecutiveFailures = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--reject-rate-threshold") {
      out.rejectRateThreshold = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--reject-rate-sample-min") {
      out.rejectRateSampleMin = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--banned-keywords") {
      out.bannedKeywords = String(argv[i + 1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (token === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!Number.isFinite(out.dailySendCap) || out.dailySendCap <= 0) {
    throw new Error("--daily-send-cap must be > 0");
  }
  if (!Number.isFinite(out.cooldownHours) || out.cooldownHours < 0) {
    throw new Error("--cooldown-hours must be >= 0");
  }
  return out;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function appendJsonLine(filePath: string, row: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function loadState(): TelegramState {
  return readJson<TelegramState>(STATE_PATH, {
    halted: false,
    consecutiveFailures: 0,
    totalAttempts: 0,
    totalRejectedSignals: 0,
    sendHistory: [],
  });
}

function statePolicy(options: CliOptions): TelegramGuardrailPolicy {
  return {
    dailySendCap: options.dailySendCap,
    cooldownHoursPerTarget: options.cooldownHours,
    maxConsecutiveFailures: options.maxConsecutiveFailures,
    rejectRateThreshold: options.rejectRateThreshold,
    rejectRateSampleMin: options.rejectRateSampleMin,
    bannedKeywords: options.bannedKeywords,
  };
}

function buildMessage(target: TargetRow): string {
  return [
    `Hi ${target.name || "there"},`,
    "timeout/validation/rejected 이슈를 1줄 입력으로 즉시 복구해드립니다.",
    "결과: 원인 분류 + retry payload + 실행 next actions(JSON).",
    "CTA: 0.02 진입(Hotfix) -> 0.05 Turbo -> 0.12 Guardrail",
  ].join("\n");
}

function hashMessage(message: string): string {
  return crypto.createHash("sha256").update(message).digest("hex");
}

function isRejectionSignal(rawText: string): boolean {
  const text = rawText.toLowerCase();
  return (
    text.includes("blocked by the user") ||
    text.includes("user is deactivated") ||
    text.includes("too many requests") ||
    text.includes("spam") ||
    text.includes("forbidden")
  );
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  message: string
): Promise<{ ok: boolean; reason?: string; rejectedSignal?: boolean }> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      reason: `${response.status} ${body.slice(0, 200)}`,
      rejectedSignal: isRejectionSignal(body),
    };
  }

  try {
    const parsed = JSON.parse(body) as { ok?: boolean; description?: string };
    if (parsed.ok === false) {
      const reason = parsed.description || "telegram api rejected";
      return { ok: false, reason, rejectedSignal: isRejectionSignal(reason) };
    }
  } catch {
    // best effort
  }

  return { ok: true };
}

function updateStateAfterSend(state: TelegramState, record: TelegramSendRecord): TelegramState {
  const nextHistory = [...state.sendHistory, record].slice(-5000);
  const totalAttempts = state.totalAttempts + 1;
  const totalRejectedSignals = state.totalRejectedSignals + (record.rejectionSignal ? 1 : 0);

  let consecutiveFailures = 0;
  if (record.result === "sent") {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures = state.consecutiveFailures + 1;
  }

  return {
    ...state,
    consecutiveFailures,
    totalAttempts,
    totalRejectedSignals,
    sendHistory: nextHistory,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = readJson<TargetRow[]>(options.targetsFile, []);
  const policy = statePolicy(options);
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();

  if (!options.dryRun && !token && targets.length > 0) {
    throw new Error("TELEGRAM_BOT_TOKEN is required unless --dry-run is used");
  }

  let state = loadState();
  const logs: SendLogRow[] = [];

  for (const target of targets) {
    const nowIso = new Date().toISOString();
    const global = checkTelegramGlobalStop(state, policy);
    if (!global.allowed) {
      state = {
        ...state,
        halted: global.shouldHaltNow || state.halted,
        haltReason: global.reason || state.haltReason,
      };
      logs.push({
        who: target.chatId,
        when: nowIso,
        template: TEMPLATE_ID,
        version: TEMPLATE_VERSION,
        result: "blocked",
        reason: global.reason,
      });
      break;
    }

    const message = buildMessage(target);
    const messageHash = hashMessage(message);
    const precheck = decideTelegramSend(state, policy, {
      chatId: target.chatId,
      messageText: message,
      messageHash,
      nowIso,
    });
    if (!precheck.allowed) {
      logs.push({
        who: target.chatId,
        when: nowIso,
        template: TEMPLATE_ID,
        version: TEMPLATE_VERSION,
        result: "skipped",
        reason: precheck.reason,
      });
      if (precheck.shouldHaltNow) {
        state = {
          ...state,
          halted: true,
          haltReason: precheck.reason,
        };
        break;
      }
      continue;
    }

    let sendResult: { ok: boolean; reason?: string; rejectedSignal?: boolean };
    if (options.dryRun) {
      sendResult = { ok: true };
    } else {
      sendResult = await sendTelegramMessage(token, target.chatId, message);
    }

    const record: TelegramSendRecord = {
      chatId: target.chatId,
      whenIso: nowIso,
      messageHash,
      result: sendResult.ok ? "sent" : sendResult.rejectedSignal ? "rejected" : "failed",
      rejectionSignal: Boolean(sendResult.rejectedSignal),
    };
    state = updateStateAfterSend(state, record);

    logs.push({
      who: target.chatId,
      when: nowIso,
      template: TEMPLATE_ID,
      version: TEMPLATE_VERSION,
      result: sendResult.ok ? (options.dryRun ? "dry_run_sent" : "sent") : "failed",
      reason: sendResult.reason,
    });

    const postGlobal = checkTelegramGlobalStop(state, policy);
    if (!postGlobal.allowed && postGlobal.shouldHaltNow) {
      state = {
        ...state,
        halted: true,
        haltReason: postGlobal.reason || "guardrail stop",
      };
      break;
    }
  }

  writeJson(STATE_PATH, state);
  for (const row of logs) {
    appendJsonLine(LOG_PATH, row as Record<string, unknown>);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        processedTargets: targets.length,
        logs,
        finalState: {
          halted: state.halted,
          haltReason: state.haltReason || null,
          consecutiveFailures: state.consecutiveFailures,
          totalAttempts: state.totalAttempts,
          totalRejectedSignals: state.totalRejectedSignals,
        },
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

export interface RevenueJobRecord {
  id: number | string;
  offeringName: string;
  clientAddress: string;
  priceUsdc: number;
  completedAtIso?: string;
  recommendedNextTier?: string;
}

export interface LeadBountyDecisionInput {
  yesterdayExternalJobs: number;
  dailyBudgetUsedUsdc: number;
  dailyBudgetCapUsdc: number;
  dailyCreatedCount: number;
  maxDailyBounties: number;
}

export interface LeadBountyDecision {
  enabled: boolean;
  reason?: string;
}

export interface UpsellConversionStats {
  candidates: number;
  conversions: number;
  conversionRate: number;
}

export interface OfferingConversionRow {
  offering: string;
  jobs: number;
  usdc: number;
}

export interface TelegramGuardrailPolicy {
  dailySendCap: number;
  cooldownHoursPerTarget: number;
  maxConsecutiveFailures: number;
  rejectRateThreshold: number;
  rejectRateSampleMin: number;
  bannedKeywords: string[];
}

export interface TelegramSendRecord {
  chatId: string;
  whenIso: string;
  messageHash: string;
  result: "sent" | "failed" | "rejected";
  rejectionSignal?: boolean;
}

export interface TelegramState {
  halted: boolean;
  haltReason?: string;
  consecutiveFailures: number;
  totalAttempts: number;
  totalRejectedSignals: number;
  sendHistory: TelegramSendRecord[];
}

export interface TelegramSendDecision {
  allowed: boolean;
  reason?: string;
  shouldHaltNow?: boolean;
}

function lowerAddress(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function isExternalClient(clientAddress: string, internalWallets: Set<string>): boolean {
  const normalized = lowerAddress(clientAddress);
  if (!normalized) return false;
  return !internalWallets.has(normalized);
}

export function offeringConversions(
  jobs: RevenueJobRecord[],
  startTimeMs: number
): OfferingConversionRow[] {
  const counters = new Map<string, OfferingConversionRow>();
  for (const job of jobs) {
    const completedAtMs = Date.parse(job.completedAtIso || "");
    if (!Number.isFinite(completedAtMs) || completedAtMs < startTimeMs) continue;
    const offering = job.offeringName || "unknown";
    const row = counters.get(offering) ?? { offering, jobs: 0, usdc: 0 };
    row.jobs += 1;
    row.usdc += Number(job.priceUsdc || 0);
    counters.set(offering, row);
  }

  return [...counters.values()]
    .map((row) => ({ ...row, usdc: Number(row.usdc.toFixed(6)) }))
    .sort((a, b) => b.jobs - a.jobs || b.usdc - a.usdc);
}

export function calculateUpsellConversion(
  jobs: RevenueJobRecord[],
  startTimeMs: number
): UpsellConversionStats {
  let candidates = 0;
  let conversions = 0;

  for (const job of jobs) {
    const completedAtMs = Date.parse(job.completedAtIso || "");
    if (!Number.isFinite(completedAtMs) || completedAtMs < startTimeMs) continue;

    if (
      job.offeringName === "ops_recovery_hotfix_openrouter_v1" &&
      (job.recommendedNextTier === "turbo" || job.recommendedNextTier === "guardrail")
    ) {
      candidates += 1;
    }

    if (
      job.offeringName === "ops_recovery_turbo_v1" ||
      job.offeringName === "ops_recovery_guardrail_v1"
    ) {
      conversions += 1;
    }
  }

  return {
    candidates,
    conversions,
    conversionRate: candidates > 0 ? Number((conversions / candidates).toFixed(6)) : 0,
  };
}

export function decideLeadBountyActivation(input: LeadBountyDecisionInput): LeadBountyDecision {
  if (input.yesterdayExternalJobs >= 1) {
    return { enabled: false, reason: "yesterday external paid jobs >= 1" };
  }
  if (input.dailyBudgetUsedUsdc >= input.dailyBudgetCapUsdc) {
    return { enabled: false, reason: "daily budget cap reached" };
  }
  if (input.dailyCreatedCount >= input.maxDailyBounties) {
    return { enabled: false, reason: "daily bounty creation cap reached" };
  }
  return { enabled: true };
}

export function checkTelegramGlobalStop(
  state: TelegramState,
  policy: TelegramGuardrailPolicy
): TelegramSendDecision {
  if (state.halted) {
    return { allowed: false, reason: state.haltReason || "outbound halted" };
  }
  if (state.consecutiveFailures >= policy.maxConsecutiveFailures) {
    return {
      allowed: false,
      reason: "max consecutive failures reached",
      shouldHaltNow: true,
    };
  }
  if (state.totalAttempts >= policy.rejectRateSampleMin) {
    const rejectRate = state.totalRejectedSignals / Math.max(1, state.totalAttempts);
    if (rejectRate > policy.rejectRateThreshold) {
      return {
        allowed: false,
        reason: "reject rate threshold exceeded",
        shouldHaltNow: true,
      };
    }
  }
  return { allowed: true };
}

export function decideTelegramSend(
  state: TelegramState,
  policy: TelegramGuardrailPolicy,
  candidate: {
    chatId: string;
    messageText: string;
    messageHash: string;
    nowIso: string;
  }
): TelegramSendDecision {
  const global = checkTelegramGlobalStop(state, policy);
  if (!global.allowed) return global;

  const now = Date.parse(candidate.nowIso);
  if (!Number.isFinite(now)) {
    return { allowed: false, reason: "invalid send timestamp" };
  }

  const dayKey = candidate.nowIso.slice(0, 10);
  const sentToday = state.sendHistory.filter((row) => row.whenIso.slice(0, 10) === dayKey).length;
  if (sentToday >= policy.dailySendCap) {
    return { allowed: false, reason: "daily send cap reached" };
  }

  const lowerMessage = candidate.messageText.toLowerCase();
  const blockedKeyword = policy.bannedKeywords.find((word) =>
    lowerMessage.includes(word.toLowerCase())
  );
  if (blockedKeyword) {
    return { allowed: false, reason: `blocked keyword: ${blockedKeyword}` };
  }

  if (
    state.sendHistory.some(
      (row) => row.messageHash === candidate.messageHash && row.chatId === candidate.chatId
    )
  ) {
    return { allowed: false, reason: "duplicate message hash blocked" };
  }

  const cooldownMs = policy.cooldownHoursPerTarget * 60 * 60 * 1000;
  const recentTargetSend = [...state.sendHistory]
    .reverse()
    .find((row) => row.chatId === candidate.chatId);
  if (recentTargetSend) {
    const lastTs = Date.parse(recentTargetSend.whenIso);
    if (Number.isFinite(lastTs) && now - lastTs < cooldownMs) {
      return { allowed: false, reason: "target cooldown active" };
    }
  }

  return { allowed: true };
}

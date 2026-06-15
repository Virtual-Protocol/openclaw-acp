import test from "node:test";
import assert from "node:assert/strict";
import {
  checkTelegramGlobalStop,
  decideLeadBountyActivation,
  decideTelegramSend,
} from "../src/seller/runtime/revenueSprintGuards.js";

test("lead bounty activation runs only when yesterday external jobs are below threshold", () => {
  const blocked = decideLeadBountyActivation({
    yesterdayExternalJobs: 1,
    dailyBudgetUsedUsdc: 0,
    dailyBudgetCapUsdc: 0.1,
    dailyCreatedCount: 0,
    maxDailyBounties: 1,
  });
  assert.equal(blocked.enabled, false);

  const allowed = decideLeadBountyActivation({
    yesterdayExternalJobs: 0,
    dailyBudgetUsedUsdc: 0.02,
    dailyBudgetCapUsdc: 0.1,
    dailyCreatedCount: 0,
    maxDailyBounties: 1,
  });
  assert.equal(allowed.enabled, true);
});

test("telegram pre-send guard blocks banned keywords and target cooldown", () => {
  const state = {
    halted: false,
    consecutiveFailures: 0,
    totalAttempts: 1,
    totalRejectedSignals: 0,
    sendHistory: [
      {
        chatId: "1001",
        whenIso: "2026-03-05T00:00:00.000Z",
        messageHash: "abc",
        result: "sent" as const,
      },
    ],
  };
  const policy = {
    dailySendCap: 10,
    cooldownHoursPerTarget: 48,
    maxConsecutiveFailures: 3,
    rejectRateThreshold: 0.5,
    rejectRateSampleMin: 6,
    bannedKeywords: ["airdrop"],
  };

  const banned = decideTelegramSend(state, policy, {
    chatId: "1002",
    messageText: "Free airdrop now",
    messageHash: "hash-1",
    nowIso: "2026-03-05T01:00:00.000Z",
  });
  assert.equal(banned.allowed, false);
  assert.match(String(banned.reason), /blocked keyword/i);

  const cooldown = decideTelegramSend(state, policy, {
    chatId: "1001",
    messageText: "Normal recovery CTA",
    messageHash: "hash-2",
    nowIso: "2026-03-05T02:00:00.000Z",
  });
  assert.equal(cooldown.allowed, false);
  assert.match(String(cooldown.reason), /cooldown/i);
});

test("telegram global stop triggers on consecutive failures and reject-rate overflow", () => {
  const policy = {
    dailySendCap: 10,
    cooldownHoursPerTarget: 24,
    maxConsecutiveFailures: 3,
    rejectRateThreshold: 0.3,
    rejectRateSampleMin: 4,
    bannedKeywords: [],
  };

  const consecutiveFailureState = {
    halted: false,
    consecutiveFailures: 3,
    totalAttempts: 3,
    totalRejectedSignals: 0,
    sendHistory: [],
  };
  const failureStop = checkTelegramGlobalStop(consecutiveFailureState, policy);
  assert.equal(failureStop.allowed, false);
  assert.equal(failureStop.shouldHaltNow, true);

  const rejectRateState = {
    halted: false,
    consecutiveFailures: 0,
    totalAttempts: 10,
    totalRejectedSignals: 5,
    sendHistory: [],
  };
  const rejectStop = checkTelegramGlobalStop(rejectRateState, policy);
  assert.equal(rejectStop.allowed, false);
  assert.equal(rejectStop.shouldHaltNow, true);
});

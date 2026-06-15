import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecoveryDeliverable,
  recommendNextTier,
  validateRecoveryRequest,
} from "../src/seller/runtime/recoveryRouterOfferings.js";
import { fallbackRecoveryPack } from "../src/seller/runtime/openrouterRecovery.js";

test("hotfix validator rejects missing error_text", () => {
  const result = validateRecoveryRequest({}, { allowPersonaMode: true });
  assert.equal(typeof result === "object" ? result.valid : result, false);
});

test("guardrail validator requires incident_context and blocks persona_mode", () => {
  const missingContext = validateRecoveryRequest(
    { error_text: "timeout", persona_mode: "speed" },
    { requireIncidentContext: true, allowPersonaMode: false }
  );
  assert.equal(typeof missingContext === "object" ? missingContext.valid : missingContext, false);

  const withContextAndPersona = validateRecoveryRequest(
    {
      error_text: "timeout",
      incident_context: "peak traffic incident",
      persona_mode: "speed",
    },
    { requireIncidentContext: true, allowPersonaMode: false }
  );
  assert.equal(
    typeof withContextAndPersona === "object" ? withContextAndPersona.valid : withContextAndPersona,
    false
  );
});

test("recommended_next_tier routes by classification and confidence", () => {
  const validationPack = fallbackRecoveryPack({
    error_text: "validation failed: target_agent_name required",
  });
  assert.equal(recommendNextTier(validationPack), "guardrail");

  const timeoutPack = {
    ...fallbackRecoveryPack({ error_text: "timeout while waiting for target" }),
    confidence: 0.8,
  };
  assert.equal(recommendNextTier(timeoutPack), "turbo");

  const rejectedPack = {
    ...fallbackRecoveryPack({ error_text: "request rejected by policy" }),
    confidence: 0.92,
    lane: "budget" as const,
    classification: "rejected" as const,
  };
  assert.equal(recommendNextTier(rejectedPack), "none");
});

test("deliverable includes standardized fields and optional recommended_next_tier", () => {
  const recovery = fallbackRecoveryPack({
    error_text: "timeout while waiting for target",
    target_system: "acp",
  });
  const deliverable = buildRecoveryDeliverable({
    offering: "ops_recovery_hotfix_openrouter_v1",
    tier: "hotfix",
    input: { error_text: "timeout while waiting for target" },
    recovery,
    includeRecommendedNextTier: true,
  });

  assert.equal(deliverable.type, "json");
  assert.equal(deliverable.value.service, "rapid-recovery-router");
  assert.equal(typeof deliverable.value.cta, "object");
  assert.equal(
    ["none", "turbo", "guardrail"].includes(String(deliverable.value.recommended_next_tier)),
    true
  );
});

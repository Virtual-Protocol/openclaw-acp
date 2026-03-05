import test from "node:test";
import assert from "node:assert/strict";
import { executeJob as executeHotfix } from "../src/seller/offerings/rapid-recovery-router/ops_recovery_hotfix_openrouter_v1/handlers.js";
import { executeJob as executeTurbo } from "../src/seller/offerings/rapid-recovery-router/ops_recovery_turbo_v1/handlers.js";
import { executeJob as executeGuardrail } from "../src/seller/offerings/rapid-recovery-router/ops_recovery_guardrail_v1/handlers.js";

function assertFreeModelIfOpenRouter(deliverable: any) {
  const model = String(deliverable?.value?.recovery?.model || "");
  const provider = String(deliverable?.value?.recovery?.provider || "");
  if (provider === "openrouter") {
    assert.equal(model === "openrouter/free" || model.endsWith(":free"), true);
  }
}

test("hotfix offering returns standardized JSON with recommended_next_tier", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const result = await executeHotfix({
      error_text: "timeout while waiting for response from target",
      target_system: "acp",
      persona_mode: "speed",
    });
    const deliverable = result.deliverable as any;
    assert.equal(deliverable.type, "json");
    assert.equal(deliverable.value.offering, "ops_recovery_hotfix_openrouter_v1");
    assert.equal(
      ["none", "turbo", "guardrail"].includes(deliverable.value.recommended_next_tier),
      true
    );
    assert.equal(Array.isArray(deliverable.value.next_actions), true);
    assertFreeModelIfOpenRouter(deliverable);
  } finally {
    if (prevKey) process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test("turbo offering returns standardized JSON payload", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const result = await executeTurbo({
      error_text: "request rejected by remote policy",
      failed_payload: '{"job":"retry"}',
      target_system: "acp",
    });
    const deliverable = result.deliverable as any;
    assert.equal(deliverable.type, "json");
    assert.equal(deliverable.value.offering, "ops_recovery_turbo_v1");
    assert.equal(typeof deliverable.value.cta, "object");
    assertFreeModelIfOpenRouter(deliverable);
  } finally {
    if (prevKey) process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test("guardrail offering forces completion lane and returns no further upsell", async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const result = await executeGuardrail({
      error_text: "validation failed: countryCode missing",
      incident_context: "high-value order queue, repeated failed runs",
      target_system: "acp",
    });
    const deliverable = result.deliverable as any;
    assert.equal(deliverable.type, "json");
    assert.equal(deliverable.value.offering, "ops_recovery_guardrail_v1");
    assert.equal(deliverable.value.input.persona_mode, "completion");
    assert.equal(deliverable.value.cta.recommended_next_tier, "none");
    assertFreeModelIfOpenRouter(deliverable);
  } finally {
    if (prevKey) process.env.OPENROUTER_API_KEY = prevKey;
  }
});

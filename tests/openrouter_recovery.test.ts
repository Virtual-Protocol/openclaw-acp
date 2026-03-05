import test from "node:test";
import assert from "node:assert/strict";
import { __testables } from "../src/seller/runtime/openrouterRecovery.js";

test("model resolution ignores non-free OPENROUTER_MODEL and uses OPENROUTER_FREE_MODEL", () => {
  const model = __testables.resolveOpenRouterModel({
    OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    OPENROUTER_FREE_MODEL: "meta-llama/llama-3.1-8b-instruct:free",
  });

  assert.equal(model, "meta-llama/llama-3.1-8b-instruct:free");
});

test("model resolution falls back to OPENROUTER_FREE_MODEL", () => {
  const model = __testables.resolveOpenRouterModel({
    OPENROUTER_FREE_MODEL: "meta-llama/llama-3.1-8b-instruct:free",
  });

  assert.equal(model, "meta-llama/llama-3.1-8b-instruct:free");
});

test("model resolution falls back to openrouter/free when configured model is not free", () => {
  const model = __testables.resolveOpenRouterModel({
    OPENROUTER_FREE_MODEL: "openai/gpt-4.1-mini",
  });

  assert.equal(model, "openrouter/free");
});

test("free model id detector accepts :free suffix and openrouter/free", () => {
  assert.equal(__testables.isFreeModelId("openrouter/free"), true);
  assert.equal(__testables.isFreeModelId("google/gemma-3-27b-it:free"), true);
  assert.equal(__testables.isFreeModelId("openai/gpt-4.1-mini"), false);
});

test("json extraction can parse fenced response", () => {
  const parsed = __testables.extractFirstJsonObject(`\n\`\`\`json\n{"a":1,"b":"ok"}\n\`\`\`\n`);

  assert.deepEqual(parsed, { a: 1, b: "ok" });
});

test("fallback pack returns actionable recovery payload", () => {
  const pack = __testables.fallbackRecoveryPack({
    error_text: "validation failed: target_agent_name required",
    target_system: "acp",
  });

  assert.equal(pack.classification, "validation");
  assert.equal(pack.lane, "guardrail");
  assert.equal(pack.retry_payload.target_agent_name, "<required>");
  assert.equal(Array.isArray(pack.next_actions), true);
  assert.equal(pack.next_actions.length > 0, true);
});

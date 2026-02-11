#!/usr/bin/env npx tsx
// =============================================================================
// Deterministic listener stack tests (no ACP network dependency).
// =============================================================================

import assert from "assert/strict";
import { AcpJobPhase } from "../src/seller/runtime/types.js";
import {
  normalizeAddress,
  normalizePhase,
  phaseLabel,
} from "../src/seller/runtime/normalize.js";
import {
  findMemoByNextPhase,
  getJobId,
  hasMemoWithNextPhase,
  resolveOfferingName,
  resolveServiceRequirements,
} from "../src/seller/runtime/jobExtract.js";
import {
  isRetryableError,
  parseHttpError,
} from "../src/seller/runtime/retry.js";

function run(): void {
  const baseJob = {
    id: "456",
    phase: "NEGOTIATION",
    name: "fallback_name",
    context: {
      jobOfferingName: "context_name",
    },
    memos: [
      {
        id: 1,
        nextPhase: "NEGOTIATION",
        content: JSON.stringify({
          name: "memo_name",
          requirement: {
            apiDescription: "build endpoint",
          },
        }),
      },
    ],
  };

  assert.equal(getJobId(baseJob), 456);
  assert.equal(normalizePhase(baseJob.phase), AcpJobPhase.NEGOTIATION);
  assert.equal(phaseLabel(baseJob.phase), "NEGOTIATION");
  assert.equal(resolveOfferingName(baseJob), "context_name");
  assert.deepEqual(resolveServiceRequirements(baseJob), {
    apiDescription: "build endpoint",
  });

  const memo = findMemoByNextPhase(baseJob.memos, AcpJobPhase.NEGOTIATION);
  assert.ok(memo);
  assert.equal(hasMemoWithNextPhase(baseJob.memos, AcpJobPhase.NEGOTIATION), true);
  assert.equal(hasMemoWithNextPhase(baseJob.memos, AcpJobPhase.TRANSACTION), false);

  // Inline requirements fallback when requirement object is absent.
  const inlineRequirementsJob = {
    id: 789,
    phase: 1,
    memos: [
      {
        id: 2,
        nextPhase: 1,
        content: JSON.stringify({
          offeringName: "inline",
          endpoint: "https://api.example.invalid",
          framework: "hono",
        }),
      },
    ],
  };

  assert.equal(resolveOfferingName(inlineRequirementsJob), "inline");
  assert.deepEqual(resolveServiceRequirements(inlineRequirementsJob), {
    endpoint: "https://api.example.invalid",
    framework: "hono",
  });

  // Address normalization
  assert.equal(
    normalizeAddress("0xAbCdEf0000000000000000000000000000000001"),
    "0xabcdef0000000000000000000000000000000001"
  );

  // HTTP error parsing + retry classifier
  const parsed429 = parseHttpError({ message: JSON.stringify({ statusCode: 429, message: "rate limited" }) });
  assert.equal(parsed429.statusCode, 429);
  assert.equal(isRetryableError({ message: JSON.stringify({ statusCode: 429 }) }), true);
  assert.equal(isRetryableError({ message: JSON.stringify({ statusCode: 400 }) }), false);
  assert.equal(isRetryableError(new Error("socket hang up")), true);

  console.log("OK: listener stack deterministic tests passed.");
}

run();

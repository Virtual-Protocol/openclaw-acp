#!/usr/bin/env npx tsx
// =============================================================================
// Deterministic repro: seller runtime ignoring jobs due to phase/nextPhase type drift.
//
// Problem:
// - Older seller runtime expected numeric phases (0..6) and numeric memo.nextPhase.
// - ACP REST (and likely socket payloads) can return string phases like "NEGOTIATION".
// - Direct enum comparisons then fail, so jobs are silently skipped.
//
// This script demonstrates the mismatch and validates the normalizers.
// =============================================================================

import assert from "assert";
import { AcpJobPhase } from "../src/seller/runtime/types.js";
import { normalizePhase, phaseLabel } from "../src/seller/runtime/normalize.js";
import {
  resolveOfferingName,
  resolveServiceRequirements,
  hasMemoWithNextPhase,
} from "../src/seller/runtime/jobExtract.js";

const sampleJob = {
  id: 123,
  phase: "NEGOTIATION",
  clientAddress: "0x1111111111111111111111111111111111111111",
  providerAddress: "0x2222222222222222222222222222222222222222",
  price: 1,
  memos: [
    {
      id: 999,
      // String nextPhase (as seen in /acp/jobs/* responses)
      nextPhase: "NEGOTIATION",
      content: JSON.stringify({
        name: "typescript_api_development",
        requirement: { apiDescription: "Build /health" },
        priceValue: 1,
        priceType: "fixed",
      }),
      createdAt: new Date().toISOString(),
      status: "APPROVED",
    },
  ],
};

// --- Old behavior (illustrative) ---
const oldShouldAccept = (sampleJob as any).phase === AcpJobPhase.REQUEST;
const oldNegotiationMemo = (sampleJob as any).memos.find(
  (m: any) => m.nextPhase === AcpJobPhase.NEGOTIATION
);

console.log(
  JSON.stringify(
    {
      old: {
        phase: (sampleJob as any).phase,
        shouldAccept: oldShouldAccept,
        negotiationMemoFound: Boolean(oldNegotiationMemo),
      },
    },
    null,
    2
  )
);

// --- New behavior ---
const normalized = normalizePhase((sampleJob as any).phase);
const offeringName = resolveOfferingName(sampleJob as any);
const requirements = resolveServiceRequirements(sampleJob as any);

console.log(
  JSON.stringify(
    {
      new: {
        phase: (sampleJob as any).phase,
        phaseLabel: phaseLabel((sampleJob as any).phase),
        normalized,
        offeringName,
        requirementKeys: Object.keys(requirements),
        paymentRequested: hasMemoWithNextPhase(
          (sampleJob as any).memos,
          AcpJobPhase.TRANSACTION
        ),
      },
    },
    null,
    2
  )
);

assert.equal(oldShouldAccept, false);
assert.equal(Boolean(oldNegotiationMemo), false);

assert.equal(normalized, AcpJobPhase.NEGOTIATION);
assert.equal(offeringName, "typescript_api_development");
assert.equal(typeof requirements.apiDescription, "string");

console.log("\nOK: normalizers handle string phases; offering+requirements extracted.\n");

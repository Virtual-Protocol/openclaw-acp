import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequirements as validateQuick } from "../offerings/connieonbase/guardian_scan_quick/handlers.js";
import { validateRequirements as validateStandard } from "../offerings/connieonbase/guardian_scan_standard/handlers.js";
import { validateRequirements as validateDeep } from "../offerings/connieonbase/guardian_scan_deep/handlers.js";
import type { ValidationResult } from "../runtime/offeringTypes.js";

const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function resultValid(result: ValidationResult): boolean {
  if (typeof result === "boolean") return result;
  return result.valid;
}

function resultReason(result: ValidationResult): string {
  if (typeof result === "boolean") return "";
  return result.reason ?? "";
}

const suites = [
  { tier: "quick", validate: validateQuick },
  { tier: "standard", validate: validateStandard },
  { tier: "deep", validate: validateDeep },
] as const;

for (const { tier, validate } of suites) {
  test(`${tier}: validateRequirements handles valid/invalid/missing/extra fields`, () => {
    const validResult = validate({ wallet: VALID_WALLET });
    assert.equal(resultValid(validResult), true, "expected valid wallet to pass");

    const invalidResult = validate({ wallet: "0x1234" });
    assert.equal(resultValid(invalidResult), false, "expected malformed wallet to fail");
    assert.match(resultReason(invalidResult), /Invalid wallet address/i);

    const missingResult = validate({});
    assert.equal(resultValid(missingResult), false, "expected missing wallet to fail");
    assert.match(resultReason(missingResult), /wallet \(or address\) is required/i);

    const extraFieldsResult = validate({
      wallet: VALID_WALLET,
      foo: "bar",
      nested: { value: 123 },
    });
    assert.equal(resultValid(extraFieldsResult), true, "expected extra fields to be ignored");
  });
}

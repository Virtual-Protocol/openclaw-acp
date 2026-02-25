import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { listOfferings, loadOffering, logOfferingsStatus } from "../runtime/offerings.js";

const OFFERINGS_ROOT = path.resolve(process.cwd(), "src/seller/offerings");

test("listOfferings discovers all Guardian offerings", () => {
  const offerings = listOfferings("connieonbase");

  assert.ok(offerings.includes("guardian_scan_quick"));
  assert.ok(offerings.includes("guardian_scan_standard"));
  assert.ok(offerings.includes("guardian_scan_deep"));
});

test("loadOffering throws when offering.json or handlers.ts is missing", async () => {
  const agentDirName = `test_agent_${Date.now()}`;
  const agentRoot = path.join(OFFERINGS_ROOT, agentDirName);
  const missingJsonDir = path.join(agentRoot, "missing_json");
  const missingHandlersDir = path.join(agentRoot, "missing_handlers");

  fs.mkdirSync(missingJsonDir, { recursive: true });
  fs.mkdirSync(missingHandlersDir, { recursive: true });

  fs.writeFileSync(
    path.join(missingJsonDir, "handlers.ts"),
    "export async function executeJob(){ return { deliverable: 'ok' }; }\n"
  );

  fs.writeFileSync(
    path.join(missingHandlersDir, "offering.json"),
    JSON.stringify(
      {
        name: "missing_handlers",
        description: "test",
        jobFee: 1,
        jobFeeType: "fixed",
        requiredFunds: false,
      },
      null,
      2
    ) + "\n"
  );

  await assert.rejects(
    () => loadOffering("missing_json", agentDirName),
    /offering\.json not found/
  );
  await assert.rejects(
    () => loadOffering("missing_handlers", agentDirName),
    /handlers\.ts not found/
  );

  fs.rmSync(agentRoot, { recursive: true, force: true });
});

test("zero offerings regression: warning is logged when offerings are empty", () => {
  const agentDirName = `test_empty_${Date.now()}`;
  const agentRoot = path.join(OFFERINGS_ROOT, agentDirName);
  fs.mkdirSync(agentRoot, { recursive: true });

  const offerings = listOfferings(agentDirName);
  assert.equal(offerings.length, 0);

  const warnings: string[] = [];
  const logs: string[] = [];

  logOfferingsStatus(agentDirName, offerings, {
    warn: (msg: string) => warnings.push(msg),
    log: (msg: string) => logs.push(msg),
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING: No offerings discovered/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Available offerings: \(none\)/);

  fs.rmSync(agentRoot, { recursive: true, force: true });
});

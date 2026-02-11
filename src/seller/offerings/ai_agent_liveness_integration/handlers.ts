import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["agentFramework"] as const;

type Requirements = {
  agentFramework?: string;
  agentEndpoint?: string;
  monitoringRequirements?: string;
};

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function writeSnapshot(jobDir: string, requirements: Requirements, ctx: JobContext): void {
  writeJsonFile(jobDir, "JOB_SNAPSHOT.json", {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offeringName: ctx.offeringName,
    clientAddress: ctx.job.clientAddress,
    providerAddress: ctx.job.providerAddress,
    evaluatorAddress: ctx.job.evaluatorAddress,
    price: ctx.job.price,
    phase: ctx.job.phase,
    createdAt: ctx.job.createdAt,
    acpContext: ctx.job.context,
    memos: ctx.job.memos,
    requirements,
  });
}

function intakeMarkdown(missing: string[]): string {
  return [
    "# Intake required — AI Agent Liveness Integration",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `agentFramework` (framework + version).",
    "",
    "Recommended fields:",
    "- agentEndpoint: health endpoint / API base URL",
    "- monitoringRequirements: thresholds, cadence, alert channels, pager policy",
    "",
    "Example:",
    "```json",
    "{",
    "  \"agentFramework\": \"OpenClaw vX.Y\",",
    "  \"agentEndpoint\": \"https://example.com/health\",",
    "  \"monitoringRequirements\": \"Alert after 2 consecutive failures; 5m checks\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function buildIntegrationPlan(
  requirements: Requirements,
  ctx: JobContext
): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    framework: text(requirements.agentFramework, ""),
    endpoint: text(requirements.agentEndpoint, "not provided"),
    monitoringRequirements: text(
      requirements.monitoringRequirements,
      "default: 5m checks, alert on 2 consecutive failures"
    ),
    integrationSteps: [
      "Define heartbeat source (cron/runtime loop/external scheduler)",
      "Define liveness signal path (endpoint + optional on-chain pulse)",
      "Attach alert channels and escalation thresholds",
      "Document operator runbook and incident response flow",
    ],
    baselinePolicy: {
      checkIntervalMinutes: 5,
      failureThreshold: 2,
      recoveryThreshold: 1,
      alertSeverityLevels: ["warning", "critical"],
    },
  };
}

function alertPolicyMarkdown(requirements: Requirements): string {
  return [
    "# Alert Policy Draft",
    "",
    `Framework: ${text(requirements.agentFramework, "unknown")}`,
    `Endpoint: ${text(requirements.agentEndpoint, "not provided")}`,
    "",
    "## Suggested defaults",
    "- Run health checks every 5 minutes",
    "- Trigger warning after 1 failure",
    "- Trigger critical after 2 consecutive failures",
    "- Resolve incident after 1 successful check",
    "",
    "## Monitoring constraints from intake",
    text(requirements.monitoringRequirements, "- none provided"),
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; policyFile: string }
): string {
  return [
    "# REPORT — AI Agent Liveness Integration",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- agentFramework: ${text(requirements.agentFramework, "(missing)")}`,
    `- agentEndpoint: ${text(requirements.agentEndpoint, "not provided")}`,
    `- monitoringRequirements: ${text(requirements.monitoringRequirements, "not provided")}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.policyFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package includes an executable integration plan + alert policy draft on disk.",
    "- It does not claim a live deployment was performed unless deployment evidence exists in this folder.",
    "",
  ].join("\n");
}

export function validateRequirements(_requirements: any, _ctx: JobContext): ValidationResult {
  return { valid: true };
}

export function requestPayment(_requirements: any, _ctx: JobContext): string {
  return "Payment requested. If requirements are incomplete, deliverable will include an intake request with exact missing fields.";
}

export async function executeJob(
  requirementsRaw: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  const requirements: Requirements = (requirementsRaw ?? {}) as Requirements;

  writeSnapshot(ctx.jobDir, requirements, ctx);

  const missing = missingRequiredFields(requirements as any, [...REQUIRED_FIELDS]);
  if (missing.length > 0) {
    writeTextFile(ctx.jobDir, "INTAKE_REQUEST.md", intakeMarkdown(missing));

    return {
      deliverable: {
        type: "needs_info",
        value: buildNeedsInfoValue({
          offering: ctx.offeringName,
          jobId: ctx.jobId,
          jobDir: ctx.jobDir,
          missing,
          filesWritten: ["JOB_SNAPSHOT.json", "INTAKE_REQUEST.md"],
        }),
      },
    };
  }

  const planFile = "LIVENESS_INTEGRATION_PLAN.json";
  const policyFile = "ALERT_POLICY.md";

  writeJsonFile(ctx.jobDir, planFile, buildIntegrationPlan(requirements, ctx));
  writeTextFile(ctx.jobDir, policyFile, alertPolicyMarkdown(requirements));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, policyFile })
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, policyFile, "REPORT.md"],
      }),
    },
  };
}

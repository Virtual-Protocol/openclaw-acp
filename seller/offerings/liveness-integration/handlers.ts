import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import { dispatchOfferingDelivery } from "../../runtime/deliveryDispatcher.js";

export async function executeJob(
  request: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(request ?? {}, ctx, {
    offeringId: "ai_agent_liveness_integration",
    deliverableType: "liveness_integration_skeleton",
    reportFileName: "LIVENESS_PLAN.md",
    pipelineFileName: "PIPELINE.md",
    findingsFileName: "ACTION_ITEMS.json",
    requiredFields: [
      {
        id: "agentFramework",
        label: "Agent framework",
        description: "OpenClaw, ElizaOS, custom (include versions).",
      },
      {
        id: "agentEndpoint",
        label: "Agent endpoint",
        description: "Health check / API URL (optional but recommended).",
        required: false,
      },
      {
        id: "monitoringRequirements",
        label: "Monitoring requirements",
        description: "SLA, alert thresholds, escalation path (optional).",
        required: false,
      },
      {
        id: "deadline",
        label: "Deadline",
        description: "Desired integration deadline/timezone (optional)",
        aliases: ["due", "dueDate", "eta"],
        required: false,
      },
    ],
    generateFindings: ({ intake }) => {
      return {
        method: "intake_structuring",
        limitations:
          "No monitoring was configured in this step. This is a plan/skeleton only.",
        actionItems: [
          "Confirm the health endpoint path + expected 200 response.",
          "Define heartbeat interval and alert thresholds.",
          "Decide where alerts should go (email/Discord/PagerDuty/etc.).",
          "Decide if on-chain attestation is required and on which network.",
        ],
        summary: {
          framework: intake.agentFramework,
          endpointProvided: Boolean(intake.agentEndpoint),
          deadline: intake.deadline ?? null,
        },
      };
    },
    buildReport: ({ request, ctx, intake, deliveryDir }) => {
      const endpoint =
        typeof request.agentEndpoint === "string" && request.agentEndpoint.trim()
          ? request.agentEndpoint.trim()
          : "(not provided)";
      const reqs =
        typeof request.monitoringRequirements === "string"
          ? request.monitoringRequirements.trim()
          : "";

      return (
        `# Agent Liveness Integration — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Framework: ${intake.agentFramework ?? "(missing)"}\n` +
        `- Endpoint: ${endpoint}\n` +
        `- Deadline: ${intake.deadline ?? "(not provided)"}\n\n` +
        `## Important Note\n\n` +
        `This is a **skeleton** generated automatically. It does not claim monitoring is already configured.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Requirements (as provided)\n\n` +
        (reqs ? `\`\`\`\n${reqs}\n\`\`\`\n\n` : "(none provided)\n\n") +
        `## Plan\n\n` +
        `1. Add/confirm a /health endpoint that returns 200 OK and basic status.\n` +
        `2. Add a heartbeat job (cron) that pings /health and emits an alert on failures.\n` +
        `3. (Optional) Add on-chain liveness attestation if required by your setup.\n` +
        `4. Add dashboards + alert routing.\n`
      );
    },
    buildPipeline: ({ intake }) => {
      return (
        `# Liveness Pipeline (to run)\n\n` +
        `## 1) Health endpoint\n\n` +
        `- Ensure a stable endpoint exists (e.g., GET /health)\n\n` +
        `## 2) Heartbeat\n\n` +
        `- Configure cron interval (e.g., every 1m/5m)\n` +
        `- Add retries + exponential backoff\n\n` +
        `## 3) Alerting\n\n` +
        `- Route alerts to desired channel\n\n` +
        `## 4) Verification\n\n` +
        `- Simulate downtime and confirm alerts fire\n\n` +
        `## Notes\n\n` +
        `Framework: ${intake.agentFramework ?? "(missing)"}\n`
      );
    },
  });
}

export function validateRequirements(request: any): boolean {
  return (
    typeof request?.agentFramework === "string" &&
    request.agentFramework.trim().length > 0
  );
}

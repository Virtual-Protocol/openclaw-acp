import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import { dispatchOfferingDelivery } from "../../runtime/deliveryDispatcher.js";

export async function executeJob(
  request: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(request ?? {}, ctx, {
    offeringId: "typescript_api_development",
    deliverableType: "api_delivery_skeleton",
    reportFileName: "API_SPEC.md",
    pipelineFileName: "IMPLEMENTATION_PLAN.md",
    findingsFileName: "ACTION_ITEMS.json",
    requiredFields: [
      {
        id: "apiDescription",
        label: "API description",
        description:
          "Describe endpoints, inputs/outputs, auth, and any constraints.",
      },
      {
        id: "framework",
        label: "Framework",
        description: "Express, Fastify, Hono (optional)",
        required: false,
      },
      {
        id: "database",
        label: "Database",
        description: "PostgreSQL, SQLite, MongoDB (optional)",
        required: false,
      },
      {
        id: "repoUrl",
        label: "Repo URL",
        description:
          "If integrating into an existing codebase, provide the repository URL.",
        aliases: ["repositoryUrl", "url"],
        required: false,
      },
      {
        id: "deadline",
        label: "Deadline",
        description: "Desired delivery deadline/timezone (optional)",
        aliases: ["due", "dueDate", "eta"],
        required: false,
      },
    ],
    generateFindings: ({ request, intake }) => {
      const framework =
        typeof request.framework === "string" && request.framework.trim()
          ? request.framework.trim()
          : "Hono";
      const database =
        typeof request.database === "string" && request.database.trim()
          ? request.database.trim()
          : "PostgreSQL";

      return {
        method: "intake_structuring",
        limitations:
          "No code was generated or executed in this step. This is a plan/skeleton only.",
        summary: {
          framework,
          database,
          repoUrl: intake.repoUrl ?? null,
        },
        actionItems: [
          "List endpoints (method/path) + request/response JSON.",
          "Define auth model (API key/JWT/OAuth/session).",
          "Define database schema + migrations.",
          "Define error model and status codes.",
          "Confirm deployment target (Docker/Vercel/Fly/etc.).",
        ],
      };
    },
    buildReport: ({ request, ctx, intake, deliveryDir }) => {
      const framework =
        typeof request.framework === "string" && request.framework.trim()
          ? request.framework.trim()
          : "Hono";
      const database =
        typeof request.database === "string" && request.database.trim()
          ? request.database.trim()
          : "PostgreSQL";

      const apiDescription =
        typeof request.apiDescription === "string" ? request.apiDescription.trim() : "";
      const excerpt = apiDescription.length > 800 ? apiDescription.slice(0, 800) + "…" : apiDescription;

      return (
        `# TypeScript API Spec — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Framework: ${framework}\n` +
        `- Database: ${database}\n` +
        `- Deadline: ${intake.deadline ?? "(not provided)"}\n` +
        `- Repo URL: ${intake.repoUrl ?? "(not provided)"}\n\n` +
        `## Important Note\n\n` +
        `This is a **skeleton** generated automatically. It does not claim the API is implemented yet.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Requested Requirements (excerpt)\n\n` +
        `\`\`\`\n${excerpt || "(missing)"}\n\`\`\`\n\n` +
        `## Endpoint Inventory (fill in)\n\n` +
        `| Method | Path | Auth | Request | Response | Notes |\n` +
        `|---|---|---|---|---|---|\n` +
        `| GET | /health | none | - | { ok: true } | |\n\n` +
        `## Data Model (fill in)\n\n` +
        `- Entities:\n` +
        `  - ...\n\n` +
        `## Auth & Security (fill in)\n\n` +
        `- Authentication:\n` +
        `- Authorization:\n` +
        `- Rate limiting:\n\n` +
        `## Non-Functional Requirements\n\n` +
        `- Latency targets\n` +
        `- Logging/observability\n` +
        `- Deployment environment\n`
      );
    },
    buildPipeline: ({ intake }) => {
      return (
        `# Implementation Plan\n\n` +
        `## 1) Bootstrap\n\n` +
        `- Create project structure + dependency setup\n` +
        `- Add env var validation\n\n` +
        `## 2) Implement endpoints\n\n` +
        `- Build handlers for all required routes\n` +
        `- Add request validation + error middleware\n\n` +
        `## 3) Database\n\n` +
        `- Schema + migrations\n` +
        `- Queries + transactions\n\n` +
        `## 4) Docs + tests\n\n` +
        `- OpenAPI spec\n` +
        `- Unit tests + integration tests\n\n` +
        `## 5) Delivery\n\n` +
        `- Confirm repo URL (optional): ${intake.repoUrl ?? "(not provided)"}\n` +
        `- Package as PR / patch + README\n`
      );
    },
  });
}

import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import { dispatchOfferingDelivery } from "../../runtime/deliveryDispatcher.js";

export async function executeJob(
  request: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(request ?? {}, ctx, {
    offeringId: "base_defi_development",
    deliverableType: "defi_development_skeleton",
    reportFileName: "DEFI_SPEC.md",
    pipelineFileName: "IMPLEMENTATION_PLAN.md",
    findingsFileName: "ACTION_ITEMS.json",
    requiredFields: [
      {
        id: "projectDescription",
        label: "Project description",
        description:
          "Describe the DeFi primitive, user flows, roles, and constraints.",
      },
      {
        id: "contractType",
        label: "Contract type",
        description: "ERC-20, staking, vault, AMM, governance (optional)",
        required: false,
      },
      {
        id: "additionalSpecs",
        label: "Additional specs",
        description: "Integrations, constraints, invariants (optional)",
        required: false,
      },
      {
        id: "repoUrl",
        label: "Repo URL",
        description:
          "If integrating into an existing codebase, provide the repository URL (optional).",
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
    generateFindings: ({ request }) => {
      const contractType =
        typeof request.contractType === "string" && request.contractType.trim()
          ? request.contractType.trim()
          : "custom";

      return {
        method: "intake_structuring",
        limitations:
          "No Solidity code was generated or executed in this step. This is a plan/skeleton only.",
        summary: { contractType, chain: "Base" },
        actionItems: [
          "Define roles (admin/pauser/keeper/user) and access control model.",
          "Define token flows (deposits/withdrawals/fees) and invariants.",
          "Decide on upgradeability (none/UUPS/proxy) and required safety checks.",
          "Specify oracle sources and assumptions (if any).",
          "Confirm external integrations (routers, bridges, etc.).",
        ],
      };
    },
    buildReport: ({ request, ctx, intake, deliveryDir }) => {
      const contractType =
        typeof request.contractType === "string" && request.contractType.trim()
          ? request.contractType.trim()
          : "custom";

      const desc =
        typeof request.projectDescription === "string"
          ? request.projectDescription.trim()
          : "";
      const excerpt = desc.length > 800 ? desc.slice(0, 800) + "…" : desc;

      return (
        `# Base DeFi Development Spec — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Chain: Base\n` +
        `- Contract type: ${contractType}\n` +
        `- Deadline: ${intake.deadline ?? "(not provided)"}\n` +
        `- Repo URL: ${intake.repoUrl ?? "(not provided)"}\n\n` +
        `## Important Note\n\n` +
        `This is a **skeleton** generated automatically. It does not claim contracts/tests were implemented yet.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Requested Requirements (excerpt)\n\n` +
        `\`\`\`\n${excerpt || "(missing)"}\n\`\`\`\n\n` +
        `## Design Outline (fill in)\n\n` +
        `### Roles & permissions\n\n` +
        `- Admin:\n` +
        `- Users:\n` +
        `- Keepers (if any):\n\n` +
        `### State + invariants\n\n` +
        `- Invariant 1:\n` +
        `- Invariant 2:\n\n` +
        `### Token economics\n\n` +
        `- Fees:\n` +
        `- Rewards:\n\n` +
        `## Testing Plan\n\n` +
        `- Unit tests\n` +
        `- Invariant / fuzz tests\n` +
        `- Fork tests (optional)\n`
      );
    },
    buildPipeline: ({ intake }) => {
      return (
        `# Implementation Plan\n\n` +
        `## 1) Scaffold\n\n` +
        `- Foundry project structure\n` +
        `- Linting + formatting\n\n` +
        `## 2) Implement contracts\n\n` +
        `- Write core contract(s)\n` +
        `- Add access control + pausing\n\n` +
        `## 3) Tests\n\n` +
        `- Unit tests\n` +
        `- Fuzz/invariant tests\n\n` +
        `## 4) Security pass\n\n` +
        `- Slither + manual checklist\n\n` +
        `## 5) Delivery\n\n` +
        `- Confirm repo URL (optional): ${intake.repoUrl ?? "(not provided)"}\n` +
        `- Package as PR / patch + deployment notes\n`
      );
    },
  });
}

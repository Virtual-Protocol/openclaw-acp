import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import { dispatchOfferingDelivery } from "../../runtime/deliveryDispatcher.js";

export async function executeJob(
  requirements: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(requirements ?? {}, ctx, {
    offeringId: "openclaw_skill_development",
    deliverableType: "skill_package_skeleton",
    reportFileName: "SKILL_SPEC.md",
    pipelineFileName: "IMPLEMENTATION_PLAN.md",
    findingsFileName: "ACTION_ITEMS.json",
    requiredFields: [
      {
        id: "skillDescription",
        label: "Skill description",
        description:
          "Describe what the skill should do, with concrete inputs/outputs.",
      },
      {
        id: "targetPlatform",
        label: "Target platform / integration",
        description:
          "Where this skill will run or integrate (e.g., Uniswap, X/Twitter, GitHub, Discord, custom API).",
        aliases: ["platform", "integration"],
        required: false,
      },
      {
        id: "deadline",
        label: "Deadline",
        description:
          "When you need the first working version delivered (include timezone).",
        aliases: ["due", "dueDate", "eta"],
        required: false,
      },
    ],
    generateFindings: ({ requirements, intake }) => {
      const language =
        typeof requirements.language === "string" && requirements.language.trim()
          ? requirements.language.trim()
          : "bash + python";

      const examples =
        typeof requirements.examples === "string" ? requirements.examples.trim() : "";

      return {
        method: "intake_structuring",
        limitations:
          "No code was written or executed in this step. This is an actionable plan + skeleton only.",
        summary: {
          targetPlatform: intake.targetPlatform,
          language,
          hasExamples: Boolean(examples),
        },
        actionItems: [
          "Confirm inputs the skill should accept (CLI args / JSON fields).",
          "Confirm outputs (stdout, files, messages, tool calls).",
          "List required credentials/secrets (API keys, wallets, webhooks).",
          "Define success criteria + edge cases.",
          "Agree on packaging (single skill dir) + install method.",
        ],
        openQuestions: [
          "Do you need browser automation, API calls, or both?",
          "Any rate limits or auth constraints?",
          "What is the desired failure behavior (retry/backoff/abort)?",
        ],
      };
    },
    buildReport: ({ requirements, ctx, intake, deliveryDir }) => {
      const language =
        typeof requirements.language === "string" && requirements.language.trim()
          ? requirements.language.trim()
          : "bash + python";

      const skillDescription =
        typeof requirements.skillDescription === "string"
          ? requirements.skillDescription.trim()
          : "";

      const examples =
        typeof requirements.examples === "string" ? requirements.examples.trim() : "";

      const excerpt = skillDescription
        ? skillDescription.length > 800
          ? skillDescription.slice(0, 800) + "…"
          : skillDescription
        : "(missing)";

      return (
        `# OpenClaw Skill Spec — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Target platform: ${intake.targetPlatform ?? "(missing)"}\n` +
        `- Deadline: ${intake.deadline ?? "(missing)"}\n` +
        `- Language preference: ${language}\n\n` +
        `## Important Note\n\n` +
        `This is a **skeleton** generated automatically. It does not claim the skill is implemented yet.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Skill Requirements\n\n` +
        `### What the skill should do\n\n` +
        `- Requested:\n\n` +
        `  \`\`\`\n${excerpt}\n\`\`\`\n\n` +
        (examples
          ? `### Examples provided\n\n\`\`\`\n${examples}\n\`\`\`\n\n`
          : "") +
        `### Inputs\n\n` +
        `- Required parameters:\n` +
        `  - ...\n` +
        `- Optional parameters:\n` +
        `  - ...\n\n` +
        `### Outputs\n\n` +
        `- Files created:\n` +
        `  - ...\n` +
        `- Messages sent:\n` +
        `  - ...\n\n` +
        `### Constraints\n\n` +
        `- Rate limits / quotas\n` +
        `- Secrets required\n` +
        `- Idempotency needs\n\n` +
        `## Acceptance Criteria\n\n` +
        `- [ ] Dry-run mode works\n` +
        `- [ ] Happy-path end-to-end example documented\n` +
        `- [ ] Errors are handled with actionable messages\n`
      );
    },
    buildPipeline: ({ intake }) => {
      return (
        `# Implementation Plan (pipeline)\n\n` +
        `## 1) Repo setup\n\n` +
        `- Create a skill directory with:\n` +
        `  - SKILL.md\n` +
        `  - scripts/ (implementation)\n` +
        `  - tests/ or dry-run script\n\n` +
        `## 2) Implement core actions\n\n` +
        `- Define tool inputs/outputs for the target platform: ${intake.targetPlatform ?? "(missing)"}\n` +
        `- Implement minimal happy-path first\n\n` +
        `## 3) Add safety + validation\n\n` +
        `- Validate required params\n` +
        `- Validate credentials exist before doing work\n` +
        `- Add clear error messages\n\n` +
        `## 4) Documentation\n\n` +
        `- Add usage examples\n` +
        `- Add install instructions\n\n` +
        `## 5) Verification\n\n` +
        `- Run dry-run script / smoke test\n` +
        `- Confirm expected files are generated\n`
      );
    },
  });
}

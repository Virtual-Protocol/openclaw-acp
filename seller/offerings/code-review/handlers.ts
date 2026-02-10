import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import {
  dispatchOfferingDelivery,
  isProbablyUrl,
} from "../../runtime/deliveryDispatcher.js";

type Severity = "info" | "low" | "medium" | "high" | "critical";

interface ReviewFinding {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  recommendation?: string;
  confidence: "low" | "medium";
}

function heuristicCodeScan(code: string, language: string): {
  method: string;
  limitations: string;
  findings: ReviewFinding[];
} {
  const findings: ReviewFinding[] = [];
  const push = (f: ReviewFinding) => findings.push(f);

  const lang = language.toLowerCase();

  if (/(eval\s*\()/.test(code) && (lang.includes("js") || lang.includes("ts"))) {
    push({
      id: "eval",
      severity: "high",
      title: "eval() detected",
      description:
        "Dynamic code execution is dangerous and often leads to RCE or injection issues.",
      recommendation: "Avoid eval(); use safe parsers and explicit logic.",
      confidence: "medium",
    });
  }

  if (/child_process/.test(code) && (lang.includes("js") || lang.includes("ts"))) {
    push({
      id: "child-process",
      severity: "medium",
      title: "child_process usage detected",
      description:
        "Shelling out can be risky if any part of the command is user-controlled.",
      recommendation:
        "Validate/escape inputs and prefer spawn with argument arrays over exec with string concatenation.",
      confidence: "low",
    });
  }

  if (/TODO|FIXME/.test(code)) {
    push({
      id: "todo-fixme",
      severity: "info",
      title: "TODO/FIXME markers detected",
      description:
        "There are unfinished sections. These can hide edge cases or security gaps.",
      recommendation: "Review and resolve TODO/FIXME items before production.",
      confidence: "low",
    });
  }

  if (lang.includes("solidity") || /pragma\s+solidity/.test(code)) {
    if (/tx\.origin\b/.test(code)) {
      push({
        id: "tx-origin",
        severity: "high",
        title: "tx.origin usage detected",
        description:
          "Using tx.origin for authorization is unsafe and can enable phishing-style attacks.",
        recommendation: "Use msg.sender for auth.",
        confidence: "medium",
      });
    }

    if (/delegatecall\b/.test(code)) {
      push({
        id: "delegatecall",
        severity: "high",
        title: "delegatecall detected",
        description:
          "delegatecall can be dangerous if targets are not strictly controlled.",
        recommendation:
          "Ensure delegatecall targets are allowlisted and upgrade/auth flows are reviewed.",
        confidence: "low",
      });
    }
  }

  return {
    method: "heuristic_keyword_scan",
    limitations:
      "This is NOT a full review. Findings are produced by simple pattern matching only.",
    findings,
  };
}

function renderFindingsMd(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return "- (No heuristic red flags detected — this does not imply the code is bug-free or secure.)";
  }

  return findings
    .map((f) => {
      const rec = f.recommendation ? `\n  - Recommendation: ${f.recommendation}` : "";
      return `- [${f.severity.toUpperCase()}] ${f.title}\n  - ${f.description}${rec}`;
    })
    .join("\n");
}

export async function executeJob(
  requirements: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(requirements ?? {}, ctx, {
    offeringId: "code_review_and_optimization",
    deliverableType: "code_review_report_skeleton",
    reportFileName: "CODE_REVIEW_REPORT.md",
    pipelineFileName: "PIPELINE.md",
    findingsFileName: "INITIAL_FINDINGS.json",
    requiredFields: [
      {
        id: "codeSource",
        label: "Code source / repo URL",
        description:
          "Paste code or provide a Git repository URL (preferred for full review).",
        aliases: ["repoUrl", "repositoryUrl", "url"],
      },
      {
        id: "focusAreas",
        label: "Scope / focus areas",
        description:
          "What to focus on (security, performance, gas, style, architecture, etc.).",
        aliases: ["scope"],
        required: false,
      },
      {
        id: "language",
        label: "Language",
        description: "TypeScript, Solidity, Python, etc. (optional — auto-detect if omitted)",
        required: false,
      },
      {
        id: "deadline",
        label: "Deadline",
        description: "When you need the first review pass delivered.",
        aliases: ["due", "dueDate", "eta"],
        required: false,
      },
    ],
    generateFindings: ({ requirements, intake }) => {
      const codeSource =
        typeof requirements.codeSource === "string" ? requirements.codeSource : "";
      const language =
        typeof requirements.language === "string" && requirements.language.trim()
          ? requirements.language.trim()
          : String(intake.language ?? "auto-detect");

      if (!codeSource.trim()) {
        return {
          method: "heuristic_keyword_scan",
          limitations: "No codeSource provided.",
          findings: [],
        };
      }

      if (isProbablyUrl(codeSource)) {
        return {
          method: "heuristic_keyword_scan",
          limitations:
            "codeSource looks like a URL; repo cloning is not performed in this automated skeleton step.",
          findings: [],
        };
      }

      return heuristicCodeScan(codeSource, language);
    },
    buildReport: ({ ctx, intake, findings, deliveryDir }) => {
      const parsedFindings =
        typeof findings === "object" && findings && "findings" in findings
          ? ((findings as any).findings as ReviewFinding[])
          : [];

      return (
        `# Code Review — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Language: ${intake.language ?? "(missing)"}\n` +
        `- Focus areas: ${intake.focusAreas ?? "(missing)"}\n` +
        `- Deadline: ${intake.deadline ?? "(missing)"}\n\n` +
        `## Important Note\n\n` +
        `This is a **skeleton** generated automatically. It does not claim a full review was completed.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Methodology (planned)\n\n` +
        `1. Identify build/test system and run tests.\n` +
        `2. Run linters/static analyzers.\n` +
        `3. Manual review against requested focus areas.\n` +
        `4. Provide prioritized fixes and optional patch suggestions.\n\n` +
        `## Initial Findings (heuristic keyword scan only)\n\n` +
        `${renderFindingsMd(parsedFindings)}\n\n` +
        `## Review Checklist\n\n` +
        `- Correctness & edge cases\n` +
        `- Security issues\n` +
        `- Performance / gas\n` +
        `- Readability & maintainability\n` +
        `- Error handling and input validation\n`
      );
    },
    buildPipeline: ({ intake }) => {
      return (
        `# Review Pipeline (to run)\n\n` +
        `## 1) Get the code\n\n` +
        `- codeSource: ${intake.codeSource ? "(provided)" : "(missing)"}\n\n` +
        `## 2) Run tests\n\n` +
        `- For Node projects:\n` +
        `  - \`npm ci\`\n` +
        `  - \`npm test\`\n\n` +
        `- For Foundry:\n` +
        `  - \`forge build\`\n` +
        `  - \`forge test -vvv\`\n\n` +
        `## 3) Lint / static analysis\n\n` +
        `- TypeScript:\n` +
        `  - \`npm run lint\` (if available)\n\n` +
        `- Solidity:\n` +
        `  - \`slither .\`\n\n` +
        `## 4) Manual pass\n\n` +
        `- Work through focus areas: ${intake.focusAreas ?? "(missing)"}\n`
      );
    },
  });
}

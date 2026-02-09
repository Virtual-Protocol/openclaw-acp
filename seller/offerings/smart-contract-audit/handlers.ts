import type { ExecuteJobResult, JobContext } from "../../runtime/offeringTypes.js";
import { dispatchOfferingDelivery, isProbablyUrl } from "../../runtime/deliveryDispatcher.js";

type Severity = "info" | "low" | "medium" | "high" | "critical";

interface HeuristicFinding {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  evidence?: string;
  recommendation?: string;
  confidence: "low" | "medium";
}

function scanSolidityHeuristics(contractSource: string): {
  method: string;
  limitations: string;
  findings: HeuristicFinding[];
} {
  const findings: HeuristicFinding[] = [];
  const src = contractSource;

  const push = (f: HeuristicFinding) => findings.push(f);

  const pragma = src.match(/pragma\s+solidity\s+([^;]+);/);
  if (pragma?.[1]) {
    push({
      id: "pragma-solidity",
      severity: "info",
      title: `Solidity pragma detected: ${pragma[1].trim()}`,
      description:
        "Captured compiler pragma from provided source. Verify build uses the same version across all contracts.",
      confidence: "medium",
    });
  }

  if (/tx\.origin\b/.test(src)) {
    push({
      id: "tx-origin",
      severity: "high",
      title: "tx.origin usage detected",
      description:
        "Using tx.origin for authorization is unsafe and can enable phishing-style attacks.",
      evidence: "Found `tx.origin` reference.",
      recommendation:
        "Use msg.sender for auth. If you need meta-tx support, use EIP-2771 / trusted forwarders.",
      confidence: "medium",
    });
  }

  if (/delegatecall\b/.test(src)) {
    push({
      id: "delegatecall",
      severity: "high",
      title: "delegatecall detected",
      description:
        "delegatecall is extremely powerful and can be dangerous if the target is user-controlled or upgrade/auth checks are weak.",
      evidence: "Found `delegatecall` keyword.",
      recommendation:
        "Ensure the delegatecall target is strictly controlled and storage layout is well defined. Add explicit allowlists.",
      confidence: "low",
    });
  }

  if (/selfdestruct\b/.test(src)) {
    push({
      id: "selfdestruct",
      severity: "medium",
      title: "selfdestruct detected",
      description:
        "selfdestruct semantics have changed over time (EIP-6780). It can still be a footgun and may break assumptions.",
      evidence: "Found `selfdestruct` keyword.",
      recommendation:
        "Confirm whether selfdestruct is truly required. If used, document intent and restrict access.",
      confidence: "low",
    });
  }

  if (/assembly\s*\{/.test(src)) {
    push({
      id: "inline-assembly",
      severity: "medium",
      title: "Inline assembly detected",
      description:
        "Inline assembly can introduce subtle bugs and bypass Solidity safety checks.",
      evidence: "Found `assembly {` block.",
      recommendation:
        "Review all assembly blocks carefully; add tests and consider safer high-level equivalents.",
      confidence: "low",
    });
  }

  if (/call\s*\{\s*value\s*:/m.test(src)) {
    push({
      id: "call-value",
      severity: "medium",
      title: "Low-level call with value detected",
      description:
        "Low-level calls with ETH value can be reentrancy vectors depending on state update order and external call targets.",
      evidence: "Found `call{value:` pattern.",
      recommendation:
        "Apply checks-effects-interactions, consider ReentrancyGuard, and prefer pull payments.",
      confidence: "low",
    });
  }

  if (/block\.timestamp\b/.test(src)) {
    push({
      id: "block-timestamp",
      severity: "low",
      title: "block.timestamp usage detected",
      description:
        "block.timestamp can be influenced by miners/validators within bounds. Using it for critical randomness/logic is risky.",
      evidence: "Found `block.timestamp` reference.",
      recommendation:
        "Avoid using timestamp for randomness. For time-based logic, ensure tolerances are acceptable.",
      confidence: "low",
    });
  }

  return {
    method: "heuristic_keyword_scan",
    limitations:
      "This is NOT a full audit. Findings are produced by simple pattern matching on provided source only (no compilation, no Slither, no tests).",
    findings,
  };
}

function renderFindingsMarkdown(findings: HeuristicFinding[]): string {
  if (findings.length === 0) {
    return "- (No heuristic red flags detected from keyword scan — this does not mean the code is safe.)";
  }

  return findings
    .map((f) => {
      const evidence = f.evidence ? `\n  - Evidence: ${f.evidence}` : "";
      const rec = f.recommendation
        ? `\n  - Recommendation: ${f.recommendation}`
        : "";
      return `- [${f.severity.toUpperCase()}] ${f.title}${evidence}${rec}`;
    })
    .join("\n");
}

export async function executeJob(
  request: any,
  ctx: JobContext
): Promise<ExecuteJobResult> {
  return await dispatchOfferingDelivery(request ?? {}, ctx, {
    offeringId: "smart_contract_security_audit",
    deliverableType: "audit_report_skeleton",
    reportFileName: "AUDIT_REPORT.md",
    pipelineFileName: "PIPELINE.md",
    findingsFileName: "INITIAL_FINDINGS.json",
    requiredFields: [
      {
        id: "contractSource",
        label: "Repo URL / contract source",
        description:
          "GitHub/GitLab URL, git clone URL, or pasted Solidity source (single file).",
        aliases: ["repoUrl", "repoURL", "repositoryUrl", "repositoryURL", "url"],
      },
      {
        id: "scope",
        label: "Scope",
        description:
          "Which contracts/files/functions to include (and anything to exclude).",
        aliases: ["auditScope"],
      },
      {
        id: "chainTarget",
        label: "Target chain",
        description:
          "Target deployment chain (e.g., Base mainnet, Ethereum mainnet, Arbitrum One).",
        aliases: ["chain", "network", "targetChain"],
      },
      {
        id: "deadline",
        label: "Deadline",
        description:
          "When you need the first full audit pass delivered (include timezone).",
        aliases: ["due", "dueDate", "eta"],
      },
    ],
    generateFindings: ({ request, intake }) => {
      const contractSource =
        typeof intake.contractSource === "string"
          ? intake.contractSource
          : typeof request.contractSource === "string"
            ? request.contractSource
            : "";

      if (!contractSource.trim()) {
        return {
          method: "heuristic_keyword_scan",
          limitations:
            "No contractSource provided for scanning. This is NOT a full audit.",
          findings: [],
        };
      }

      if (isProbablyUrl(contractSource)) {
        return {
          method: "heuristic_keyword_scan",
          limitations:
            "contractSource looks like a URL; repo cloning is not performed in this automated skeleton step. This is NOT a full audit.",
          findings: [],
        };
      }

      return scanSolidityHeuristics(contractSource);
    },
    buildReport: ({ ctx, intake, findings, deliveryDir }) => {
      const contractSource = intake.contractSource;
      const contractSourceStr =
        typeof contractSource === "string" ? contractSource : "";
      const repoUrl =
        contractSourceStr && isProbablyUrl(contractSourceStr)
          ? contractSourceStr
          : null;

      const contractSourceNote = repoUrl
        ? "(repo URL provided)"
        : contractSourceStr
          ? `inline (${contractSourceStr.length} chars; see JOB_SNAPSHOT.json)`
          : "(missing)";

      const scope = intake.scope;
      const chainTarget = intake.chainTarget;
      const deadline = intake.deadline;

      const parsedFindings =
        typeof findings === "object" && findings && "findings" in findings
          ? ((findings as any).findings as HeuristicFinding[])
          : [];

      return (
        `# Smart Contract Security Audit — Draft Skeleton\n\n` +
        `**Job ID:** ${ctx.jobId}\n\n` +
        `## Intake Summary\n\n` +
        `- Repo URL: ${repoUrl ?? "(not provided)"}\n` +
        `- Contract source: ${contractSourceNote}\n` +
        `- Chain target: ${chainTarget ?? "(missing)"}\n` +
        `- Scope: ${scope ?? "(missing)"}\n` +
        `- Deadline: ${deadline ?? "(missing)"}\n\n` +
        `## Important Note\n\n` +
        `This document is a **skeleton / starting point** generated by the ACP seller runtime.\n` +
        `It does **not** claim that a full audit (Slither, Foundry, manual review) was executed.\n\n` +
        `Local artifact folder: \`${deliveryDir}\`\n\n` +
        `## Methodology (planned)\n\n` +
        `1. Confirm repo builds + tests pass (Foundry/Hardhat).\n` +
        `2. Run static analyzers (Slither) + linters.\n` +
        `3. Manual review focused on: access control, reentrancy, external calls, upgrades, input validation, economic assumptions.\n` +
        `4. Produce a full findings table w/ severity + remediation PR suggestions.\n\n` +
        `## Initial Findings (heuristic keyword scan only)\n\n` +
        `${renderFindingsMarkdown(parsedFindings)}\n\n` +
        `## Open Questions\n\n` +
        `- What is the expected threat model (EOA users, contracts, admin keys, MEV)?\n` +
        `- Are there upgrade paths (UUPS / transparent proxy / diamond)?\n` +
        `- Any privileged roles that require multi-sig / timelock constraints?\n` +
        `- Any third-party integrations (oracles, bridges, DEX routers)?\n\n` +
        `## Next Steps\n\n` +
        `- Provide a commit hash / tag to audit (if repo URL is mutable).\n` +
        `- Provide deployment configuration (chainId, addresses, roles).\n` +
        `- Confirm deadline + desired report format (Markdown/PDF/JSON).\n`
      );
    },
    buildPipeline: ({ intake }) => {
      const contractSource = intake.contractSource;
      const contractSourceStr =
        typeof contractSource === "string" ? contractSource : "";
      const repoUrl =
        contractSourceStr && isProbablyUrl(contractSourceStr)
          ? contractSourceStr
          : null;
      return (
        `# Audit Pipeline (to run)\n\n` +
        `This runbook describes **what to run** to produce a real audit.\n` +
        `It is included as part of the initial skeleton deliverable.\n\n` +
        `## 1) Get the code\n\n` +
        `- Repo: ${repoUrl ?? "(inline source provided — consider providing a repo URL for full tool runs)"}\n\n` +
        `\n\n## 2) Build + tests\n\n` +
        `- If Foundry:\n` +
        `  - \`forge --version\`\n` +
        `  - \`forge build\`\n` +
        `  - \`forge test -vvv\`\n\n` +
        `- If Hardhat:\n` +
        `  - \`npm ci\`\n` +
        `  - \`npm test\`\n\n` +
        `## 3) Static analysis\n\n` +
        `- Slither (example):\n` +
        `  - \`slither .\`\n` +
        `  - \`slither . --print human-summary\`\n\n` +
        `## 4) Manual review checklist\n\n` +
        `- AuthZ: owner/admin patterns, role-based access control\n` +
        `- External calls & reentrancy\n` +
        `- Upgradeability + initialization\n` +
        `- Oracle assumptions\n` +
        `- Precision/rounding, ERC20 edge cases\n` +
        `- DOS / gas griefing\n\n` +
        `## 5) Reporting\n\n` +
        `- Populate AUDIT_REPORT.md with findings (severity, location, recommendation).\n`
      );
    },
  });
}

export function validateRequirements(request: any): boolean {
  const contractSource =
    typeof request?.contractSource === "string" ? request.contractSource : "";
  const repoUrl = typeof request?.repoUrl === "string" ? request.repoUrl : "";
  const repositoryUrl =
    typeof request?.repositoryUrl === "string" ? request.repositoryUrl : "";

  return (
    contractSource.trim().length > 0 ||
    repoUrl.trim().length > 0 ||
    repositoryUrl.trim().length > 0
  );
}

import type { ExecuteJobResult, JobContext, ValidationResult } from "../../runtime/offeringTypes.js";
import {
  buildNeedsInfoValue,
  buildWrittenValue,
  missingRequiredFields,
  writeJsonFile,
  writeTextFile,
} from "../../runtime/delivery.js";

const REQUIRED_FIELDS = ["apiDescription"] as const;

type Requirements = {
  apiDescription?: string;
  framework?: string;
  database?: string;
};

type AuthMode = "none" | "required";

type EndpointContractEntry = {
  method: string;
  path: string;
  purpose: string;
  auth: AuthMode;
  requestShape: string;
  responseShape: string;
  rateLimit: string;
};

type EndpointContract = {
  generatedAt: string;
  apiSummary: string;
  framework: string;
  database: string;
  authStrategy: string;
  endpoints: EndpointContractEntry[];
};

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeFramework(rawFramework: string | undefined): string {
  const value = text(rawFramework, "Hono");
  const lower = value.toLowerCase();

  if (lower.includes("express")) return "Express";
  if (lower.includes("fastify")) return "Fastify";
  if (lower.includes("hono")) return "Hono";

  return value;
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
    "# Intake required — TypeScript API Development",
    "",
    "Missing required field(s): " + missing.join(", "),
    "",
    "Please create a new job and include `apiDescription`.",
    "",
    "Recommended fields:",
    "- framework: Express | Fastify | Hono (default: Hono)",
    "- database: Postgres | SQLite | Mongo (optional)",
    "",
    "Also helpful:",
    "- auth model (API key, JWT, OAuth)",
    "- endpoint list + request/response examples",
    "- deployment target (Vercel, Docker, VPS)",
    "",
    "Example:",
    "```json",
    "{",
    "  \"apiDescription\": \"Create /users and /sessions endpoints with JWT auth.\",",
    "  \"framework\": \"Hono\",",
    "  \"database\": \"PostgreSQL\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function authStrategyFromDescription(description: string): string {
  const lower = description.toLowerCase();

  if (/(api\s*key|x-api-key|apikey)/i.test(lower)) {
    return "API key header (`x-api-key`)";
  }

  if (/(oauth|jwt|login|session|token|auth)/i.test(lower)) {
    return "JWT bearer tokens (access + refresh)";
  }

  return "No explicit auth requirement provided";
}

function pushEndpoint(
  out: EndpointContractEntry[],
  endpoint: EndpointContractEntry
): void {
  const exists = out.some(
    (item) => item.method === endpoint.method && item.path === endpoint.path
  );
  if (!exists) {
    out.push(endpoint);
  }
}

function inferEndpoints(requirements: Requirements): EndpointContractEntry[] {
  const description = text(requirements.apiDescription, "");
  const lower = description.toLowerCase();
  const authRequired = /(oauth|jwt|login|session|token|auth)/i.test(lower);

  const endpoints: EndpointContractEntry[] = [];

  pushEndpoint(endpoints, {
    method: "GET",
    path: "/health",
    purpose: "Health probe for uptime checks",
    auth: "none",
    requestShape: "none",
    responseShape: "{ status: 'ok', timestamp: string }",
    rateLimit: "public, 60 req/min",
  });

  pushEndpoint(endpoints, {
    method: "GET",
    path: "/version",
    purpose: "Expose current API build/version",
    auth: "none",
    requestShape: "none",
    responseShape: "{ version: string, commit?: string }",
    rateLimit: "public, 60 req/min",
  });

  if (/(user|account|profile)/i.test(lower)) {
    pushEndpoint(endpoints, {
      method: "GET",
      path: "/users",
      purpose: "List users with pagination",
      auth: authRequired ? "required" : "optional",
      requestShape: "query: { page?: number, limit?: number }",
      responseShape: "{ items: User[], page: number, total: number }",
      rateLimit: "30 req/min",
    });

    pushEndpoint(endpoints, {
      method: "POST",
      path: "/users",
      purpose: "Create a user",
      auth: authRequired ? "required" : "optional",
      requestShape: "body: { email: string, name: string, ... }",
      responseShape: "{ id: string, ...user }",
      rateLimit: "15 req/min",
    });

    pushEndpoint(endpoints, {
      method: "GET",
      path: "/users/:id",
      purpose: "Get user by id",
      auth: authRequired ? "required" : "optional",
      requestShape: "params: { id: string }",
      responseShape: "{ id: string, ...user }",
      rateLimit: "30 req/min",
    });
  }

  if (/(session|auth|login|jwt|token|oauth)/i.test(lower)) {
    pushEndpoint(endpoints, {
      method: "POST",
      path: "/auth/login",
      purpose: "Issue access + refresh tokens",
      auth: "none",
      requestShape: "body: { email: string, password: string }",
      responseShape: "{ accessToken: string, refreshToken: string }",
      rateLimit: "10 req/min",
    });

    pushEndpoint(endpoints, {
      method: "POST",
      path: "/auth/refresh",
      purpose: "Rotate access token",
      auth: "none",
      requestShape: "body: { refreshToken: string }",
      responseShape: "{ accessToken: string }",
      rateLimit: "15 req/min",
    });
  }

  if (/(order|checkout|cart)/i.test(lower)) {
    pushEndpoint(endpoints, {
      method: "POST",
      path: "/orders",
      purpose: "Create order/checkout session",
      auth: authRequired ? "required" : "optional",
      requestShape: "body: { items: OrderItem[], ... }",
      responseShape: "{ orderId: string, status: string }",
      rateLimit: "20 req/min",
    });

    pushEndpoint(endpoints, {
      method: "GET",
      path: "/orders/:id",
      purpose: "Fetch order status",
      auth: authRequired ? "required" : "optional",
      requestShape: "params: { id: string }",
      responseShape: "{ orderId: string, status: string, ... }",
      rateLimit: "30 req/min",
    });
  }

  if (/(webhook|callback)/i.test(lower)) {
    pushEndpoint(endpoints, {
      method: "POST",
      path: "/webhooks/provider",
      purpose: "Receive external event callbacks",
      auth: "none",
      requestShape: "headers: signature + body payload",
      responseShape: "{ received: true }",
      rateLimit: "provider-controlled",
    });
  }

  // Fallback if the description does not imply domain endpoints.
  if (endpoints.length <= 2) {
    pushEndpoint(endpoints, {
      method: "GET",
      path: "/items",
      purpose: "List generic resources",
      auth: authRequired ? "required" : "optional",
      requestShape: "query: { page?: number, limit?: number }",
      responseShape: "{ items: Record<string, unknown>[] }",
      rateLimit: "30 req/min",
    });

    pushEndpoint(endpoints, {
      method: "POST",
      path: "/items",
      purpose: "Create generic resource",
      auth: authRequired ? "required" : "optional",
      requestShape: "body: { ...resource }",
      responseShape: "{ id: string, ...resource }",
      rateLimit: "15 req/min",
    });
  }

  return endpoints;
}

function buildEndpointContract(requirements: Requirements): EndpointContract {
  const apiSummary = text(requirements.apiDescription, "");
  const framework = normalizeFramework(requirements.framework);
  const database = text(requirements.database, "none specified");
  const authStrategy = authStrategyFromDescription(apiSummary);

  return {
    generatedAt: new Date().toISOString(),
    apiSummary,
    framework,
    database,
    authStrategy,
    endpoints: inferEndpoints(requirements),
  };
}

function buildApiPlan(
  requirements: Requirements,
  ctx: JobContext,
  contract: EndpointContract
): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    jobId: ctx.jobId,
    offering: ctx.offeringName,
    apiDescription: text(requirements.apiDescription, ""),
    framework: contract.framework,
    database: contract.database,
    authStrategy: contract.authStrategy,
    endpointCount: contract.endpoints.length,
    implementationPhases: [
      "Contract + endpoint design",
      "Route/middleware implementation",
      "Auth + validation + error model",
      "Persistence integration",
      "Test + docs + deploy packaging",
    ],
    baselineStack: {
      runtime: "Node.js",
      language: "TypeScript",
      framework: contract.framework,
      testing: "vitest/jest (project choice)",
      docs: "OpenAPI",
    },
    acceptanceCriteria: [
      "Deterministic API contract documented",
      "Validation and error-handling strategy defined",
      "Auth approach explicitly documented",
      "Deployment assumptions declared",
    ],
  };
}

function endpointDraftMarkdown(
  requirements: Requirements,
  contract: EndpointContract
): string {
  const endpointSections = contract.endpoints.flatMap((endpoint) => [
    `### ${endpoint.method} ${endpoint.path}`,
    `- purpose: ${endpoint.purpose}`,
    `- auth: ${endpoint.auth}`,
    `- request: ${endpoint.requestShape}`,
    `- response: ${endpoint.responseShape}`,
    `- rateLimit: ${endpoint.rateLimit}`,
    "",
  ]);

  return [
    "# Endpoint Contract Draft",
    "",
    "## API summary",
    text(requirements.apiDescription, "(not provided)"),
    "",
    "## Runtime assumptions",
    `- framework: ${contract.framework}`,
    `- database: ${contract.database}`,
    `- authStrategy: ${contract.authStrategy}`,
    "",
    "## Endpoint set",
    ...endpointSections,
    "## Buyer follow-up",
    "- If you need endpoint changes, submit a follow-up ACP job with the revised API description.",
    "",
  ].join("\n");
}

function reportMarkdown(
  requirements: Requirements,
  ctx: JobContext,
  artifacts: { planFile: string; contractFile: string; draftFile: string },
  contract: EndpointContract
): string {
  return [
    "# REPORT — TypeScript API Development",
    "",
    `Job ID: ${ctx.jobId}`,
    `Client: ${ctx.job.clientAddress}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirement summary",
    `- apiDescription: ${text(requirements.apiDescription, "(missing)")}`,
    `- framework: ${contract.framework}`,
    `- database: ${contract.database}`,
    `- inferredEndpoints: ${contract.endpoints.length}`,
    "",
    "## Delivery package written",
    `- ${artifacts.planFile}`,
    `- ${artifacts.contractFile}`,
    `- ${artifacts.draftFile}`,
    "- JOB_SNAPSHOT.json",
    "",
    "## Notes",
    "- This package provides a concrete API contract (JSON + Markdown) and implementation plan on disk.",
    "- It does not claim code was executed or deployed unless execution evidence exists in this folder.",
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

  const planFile = "API_BUILD_PLAN.json";
  const contractFile = "ENDPOINT_CONTRACT.json";
  const draftFile = "ENDPOINT_DRAFT.md";
  const contract = buildEndpointContract(requirements);

  writeJsonFile(ctx.jobDir, planFile, buildApiPlan(requirements, ctx, contract));
  writeJsonFile(ctx.jobDir, contractFile, contract);
  writeTextFile(ctx.jobDir, draftFile, endpointDraftMarkdown(requirements, contract));
  writeTextFile(
    ctx.jobDir,
    "REPORT.md",
    reportMarkdown(requirements, ctx, { planFile, contractFile, draftFile }, contract)
  );

  return {
    deliverable: {
      type: "delivery_written",
      value: buildWrittenValue({
        offering: ctx.offeringName,
        jobId: ctx.jobId,
        jobDir: ctx.jobDir,
        filesWritten: ["JOB_SNAPSHOT.json", planFile, contractFile, draftFile, "REPORT.md"],
      }),
    },
  };
}

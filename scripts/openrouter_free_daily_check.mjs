#!/usr/bin/env node

import { execFileSync } from "child_process";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_SITE_URL = "https://app.virtuals.io";
const DEFAULT_APP_NAME = "acp-ops-recovery-router";
const ROLLBACK_FREE_MODEL = "openrouter/free";

const argv = new Set(process.argv.slice(2));
const shouldApply = argv.has("--apply");
const shouldDeploy = argv.has("--deploy");
const verbose = argv.has("--verbose");

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function runInherit(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function toVarsMap(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (Array.isArray(parsed)) {
    return Object.fromEntries(parsed.map((entry) => [entry.name, String(entry.value ?? "")]));
  }
  if (parsed && typeof parsed === "object") {
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")])
    );
  }
  throw new Error("Unexpected format from `railway variables --json`.");
}

function isFreeModel(modelId) {
  const id = String(modelId || "")
    .trim()
    .toLowerCase();
  return id === "openrouter/free" || id.endsWith(":free");
}

function hasZeroCost(model) {
  const pricing = model?.pricing ?? {};
  const prompt = Number(pricing.prompt ?? pricing.input ?? Number.NaN);
  const completion = Number(pricing.completion ?? pricing.output ?? Number.NaN);
  return prompt === 0 && completion === 0;
}

function isTextCapable(model) {
  const modalities = model?.architecture?.input_modalities;
  if (!Array.isArray(modalities) || modalities.length === 0) return true;
  return modalities.includes("text");
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function applyFreeModelPolicy(modelId, { deploy } = { deploy: false }) {
  const targetModel = isFreeModel(modelId) ? modelId : ROLLBACK_FREE_MODEL;
  runInherit("railway", ["variables", "set", `OPENROUTER_FREE_MODEL=${targetModel}`]);
  try {
    runInherit("railway", ["variables", "delete", "OPENROUTER_MODEL"]);
  } catch {
    // OPENROUTER_MODEL may not exist; ignore.
  }
  if (deploy) {
    try {
      runInherit("npx", ["tsx", "bin/acp.ts", "serve", "deploy", "railway"]);
    } catch {
      // Fallback for environments where active-agent config is not set locally.
      runInherit("railway", ["up", "--detach"]);
    }
  }
  return targetModel;
}

async function probeModel({ apiKey, baseUrl, siteUrl, appName, modelId }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const requestBody = {
    model: modelId,
    temperature: 0,
    max_tokens: 120,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Return strict JSON with keys: classification, lane, summary, retry_payload, next_actions, message_templates, confidence.",
      },
      {
        role: "user",
        content: JSON.stringify({
          input: {
            error_text: "timeout while waiting for response from target agent",
            target_system: "acp",
            persona_mode: "speed",
          },
        }),
      },
    ],
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl,
        "X-Title": appName,
      },
      body: JSON.stringify(requestBody),
    });

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body.slice(0, 300),
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    const content =
      parsed?.choices?.[0]?.message?.content &&
      typeof parsed.choices[0].message.content === "string"
        ? parsed.choices[0].message.content
        : "";

    return {
      ok: content.length > 0,
      status: response.status,
      usage: parsed?.usage ?? null,
      error: content.length > 0 ? null : "empty model content",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function modelProbeErrorMessage(probes) {
  return `All free-model probes failed: ${JSON.stringify(probes, null, 2)}`;
}

async function main() {
  const railwayVars = toVarsMap(run("railway", ["variables", "--json"]));
  const apiKey = railwayVars.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || "";
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is missing (Railway/env).");
  }

  const baseUrl = (railwayVars.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(
    /\/$/,
    ""
  );
  const siteUrl = railwayVars.OPENROUTER_SITE_URL || DEFAULT_SITE_URL;
  const appName = railwayVars.OPENROUTER_APP_NAME || DEFAULT_APP_NAME;
  const currentModel = railwayVars.OPENROUTER_FREE_MODEL || "";

  const probes = [];
  let selected = null;
  let freeModels = [];
  let freeModelsCount = 0;
  let selectionError = null;

  try {
    const modelsResponse = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!modelsResponse.ok) {
      throw new Error(`Failed to fetch models: HTTP ${modelsResponse.status}`);
    }
    const modelsJson = await modelsResponse.json();
    const allModels = Array.isArray(modelsJson?.data) ? modelsJson.data : [];
    freeModels = allModels.filter((model) => hasZeroCost(model) && isTextCapable(model));
    freeModelsCount = freeModels.length;

    const preferred = unique([
      currentModel,
      ROLLBACK_FREE_MODEL,
      "qwen/qwen3-coder:free",
      "openai/gpt-oss-20b:free",
      "openai/gpt-oss-120b:free",
      "google/gemma-3-27b-it:free",
      "mistralai/mistral-small-3.1-24b-instruct:free",
      ...freeModels.map((model) => model.id),
    ]).filter((modelId) => isFreeModel(modelId));

    if (preferred.length === 0) {
      throw new Error("No text-capable free models available.");
    }

    for (const modelId of preferred) {
      const result = await probeModel({ apiKey, baseUrl, siteUrl, appName, modelId });
      probes.push({ modelId, ...result });
      if (result.ok) {
        selected = { modelId, usage: result.usage ?? null };
        break;
      }
    }

    if (!selected) {
      throw new Error(modelProbeErrorMessage(probes));
    }
  } catch (error) {
    selectionError = error instanceof Error ? error.message : String(error);
    if (!shouldApply) {
      throw error;
    }
  }

  let appliedModel = null;
  let rollbackApplied = false;
  if (shouldApply) {
    const targetModel = selected?.modelId ?? ROLLBACK_FREE_MODEL;
    rollbackApplied = !selected;
    appliedModel = applyFreeModelPolicy(targetModel, { deploy: shouldDeploy });
  }

  const selectedMeta = selected
    ? (freeModels.find((model) => model.id === selected.modelId) ?? null)
    : null;
  const promptCostPerToken = Number(
    selectedMeta?.pricing?.prompt ?? selectedMeta?.pricing?.input ?? 0
  );
  const completionCostPerToken = Number(
    selectedMeta?.pricing?.completion ?? selectedMeta?.pricing?.output ?? 0
  );
  const promptTokens = Number(selected?.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(selected?.usage?.completion_tokens ?? 0);
  const estimatedUsd = selected
    ? promptTokens * promptCostPerToken + completionTokens * completionCostPerToken
    : 0;

  const summary = {
    timestamp: new Date().toISOString(),
    applied: shouldApply,
    deployed: shouldApply && shouldDeploy,
    selectedModel: selected?.modelId ?? null,
    appliedModel,
    rollbackApplied,
    rollbackModel: rollbackApplied ? ROLLBACK_FREE_MODEL : null,
    currentModelBefore: currentModel || null,
    openrouterModelPolicy: "OPENROUTER_MODEL unset",
    freeModelsCount,
    estimatedUsdPerProbe: estimatedUsd,
    usage: {
      promptTokens,
      completionTokens,
    },
    probes: verbose ? probes : probes.slice(0, 5),
    selectionError,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    ) + "\n"
  );
  process.exit(1);
});

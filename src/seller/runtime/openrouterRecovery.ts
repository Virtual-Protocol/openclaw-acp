type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface RecoveryPackInput {
  error_text: string;
  failed_payload?: string;
  target_system?: string;
  persona_mode?: string;
  buyer_goal?: string;
}

export interface RecoveryPack {
  service: string;
  provider: "openrouter" | "fallback";
  model: string;
  lane: "budget" | "turbo" | "guardrail";
  classification: "validation" | "timeout" | "rejected" | "unknown";
  summary: string;
  retry_payload: Record<string, JsonValue>;
  next_actions: string[];
  message_templates: {
    buyer_update: string;
    internal_note: string;
  };
  confidence: number;
}

type OpenRouterEnv = Record<string, string | undefined>;

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_FREE_MODEL = "openrouter/free";

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function classifyError(errorText: string): RecoveryPack["classification"] {
  const lower = errorText.toLowerCase();
  if (lower.includes("required") || lower.includes("validation") || lower.includes("schema")) {
    return "validation";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("expired")) {
    return "timeout";
  }
  if (lower.includes("reject") || lower.includes("rejected") || lower.includes("declined")) {
    return "rejected";
  }
  return "unknown";
}

function laneFromPersona(
  personaMode: string,
  classification: RecoveryPack["classification"]
): RecoveryPack["lane"] {
  const persona = personaMode.toLowerCase();
  if (persona === "price") return "budget";
  if (persona === "speed") return "turbo";
  if (persona === "completion") return "guardrail";
  if (classification === "timeout") return "turbo";
  if (classification === "validation") return "guardrail";
  return "budget";
}

export function fallbackRecoveryPack(input: RecoveryPackInput): RecoveryPack {
  const errorText = cleanText(input.error_text);
  const targetSystem = cleanText(input.target_system) || "acp";
  const classification = classifyError(errorText);
  const lane = laneFromPersona(cleanText(input.persona_mode), classification);
  const retryPayload: Record<string, JsonValue> = {
    target_system: targetSystem,
    error_text: errorText || "unknown error",
  };

  if (classification === "validation") {
    retryPayload.target_agent_name = "<required>";
  }
  if (cleanText(input.failed_payload)) {
    retryPayload.failed_payload = cleanText(input.failed_payload);
  }

  const summaryMap: Record<RecoveryPack["classification"], string> = {
    validation: "입력 스키마 누락/불일치가 핵심 원인입니다.",
    timeout: "타임아웃/지연으로 트랜잭션이 완료되지 못했습니다.",
    rejected: "상대 에이전트 정책 또는 조건 불일치로 거절되었습니다.",
    unknown: "원인 신호가 약해 보수적 재시도 절차가 필요합니다.",
  };

  return {
    service: "acp-ops-recovery",
    provider: "fallback",
    model: "rule-based",
    lane,
    classification,
    summary: summaryMap[classification],
    retry_payload: retryPayload,
    next_actions: [
      "요구 필드(필수값) 확인 후 재시도 payload를 1회 생성합니다.",
      "같은 실패가 반복되면 lane을 guardrail로 고정하고 타겟을 교체합니다.",
      "재시도 후 5분 내 phase 변화를 확인하고 없으면 즉시 에스컬레이션합니다.",
    ],
    message_templates: {
      buyer_update: `현재 ${classification} 이슈를 복구 중입니다. ${lane} 경로로 재시도 후 결과를 공유드리겠습니다.`,
      internal_note: `[${targetSystem}] ${classification} classified -> ${lane} lane retry`,
    },
    confidence: classification === "unknown" ? 0.62 : 0.78,
  };
}

export function isFreeModelId(modelId: string): boolean {
  const model = cleanText(modelId).toLowerCase();
  if (!model) return false;
  return model === "openrouter/free" || model.endsWith(":free");
}

export function resolveOpenRouterModel(
  env: OpenRouterEnv = process.env,
  modelOverride?: string
): string {
  const override = cleanText(modelOverride);
  if (isFreeModelId(override)) return override;
  const freeModel = cleanText(env.OPENROUTER_FREE_MODEL);
  if (isFreeModelId(freeModel)) return freeModel;
  return DEFAULT_OPENROUTER_FREE_MODEL;
}

function resolveOpenRouterBaseUrl(env: OpenRouterEnv = process.env): string {
  const configured = cleanText(env.OPENROUTER_BASE_URL);
  if (configured) return configured.replace(/\/$/, "");
  return DEFAULT_OPENROUTER_BASE_URL;
}

export function extractFirstJsonObject(raw: string): Record<string, any> | null {
  const text = cleanText(raw);
  if (!text) return null;

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  } catch {
    // continue
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeOpenRouterPack(candidate: Record<string, any>, base: RecoveryPack): RecoveryPack {
  const classification = classifyError(cleanText(candidate.classification || base.classification));
  const laneCandidate = cleanText(candidate.lane).toLowerCase();
  const lane: RecoveryPack["lane"] = ["budget", "turbo", "guardrail"].includes(laneCandidate)
    ? (laneCandidate as RecoveryPack["lane"])
    : laneFromPersona("", classification);

  const retryPayload =
    candidate.retry_payload && typeof candidate.retry_payload === "object"
      ? (candidate.retry_payload as Record<string, JsonValue>)
      : base.retry_payload;

  const actions = Array.isArray(candidate.next_actions)
    ? candidate.next_actions.map((item) => String(item).trim()).filter(Boolean)
    : base.next_actions;

  return {
    ...base,
    classification,
    lane,
    summary: cleanText(candidate.summary) || base.summary,
    retry_payload: retryPayload,
    next_actions: actions.length > 0 ? actions : base.next_actions,
    message_templates: {
      buyer_update:
        cleanText(candidate?.message_templates?.buyer_update) ||
        base.message_templates.buyer_update,
      internal_note:
        cleanText(candidate?.message_templates?.internal_note) ||
        base.message_templates.internal_note,
    },
    confidence: Number.isFinite(Number(candidate.confidence))
      ? Math.max(0, Math.min(1, Number(candidate.confidence)))
      : base.confidence,
  };
}

export async function buildRecoveryPack(input: RecoveryPackInput): Promise<RecoveryPack> {
  const fallback = fallbackRecoveryPack(input);
  const env: OpenRouterEnv = process.env;
  const apiKey = cleanText(env.OPENROUTER_API_KEY);

  if (!apiKey) return fallback;

  const model = resolveOpenRouterModel(env);
  const baseUrl = resolveOpenRouterBaseUrl(env);
  const endpoint = `${baseUrl}/chat/completions`;

  const requestBody = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an ACP runtime recovery agent. Return strict JSON with keys: classification, lane, summary, retry_payload, next_actions, message_templates, confidence.",
      },
      {
        role: "user",
        content: JSON.stringify({
          input,
          fallback_reference: fallback,
          constraints: {
            classification: ["validation", "timeout", "rejected", "unknown"],
            lane: ["budget", "turbo", "guardrail"],
            max_actions: 4,
          },
        }),
      },
    ],
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": cleanText(env.OPENROUTER_SITE_URL) || "https://app.virtuals.io",
        "X-Title": cleanText(env.OPENROUTER_APP_NAME) || "acp-ops-recovery-router",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      return fallback;
    }

    const json = (await response.json()) as Record<string, any>;
    const content = cleanText(json?.choices?.[0]?.message?.content);
    const parsed = extractFirstJsonObject(content);
    if (!parsed) {
      return fallback;
    }

    const normalized = normalizeOpenRouterPack(parsed, fallback);
    return {
      ...normalized,
      provider: "openrouter",
      model,
    };
  } catch {
    return fallback;
  }
}

export const __testables = {
  fallbackRecoveryPack,
  isFreeModelId,
  resolveOpenRouterModel,
  extractFirstJsonObject,
};

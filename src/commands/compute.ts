// =============================================================================
// acp compute setup         — Enable LLM compute for this agent
// acp compute status        — Get compute account status and credit balance
// acp compute topup <amount>— Manually top up LLM credits from agent wallet
// acp compute config        — Configure auto top-up and fallback model settings
// acp compute chat '<json>' — Run a chat completion with OpenAI-compatible payload
// acp compute models        — List available models
// =============================================================================

import readline from "readline";
import * as output from "../lib/output.js";
import client from "../lib/client.js";

// -- Helpers --

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// -- Types --

interface ComputeAccount {
  enabled: boolean;
  creditBalance: number;
  endpoint: string;
  autoTopup: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  fallbackModel: {
    enabled: boolean;
    model: string;
    activateBelow: number;
  };
}

interface ModelEntry {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

interface ModelsResponse {
  object: string;
  data: ModelEntry[];
}

interface ChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

interface ChatResponse {
  id: string;
  model: string;
  choices: ChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// -- Commands --

export async function setup(): Promise<void> {
  try {
    const { data } = await client.post<{ data: ComputeAccount }>("/compute/accounts", {});

    output.output(data.data, (account) => {
      output.heading("LLM Compute — Setup");
      output.success("Compute enabled for this agent.");
      output.log("");
      output.log(`  Run ${output.colors.cyan("acp compute status")} to check your balance.`);
      output.log(
        `  Run ${output.colors.cyan("acp compute topup <amount>")} to add credits from your wallet.`
      );
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to enable compute: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function status(): Promise<void> {
  try {
    const { data } = await client.get<{ data: ComputeAccount }>("/compute/api-key/details");
    const account = data.data;

    output.output(account, (a) => {
      output.heading("LLM Compute — Status");
      output.field("Credit Balance", `$${a.limitRemaining}`);
      output.log("");

      output.log(`  ${output.colors.cyan("Auto Top-up")}`);
      output.field("  Enabled", a.autoTopUpEnabled ? "Yes" : "No");
      if (a.autoTopupEnabled) {
        output.field("  Threshold", `$${a.autoTopUpThreshold.toFixed(2)}`);
        output.field("  Top-up Amount", `$${a.autoTopUpAmount.toFixed(2)}`);
      }
      output.log("");

      output.log(`  ${output.colors.cyan("Fallback Model")}`);
      output.field("  Enabled", a.fallbackModel ? "Yes" : "No");
      if (a.fallbackModel) {
        output.field("  Model", a.fallbackModel);
        output.field("  Activate Threshold", `$${a.fallbackModelThreshold.toFixed(2)}`);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to get compute status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function topup(amountStr: string): Promise<void> {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    output.fatal("Amount must be a positive number (USD). Example: acp compute topup 10");
  }

  output.log("");
  output.log(`${output.colors.bold("Top-up Summary")}`);
  output.log(`${output.colors.dim("-".repeat(35))}`);
  output.field("Credits to add", `$${amount.toFixed(2)}`);
  output.log("");

  try {
    const { data } = await client.post<{ data: { creditBalance: number; txHash?: string } }>(
      "/top-up",
      { amount }
    );

    output.output(data, (result) => {
      output.log("Top up successful");
      if (result.txHash) {
        output.field("Tx Hash", result.txHash);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Top-up failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function config(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    output.heading("LLM Compute — Configuration");

    // Fetch current settings
    const { data: currentData } = await client.get<{ data: Record<string, unknown> }>(
      "/compute/api-key/details"
    );
    const current = currentData.data;

    // -- Auto top-up --
    output.log(`\n  ${output.colors.cyan("Auto Top-up")}`);
    output.log(
      "  Automatically top up credits from your wallet when balance drops below a threshold.\n"
    );

    let autoTopUpEnabled: boolean;
    let autoTopupThreshold: number | undefined;
    let autoTopupAmount: number | undefined;

    const autoAlreadyConfigured = current.autoTopUpEnabled === true;
    if (autoAlreadyConfigured) {
      output.field("  Current threshold", `$${(current.autoTopUpThreshold as number).toFixed(2)}`);
      output.field("  Current top-up amount", `$${(current.autoTopUpAmount as number).toFixed(2)}`);
      output.log("");
      const skipStr = (await question(rl, "  Keep current auto top-up settings? (Y/n): "))
        .trim()
        .toLowerCase();
      if (skipStr === "" || skipStr === "y" || skipStr === "yes") {
        autoTopUpEnabled = true;
        autoTopupThreshold = current.autoTopUpThreshold as number;
        autoTopupAmount = current.autoTopUpAmount as number;
      } else {
        const enableAutoStr = (await question(rl, "  Enable auto top-up? (y/N): "))
          .trim()
          .toLowerCase();
        autoTopUpEnabled = enableAutoStr === "y" || enableAutoStr === "yes";
      }
    } else {
      const enableAutoStr = (await question(rl, "  Enable auto top-up? (y/N): "))
        .trim()
        .toLowerCase();
      autoTopUpEnabled = enableAutoStr === "y" || enableAutoStr === "yes";
    }

    if (autoTopUpEnabled && autoTopupThreshold === undefined) {
      const thresholdStr = (
        await question(rl, "  Threshold — top up when balance drops below (integer only) ($): ")
      ).trim();
      autoTopupThreshold = parseFloat(thresholdStr);
      if (isNaN(autoTopupThreshold) || autoTopupThreshold <= 0) {
        rl.close();
        output.fatal("Invalid threshold. Must be a positive number.");
      }

      const amountStr = (
        await question(rl, "  Top-up amount — how much to add each time ($): ")
      ).trim();
      autoTopupAmount = parseFloat(amountStr);
      if (isNaN(autoTopupAmount) || autoTopupAmount <= 0) {
        rl.close();
        output.fatal("Invalid amount. Must be a positive number.");
      }
    }

    // -- Fallback model --
    output.log(`\n  ${output.colors.cyan("Fallback Model")}`);
    output.log(
      "  Switch to a cheaper model automatically when your balance drops below a threshold.\n"
    );

    let fallbackModel: string | undefined;
    let fallbackActivateBelow: number | undefined;

    const fallbackAlreadyConfigured = !!current.fallbackModel;
    if (fallbackAlreadyConfigured) {
      output.field("  Current model", current.fallbackModel as string);
      output.field(
        "  Current threshold",
        `$${(current.fallbackModelThreshold as number).toFixed(2)}`
      );
      output.log("");
      const skipStr = (await question(rl, "  Keep current fallback model settings? (Y/n): "))
        .trim()
        .toLowerCase();
      if (skipStr === "" || skipStr === "y" || skipStr === "yes") {
        fallbackModel = current.fallbackModel as string;
        fallbackActivateBelow = current.fallbackModelThreshold as number;
      }
    }

    if (fallbackModel === undefined) {
      const enableFallbackStr = (await question(rl, "  Enable fallback model? (y/N): "))
        .trim()
        .toLowerCase();
      const enableFallback = enableFallbackStr === "y" || enableFallbackStr === "yes";

      if (enableFallback) {
        fallbackModel = (await question(rl, "  Fallback model name: ")).trim();

        const belowStr = (
          await question(rl, "  Activate fallback when balance drops below ($): ")
        ).trim();
        fallbackActivateBelow = parseFloat(belowStr);
        if (isNaN(fallbackActivateBelow) || fallbackActivateBelow <= 0) {
          rl.close();
          output.fatal("Invalid threshold. Must be a positive number.");
        }
      }
    }

    // -- Save config --
    const payload: Record<string, unknown> = {
      autoTopUpEnabled: autoTopUpEnabled,
      autoTopUpThreshold: autoTopUpEnabled ? autoTopupThreshold : 0,
      autoTopUpAmount: autoTopUpEnabled ? autoTopupAmount : 0,
      fallbackModel: fallbackModel ?? null,
      fallbackModelThreshold: fallbackActivateBelow ?? 0,
    };

    await client.put<{ data: ComputeAccount }>("/compute/accounts/settings", payload);

    await status();
  } catch (e) {
    output.fatal(`Failed to save compute config: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rl.close();
  }
}

export async function models(): Promise<void> {
  try {
    const { data } = await client.get<ModelsResponse>("/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.LITE_AGENT_API_KEY}`,
      },
    });
    const list = data.data;

    output.output(list, (ms) => {
      output.heading("LLM Compute — Models");
      if (ms.length === 0) {
        output.log("  No models found.");
      }
      for (const m of ms) {
        output.log(`  ${output.colors.bold(m.id)}`);
      }
      output.log("");
    });
  } catch (e) {
    output.fatal(`Failed to list models: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function chat(payloadArg: string | undefined): Promise<void> {
  // Accept JSON from positional arg or stdin (piped)
  let raw: string;
  if (payloadArg) {
    raw = payloadArg;
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    output.fatal(
      "Provide a JSON payload as an argument or pipe it via stdin.\n" +
        `  Example: acp compute chat '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'`
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    output.fatal("Invalid JSON payload.");
  }

  if (!payload.messages) {
    output.fatal('Payload must include a "messages" array.');
  }

  try {
    const { data } = await client.post<ChatResponse>("/v1/chat/completions", payload, {
      headers: {
        Authorization: `Bearer ${process.env.LITE_AGENT_API_KEY}`,
      },
    });
    const result = data;

    output.output(result, (r) => {
      output.heading("LLM Compute — Chat Completion");
      output.field("Model", r.model);
      output.log("");
      for (const choice of r.choices) {
        if (r.choices.length > 1) {
          output.log(`  ${output.colors.dim(`[Choice ${choice.index}]`)}`);
        }
        output.log(`  ${output.colors.dim("Role:")} ${choice.message.role}`);
        output.log("");
        for (const line of choice.message.content.split("\n")) {
          output.log(`  ${line}`);
        }
        output.log("");
      }
    });
  } catch (e) {
    output.fatal(`Chat completion failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

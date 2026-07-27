import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import type { z } from "zod";
import { env } from "../env";

/**
 * Model routing for the degradation ladder. Every id comes from env with a free-model fallback
 * list, so a free-tier retirement is a config change rather than an outage
 * (docs/02-tech-stack.md). The OpenRouter key is read server-side only (AGENTS.md rule 1).
 */

let provider: ReturnType<typeof createOpenRouter> | undefined;
function openrouter() {
  provider ??= createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  return provider;
}

export type Tier = "free" | "paid";
export type LadderStep = { tier: Tier; modelId: string; maxAttempts: number };

/**
 * The ordered ladder the generator walks: the free model (3 attempts) and any configured free
 * fallbacks (2 each), then the paid model (2). Retries are kept few — failed requests, including
 * 429s, count against the free daily quota (docs/04 §1).
 */
export function modelLadder(): LadderStep[] {
  const fallbacks = env.OPENROUTER_FREE_FALLBACKS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    { tier: "free", modelId: env.OPENROUTER_FREE_MODEL, maxAttempts: 3 },
    ...fallbacks.map((modelId) => ({
      tier: "free" as const,
      modelId,
      maxAttempts: 2,
    })),
    { tier: "paid", modelId: env.OPENROUTER_PAID_MODEL, maxAttempts: 2 },
  ];
}

export type RunModelArgs = {
  modelId: string;
  system: string;
  prompt: string;
  /** When present, use structured generation (generateObject); otherwise free text. */
  schema?: z.ZodType;
};
export type RunModelResult = { data: unknown; tokensIn: number; tokensOut: number };

/** The single seam the ladder calls. Tests inject a fake to force each tier's behaviour. */
export type RunModel = (args: RunModelArgs) => Promise<RunModelResult>;

/** Real OpenRouter-backed runner. Never called from tests — they inject a fake. */
export const realRunModel: RunModel = async ({ modelId, system, prompt, schema }) => {
  const model = openrouter().chat(modelId);
  if (schema) {
    const { object, usage } = await generateObject({ model, system, prompt, schema });
    return {
      data: object,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
    };
  }
  const { text, usage } = await generateText({ model, system, prompt });
  return {
    data: text,
    tokensIn: usage.inputTokens ?? 0,
    tokensOut: usage.outputTokens ?? 0,
  };
};

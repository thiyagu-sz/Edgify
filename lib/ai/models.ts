import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText, streamText } from "ai";
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

// ── Streaming seam (markdown Quick Notes) ────────────────────────────────────
export type RunStreamArgs = {
  modelId: string;
  system: string;
  prompt: string;
  /** Aborts the model call when the client disconnects. */
  signal?: AbortSignal;
};
export type RunStreamResult = {
  /** Progressive token stream. Iterating rejects (or ends empty) on a model failure. */
  textStream: AsyncIterable<string>;
  /** Resolves once the stream completes. Await only after draining `textStream`. */
  usage: Promise<{ tokensIn: number; tokensOut: number }>;
};

/**
 * The streaming counterpart to `RunModel`. Returns synchronously with a live `textStream`; the
 * ladder in generate.ts drives it (pulls the first token to detect a tier failure before
 * committing). Tests inject a fake that yields chunks or throws to force each tier.
 */
export type RunStream = (args: RunStreamArgs) => RunStreamResult;

/**
 * Real OpenRouter-backed streamer. `maxRetries: 0` — retry discipline is the ladder's job, not
 * the SDK's (docs/04 §1). Never called from tests.
 */
export const realRunStream: RunStream = ({ modelId, system, prompt, signal }) => {
  /**
   * The transport error, captured from `onError`.
   *
   * When a stream fails before producing anything, iterating `textStream` throws a generic
   * `AI_NoOutputGeneratedError` whose `cause` is undefined — the real `APICallError`, with the
   * status code on it, only ever reaches the `onError` callback. The ladder classifies by status
   * (docs/04 §1), so without this a 401 or 402 looks like an unknown error and gets RETRIED:
   * measured at 7 model calls for a single generation on a bad key, with no operator alert,
   * when the spec says stop immediately and go to demo.
   */
  let transportError: unknown;

  const result = streamText({
    model: openrouter().chat(modelId),
    system,
    prompt,
    maxRetries: 0,
    abortSignal: signal,
    onError: ({ error }) => {
      transportError = error;
    },
  });

  // `totalUsage` is a PromiseLike; normalise to a real Promise for the RunStream contract.
  const usage = Promise.resolve(result.totalUsage).then((u) => ({
    tokensIn: u.inputTokens ?? 0,
    tokensOut: u.outputTokens ?? 0,
  }));
  /**
   * Mark the usage promise handled up front. When a tier fails at startup the ladder abandons
   * the attempt without awaiting usage, so its rejection would have no handler — measured as 7
   * `unhandledRejection`s per failed generation, which is a process-stability risk on Cloud Run,
   * not just log noise. `commitStream` still awaits and handles it on the success path.
   */
  usage.catch(() => {});

  /**
   * Surface the transport error to the ladder.
   *
   * The failure mode here is counter-intuitive and was found by pointing the app at an invalid
   * key and watching what actually happened. On a 401 the SDK does NOT throw from `textStream`:
   * the stream yields zero chunks and closes cleanly, `totalUsage` rejects with a generic
   * `AI_NoOutputGeneratedError` that carries no status, and the `APICallError` with
   * `statusCode: 401` reaches `onError` alone.
   *
   * So the ladder saw an empty stream, treated it as a retryable empty result, and burned all 7
   * attempts on a key that could never work — with no operator alert, when docs/04 §1 says a 401
   * is non-retryable and must be alerted on. Re-raising the captured error when the stream
   * produced nothing turns that back into one attempt per model and a logged alert.
   *
   * An empty stream with NO captured error is different: that is a model returning nothing,
   * which is a genuine (retryable) tier failure, so it is left to the ladder's EmptyStreamError.
   */
  async function* withTransportError(): AsyncGenerator<string> {
    let produced = false;
    try {
      for await (const chunk of result.textStream) {
        produced = true;
        yield chunk;
      }
    } catch (err) {
      throw transportError ?? err;
    }
    if (!produced && transportError !== undefined) throw transportError;
  }

  return { textStream: withTransportError(), usage };
};

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
  /**
   * Cancels the call when the caller's wall-clock budget runs out (docs/09 §1.6).
   *
   * Without this the ladder has NO per-call bound, and a between-rungs budget check cannot save
   * it: the check only runs when a call returns, so one stalled provider connection skips every
   * check and the request is bounded by nothing below the platform deadline itself — which is
   * exactly the deadline the budget exists to stay inside.
   */
  signal?: AbortSignal;
};
export type RunModelResult = { data: unknown; tokensIn: number; tokensOut: number };

/** The single seam the ladder calls. Tests inject a fake to force each tier's behaviour. */
export type RunModel = (args: RunModelArgs) => Promise<RunModelResult>;

/**
 * Real OpenRouter-backed runner. Never called from tests — they inject a fake.
 *
 * `maxRetries: 0`, for the same reason `realRunStream` sets it: retry discipline belongs to the
 * ladder, not the SDK (docs/04 §1, `.claude/rules/ai.md` "Maximum 2 retries per model tier").
 *
 * This was MISSING here until 2026-07-30 while the streaming seam had it from the start, so the
 * buffered path silently ran the AI SDK's default of 2 internal retries underneath every ladder
 * attempt. The ladder makes up to 7 attempts (free 3 + fallback 2 + paid 2), each of which can
 * repair once — up to 14 calls — and every one of those was up to 3 HTTP requests, so a single
 * graph build could reach ~42 provider requests instead of 14. Three consequences, all bad:
 * failed requests count against the free daily quota (docs/04 §1), the retries were unjittered by
 * our own backoff, and worst-case build latency tripled against a hard Cloud Run request timeout.
 *
 * It matters most for Phase 5: `graph_structure` and `concept_detail` both use this seam, and the
 * graph build is the longest operation in the product (docs/06 Phase 5 results).
 */
export const realRunModel: RunModel = async ({ modelId, system, prompt, schema, signal }) => {
  const model = openrouter().chat(modelId);
  if (schema) {
    const { object, usage } = await generateObject({
      model,
      system,
      prompt,
      schema,
      maxRetries: 0,
      abortSignal: signal,
    });
    return {
      data: object,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
    };
  }
  const { text, usage } = await generateText({
    model,
    system,
    prompt,
    maxRetries: 0,
    abortSignal: signal,
  });
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
/**
 * The diagnosis of a stream that terminated having produced no token.
 *
 * THE TWO STATES ARE BYTE-IDENTICAL ON THE DATA CHANNEL. Both are a clean, zero-length close, so
 * no reader of `textStream` can tell them apart — separating them is the entire job of this type:
 *
 *  - `transport-fault` — the adapter reconstructed a failure that the data channel never carried.
 *    The ladder re-raises it so `classify` can read the recovered status (docs/04 §1); a 401, 402
 *    or 400 then costs this source exactly one attempt instead of its whole retry budget.
 *  - `no-output` — the source genuinely produced nothing and no fault was reported anywhere. A
 *    retryable tier failure, exactly like an empty buffered result (docs/04 §3).
 */
export type ZeroOutputVerdict =
  | { kind: "transport-fault"; fault: unknown }
  | { kind: "no-output" };

export type RunStreamResult = {
  /**
   * Progressive token stream. Carries DATA ONLY — a terminal fault is never encoded here, because
   * on the fault class this seam exists for there is nothing to encode: the stream closes cleanly.
   */
  textStream: AsyncIterable<string>;
  /** Resolves once the stream completes. Await only after draining `textStream`. */
  usage: Promise<{ tokensIn: number; tokensOut: number }>;
  /**
   * REQUIRED CAPABILITY — the half of the admission barrier that the transport must supply.
   *
   * Called by `admitFirstToken` at, and only at, the instant the stream terminates having admitted
   * no token. The adapter answers with what it reconstructed from its own out-of-band channels;
   * it does not expose those channels, and the ladder does not know they exist.
   *
   * This is a required field rather than an optional one on purpose. An implementation that cannot
   * discriminate is not a weaker streaming source, it is an UNSAFE one — it silently returns the
   * pre-2026-07-30 behaviour in which a bad key burns all seven ladder attempts with no operator
   * alert. Making the capability part of the contract means that regression cannot be reintroduced
   * by writing a new adapter and forgetting; it is a compile error, pinned by
   * `admission-barrier.test.ts` case A.
   */
  diagnoseZeroOutput: () => ZeroOutputVerdict;
};

/**
 * The streaming counterpart to `RunModel`. Returns synchronously with a live `textStream` plus the
 * zero-output diagnosis the admission barrier needs; the ladder in generate.ts drives both through
 * `admitFirstToken`. Tests inject a fake that yields chunks, throws, or closes empty with or
 * without a reconstructed fault, to force each tier.
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
   * The data channel, and nothing else.
   *
   * The only fault handling left here is preferring the CAPTURED error when iteration itself
   * throws: the error the iterator raises is a generic wrapper carrying no status, while the one
   * `onError` received is the `APICallError` the ladder classifies by (docs/04 §1).
   *
   * A zero-length close is deliberately NOT turned into a throw. That used to happen here, and it
   * meant the fault travelled to the ladder disguised as data-path behaviour — the barrier's own
   * `next()` rejecting. The diagnosis now leaves through `diagnoseZeroOutput` instead, which is a
   * typed answer to a question the barrier asks, so the data channel carries data and the fault
   * channel carries faults.
   */
  async function* dataChannel(): AsyncGenerator<string> {
    try {
      for await (const chunk of result.textStream) yield chunk;
    } catch (err) {
      throw transportError ?? err;
    }
  }

  return {
    textStream: dataChannel(),
    usage,
    /**
     * The reconstruction, answered on demand.
     *
     * The failure mode this exists for is counter-intuitive and was found by pointing the app at
     * an invalid key and watching what actually happened. On a 401 the SDK does NOT throw from
     * `textStream`: the stream yields zero chunks and closes cleanly, `totalUsage` rejects with a
     * generic `AI_NoOutputGeneratedError` carrying no status, and the `APICallError` with
     * `statusCode: 401` reaches `onError` alone.
     *
     * So the ladder saw an empty stream, treated it as a retryable empty result, and burned all 7
     * attempts on a key that could never work — with no operator alert, when docs/04 §1 says a 401
     * is non-retryable and must be alerted on.
     *
     * `transportError` never leaves this closure. What leaves is the verdict.
     */
    diagnoseZeroOutput: () =>
      transportError !== undefined
        ? { kind: "transport-fault", fault: transportError }
        : { kind: "no-output" },
  };
};

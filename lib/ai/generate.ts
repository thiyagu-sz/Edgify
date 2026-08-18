import { APICallError, NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import { getCached, setCached, cacheKey } from "../cache";
import { recordLedger, type LedgerOutcome } from "../db/queries/ledger";
import { demoContentFor, type DemoInput } from "../demo";
import { env } from "../env";
import { log } from "../log";
import { consumeQuota } from "../quota";
import {
  modelLadder,
  realRunModel,
  realRunStream,
  type RunModel,
  type RunModelArgs,
  type RunModelResult,
  type RunStream,
  type RunStreamResult,
  type ZeroOutputVerdict,
} from "./models";
import { costMicrosFor } from "./pricing";
import {
  buildConceptDetailPrompt,
  buildGraphPrompt,
  buildNotesPrompt,
  getFormat,
} from "./prompts";
import {
  conceptDetailSchema,
  graphSchema,
  quizSchema,
  sanitizeConceptDetail,
  sanitizeGraph,
  sanitizeQuiz,
} from "./schemas";

/**
 * The degradation ladder (docs/04-resilience.md §1) — the SINGLE chokepoint for all model spend
 * (AGENTS.md rule 3). Every generation walks: cache → quota → free (with fallbacks) → paid →
 * demo → busy. Tiers 0–4 are invisible to the user; only demo and busy change what they see, and
 * both are calm. The user never sees a raw error (rule 4); failures become content or a message.
 *
 * `deps` are injectable so tests force each tier deterministically with no network and assert
 * jittered backoff (see generate.integration.test.ts).
 */

export class ServiceBusyError extends Error {
  constructor() {
    super("Server is busy, please try again in a moment.");
    this.name = "ServiceBusyError";
  }
}

/**
 * The ladder was abandoned because it ran out of WALL CLOCK, not because it ran out of rungs
 * (docs/09 §1.6, `LADDER-EXCEEDS-TIMEOUT`).
 *
 * Extends `ServiceBusyError` deliberately: to the user these are the same event — the calm tier-6
 * outcome — and every existing `instanceof ServiceBusyError` check keeps working unchanged. The
 * subclass exists so the CALLER can record which one happened in `graphs.failureReason`, which is
 * internal and never rendered. Distinguishing them matters operationally: "the ladder exhausted
 * every model" and "we ran out of time before the ladder could" call for opposite responses.
 */
export class GenerationBudgetExceededError extends ServiceBusyError {
  constructor() {
    super();
    this.name = "GenerationBudgetExceededError";
  }
}

/**
 * Internal marker: this call, or this ladder, has no time left. Never escapes the module — the
 * ladder catches it and converts it to the demo/busy tail so the ledger row is still written.
 */
class BudgetExhaustedError extends Error {
  constructor() {
    super("Wall-clock budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

class MalformedOutputError extends Error {
  constructor() {
    super("Model output failed validation");
    this.name = "MalformedOutputError";
  }
}

/** A stream that produced no content — treated as a retryable tier failure (like an empty result). */
class EmptyStreamError extends Error {
  constructor() {
    super("Model produced an empty stream");
    this.name = "EmptyStreamError";
  }
}

export type GenerateNotice = "demo" | "quota" | null;

/** Quick Notes (W2/W3). `format` is the prompt and cache discriminator. */
export type QuickNotesInput = {
  userId: string;
  operation: "quick_notes";
  format: string;
  /** Source material. Normalised before hashing so identical documents dedupe. */
  text: string;
};

/** Graph structure extraction (W4 step 13). The whole document is the input. */
export type GraphStructureInput = {
  userId: string;
  operation: "graph_structure";
  text: string;
};

/** Lazy per-concept explanation (W5). */
export type ConceptDetailInput = {
  userId: string;
  operation: "concept_detail";
  /** Stable id within the graph — REQUIRED in the cache key; see `cacheDiscriminator`. */
  conceptSlug: string;
  conceptName: string;
  /**
   * The one-sentence description the structure pass produced. Used to RETRIEVE the passages this
   * concept is explained from (lib/ai/retrieval.ts) — it is the strongest query material available
   * and was previously written to the database and never read.
   */
  conceptSummary?: string | null;
  /** The document text, as grounding. Identical for every concept in one graph. */
  text: string;
};

export type GenerateInput =
  | QuickNotesInput
  | GraphStructureInput
  | ConceptDetailInput;

export type GenerateResult = {
  data: unknown;
  tier: "cache" | "free" | "paid" | "demo";
  notice: GenerateNotice;
  /** Which model actually answered — null for cache and demo tiers. `graphs.modelId` records it. */
  modelId: string | null;
};

/**
 * The second component of the cache key, after the normalised text (see `lib/cache.ts`).
 *
 * `concept_detail` MUST carry the concept slug. Every concept in one graph is generated from the
 * SAME document text — that is the whole point of grounding — so without the slug all 6-9
 * concepts hash to one key. The first concept clicked would populate the entry and every other
 * concept would then "hit" it and render that first concept's definition under its own name. The
 * failure is silent, looks like a working cache, and gets worse the better the cache performs.
 *
 * `graph_structure` needs no extra component: one graph per document, and the text is the key.
 *
 * Quick Notes keeps using the bare format id, so every cache entry written before Phase 5 stays
 * valid — no format is named `graph_structure`, and none contains a colon.
 */
export function cacheDiscriminator(input: GenerateInput): string {
  switch (input.operation) {
    case "quick_notes":
      return input.format;
    case "graph_structure":
      return "graph_structure";
    case "concept_detail":
      /**
       * `r2` is the RETRIEVAL version. Concept detail is now grounded in passages selected for the
       * concept rather than the document's first 7,000 characters, so entries cached under the old
       * grounding must not be served — but bumping `PROMPT_VERSION` for that would also change
       * `contentHash` and force a second full rebuild of every graph, hours after the sampling fix
       * rebuilt them all. Versioning the discriminator invalidates concept details ONLY.
       */
      return `concept_detail:r2:${input.conceptSlug}`;
  }
}

/** What the ladder needs to run one operation: a prompt, an optional schema, and a validator. */
type GenerationPlan = {
  system: string;
  prompt: string;
  /** Present → structured generation (`generateObject`); absent → free text (docs/04 §3). */
  schema?: z.ZodType;
  /** Returns the sanitised payload, or null for a tier failure. Never throws. */
  validate: (data: unknown) => unknown | null;
};

/**
 * Build the plan for an operation. Returns null only when the request itself is unusable (an
 * unknown Quick Notes format), which the caller maps to the demo/busy tail rather than an error.
 */
function planGeneration(input: GenerateInput): GenerationPlan | null {
  if (input.operation === "quick_notes") {
    if (!getFormat(input.format)) return null;
    const { system, prompt, mode } = buildNotesPrompt(input.format, input.text);
    return {
      system,
      prompt,
      schema: mode === "quiz" ? quizSchema : undefined,
      validate: (data) => (mode === "quiz" ? sanitizeQuiz(data) : nonEmptyText(data)),
    };
  }

  if (input.operation === "graph_structure") {
    const { system, prompt } = buildGraphPrompt(input.text);
    // sanitizeGraph drops dangling edges, breaks cycles, and rejects fewer than three concepts
    // as a FAILED extraction rather than a small graph (docs/04 §3).
    return { system, prompt, schema: graphSchema, validate: sanitizeGraph };
  }

  const { system, prompt } = buildConceptDetailPrompt(
    { name: input.conceptName, slug: input.conceptSlug, summary: input.conceptSummary },
    input.text,
  );
  return {
    system,
    prompt,
    schema: conceptDetailSchema,
    validate: sanitizeConceptDetail,
  };
}

/** Markdown validation: trimmed non-empty text. Empty is a failure, not an empty success. */
function nonEmptyText(data: unknown): string | null {
  return typeof data === "string" && data.trim().length > 0 ? data.trim() : null;
}

export type GenerateDeps = {
  runModel?: RunModel;
  /** Streaming seam for markdown Quick Notes (generateNotesStream). Injected in tests. */
  runStream?: RunStream;
  /** Waits, ADVANCING wall clock. The optional signal cancels a wait nobody is listening for. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  demoFor?: (input: DemoInput) => unknown | null;
  /**
   * Fires when a single model call has consumed the remaining wall-clock budget.
   *
   * Separate from `sleep` because on a simulated clock the two mean OPPOSITE things: `sleep`
   * advances time (a backoff genuinely waits), while this OBSERVES time reaching a point. Sharing
   * one seam would make the deadline timer itself push the clock forward, so arming a deadline
   * would consume the very budget it is measuring. Injected so the stalled-call case is provable
   * without a 200-second test.
   */
  deadline?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** Per-call options, distinct from the injectable `deps` (which exist for tests). */
export type GenerateOptions = {
  /**
   * Wall-clock budget for the entire ladder walk, in milliseconds. Omitted → unbounded, which is
   * the Quick Notes behaviour: that path is short-lived and the CLIENT owns a 45s deadline.
   *
   * The graph build passes one because it is the longest operation in the product and has no
   * deadline of its own, so without this the ladder can outlive the platform request timeout and
   * be killed mid-flight — which writes nothing and strands the row on `processing` (docs/09 §1.6).
   */
  budgetMs?: number;
};

/**
 * The result of a streaming Quick Notes generation.
 *  - `final`  — no live streaming: a cache hit, the quota/demo/busy tail, or a quiz (buffered
 *               JSON). The route renders it immediately with any notice banner.
 *  - `stream` — a live markdown generation. The route pipes `textStream` to the client; the
 *               ladder has already committed this tier, and the stream writes the cache + ledger
 *               row when it drains.
 */
export type NotesStreamResult =
  | { kind: "final"; data: unknown; tier: GenerateResult["tier"]; notice: GenerateNotice }
  | { kind: "stream"; tier: "free" | "paid"; textStream: AsyncIterable<string> };

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A backoff nobody is waiting for any more (the budget ran out mid-wait) must not hold a
    // timer open for the rest of the budget.
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * The default deadline: a plain timer, cleared when the call it was guarding finishes first.
 * Deliberately never resolves after being cancelled — the race it belongs to has already settled.
 */
const defaultDeadline = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  });

/**
 * The wall-clock budget for one ladder walk. `bounded` is false for Quick Notes, where every check
 * below compiles away to a no-op and behaviour is exactly what Phase 3 proved.
 */
type Budget = {
  bounded: boolean;
  /** Milliseconds left. `Infinity` when unbounded. */
  remaining: () => number;
  /** No time left to START new work. */
  spent: () => boolean;
};

/**
 * Run one model call, cancelling it if the budget runs out first.
 *
 * THE DEADLINE IS ARMED BEFORE THE CALL STARTS, not after: a call that stalls immediately must
 * still be cut off, and arming afterwards would leave a window where nothing is watching.
 */
async function callWithinBudget(
  runModel: RunModel,
  call: RunModelArgs,
  budget: Budget,
  deadline: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<RunModelResult> {
  if (!budget.bounded) return runModel(call);

  const left = budget.remaining();
  if (left <= 0) throw new BudgetExhaustedError();

  const cancelCall = new AbortController();
  const cancelDeadline = new AbortController();

  /**
   * The deadline REJECTS rather than resolving, so the race has one result type and the winner
   * needs no sentinel to identify it. If the call wins, this promise is never settled at all —
   * `cancelDeadline` clears its timer — so it cannot produce a stray rejection afterwards.
   */
  const deadline$ = deadline(left, cancelDeadline.signal).then<RunModelResult>(() => {
    cancelCall.abort();
    throw new BudgetExhaustedError();
  });

  const call$ = runModel({ ...call, signal: cancelCall.signal });
  /**
   * The LOSER of the race still rejects — an aborted provider call throws — and nothing would be
   * awaiting it. That is the unhandled-rejection class of bug measured in Phase 4 (seven per
   * failed generation, a process-stability risk on Cloud Run, not just log noise), so the
   * rejection is marked handled here rather than left to the runtime.
   */
  call$.catch(() => {});

  try {
    return await Promise.race([call$, deadline$]);
  } finally {
    cancelDeadline.abort();
  }
}

export async function generate(
  input: GenerateInput,
  deps: GenerateDeps = {},
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const runModel = deps.runModel ?? realRunModel;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = deps.deadline ?? defaultDeadline;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const demoFor = deps.demoFor ?? demoContentFor;
  const started = now();
  const elapsed = () => now() - started;

  const budgetMs = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const budget: Budget = {
    bounded: Number.isFinite(budgetMs),
    remaining: () => budgetMs - elapsed(),
    spent: () => Number.isFinite(budgetMs) && budgetMs - elapsed() <= 0,
  };

  const key = cacheKey(input.text, cacheDiscriminator(input), env.PROMPT_VERSION);

  // ── Tier 0: cache hit — free, no quota consumed, no model call ──────────────
  const cached = await getCached(key);
  if (cached !== null) {
    await recordLedger(input.userId, {
      operation: input.operation,
      tier: "cache",
      outcome: "ok",
      tokensIn: 0,
      tokensOut: 0,
      // Explicitly zero, not merely unset: a cache hit genuinely cost nothing, which is a
      // different fact from `null` ("unpriced model") and must not be confused with it.
      costMicros: 0,
      latencyMs: elapsed(),
    });
    return { data: cached, tier: "cache", notice: null, modelId: null };
  }

  // ── Cache miss: consume quota. Over limit → demo with the quota banner ──────
  const quota = await consumeQuota(input.userId);
  if (!quota.allowed) {
    return serveDemo(input, "quota", demoFor, elapsed);
  }

  // Build the prompt. An unusable request (unknown format) → demo/busy tail.
  const plan = planGeneration(input);
  if (!plan) {
    log.error("generate: unusable request", undefined, {
      operation: input.operation,
      discriminator: cacheDiscriminator(input),
    });
    return serveDemo(input, "demo", demoFor, elapsed);
  }
  const { system, prompt, schema } = plan;

  // ── Tiers 1–4: walk the model ladder ────────────────────────────────────────
  const ladder = modelLadder();
  let fellThrough = false; // moved past the first model → outcome "fallback"
  let budgetExceeded = false;

  for (const step of ladder) {
    // Between rungs — the check docs/09 §1.6 names. Necessary, and on its own not sufficient:
    // it only runs when a call RETURNS, which is why each call also carries a deadline.
    if (budget.spent()) {
      budgetExceeded = true;
      break;
    }
    let retried = false;
    for (let attempt = 0; attempt < step.maxAttempts; attempt++) {
      if (budget.spent()) {
        budgetExceeded = true;
        break;
      }
      try {
        const result = await attemptModel(
          runModel,
          { modelId: step.modelId, system, prompt, schema },
          plan.validate,
          budget,
          deadline,
        );
        const outcome: LedgerOutcome = fellThrough
          ? "fallback"
          : retried
            ? "retried"
            : "ok";
        // Independent writes to different tables, neither reading the other's result — issue
        // them together rather than paying two sequential round trips. Also means a failing
        // cache write no longer prevents the ledger row from being written.
        await Promise.all([
          setCached(key, result.data),
          recordLedger(input.userId, {
            operation: input.operation,
            modelId: step.modelId,
            tier: step.tier,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            // The only two places in the system that can spend money are here and `commitStream`.
            // Priced at record time so the row carries the rate that applied then (lib/ai/pricing).
            costMicros: costMicrosFor(step.modelId, result.tokensIn, result.tokensOut),
            outcome,
            latencyMs: elapsed(),
          }),
        ]);
        return {
          data: result.data,
          tier: step.tier,
          notice: null,
          modelId: step.modelId,
        };
      } catch (err) {
        /**
         * THE BUDGET IS CHECKED BEFORE CLASSIFICATION, and the order is load-bearing.
         *
         * An aborted call throws an error carrying no HTTP status, and `classify` maps statusless
         * errors to "retry" (a network blip deserves one). Classify first and the ladder politely
         * retries the very call it just cancelled for running out of time — the budget would buy
         * nothing at all.
         */
        if (err instanceof BudgetExhaustedError || budget.spent()) {
          budgetExceeded = true;
          break;
        }
        const kind = classify(err);
        if (kind === "retry") {
          retried = true;
          if (attempt < step.maxAttempts - 1) {
            const wait = backoff(attempt, err, random);
            // Never sleep past the deadline: waiting out a backoff we cannot afford would spend
            // the remaining budget doing nothing at all.
            if (budget.bounded && wait >= budget.remaining()) {
              budgetExceeded = true;
              break;
            }
            await sleep(wait);
            continue;
          }
          break; // this model's attempts exhausted → next model
        }
        // "malformed" (repair already tried) and "stop" (402/401/400) → next model
        if (kind === "stop") logNonRetryable(err);
        break;
      }
    }
    if (budgetExceeded) break;
    fellThrough = true;
  }

  // ── Tier 5/6: demo, else busy ───────────────────────────────────────────────
  return serveDemo(input, "demo", demoFor, elapsed, budgetExceeded);
}

/**
 * Streaming Quick Notes generation (W2, docs/05). Same degradation ladder as `generate`, but
 * markdown formats stream token-by-token so the first token reaches the user in ~2s (Phase 4
 * acceptance). Quiz formats and every non-live outcome (cache / quota / demo / busy) come back
 * as a buffered `final` — a half-streamed quiz is not useful, and the rest are instant anyway.
 *
 * This is the ONLY streaming entry point; it keeps the cache, quota, ladder and ledger inside
 * this module (AGENTS.md rule 3) rather than in the route. The commit rule for streaming: pull
 * the first non-empty token before returning, so a tier that fails at startup falls through
 * invisibly; once tokens flow we are committed to that tier.
 */
export async function generateNotesStream(
  input: QuickNotesInput,
  deps: GenerateDeps = {},
  opts: { signal?: AbortSignal } = {},
): Promise<NotesStreamResult> {
  const format = getFormat(input.format);

  // Quiz (and any unknown format) → buffered path. `generate` owns cache/quota/ladder/demo for
  // these; we just adapt its result. Streaming a quiz would ship an un-gradeable half-quiz.
  if (!format || format.mode === "quiz") {
    const result = await generate(input, deps);
    return { kind: "final", data: result.data, tier: result.tier, notice: result.notice };
  }

  const runStream = deps.runStream ?? realRunStream;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const demoFor = deps.demoFor ?? demoContentFor;
  const started = now();
  const elapsed = () => now() - started;

  const key = cacheKey(input.text, cacheDiscriminator(input), env.PROMPT_VERSION);

  /**
   * ── Tier 0: cache hit ─────────────────────────────────────────────────────
   *
   * The cache lookup and the quota consume below stay SEQUENTIAL on purpose. They look like an
   * obvious `Promise.all` pair, and they are not:
   *
   *  - Running them together consumes quota before the cache result is known, so a cache HIT
   *    would cost the user a generation. That is exactly the invariant `.claude/rules/ai.md`
   *    ("Ordering matters") exists to protect, and refunding afterwards is worse — the counter is
   *    briefly wrong under concurrency, and a crash in the window silently eats an allowance.
   *  - Pairing the lookup with the non-consuming `getRemaining` instead is safe but measures
   *    strictly SLOWER: the miss path still needs the consume write afterwards, so it adds a
   *    round trip rather than removing one (test/e2e/db-hotpath-latency.mjs).
   *
   * The genuinely independent pair here is the session lookup ∥ this cache lookup — the cache key
   * is content-addressed and does not depend on `userId`. It is worth ~283ms and its blocker (the
   * route being unwrapped, so overlapping would issue a database WRITE before authentication) was
   * removed on 2026-07-29 when `/api/notes/generate` was rate limited. Still NOT taken: the
   * wrapper adds one round trip (~275ms) to the same path, so the best case is a wash. See
   * docs/06 Phase 4 results.
   */
  const cached = await getCached(key);
  if (cached !== null) {
    await recordLedger(input.userId, {
      operation: input.operation,
      tier: "cache",
      outcome: "ok",
      tokensIn: 0,
      tokensOut: 0,
      // Explicitly zero, not merely unset: a cache hit genuinely cost nothing, which is a
      // different fact from `null` ("unpriced model") and must not be confused with it.
      costMicros: 0,
      latencyMs: elapsed(),
    });
    return { kind: "final", data: cached, tier: "cache", notice: null };
  }

  // ── Cache miss: consume quota. Over limit → demo with the quota banner ──────
  const quota = await consumeQuota(input.userId);
  if (!quota.allowed) {
    const demoResult = await serveDemo(input, "quota", demoFor, elapsed);
    return { kind: "final", data: demoResult.data, tier: demoResult.tier, notice: demoResult.notice };
  }

  const { system, prompt } = buildNotesPrompt(input.format, input.text);

  // ── Tiers 1–4: walk the ladder, streaming ───────────────────────────────────
  const ladder = modelLadder();
  let fellThrough = false;

  for (const step of ladder) {
    let retried = false;
    for (let attempt = 0; attempt < step.maxAttempts; attempt++) {
      try {
        const source = runStream({
          modelId: step.modelId,
          system,
          prompt,
          signal: opts.signal,
        });

        /**
         * THE ADMISSION BARRIER. Nothing is committed until this returns, and it cannot return a
         * zero-output result without the transport's own diagnosis of that zero output.
         */
        const admission = await admitFirstToken(source);

        switch (admission.kind) {
          case "transport-fault":
            /**
             * Zero tokens, and the adapter reconstructed a fault behind them. Re-raise into the
             * ladder so `classify` reads the RECOVERED status rather than an absence of one: a
             * 401/402/400 stops this source after a single attempt (docs/04 §1) instead of
             * spending its whole retry budget on a condition that cannot clear.
             */
            throw admission.fault;
          case "no-output":
            // Zero tokens and nothing reported anywhere — a genuine empty generation, retryable
            // within this source's attempt budget exactly like an empty buffered result.
            throw new EmptyStreamError();
          case "producing":
            break;
          default: {
            // Exhaustiveness: a future verdict cannot be silently folded into the retryable path.
            const unreachable: never = admission;
            throw unreachable;
          }
        }

        const outcome: LedgerOutcome = fellThrough ? "fallback" : retried ? "retried" : "ok";
        const textStreamOut = commitStream({
          userId: input.userId,
          operation: input.operation,
          key,
          modelId: step.modelId,
          tier: step.tier,
          outcome,
          firstChunk: admission.firstToken,
          iterator: admission.rest,
          usage: source.usage,
          elapsed,
        });
        return { kind: "stream", tier: step.tier, textStream: textStreamOut };
      } catch (err) {
        const kind = classify(err);
        if (kind === "retry") {
          retried = true;
          if (attempt < step.maxAttempts - 1) {
            await sleep(backoff(attempt, err, random));
            continue;
          }
          break; // attempts exhausted → next model
        }
        if (kind === "stop") logNonRetryable(err);
        break; // "malformed"/"stop" → next model
      }
    }
    fellThrough = true;
  }

  // ── Tier 5/6: demo, else busy ───────────────────────────────────────────────
  const demoResult = await serveDemo(input, "demo", demoFor, elapsed);
  return { kind: "final", data: demoResult.data, tier: demoResult.tier, notice: demoResult.notice };
}

/**
 * What the admission barrier decided about one streaming attempt.
 *
 * The two zero-output variants are the reason this is a union rather than a token-or-null. They
 * are INDISTINGUISHABLE on the data channel — both are a clean, zero-length close — so a barrier
 * that returned "no first token" would have destroyed the only difference that matters before the
 * ladder ever saw it. Carrying the transport's verdict through means the recovery layer chooses
 * between "retry this source" and "abandon this source" on evidence rather than on a guess.
 */
type Admission =
  | { kind: "producing"; firstToken: string; rest: AsyncIterator<string> }
  | ZeroOutputVerdict;

/**
 * THE ADMISSION BARRIER (docs/04 §3) — the single, and only, way to consume the head of a
 * `RunStreamResult`.
 *
 * Draws from the transport until it holds a token of non-zero length, and withholds that token so
 * the caller commits only on possession of it. `commitStream` re-emits it at the head of the same
 * generation, so the client's progressive experience is identical to immediate relay.
 *
 * The coupling to element B is structural, not conventional: the ONLY route out of this function
 * that is not a held token runs through `diagnoseZeroOutput()`. There is no path by which a
 * zero-output stream reaches the ladder undiagnosed, because there is no zero-output return value
 * to construct except the one the transport supplies. Removing the barrier removes the only caller
 * of the diagnosis; removing the diagnosis removes the barrier's only non-token exit. Neither can
 * be deleted and leave the other doing anything useful — see `admission-barrier.test.ts`.
 */
async function admitFirstToken(source: RunStreamResult): Promise<Admission> {
  const iterator = source.textStream[Symbol.asyncIterator]();
  for (;;) {
    const next = await iterator.next();
    // Terminated with nothing admitted. Which of the two zero-output states this is cannot be
    // read off the data channel, so it is asked of the transport that owns the other channel.
    if (next.done) return source.diagnoseZeroOutput();
    if (next.value.length > 0) {
      return { kind: "producing", firstToken: next.value, rest: iterator };
    }
  }
}

/**
 * Re-emit the committed stream (starting with the already-pulled first token), accumulating the
 * full text, then write the cache and the ledger row once it drains. Failures here (e.g. a
 * mid-stream disconnect) surface to the route, which has already sent partial content.
 */
async function* commitStream(args: {
  userId: string;
  operation: string;
  key: string;
  modelId: string;
  tier: "free" | "paid";
  outcome: LedgerOutcome;
  firstChunk: string;
  iterator: AsyncIterator<string>;
  usage: Promise<{ tokensIn: number; tokensOut: number }>;
  elapsed: () => number;
}): AsyncGenerator<string> {
  let accumulated = args.firstChunk;
  yield args.firstChunk;
  for (;;) {
    const next = await args.iterator.next();
    if (next.done) break;
    accumulated += next.value;
    yield next.value;
  }

  // Start the cache write immediately: it depends only on the accumulated text, not on usage,
  // so it can overlap with both the usage settle and the ledger write below.
  const finalText = accumulated.trim();
  const cacheWrite =
    finalText.length > 0 ? setCached(args.key, finalText) : Promise.resolve();

  let tokens = { tokensIn: 0, tokensOut: 0 };
  try {
    tokens = await args.usage;
  } catch {
    // Usage is best-effort telemetry; never fail a delivered generation over it.
  }

  // Two independent writes to different tables. Sequential here cost a full extra round trip
  // (~250ms against a remote database) on every completed generation, delaying stream close for
  // no reason — the ledger row does not read the cache row.
  await Promise.all([
    cacheWrite,
    recordLedger(args.userId, {
      operation: args.operation,
      modelId: args.modelId,
      tier: args.tier,
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut,
      // Streaming's usage arrives only once the stream drains, so this is the first point the
      // cost of a streamed generation can be known at all.
      costMicros: costMicrosFor(args.modelId, tokens.tokensIn, tokens.tokensOut),
      outcome: args.outcome,
      latencyMs: args.elapsed(),
    }),
  ]);
}

/**
 * One model attempt: call, validate, and on malformed content do exactly ONE repair (docs/04 §3).
 * `validate` is the operation's sanitiser — it returns null for unusable output and never throws.
 */
async function attemptModel(
  runModel: RunModel,
  call: RunModelArgs,
  validate: (data: unknown) => unknown | null,
  budget: Budget,
  deadline: (ms: number, signal: AbortSignal) => Promise<void>,
): Promise<{ data: unknown; tokensIn: number; tokensOut: number }> {
  try {
    const res = await callWithinBudget(runModel, call, budget, deadline);
    const valid = validate(res.data);
    if (valid !== null) {
      return { data: valid, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
    }
  } catch (err) {
    // `BudgetExhaustedError` is not malformed, so it bubbles to the ladder — as APICallError does.
    if (!isMalformed(err)) throw err;
  }

  /**
   * THE REPAIR IS BUDGET-CHECKED, and this is the easiest place in the ladder to get it wrong.
   * A repair DOUBLES a rung's wall-clock cost and happens INSIDE the rung, so no between-rungs
   * check can see it: without this line a build can start a second full-length call with seconds
   * left on the clock and be killed by the platform partway through it.
   */
  if (budget.spent()) throw new BudgetExhaustedError();

  // Repair: one more attempt, telling the model its previous output was invalid.
  const repairPrompt = `${call.prompt}\n\nYour previous response was invalid. Respond again with ONLY valid output in the required format, and nothing else.`;
  try {
    const res = await callWithinBudget(
      runModel,
      { ...call, prompt: repairPrompt },
      budget,
      deadline,
    );
    const valid = validate(res.data);
    if (valid !== null) {
      return { data: valid, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
    }
  } catch (err) {
    if (!isMalformed(err)) throw err;
  }
  throw new MalformedOutputError();
}

/**
 * Tier 5 if demo content exists for this request, otherwise tier 6 (busy).
 *
 * `graph_structure` and `concept_detail` deliberately have NO demo content, so for them this is
 * always tier 6 — both persist rows into the user's own workspace, and a curated sample written
 * there would misrepresent a document they uploaded (docs/03 §graphs, lib/demo/index.ts). The
 * caller maps the resulting `ServiceBusyError` to `status = "failed"` and the W4 message.
 */
async function serveDemo(
  input: GenerateInput,
  notice: GenerateNotice,
  demoFor: (input: DemoInput) => unknown | null,
  elapsed: () => number,
  budgetExceeded = false,
): Promise<GenerateResult> {
  const demo = demoFor({
    operation: input.operation,
    format: cacheDiscriminator(input),
  });
  if (demo !== null) {
    await recordLedger(input.userId, {
      operation: input.operation,
      tier: "demo",
      outcome: "demo",
      costMicros: 0, // curated content, no model call
      latencyMs: elapsed(),
    });
    return { data: demo, tier: "demo", notice, modelId: null };
  }
  /**
   * The ledger row is written on this path too, INCLUDING a budget abandonment. A code path that
   * skips the ledger write is incomplete (`.claude/rules/ai.md`), and an abandoned build that
   * recorded nothing would be invisible to the Phase 7 cost dashboard — the one place anyone
   * would notice builds routinely running out of time.
   *
   * The row keeps the existing `demo`/`failed` shape rather than introducing a sixth
   * `LedgerOutcome`: the Phase 3 AC6 test pins that union exhaustively, and a new value would be
   * schema churn for a distinction already recorded, more precisely, in `graphs.failureReason`.
   */
  await recordLedger(input.userId, {
    operation: input.operation,
    tier: "demo",
    outcome: "failed",
    costMicros: 0, // the ladder produced nothing to charge for
    latencyMs: elapsed(),
  });
  throw budgetExceeded ? new GenerationBudgetExceededError() : new ServiceBusyError();
}

// ── Error classification (docs/04 §1 table) ─────────────────────────────────
type Classification = "retry" | "malformed" | "stop";

function isMalformed(err: unknown): boolean {
  return err instanceof MalformedOutputError || NoObjectGeneratedError.isInstance(err);
}

/**
 * Find the `APICallError` in an error chain. SDK layers wrap transport failures, so the status
 * code the ladder classifies by is often one or two `cause` hops down. Missing it means a 401 or
 * 402 is treated as an unknown error and retried — the opposite of what docs/04 §1 requires.
 */
function findApiCallError(err: unknown): APICallError | undefined {
  let current = err;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    if (APICallError.isInstance(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function classify(err: unknown): Classification {
  if (isMalformed(err)) return "malformed";
  const apiError = findApiCallError(err);
  if (apiError) {
    const status = apiError.statusCode;
    if (status === 429 || (typeof status === "number" && status >= 500)) return "retry";
    if (status === 402 || status === 401 || status === 400) return "stop";
    return apiError.isRetryable ? "retry" : "stop";
  }
  // Network/timeout-style errors without a status → one bounded retry, then next tier.
  return "retry";
}

/** Jittered exponential backoff. Jitter is mandatory (docs/04 §1); honours `retry-after`. */
function backoff(attempt: number, err: unknown, random: () => number): number {
  if (APICallError.isInstance(err)) {
    const header = err.responseHeaders?.["retry-after"];
    const seconds = header ? Number(header) : NaN;
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000 + random() * 250;
    }
  }
  return 300 * 2 ** attempt + random() * 400;
}

function logNonRetryable(err: unknown): void {
  // 401 (bad key) and 400 (our bug) are config errors worth alerting on (docs/04 §1, §8).
  const status = findApiCallError(err)?.statusCode;
  log.error("model call: non-retryable error", err, { status });
}

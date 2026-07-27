import { APICallError, NoObjectGeneratedError } from "ai";
import { getCached, setCached, cacheKey } from "../cache";
import { recordLedger, type LedgerOutcome } from "../db/queries/ledger";
import { demoContentFor, type DemoInput } from "../demo";
import { env } from "../env";
import { log } from "../log";
import { consumeQuota } from "../quota";
import {
  modelLadder,
  realRunModel,
  type RunModel,
  type RunModelArgs,
} from "./models";
import { buildNotesPrompt, getFormat, type NotesMode } from "./prompts";
import { quizSchema, sanitizeQuiz } from "./schemas";

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

class MalformedOutputError extends Error {
  constructor() {
    super("Model output failed validation");
    this.name = "MalformedOutputError";
  }
}

export type GenerateNotice = "demo" | "quota" | null;

export type GenerateInput = {
  userId: string;
  /** Phase 3 handles quick_notes; graph_structure / concept_detail arrive in Phase 5. */
  operation: "quick_notes";
  /** Notes format id — the cache and prompt discriminator. */
  format: string;
  /** Source material. Normalised before hashing so identical documents dedupe. */
  text: string;
};

export type GenerateResult = {
  data: unknown;
  tier: "cache" | "free" | "paid" | "demo";
  notice: GenerateNotice;
};

export type GenerateDeps = {
  runModel?: RunModel;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  demoFor?: (input: DemoInput) => unknown | null;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function generate(
  input: GenerateInput,
  deps: GenerateDeps = {},
): Promise<GenerateResult> {
  const runModel = deps.runModel ?? realRunModel;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const demoFor = deps.demoFor ?? demoContentFor;
  const started = now();
  const elapsed = () => now() - started;

  const key = cacheKey(input.text, input.format, env.PROMPT_VERSION);

  // ── Tier 0: cache hit — free, no quota consumed, no model call ──────────────
  const cached = await getCached(key);
  if (cached !== null) {
    await recordLedger(input.userId, {
      operation: input.operation,
      tier: "cache",
      outcome: "ok",
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: elapsed(),
    });
    return { data: cached, tier: "cache", notice: null };
  }

  // ── Cache miss: consume quota. Over limit → demo with the quota banner ──────
  const quota = await consumeQuota(input.userId);
  if (!quota.allowed) {
    return serveDemo(input, "quota", demoFor, elapsed);
  }

  // Build the prompt. An unknown format can't be generated → demo/busy tail.
  let promptInfo: { system: string; prompt: string; mode: NotesMode } | null = null;
  if (getFormat(input.format)) {
    promptInfo = buildNotesPrompt(input.format, input.text);
  }
  if (!promptInfo) {
    log.error("generate: unknown format", undefined, { format: input.format });
    return serveDemo(input, "demo", demoFor, elapsed);
  }
  const { system, prompt, mode } = promptInfo;
  const schema = mode === "quiz" ? quizSchema : undefined;

  // ── Tiers 1–4: walk the model ladder ────────────────────────────────────────
  const ladder = modelLadder();
  let fellThrough = false; // moved past the first model → outcome "fallback"

  for (const step of ladder) {
    let retried = false;
    for (let attempt = 0; attempt < step.maxAttempts; attempt++) {
      try {
        const result = await attemptModel(runModel, {
          modelId: step.modelId,
          system,
          prompt,
          schema,
          mode,
        });
        await setCached(key, result.data);
        const outcome: LedgerOutcome = fellThrough
          ? "fallback"
          : retried
            ? "retried"
            : "ok";
        await recordLedger(input.userId, {
          operation: input.operation,
          modelId: step.modelId,
          tier: step.tier,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          outcome,
          latencyMs: elapsed(),
        });
        return { data: result.data, tier: step.tier, notice: null };
      } catch (err) {
        const kind = classify(err);
        if (kind === "retry") {
          retried = true;
          if (attempt < step.maxAttempts - 1) {
            await sleep(backoff(attempt, err, random));
            continue;
          }
          break; // this model's attempts exhausted → next model
        }
        // "malformed" (repair already tried) and "stop" (402/401/400) → next model
        if (kind === "stop") logNonRetryable(err);
        break;
      }
    }
    fellThrough = true;
  }

  // ── Tier 5/6: demo, else busy ───────────────────────────────────────────────
  return serveDemo(input, "demo", demoFor, elapsed);
}

/** One model attempt: call, validate, and on malformed content do exactly ONE repair. */
async function attemptModel(
  runModel: RunModel,
  args: RunModelArgs & { mode: NotesMode },
): Promise<{ data: unknown; tokensIn: number; tokensOut: number }> {
  const { mode, ...call } = args;
  try {
    const res = await runModel(call);
    const valid = validateOutput(res.data, mode);
    if (valid !== null) {
      return { data: valid, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
    }
  } catch (err) {
    if (!isMalformed(err)) throw err; // APICallError etc. bubble to the ladder
  }
  // Repair: one more attempt, telling the model its previous output was invalid.
  const repairPrompt = `${call.prompt}\n\nYour previous response was invalid. Respond again with ONLY valid output in the required format, and nothing else.`;
  try {
    const res = await runModel({ ...call, prompt: repairPrompt });
    const valid = validateOutput(res.data, mode);
    if (valid !== null) {
      return { data: valid, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
    }
  } catch (err) {
    if (!isMalformed(err)) throw err;
  }
  throw new MalformedOutputError();
}

/** Quiz → sanitised Quiz (drops out-of-range answers); markdown → trimmed non-empty string. */
function validateOutput(data: unknown, mode: NotesMode): unknown | null {
  if (mode === "quiz") return sanitizeQuiz(data);
  if (typeof data === "string" && data.trim().length > 0) return data.trim();
  return null; // empty/whitespace is a failure, not a successful empty result
}

async function serveDemo(
  input: GenerateInput,
  notice: GenerateNotice,
  demoFor: (input: DemoInput) => unknown | null,
  elapsed: () => number,
): Promise<GenerateResult> {
  const demo = demoFor({ operation: input.operation, format: input.format });
  if (demo !== null) {
    await recordLedger(input.userId, {
      operation: input.operation,
      tier: "demo",
      outcome: "demo",
      latencyMs: elapsed(),
    });
    return { data: demo, tier: "demo", notice };
  }
  await recordLedger(input.userId, {
    operation: input.operation,
    tier: "demo",
    outcome: "failed",
    latencyMs: elapsed(),
  });
  throw new ServiceBusyError();
}

// ── Error classification (docs/04 §1 table) ─────────────────────────────────
type Classification = "retry" | "malformed" | "stop";

function isMalformed(err: unknown): boolean {
  return err instanceof MalformedOutputError || NoObjectGeneratedError.isInstance(err);
}

function classify(err: unknown): Classification {
  if (isMalformed(err)) return "malformed";
  if (APICallError.isInstance(err)) {
    const status = err.statusCode;
    if (status === 429 || (typeof status === "number" && status >= 500)) return "retry";
    if (status === 402 || status === 401 || status === 400) return "stop";
    return err.isRetryable ? "retry" : "stop";
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
  const status = APICallError.isInstance(err) ? err.statusCode : undefined;
  log.error("model call: non-retryable error", err, { status });
}

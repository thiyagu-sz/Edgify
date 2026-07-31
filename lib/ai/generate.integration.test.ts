import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { readLedger } from "@/lib/db/queries/ledger";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { getRemaining } from "@/lib/quota";
import { createTestUser } from "@/test/factories";
import { generate, ServiceBusyError, type GenerateDeps } from "./generate";
import { modelLadder, type RunModel, type RunModelResult } from "./models";

/**
 * The degradation ladder, proven tier by tier (docs/06 Phase 3 acceptance). Every test injects a
 * fake `runModel`, so tiers are forced with no network and no spend. Each uses a fresh user and a
 * unique document, so the shared cache and per-user quota/ledger never bleed between tests.
 */

const isFree = (modelId: string) => modelId.includes(":free");
const noSleep = async () => {};
const uniqueText = () => `neural networks ${randomUUID()}`;

/**
 * The ladder has MORE THAN ONE free rung: the primary free model (3 attempts) plus every id in
 * `OPENROUTER_FREE_FALLBACKS` (2 attempts each), then the paid model (docs/02 — a free-tier
 * retirement must be a config change, not an outage).
 *
 * These counts are derived from `modelLadder()` rather than hardcoded. They used to be literals
 * written when there was a single free rung, and they silently went stale the moment
 * `OPENROUTER_FREE_FALLBACKS` gained a default — the tests then asserted 3 free calls against a
 * ladder that legitimately makes 5. Deriving them means adding or removing a fallback updates the
 * expectation instead of breaking the suite.
 */
const freeSteps = () => modelLadder().filter((s) => s.tier === "free");
/** Total free attempts when every free rung fails with a RETRYABLE error (all attempts used). */
const freeAttemptsWhenRetrying = () =>
  freeSteps().reduce((n, s) => n + s.maxAttempts, 0);
/** Total free calls when output is MALFORMED: one attempt + one repair per rung, no retries. */
const freeCallsWhenMalformed = () => freeSteps().length * 2;

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

const OK_MD = "# Notes\n- a key point";
const OK_QUIZ = {
  questions: [{ q: "Q?", options: ["a", "b", "c", "d"], answer: 1, explanation: "e" }],
};
const BAD_QUIZ = {
  questions: [{ q: "x", options: ["a", "b"], answer: 9, explanation: "" }],
};

/** Build a fake runModel that decides behaviour from the model id, recording every call. */
function runner(fn: (modelId: string) => RunModelResult) {
  const calls: string[] = [];
  const runModel: RunModel = async ({ modelId }) => {
    calls.push(modelId);
    return fn(modelId);
  };
  return { runModel, calls };
}

describe("generate — degradation ladder", () => {
  it("AC1: identical input twice → cache hit, zero tokens, no quota consumed", async () => {
    const userId = await createTestUser();
    const text = uniqueText();
    const { runModel, calls } = runner(() => ({ data: OK_MD, tokensIn: 10, tokensOut: 20 }));
    const deps: GenerateDeps = { runModel, sleep: noSleep };
    const input = { userId, operation: "quick_notes" as const, format: "key_points", text };

    const r1 = await generate(input, deps);
    expect(r1.tier).toBe("free");
    expect(calls).toHaveLength(1);
    const remainingAfterFirst = (await getRemaining(userId)).remaining;

    const r2 = await generate(input, deps);
    expect(r2.tier).toBe("cache");
    expect(r2.data).toBe(OK_MD);
    expect(calls).toHaveLength(1); // model NOT called again
    expect((await getRemaining(userId)).remaining).toBe(remainingAfterFirst); // no quota consumed

    const ledger = await readLedger(userId); // newest first
    expect(ledger.map((r) => [r.tier, r.outcome])).toEqual([
      ["cache", "ok"],
      ["free", "ok"],
    ]);
    expect(ledger[0].tokensIn).toBe(0);
    expect(ledger[0].tokensOut).toBe(0);
  });

  it("AC2: forced 429 on free falls through to paid, invisibly", async () => {
    const userId = await createTestUser();
    const { runModel, calls } = runner((modelId) => {
      if (isFree(modelId)) throw apiError(429);
      return { data: OK_MD, tokensIn: 3, tokensOut: 4 };
    });
    const r = await generate(
      { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
      { runModel, sleep: noSleep },
    );
    expect(r.tier).toBe("paid");
    expect(r.notice).toBeNull();
    // Every free rung exhausts its attempts on a retryable 429, then the paid rung answers.
    expect(calls.filter(isFree)).toHaveLength(freeAttemptsWhenRetrying());
    expect(calls.filter((m) => !isFree(m))).toHaveLength(1); // paid once
    const ledger = await readLedger(userId);
    expect(ledger[0].tier).toBe("paid");
    expect(ledger[0].outcome).toBe("fallback");
  });

  it("AC3: both tiers failing → demo content with the banner", async () => {
    const userId = await createTestUser();
    const { runModel } = runner(() => {
      throw apiError(500);
    });
    const r = await generate(
      { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
      { runModel, sleep: noSleep },
    );
    expect(r.tier).toBe("demo");
    expect(r.notice).toBe("demo");
    expect(r.data).toBe(DEMO_NOTES.key_points);
    expect((await readLedger(userId))[0].outcome).toBe("demo");
  });

  it("AC4: demo unavailable → busy message, not a raw exception", async () => {
    const userId = await createTestUser();
    const { runModel } = runner(() => {
      throw apiError(500);
    });
    let caught: unknown;
    try {
      await generate(
        { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
        { runModel, sleep: noSleep, demoFor: () => null },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceBusyError);
    expect((caught as Error).message).toMatch(/Server is busy/);
    const ledger = await readLedger(userId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outcome).toBe("failed");
  });

  it("AC5: malformed output triggers exactly one repair, then falls through", async () => {
    const userId = await createTestUser();
    const { runModel, calls } = runner((modelId) =>
      isFree(modelId)
        ? { data: BAD_QUIZ, tokensIn: 1, tokensOut: 1 }
        : { data: OK_QUIZ, tokensIn: 2, tokensOut: 3 },
    );
    const r = await generate(
      { userId, operation: "quick_notes", format: "mcqs", text: uniqueText() },
      { runModel, sleep: noSleep },
    );
    expect(r.tier).toBe("paid");
    // Malformed output is NOT retried within a rung: one attempt + exactly one repair, then
    // straight to the next rung (docs/04 §3).
    expect(calls.filter(isFree)).toHaveLength(freeCallsWhenMalformed());
    expect(calls.filter((m) => !isFree(m))).toHaveLength(1);
  });

  it("AC7: retries use jittered backoff (delay = base + random component)", async () => {
    const userId = await createTestUser();
    const { runModel } = runner((modelId) => {
      if (isFree(modelId)) throw apiError(429);
      return { data: OK_MD, tokensIn: 1, tokensOut: 1 };
    });
    const sleeps: number[] = [];
    const seq = [0.1, 0.9];
    let i = 0;
    const r = await generate(
      { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
      {
        runModel,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => seq[i++ % seq.length],
      },
    );
    expect(r.tier).toBe("paid");
    // The delays below assume this ladder shape; assert it so a new fallback rung explains
    // itself rather than just breaking the next line.
    expect(
      freeSteps().map((s) => s.maxAttempts),
      "free ladder shape changed — update the expected delays below",
    ).toEqual([3, 2]);
    // random() cycles [0.1, 0.9]. Primary rung: 300*2^0 + 0.1*400 = 340, then
    // 300*2^1 + 0.9*400 = 960. The fallback rung restarts at attempt 0 → 340 again.
    expect(sleeps).toEqual([340, 960, 340]);
    // Jitter is applied: no delay equals its un-jittered base (300, 600).
    expect(sleeps).not.toContain(300);
    expect(sleeps).not.toContain(600);
  });
});

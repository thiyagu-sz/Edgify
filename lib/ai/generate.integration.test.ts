import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { readLedger } from "@/lib/db/queries/ledger";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { getRemaining } from "@/lib/quota";
import { createTestUser } from "@/test/factories";
import { generate, ServiceBusyError, type GenerateDeps } from "./generate";
import type { RunModel, RunModelResult } from "./models";

/**
 * The degradation ladder, proven tier by tier (docs/06 Phase 3 acceptance). Every test injects a
 * fake `runModel`, so tiers are forced with no network and no spend. Each uses a fresh user and a
 * unique document, so the shared cache and per-user quota/ledger never bleed between tests.
 */

const isFree = (modelId: string) => modelId.includes(":free");
const noSleep = async () => {};
const uniqueText = () => `neural networks ${randomUUID()}`;

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
    expect(calls.filter(isFree)).toHaveLength(3); // free attempted 3x
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
    expect(calls.filter(isFree)).toHaveLength(2); // original + exactly one repair
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
    // 300*2^0 + 0.1*400 = 340 ; 300*2^1 + 0.9*400 = 960 → distinct ⇒ jitter applied
    expect(sleeps).toEqual([340, 960]);
  });
});

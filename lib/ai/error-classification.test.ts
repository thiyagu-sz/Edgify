import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { generateNotesStream, type GenerateDeps } from "./generate";
import type { RunStream } from "./models";

/**
 * Regression tests for two defects found by breaking the model on purpose in a real browser
 * (test/e2e/degradation-proof.mjs, MODE=badkey). Both were invisible to every mocked test,
 * because the mocks threw a bare `APICallError` while the real SDK does not.
 *
 * 1. A 401 was being RETRIED. Iterating a failed `textStream` throws a generic
 *    `AI_NoOutputGeneratedError` with no `cause`; the `APICallError` carrying the status code
 *    only reaches the `onError` callback. `classify` saw an unrecognised error and returned
 *    "retry", so a bad key cost 7 model calls per generation instead of 1 and never produced the
 *    operator alert docs/04 §1 requires.
 *
 * 2. Each abandoned attempt left an unobserved rejected `usage` promise — 7 `unhandledRejection`s
 *    per generation, a process-stability risk rather than mere log noise.
 *
 * These tests assert the ladder's BEHAVIOUR (how many attempts, which outcome), which is what
 * actually went wrong, rather than asserting the shape of an internal helper.
 */

const noSleep = async () => {};

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

/**
 * A streamer that fails the way the REAL SDK fails: the iterator throws the transport error, and
 * `usage` rejects with it too. Records how many times it was called.
 */
function failingStreamer(error: unknown) {
  const calls: string[] = [];
  const runStream: RunStream = ({ modelId }) => {
    calls.push(modelId);
    async function* gen(): AsyncGenerator<string> {
      throw error;
    }
    const usage = Promise.reject(error) as Promise<{ tokensIn: number; tokensOut: number }>;
    // The production seam attaches this; mirror it so the test does not itself leak a rejection.
    usage.catch(() => {});
    return { textStream: gen(), usage };
  };
  return { runStream, calls };
}

const input = {
  userId: "user-classification",
  operation: "quick_notes" as const,
  format: "key_points",
  text: "x".repeat(300),
};

/** Skip the database entirely: no cache, always in quota, demo always available. */
function depsWith(runStream: RunStream): GenerateDeps {
  return { runStream, sleep: noSleep, demoFor: () => "# Sample notes" };
}

vi.mock("../cache", () => ({
  cacheKey: () => "test-key",
  getCached: async () => null,
  setCached: async () => {},
}));
vi.mock("../quota", () => ({
  consumeQuota: async () => ({ allowed: true, remaining: 10, limit: 30 }),
}));
vi.mock("../db/queries/ledger", () => ({ recordLedger: async () => {} }));

describe("non-retryable errors stop immediately", () => {
  for (const status of [401, 402, 400]) {
    it(`a ${status} tries each model once, then falls to demo`, async () => {
      const { runStream, calls } = failingStreamer(apiError(status));
      const result = await generateNotesStream(input, depsWith(runStream));

      expect(result.kind).toBe("final");
      if (result.kind !== "final") return;
      expect(result.tier).toBe("demo");

      // One attempt per model in the ladder — never the full retry budget.
      const perModel = new Map<string, number>();
      for (const id of calls) perModel.set(id, (perModel.get(id) ?? 0) + 1);
      for (const [modelId, count] of perModel) {
        expect(count, `${modelId} was retried on a ${status}`).toBe(1);
      }
    });
  }

  it("a 429 still uses the full retry budget", async () => {
    const { runStream, calls } = failingStreamer(apiError(429));
    await generateNotesStream(input, depsWith(runStream));

    const perModel = new Map<string, number>();
    for (const id of calls) perModel.set(id, (perModel.get(id) ?? 0) + 1);
    // The first free model gets 3 attempts; retrying a rate limit is correct.
    expect(Math.max(...perModel.values())).toBeGreaterThan(1);
  });
});

describe("wrapped transport errors are still classified", () => {
  it("finds an APICallError behind a generic wrapper via cause", async () => {
    const wrapped = new Error("No output generated. Check the stream for errors.", {
      cause: apiError(401),
    });
    const { runStream, calls } = failingStreamer(wrapped);
    const result = await generateNotesStream(input, depsWith(runStream));

    expect(result.kind).toBe("final");
    const perModel = new Map<string, number>();
    for (const id of calls) perModel.set(id, (perModel.get(id) ?? 0) + 1);
    for (const [modelId, count] of perModel) {
      expect(count, `${modelId} retried a wrapped 401`).toBe(1);
    }
  });

  it("finds one nested two levels down", async () => {
    const inner = new Error("transport", { cause: apiError(402) });
    const outer = new Error("no output", { cause: inner });
    const { runStream, calls } = failingStreamer(outer);
    await generateNotesStream(input, depsWith(runStream));

    const perModel = new Map<string, number>();
    for (const id of calls) perModel.set(id, (perModel.get(id) ?? 0) + 1);
    for (const count of perModel.values()) expect(count).toBe(1);
  });

  it("treats a truly unknown error as retryable, as before", async () => {
    const { runStream, calls } = failingStreamer(new Error("socket hang up"));
    await generateNotesStream(input, depsWith(runStream));

    const perModel = new Map<string, number>();
    for (const id of calls) perModel.set(id, (perModel.get(id) ?? 0) + 1);
    expect(Math.max(...perModel.values())).toBeGreaterThan(1);
  });
});

/**
 * Pins the SDK behaviour this fix depends on, because it is surprising enough that a future
 * version could change it silently.
 *
 * Observed against @openrouter/ai-sdk-provider + ai v7 with an invalid key:
 *   - `textStream` does NOT throw. It yields zero chunks and closes cleanly.
 *   - `totalUsage` rejects with a generic AI_NoOutputGeneratedError carrying no status.
 *   - The APICallError with `statusCode: 401` reaches `onError` and nowhere else.
 *
 * So an empty stream must be re-raised as the captured transport error, or the ladder reads a
 * config failure as an empty result and retries it.
 */
describe("realRunStream — an empty stream caused by a transport error is re-raised", () => {
  it("throws the captured error instead of completing silently", async () => {
    vi.resetModules();
    const failure = apiError(401);

    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: (opts: { onError?: (e: { error: unknown }) => void }) => {
          // Exactly the observed shape: report through onError, yield nothing, close cleanly.
          opts.onError?.({ error: failure });
          return {
            textStream: (async function* () {})(),
            totalUsage: Promise.reject(new Error("No output generated.")),
          };
        },
      };
    });
    vi.doMock("@openrouter/ai-sdk-provider", () => ({
      createOpenRouter: () => ({ chat: (id: string) => ({ id }) }),
    }));

    const { realRunStream } = await import("./models");
    const { textStream } = realRunStream({ modelId: "m", system: "s", prompt: "p" });

    let thrown: unknown;
    try {
      for await (const chunk of textStream) void chunk;
    } catch (err) {
      thrown = err;
    }

    expect(thrown, "an empty stream hid the transport error").toBe(failure);
    vi.doUnmock("ai");
    vi.doUnmock("@openrouter/ai-sdk-provider");
    vi.resetModules();
  });

  it("leaves a genuinely empty stream (no transport error) alone", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...actual,
        streamText: () => ({
          textStream: (async function* () {})(),
          totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
        }),
      };
    });
    vi.doMock("@openrouter/ai-sdk-provider", () => ({
      createOpenRouter: () => ({ chat: (id: string) => ({ id }) }),
    }));

    const { realRunStream } = await import("./models");
    const { textStream } = realRunStream({ modelId: "m", system: "s", prompt: "p" });

    const chunks: string[] = [];
    for await (const chunk of textStream) chunks.push(chunk);
    // A model that returns nothing is a retryable tier failure, handled by the ladder — not a
    // config error, so nothing should be re-raised here.
    expect(chunks).toEqual([]);

    vi.doUnmock("ai");
    vi.doUnmock("@openrouter/ai-sdk-provider");
    vi.resetModules();
  });
});

describe("abandoned attempts leave no unhandled rejection", () => {
  it("survives a full ladder failure without an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { runStream } = failingStreamer(apiError(500));
      await generateNotesStream(input, depsWith(runStream));
      // Give the microtask queue a chance to surface any unobserved rejection.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

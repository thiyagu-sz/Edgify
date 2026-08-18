import { describe, expect, it, vi } from "vitest";

/**
 * The ordering invariant: **auth → cache → quota → model** (`.claude/rules/ai.md`).
 *
 * A cached result costs nothing, so it must not consume the user's daily allowance. The cache
 * lookup and the quota consume look like an obvious `Promise.all` pair — issuing them together
 * would shave a database round trip off the hot path — and doing so silently charges a
 * generation for every cache hit. The symptom is invisible in development, where the cache is
 * usually empty, and shows up as users hitting their limit early.
 *
 * These tests exist so that optimisation fails loudly rather than shipping.
 */

const getCached = vi.fn<(key: string) => Promise<unknown>>();
const setCached = vi.fn<(key: string, result: unknown) => Promise<void>>(async () => {});
const consumeQuota =
  vi.fn<(userId: string) => Promise<{ allowed: boolean; remaining: number; limit: number }>>();
const recordLedger = vi.fn<(userId: string, row: unknown) => Promise<void>>(async () => {});

/** Call order across both modules, so "before" is asserted rather than assumed. */
const callOrder: string[] = [];

vi.mock("../cache", () => ({
  cacheKey: () => "key",
  getCached: (key: string) => {
    callOrder.push("cache");
    return getCached(key);
  },
  setCached: (key: string, result: unknown) => setCached(key, result),
}));
vi.mock("../quota", () => ({
  consumeQuota: (userId: string) => {
    callOrder.push("quota");
    return consumeQuota(userId);
  },
}));
vi.mock("../db/queries/ledger", () => ({
  recordLedger: (userId: string, row: unknown) => recordLedger(userId, row),
}));

const { generate, generateNotesStream } = await import("./generate");

const base = {
  userId: "user-ordering",
  operation: "quick_notes" as const,
  text: "x".repeat(300),
};

function reset() {
  callOrder.length = 0;
  getCached.mockReset();
  consumeQuota.mockReset();
  recordLedger.mockClear();
  setCached.mockClear();
}

const deps = {
  sleep: async () => {},
  runStream: () => ({
    textStream: (async function* () {
      yield "streamed";
    })(),
    usage: Promise.resolve({ tokensIn: 1, tokensOut: 2 }),
    // This double always produces, so the barrier never asks; answered truthfully regardless.
    diagnoseZeroOutput: () => ({ kind: "no-output" as const }),
  }),
  runModel: async () => ({ data: "generated", tokensIn: 1, tokensOut: 2 }),
  demoFor: () => "# demo",
};

describe("a cache hit never consumes quota", () => {
  it("streaming path: hit short-circuits before quota", async () => {
    reset();
    getCached.mockResolvedValue("cached notes");

    const result = await generateNotesStream({ ...base, format: "key_points" }, deps);

    expect(result.kind).toBe("final");
    if (result.kind !== "final") return;
    expect(result.tier).toBe("cache");
    expect(result.data).toBe("cached notes");

    expect(consumeQuota, "a cache hit charged the user a generation").not.toHaveBeenCalled();
    expect(callOrder).toEqual(["cache"]);
  });

  it("buffered path: hit short-circuits before quota", async () => {
    reset();
    getCached.mockResolvedValue({ questions: [] });

    const result = await generate({ ...base, format: "mcqs" }, deps);

    expect(result.tier).toBe("cache");
    expect(consumeQuota).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["cache"]);
  });
});

describe("a cache miss consumes quota, and only then", () => {
  it("streaming path: cache is checked strictly before quota", async () => {
    reset();
    getCached.mockResolvedValue(null);
    consumeQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 30 });

    const result = await generateNotesStream({ ...base, format: "key_points" }, deps);

    expect(result.kind).toBe("stream");
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    // Order, not merely presence: a Promise.all would produce both entries but interleaved,
    // and — more importantly — would have called quota on the hit path above.
    expect(callOrder).toEqual(["cache", "quota"]);
  });

  it("buffered path: cache is checked strictly before quota", async () => {
    reset();
    getCached.mockResolvedValue(null);
    consumeQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 30 });

    await generate({ ...base, format: "key_points" }, deps);

    expect(callOrder).toEqual(["cache", "quota"]);
  });

  it("over quota serves demo with the quota notice, without calling the model", async () => {
    reset();
    getCached.mockResolvedValue(null);
    consumeQuota.mockResolvedValue({ allowed: false, remaining: 0, limit: 30 });

    const runStream = vi.fn();
    const result = await generateNotesStream(
      { ...base, format: "key_points" },
      { ...deps, runStream },
    );

    expect(result.kind).toBe("final");
    if (result.kind !== "final") return;
    expect(result.tier).toBe("demo");
    expect(result.notice).toBe("quota");
    expect(runStream, "spent a model call after the quota was exhausted").not.toHaveBeenCalled();
  });
});

describe("completion writes both rows", () => {
  it("writes the cache entry and the ledger row for a streamed generation", async () => {
    reset();
    getCached.mockResolvedValue(null);
    consumeQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 30 });

    const result = await generateNotesStream({ ...base, format: "key_points" }, deps);
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    for await (const chunk of result.textStream) void chunk;

    // These two are issued together (Promise.all) rather than sequentially; both must still land.
    expect(setCached).toHaveBeenCalledTimes(1);
    expect(setCached).toHaveBeenCalledWith("key", "streamed");
    expect(recordLedger).toHaveBeenCalledTimes(1);
  });

  it("still writes the ledger row when the cache write fails", async () => {
    reset();
    getCached.mockResolvedValue(null);
    consumeQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 30 });
    setCached.mockRejectedValueOnce(new Error("cache table unavailable"));

    const result = await generateNotesStream({ ...base, format: "key_points" }, deps);
    if (result.kind !== "stream") throw new Error("expected a stream");

    // The stream itself must still deliver; the caller sees the tokens either way.
    let text = "";
    try {
      for await (const chunk of result.textStream) text += chunk;
    } catch {
      // The cache failure surfaces after the last token; content was already delivered.
    }
    expect(text).toBe("streamed");
    // Sequential awaits would have skipped the ledger entirely once the cache write threw.
    expect(recordLedger).toHaveBeenCalledTimes(1);
  });
});

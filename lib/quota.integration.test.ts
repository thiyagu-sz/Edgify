import { describe, expect, it } from "vitest";
import { createTestUser } from "@/test/factories";
import { consumeQuota, getRemaining } from "./quota";

/**
 * Quota against real Postgres (docs/04 §5, docs/09 §3.3/§3.4). The atomic upsert is the whole
 * point — an in-memory mock could never prove the concurrency guarantee.
 */
describe("quota", () => {
  it("increments and reports remaining 1:1 up to the limit", async () => {
    const u = await createTestUser();
    const limit = 3;
    expect(await consumeQuota(u, { limit })).toMatchObject({
      allowed: true,
      remaining: 2,
      limit: 3,
    });
    expect((await consumeQuota(u, { limit })).remaining).toBe(1);
    expect(await consumeQuota(u, { limit })).toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  it("enforces at the limit and never stores more than the limit", async () => {
    const u = await createTestUser();
    const limit = 2;
    await consumeQuota(u, { limit });
    await consumeQuota(u, { limit });
    expect(await consumeQuota(u, { limit })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
    // The rejected call did not increment past the limit.
    expect(await getRemaining(u, { limit })).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("resets at the UTC day boundary — a new day gets a fresh allowance", async () => {
    const u = await createTestUser();
    const limit = 2;
    const day1 = new Date("2026-07-25T23:59:00Z");
    const day2 = new Date("2026-07-26T00:01:00Z");
    await consumeQuota(u, { limit, now: day1 });
    await consumeQuota(u, { limit, now: day1 });
    expect((await consumeQuota(u, { limit, now: day1 })).allowed).toBe(false); // day1 spent
    expect(await consumeQuota(u, { limit, now: day2 })).toMatchObject({
      allowed: true,
      remaining: 1, // fresh row for the new UTC day
    });
  });

  it("holds under concurrent requests — no lost update, no overshoot", async () => {
    const u = await createTestUser();
    const limit = 20;
    const attempts = 50;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => consumeQuota(u, { limit })),
    );
    expect(results.filter((r) => r.allowed).length).toBe(limit);
    expect((await getRemaining(u, { limit })).remaining).toBe(0);
  });

  /**
   * The UI polls `getRemaining` after every generation to refresh the counter. If reading cost a
   * generation, looking at your allowance would spend it and the counter would race itself to
   * zero. Asserted against the real table rather than a mock, because the guarantee is about
   * what the SQL does.
   */
  it("getRemaining never consumes, however often it is called", async () => {
    const u = await createTestUser();
    const limit = 10;
    await consumeQuota(u, { limit });

    const before = await getRemaining(u, { limit });
    expect(before.remaining).toBe(9);

    for (let i = 0; i < 20; i++) {
      expect((await getRemaining(u, { limit })).remaining).toBe(9);
    }

    // And the next real generation still gets its full turn.
    expect(await consumeQuota(u, { limit })).toMatchObject({ allowed: true, remaining: 8 });
  });

  it("getRemaining reports a full allowance for a user with no row yet", async () => {
    const u = await createTestUser();
    const limit = 10;
    // Reading before any generation must not create a counter row or imply usage.
    expect(await getRemaining(u, { limit })).toMatchObject({
      allowed: true,
      remaining: 10,
      limit: 10,
    });
    expect(await consumeQuota(u, { limit })).toMatchObject({ allowed: true, remaining: 9 });
  });
});

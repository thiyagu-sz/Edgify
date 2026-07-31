import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cacheKey, contentHash, getCached, normalizeText, setCached } from "./cache";
import { getPool } from "./db/client";

describe("cache key", () => {
  it("normalises whitespace so the same document hashes identically", () => {
    expect(normalizeText("a   b\n\nc ")).toBe("a b c");
    expect(cacheKey("a   b", "key_points", "v1")).toBe(
      cacheKey("a b", "key_points", "v1"),
    );
  });

  it("differs by format and by prompt version", () => {
    expect(cacheKey("t", "key_points", "v1")).not.toBe(cacheKey("t", "mcqs", "v1"));
    expect(cacheKey("t", "key_points", "v1")).not.toBe(
      cacheKey("t", "key_points", "v2"),
    );
  });
});

describe("cache store", () => {
  it("round-trips a value and misses on an unknown key", async () => {
    const key = `k-${randomUUID()}`;
    expect(await getCached(key)).toBeNull();
    await setCached(key, { hello: "world" });
    expect(await getCached(key)).toEqual({ hello: "world" });
  });

  it("ON CONFLICT DO NOTHING keeps the first value on a duplicate insert", async () => {
    const key = `k-${randomUUID()}`;
    await setCached(key, "first");
    await setCached(key, "second");
    expect(await getCached(key)).toBe("first");
  });
});

/**
 * ── `generation_cache` inserts under REAL concurrency (.claude/rules/database.md) ────────────
 *
 * "Two users uploading the same document simultaneously will produce the same cache key, and
 * without this one of them errors on a duplicate key. This is the exact classroom scenario the
 * cache exists for."
 *
 * The sequential test above does NOT prove that. By the time the second `setCached` runs, the
 * first has committed, so Postgres never has two live inserts to arbitrate — `ON CONFLICT DO
 * NOTHING` and a plain `INSERT` behave identically apart from the error, and even that only
 * because the row is already visible.
 *
 * So these tests force the genuine race with a BARRIER rather than hoping `Promise.all` overlaps:
 * two separate pooled connections both `BEGIN`, both `INSERT` the same fresh key, and only then
 * does either `COMMIT`. Postgres blocks the second insert on the first's uncommitted row lock —
 * this is the exact interleaving production hits and the one a sequential test cannot reach.
 *
 * Each has a NEGATIVE CONTROL running the identical barrier WITHOUT the conflict clause. If that
 * control ever stops raising 23505, the barrier has stopped producing a race and the positive
 * test proves nothing.
 */
describe("cache store: concurrent inserts on one key", () => {
  /**
   * Run `insertSql` on two connections with both transactions open at once.
   * Returns each side's outcome so a test can assert on the errors as well as the survivor.
   */
  async function racingInserts(
    key: string,
    insertSql: (value: string) => string,
  ): Promise<{ first: unknown; second: unknown }> {
    const pool = getPool();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");

      // A inserts and HOLDS the row lock (uncommitted).
      const first = await a
        .query(insertSql("first"), [key])
        .then(() => null)
        .catch((error: unknown) => error);

      // B's insert on the same key now blocks on A's lock. Issue it without awaiting, commit A,
      // and only then collect B's outcome — that ordering is what makes the race deterministic.
      const pendingSecond = b
        .query(insertSql("second"), [key])
        .then(() => null)
        .catch((error: unknown) => error);

      await a.query("COMMIT");
      const second = await pendingSecond;
      await b.query(second === null ? "COMMIT" : "ROLLBACK");

      return { first, second };
    } finally {
      a.release();
      b.release();
    }
  }

  const WITH_CONFLICT_CLAUSE = (value: string) =>
    `INSERT INTO generation_cache (cache_key, result_json) VALUES ($1, '"${value}"'::jsonb) ON CONFLICT DO NOTHING`;
  const WITHOUT_CONFLICT_CLAUSE = (value: string) =>
    `INSERT INTO generation_cache (cache_key, result_json) VALUES ($1, '"${value}"'::jsonb)`;

  it("tolerates a simultaneous duplicate: neither side errors, the first value wins", async () => {
    const key = `race-${randomUUID()}`;

    const { first, second } = await racingInserts(key, WITH_CONFLICT_CLAUSE);

    expect(first, "the first writer errored").toBeNull();
    expect(second, "the losing writer errored on a duplicate key").toBeNull();
    expect(await getCached(key)).toBe("first");
  });

  /**
   * The negative control: the SAME barrier, the SAME two connections, one clause removed.
   * It must raise `23505` (unique_violation) — otherwise the barrier is not producing a race and
   * the test above passes for the wrong reason.
   */
  it("negative control: WITHOUT the clause, the same race raises 23505", async () => {
    const key = `race-control-${randomUUID()}`;

    const { first, second } = await racingInserts(key, WITHOUT_CONFLICT_CLAUSE);

    expect(first, "the first writer errored").toBeNull();
    expect(
      (second as { code?: string } | null)?.code,
      "the barrier did NOT produce a duplicate-key conflict — the positive test above proves nothing",
    ).toBe("23505");
  });

  it("survives the classroom case: ten simultaneous writers, one row, no errors", async () => {
    const key = `class-${randomUUID()}`;

    // The real shape of the scenario the cache exists for: a whole class hitting one key at once.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => setCached(key, `writer-${i}`)),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected, `${rejected.length} of 10 concurrent writers errored`).toEqual([]);
    expect(await getCached(key)).toMatch(/^writer-\d$/); // exactly one winner, whoever it was
  });
});

describe("contentHash", () => {
  it("is stable across whitespace differences, so re-exports of one document dedupe", () => {
    expect(contentHash("Lecture  one.\n\nIntro.")).toBe(contentHash("Lecture one. Intro."));
  });

  it("differs for different documents", () => {
    expect(contentHash("Lecture one")).not.toBe(contentHash("Lecture two"));
  });

  it("shares normalisation with cacheKey, so the clone path and the cache agree", () => {
    // If these ever diverged, W4 step 8 and tier 0 would disagree about "the same document" and
    // the classroom case would half-work with nothing reporting it.
    const spaced = "a   b\n\nc";
    const tight = "a b c";
    expect(contentHash(spaced)).toBe(contentHash(tight));
    expect(cacheKey(spaced, "key_points", "v1")).toBe(cacheKey(tight, "key_points", "v1"));
  });
});

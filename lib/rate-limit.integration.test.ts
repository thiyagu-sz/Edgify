import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { countOf, countQueries } from "@/test/count-queries";
import { db } from "./db/client";
import { rateLimits } from "./db/schema";
import { log } from "./log";
import { checkRateLimit, withRateLimit } from "./rate-limit";

function req(ip: string): Request {
  return new Request("http://localhost/api/health", {
    headers: { "x-forwarded-for": ip },
  });
}

function uniqueKey(): string {
  return `rl-${Date.now()}-${Math.random()}`;
}

/** Rows currently stored for a bucket, oldest window first. */
async function windowRows(key: string) {
  return db
    .select()
    .from(rateLimits)
    .where(eq(rateLimits.bucketKey, key))
    .orderBy(rateLimits.windowStart);
}

describe("rate limiting", () => {
  it("allows up to the limit within a window, then rejects", async () => {
    const key = uniqueKey();
    const opts = { limit: 3, windowMs: 60_000 };
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      allowed.push((await checkRateLimit(key, opts)).allowed);
    }
    expect(allowed).toEqual([true, true, true, false, false]);
  });

  it("resets when the window advances", async () => {
    const key = uniqueKey();
    const opts = { limit: 1, windowMs: 60_000 };
    const now0 = new Date("2026-07-25T10:00:00Z");
    expect((await checkRateLimit(key, { ...opts, now: now0 })).allowed).toBe(true);
    expect((await checkRateLimit(key, { ...opts, now: now0 })).allowed).toBe(false);
    const now1 = new Date(now0.getTime() + 61_000); // next fixed window
    expect((await checkRateLimit(key, { ...opts, now: now1 })).allowed).toBe(true);
  });

  it("wrapped unauthenticated route returns a calm 429 on a burst, isolated per IP", async () => {
    const handler = withRateLimit("rl-route", () => Response.json({ ok: true }), {
      limit: 2,
      windowMs: 60_000,
    });
    const ip = `9.9.9.${Math.floor(Math.random() * 255)}`;

    expect((await handler(req(ip))).status).toBe(200);
    expect((await handler(req(ip))).status).toBe(200);

    const blocked = await handler(req(ip));
    expect(blocked.status).toBe(429);
    const body = await blocked.json();
    expect(body.error).toMatch(/wait a moment/i);
    // No leaked status code or vendor name in the user-facing body.
    expect(JSON.stringify(body)).not.toMatch(/429|postgres|neon|rate.?limit/i);
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // A different IP has its own budget.
    expect((await handler(req("1.2.3.4"))).status).toBe(200);
  });
});

/**
 * The round-trip budget (docs/06 Phase 2: "the wrapper must add ONE round trip, not two").
 *
 * The cleanup DELETE used to run on every request — a second full round trip (~275ms remote) for
 * housekeeping no request needs. In front of `/api/notes/generate` that doubles the wrapper's
 * cost on the first-token path. These assert statement COUNTS rather than elapsed time, so they
 * hold identically against a localhost container and a remote Neon instance.
 */
describe("rate limiting: round-trip cost", () => {
  it("costs exactly one round trip per request within an established window", async () => {
    const key = uniqueKey();
    const now = new Date("2026-07-29T10:00:00Z");
    const opts = { limit: 100, windowMs: 60_000, now };

    // Open the window. This is the once-per-window request that also cleans up.
    const first = await countQueries(() => checkRateLimit(key, opts));
    expect(countOf(first.queries, "insert"), "the upsert that answers the request").toBe(1);
    expect(countOf(first.queries, "delete"), "cleanup runs on the window's first request").toBe(1);

    // Every subsequent request in the same window must be a single statement.
    for (let i = 0; i < 5; i++) {
      const next = await countQueries(() => checkRateLimit(key, opts));
      expect(next.queries, `request ${i + 2} issued more than one statement`).toHaveLength(1);
      expect(countOf(next.queries, "delete")).toBe(0);
    }
  });

  it("cleans once per window per key, not once per request", async () => {
    const key = uniqueKey();
    const windowMs = 60_000;
    const w0 = new Date("2026-07-29T11:00:00Z");
    const w1 = new Date(w0.getTime() + windowMs);
    const w2 = new Date(w1.getTime() + windowMs);
    const opts = { limit: 100, windowMs };

    const burst = await countQueries(async () => {
      for (const now of [w0, w0, w0, w0, w1, w1, w1, w2, w2, w2]) {
        await checkRateLimit(key, { ...opts, now });
      }
    });

    // 10 requests across 3 windows: 10 upserts, and 3 cleanups — one per window, not one per
    // request. The pre-fix implementation issued 10 deletes here.
    expect(countOf(burst.queries, "insert")).toBe(10);
    expect(countOf(burst.queries, "delete"), "cleanup should be once per window per key").toBe(3);
    expect(burst.queries).toHaveLength(13);
  });

  it("still bounds storage — an elapsed window row does not survive the next window", async () => {
    const key = uniqueKey();
    const windowMs = 60_000;
    const w0 = new Date("2026-07-29T12:00:00Z");
    const w1 = new Date(w0.getTime() + windowMs);
    const opts = { limit: 100, windowMs };

    await checkRateLimit(key, { ...opts, now: w0 });
    await checkRateLimit(key, { ...opts, now: w0 });
    expect(await windowRows(key)).toHaveLength(1);

    // Opening the next window is what triggers the cleanup of the elapsed one.
    await checkRateLimit(key, { ...opts, now: w1 });
    const rows = await windowRows(key);
    expect(rows, "the elapsed window row was left behind").toHaveLength(1);
    expect(rows[0].windowStart.getTime()).toBe(w1.getTime());
  });

  it("a failing cleanup never fails the request", async () => {
    const key = uniqueKey();
    const windowMs = 60_000;
    const w0 = new Date("2026-07-29T13:00:00Z");
    const w1 = new Date(w0.getTime() + windowMs);
    const opts = { limit: 100, windowMs };

    await checkRateLimit(key, { ...opts, now: w0 });

    // Break the cleanup on purpose: blow up the DELETE this key's next window will attempt.
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const spy = vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("housekeeping exploded");
    });

    try {
      const result = await checkRateLimit(key, { ...opts, now: w1 });
      // The request still gets its correct answer.
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
      expect(logged).toHaveBeenCalledWith(
        "rate limit: elapsed-window cleanup failed",
        expect.anything(),
        expect.objectContaining({ key }),
      );
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  });

  it("fails OPEN when the limiter's own query fails, rather than 500ing the route", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {});
    const spy = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("database unreachable");
    });

    try {
      const handler = withRateLimit("rl-failopen", () => Response.json({ ok: true }));
      const res = await handler(req("7.7.7.7"));
      expect(res.status, "a limiter outage must not take the route down").toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(logged).toHaveBeenCalledWith(
        "rate limit: check failed, allowing request",
        expect.anything(),
        expect.objectContaining({ key: "rl-failopen:7.7.7.7" }),
      );
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  });
});

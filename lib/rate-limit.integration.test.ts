import { describe, expect, it } from "vitest";
import { checkRateLimit, withRateLimit } from "./rate-limit";

function req(ip: string): Request {
  return new Request("http://localhost/api/health", {
    headers: { "x-forwarded-for": ip },
  });
}

function uniqueKey(): string {
  return `rl-${Date.now()}-${Math.random()}`;
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

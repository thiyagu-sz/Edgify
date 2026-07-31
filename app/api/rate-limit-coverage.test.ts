import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Closes the Phase 2 rate-limiting criterion (docs/06): "`/api/notes/generate` and `/api/usage`
 * reject a burst of unauthenticated requests."
 *
 * Two distinct properties, and the second is the one with teeth:
 *
 *  1. Every spending/session route module is actually wrapped — a source scan, so a route added
 *     later (Phase 5 adds three) cannot quietly ship unwrapped.
 *  2. A rejected request never reaches the session lookup. That is the whole point on
 *     `/api/notes/generate`: unwrapped, an attacker with no credentials drives a database read
 *     per request before being rejected, and this route is the entry point to model-tier spend.
 *     Asserting only "returns 429" would pass even if the session read still happened first.
 */

// ── 1. Structural: the routes are wrapped at all ────────────────────────────
const API_DIR = join(process.cwd(), "app", "api");

/** Routes deliberately exempt: Better Auth owns its own handler and its own abuse controls. */
const EXEMPT = [join("app", "api", "auth")];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

describe("rate limiting: coverage", () => {
  it("wraps every API route handler with withRateLimit", () => {
    const unwrapped: string[] = [];
    for (const file of routeFiles(API_DIR)) {
      const rel = relative(process.cwd(), file);
      if (EXEMPT.some((e) => rel.startsWith(e))) continue;
      const source = readFileSync(file, "utf8");
      // Allow an explicit type argument: dynamic routes pin the route context, e.g.
      // `withRateLimit<RouteContext>("graph-read", handler)`. A bare `includes("withRateLimit(")`
      // missed those and reported the Phase 5 graph routes as unwrapped when they were not.
      if (!/\bwithRateLimit\s*(<[^>]*>)?\s*\(/.test(source)) unwrapped.push(rel);
    }
    expect(
      unwrapped,
      `API routes reachable without rate limiting (wrap them with withRateLimit):\n${unwrapped.join("\n")}`,
    ).toEqual([]);
  });
});

// ── 2. Behavioural: rejection precedes the session read ─────────────────────
const getSession = vi.fn();
const generateNotesStream = vi.fn();
const getRemaining = vi.fn();

/**
 * The counter is faked at the DATABASE, not at `checkRateLimit`.
 *
 * Stubbing `checkRateLimit` would not work anyway — `withRateLimit` calls it through a
 * module-internal binding, so replacing the export leaves the real function in play — but more
 * importantly it would hollow out the test. Faking only the upsert keeps the real wrapper, the
 * real bucket-key construction and the real allow/reject arithmetic under test; only the round
 * trip is replaced.
 */
const fake = vi.hoisted(() => ({ count: 1, buckets: [] as string[] }));

vi.mock("@/lib/db/client", () => {
  const returning = async () => [{ count: fake.count }];
  const onConflictDoUpdate = () => ({ returning });
  const values = (row: { bucketKey: string }) => {
    fake.buckets.push(row.bucketKey);
    return { onConflictDoUpdate };
  };
  return {
    db: {
      insert: () => ({ values }),
      delete: () => ({ where: async () => undefined }),
    },
    withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
    getPool: vi.fn(),
    pingDatabase: vi.fn(),
    schema: {},
  };
});

vi.mock("@/lib/auth", () => ({
  auth: { api: { get getSession() { return getSession; } } },
}));
vi.mock("@/lib/ai/generate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/generate")>("@/lib/ai/generate");
  return { ...actual, generateNotesStream: (...a: unknown[]) => generateNotesStream(...a) };
});
vi.mock("@/lib/db/queries/notes", () => ({ createNote: vi.fn() }));
vi.mock("@/lib/quota", () => ({
  getRemaining: (...a: unknown[]) => getRemaining(...a),
  consumeQuota: vi.fn(),
}));

const { POST } = await import("./notes/generate/route");
const { GET } = await import("./usage/route");

/** Both routes are configured well under this, so it trips either one. */
const OVER_LIMIT = 100_000;

function generateRequest(ip: string): Request {
  return new Request("http://localhost/api/notes/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ text: "a".repeat(250), format: "key_points" }),
  });
}

function usageRequest(ip: string): Request {
  return new Request("http://localhost/api/usage", {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.count = 1;
  fake.buckets.length = 0;
  // No session: these are unauthenticated callers.
  getSession.mockResolvedValue(null);
  getRemaining.mockResolvedValue({ remaining: 6, limit: 30 });
});

describe("POST /api/notes/generate — unauthenticated burst", () => {
  it("rejects past the limit WITHOUT ever reading the session", async () => {
    fake.count = OVER_LIMIT;

    const res = await POST(generateRequest("6.6.6.6"));

    expect(res.status).toBe(429);
    expect(
      getSession,
      "the request was rejected but still cost a session database read",
    ).not.toHaveBeenCalled();
    expect(generateNotesStream, "a rejected request reached the model layer").not.toHaveBeenCalled();
  });

  it("under the limit, the request proceeds to the session check as before", async () => {
    fake.count = 1;

    const res = await POST(generateRequest("6.6.6.7"));

    expect(res.status).toBe(401); // no session — the handler's own answer
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("across a burst, the session read count stops growing once the limit trips", async () => {
    let hits = 0;
    // The route allows 60/min; walk the counter past it mid-burst.
    for (let i = 0; i < 70; i++) {
      fake.count = ++hits;
      await POST(generateRequest("6.6.6.8"));
    }

    // 70 requests, 60 allowed: exactly 60 session reads, not 70.
    expect(getSession).toHaveBeenCalledTimes(60);
  });

  it("the 429 body stays calm — no status code, vendor name, or raw error", async () => {
    fake.count = OVER_LIMIT;
    const res = await POST(generateRequest("6.6.6.9"));
    const body = JSON.stringify(await res.json());
    expect(body).toMatch(/wait a moment/i);
    expect(body).not.toMatch(/429|postgres|neon|openrouter|rate.?limit|error:/i);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("GET /api/usage — unauthenticated burst", () => {
  it("rejects past the limit WITHOUT ever reading the session", async () => {
    fake.count = OVER_LIMIT;

    const res = await GET(usageRequest("8.8.8.8"));

    expect(res.status).toBe(429);
    expect(
      getSession,
      "the request was rejected but still cost a session database read",
    ).not.toHaveBeenCalled();
    expect(getRemaining).not.toHaveBeenCalled();
  });

  it("under the limit, the request proceeds to the session check as before", async () => {
    fake.count = 1;

    const res = await GET(usageRequest("8.8.8.9"));

    expect(res.status).toBe(401);
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("buckets the two routes independently, per IP", async () => {
    await POST(generateRequest("4.4.4.4"));
    await GET(usageRequest("4.4.4.4"));
    await GET(usageRequest("5.5.5.5"));

    expect(fake.buckets).toEqual([
      "notes-generate:4.4.4.4",
      "usage:4.4.4.4",
      "usage:5.5.5.5",
    ]);
  });
});

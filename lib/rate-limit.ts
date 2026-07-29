import { and, eq, lt, sql } from "drizzle-orm";
import { db, withDbRetry } from "./db/client";
import { rateLimits } from "./db/schema";
import { env } from "./env";
import { log } from "./log";

/**
 * Fixed-window rate limiting, backed by Postgres counters.
 *
 * Postgres is the chosen mechanism at this volume — docs/02-tech-stack.md deliberately
 * excludes Redis ("Postgres counters are sufficient at this volume"). The window a request
 * belongs to is `floor(now / windowMs)`; the count is incremented atomically with
 * ON CONFLICT ... DO UPDATE, so concurrent requests cannot lose an update.
 *
 * The route wrapper `withRateLimit` maps an exceeded limit to a calm 429 that never leaks a
 * status code or vendor name in its body text (docs/04-resilience.md §7).
 *
 * ONE round trip per request is the design constraint (docs/06 Phase 2). This wrapper now sits
 * in front of `/api/notes/generate`, on the first-token path, where a second sequential round
 * trip costs ~275ms against a remote database for work no request needs. See `checkRateLimit`.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Requests remaining in the current window after this call. */
  remaining: number;
  limit: number;
  /** When the current window ends and the allowance refills. */
  resetAt: Date;
};

type CheckOpts = { limit?: number; windowMs?: number; now?: Date };

/**
 * Count one hit against `key` for the current fixed window and report whether it is allowed.
 * `now` is injectable so tests can advance across a window boundary deterministically.
 *
 * Costs exactly ONE round trip on the request path. The upsert answers the question the request
 * is asking; nothing else is awaited before returning.
 */
export async function checkRateLimit(
  key: string,
  opts: CheckOpts = {},
): Promise<RateLimitResult> {
  const limit = opts.limit ?? env.RATE_LIMIT_MAX;
  const windowMs = opts.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const nowMs = (opts.now ?? new Date()).getTime();
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const windowStart = new Date(windowStartMs);
  const resetAt = new Date(windowStartMs + windowMs);

  const count = await withDbRetry(async () => {
    const [row] = await db
      .insert(rateLimits)
      .values({ bucketKey: key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.bucketKey, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });
    return row.count;
  });

  /**
   * Bound storage by dropping this key's ELAPSED windows — housekeeping, not part of the answer.
   *
   * It used to run on every request, which is a second full round trip (~275ms remote) charged to
   * work no request needs. `count === 1` means the upsert just INSERTED a fresh window row, which
   * is exactly the moment a prior window became elapsed — so cleaning only then is both sufficient
   * and once-per-window-per-key rather than once-per-request (docs/06 Phase 2).
   *
   * Deliberately OUTSIDE the `withDbRetry` above: a retry there would re-run the upsert and
   * double-count the request. And a housekeeping failure must never fail the request, so it is
   * caught and logged — an elapsed row that survives is dead weight, never a wrong answer.
   */
  if (count === 1) {
    try {
      await withDbRetry(async () => {
        await db
          .delete(rateLimits)
          .where(
            and(
              eq(rateLimits.bucketKey, key),
              lt(rateLimits.windowStart, windowStart),
            ),
          );
      });
    } catch (error) {
      log.error("rate limit: elapsed-window cleanup failed", error, { key });
    }
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    resetAt,
  };
}

/** Best-effort client IP from proxy headers. Cloud Run sets `x-forwarded-for`. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** A calm 429 — no status code or vendor name in the body text. */
function tooManyRequests(result: RateLimitResult): Response {
  const retryAfterSec = Math.max(
    1,
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
  );
  return Response.json(
    { error: "You're going a little fast. Please wait a moment and try again." },
    {
      status: 429,
      headers: {
        "retry-after": String(retryAfterSec),
        "x-ratelimit-limit": String(result.limit),
        "x-ratelimit-remaining": String(result.remaining),
      },
    },
  );
}

type RouteHandler = (req: Request) => Promise<Response> | Response;

/**
 * Wrap a route handler with per-IP fixed-window rate limiting. `routeName` namespaces the bucket
 * so different routes have independent budgets.
 *
 * The limiter runs BEFORE the wrapped handler, and therefore before that handler's session
 * lookup. That ordering is the point on the authenticated-but-expensive routes: without it an
 * unauthenticated caller drives a session DB read per request before being rejected, and on
 * `/api/notes/generate` that is also the entry point to model-tier spend (docs/06 Phase 2).
 *
 * FAILS OPEN. If the limiter's own query fails, the request is allowed through and the failure is
 * logged (it alerts via Sentry). Throwing here would surface Next's raw 500 on routes that
 * otherwise map every failure to a calm message (docs/04 §7), and would turn a brief database
 * hiccup into a total product outage. Nothing is exposed by failing open: every route behind this
 * needs the database for its own session and quota reads, so it cannot do expensive work either.
 */
export function withRateLimit(
  routeName: string,
  handler: RouteHandler,
  opts: Omit<CheckOpts, "now"> = {},
): RouteHandler {
  return async (req: Request) => {
    const key = `${routeName}:${clientIp(req)}`;
    let result: RateLimitResult;
    try {
      result = await checkRateLimit(key, opts);
    } catch (error) {
      log.error("rate limit: check failed, allowing request", error, { key });
      return handler(req);
    }
    if (!result.allowed) return tooManyRequests(result);
    return handler(req);
  };
}

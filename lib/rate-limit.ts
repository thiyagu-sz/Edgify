import { and, eq, lt, sql } from "drizzle-orm";
import { db, withDbRetry } from "./db/client";
import { rateLimits } from "./db/schema";
import { env } from "./env";

/**
 * Fixed-window rate limiting for unauthenticated routes, backed by Postgres counters.
 *
 * Postgres is the chosen mechanism at this volume — docs/02-tech-stack.md deliberately
 * excludes Redis ("Postgres counters are sufficient at this volume"). The window a request
 * belongs to is `floor(now / windowMs)`; the count is incremented atomically with
 * ON CONFLICT ... DO UPDATE, so concurrent requests cannot lose an update.
 *
 * The route wrapper `withRateLimit` maps an exceeded limit to a calm 429 that never leaks a
 * status code or vendor name in its body text (docs/04-resilience.md §7).
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

  return withDbRetry(async () => {
    const [row] = await db
      .insert(rateLimits)
      .values({ bucketKey: key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.bucketKey, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });

    const count = row.count;

    // Bound storage: drop this key's elapsed windows. Cheap — the PK is prefixed by bucketKey,
    // and an elapsed window is never read again.
    await db
      .delete(rateLimits)
      .where(
        and(
          eq(rateLimits.bucketKey, key),
          lt(rateLimits.windowStart, windowStart),
        ),
      );

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      resetAt,
    };
  });
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
 * Wrap an unauthenticated route handler with per-IP fixed-window rate limiting. `routeName`
 * namespaces the bucket so different routes have independent budgets.
 */
export function withRateLimit(
  routeName: string,
  handler: RouteHandler,
  opts: Omit<CheckOpts, "now"> = {},
): RouteHandler {
  return async (req: Request) => {
    const key = `${routeName}:${clientIp(req)}`;
    const result = await checkRateLimit(key, opts);
    if (!result.allowed) return tooManyRequests(result);
    return handler(req);
  };
}

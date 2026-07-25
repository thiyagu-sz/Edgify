import { and, eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "./db/client";
import { usageCounters } from "./db/schema";
import { env } from "./env";

/**
 * Per-user daily generation quota (docs/04-resilience.md §5, docs/09 §3.4).
 *
 * Quota is a product surface, not just a guard: the UI shows the counter before it bites and
 * offers demo mode at the limit. This module owns only the counting; the messaging lives in
 * the UI layer.
 *
 * The reset boundary is the calendar day in `QUOTA_TIMEZONE` (default UTC — a DELIBERATE
 * choice, not an accidental inheritance). `dayKey` is pure and unit-tested around the
 * boundary; `consumeQuota` increments atomically so the limit can never be exceeded and
 * concurrent requests from the same user cannot lose an update.
 */

export type QuotaResult = {
  /** Whether this request is within the daily allowance. */
  allowed: boolean;
  /** Generations remaining today after this call (never negative). */
  remaining: number;
  /** The daily limit in force. */
  limit: number;
};

/**
 * The calendar date (`YYYY-MM-DD`) for `now` in the configured quota time zone. `en-CA`
 * formats as ISO-style `YYYY-MM-DD`, which is exactly what the `date` column stores.
 */
export function dayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.QUOTA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

type QuotaOpts = { now?: Date; limit?: number };

/**
 * Atomically count one generation against the user's daily allowance and report the result.
 *
 * The increment and the limit check are a SINGLE statement:
 *
 *   INSERT ... VALUES (user, day, 1)
 *   ON CONFLICT (user_id, day) DO UPDATE SET generations = generations + 1
 *     WHERE usage_counters.generations < :limit
 *   RETURNING generations
 *
 * When the row is already at the limit the DO UPDATE's WHERE fails, no row is written, and
 * RETURNING yields nothing — so we report `allowed: false` without ever exceeding the limit.
 * Because Postgres serialises conflicting upserts on the row, concurrent calls cannot lose an
 * update or overshoot (proven in lib/quota.test.ts).
 */
export async function consumeQuota(
  userId: string,
  opts: QuotaOpts = {},
): Promise<QuotaResult> {
  const limit = opts.limit ?? env.QUOTA_DAILY_LIMIT;
  const day = dayKey(opts.now);
  return withDbRetry(async () => {
    const rows = await db
      .insert(usageCounters)
      .values({ userId, day, generations: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.day],
        set: { generations: sql`${usageCounters.generations} + 1` },
        setWhere: sql`${usageCounters.generations} < ${limit}`,
      })
      .returning({ generations: usageCounters.generations });

    if (rows.length === 0) {
      // The DO UPDATE was skipped by its WHERE → already at the limit for today.
      return { allowed: false, remaining: 0, limit };
    }
    const generations = rows[0].generations;
    return { allowed: true, remaining: Math.max(0, limit - generations), limit };
  });
}

/** Read today's remaining allowance without consuming any (for the UI counter). */
export async function getRemaining(
  userId: string,
  opts: QuotaOpts = {},
): Promise<QuotaResult> {
  const limit = opts.limit ?? env.QUOTA_DAILY_LIMIT;
  const day = dayKey(opts.now);
  return withDbRetry(async () => {
    const [row] = await db
      .select({ generations: usageCounters.generations })
      .from(usageCounters)
      .where(and(eq(usageCounters.userId, userId), eq(usageCounters.day, day)));
    const generations = row?.generations ?? 0;
    return {
      allowed: generations < limit,
      remaining: Math.max(0, limit - generations),
      limit,
    };
  });
}

import { and, desc, gte, sql } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { user } from "../auth-schema";
import { usageCounters, usageLedger } from "../schema";

/**
 * Fleet-wide aggregates for the internal usage dashboard (docs/06 Phase 7, `/admin/usage`).
 *
 * ⚠️ **EVERY FUNCTION IN THIS MODULE READS ACROSS ALL USERS, BY DESIGN.** That is the opposite of
 * AGENTS.md rule 2, which the rest of `queries/` follows without exception: `userId` first, always
 * in the WHERE clause. Read this before adding anything here.
 *
 * WHY IT IS SOUND, AND WHAT THE ARGUMENT DEPENDS ON. For every other query, isolation is a
 * property OF THE QUERY — a caller who reaches the function still cannot see another tenant's
 * rows. Here isolation is a property of the GATE: these functions have no tenant scope at all, so
 * the only thing standing between them and a data leak is `lib/admin.ts` refusing non-admins at
 * the page. Two consequences that are easy to get wrong later:
 *
 *  1. **Nothing here may be called from a route or component that is merely session-gated.** A
 *     signed-in student reaching any of these reads the whole fleet's spend and identities.
 *  2. **These must not be "fixed" by adding a `userId` parameter.** Aggregating one user's rows is
 *     a different feature (`readLedger` already does it). Making the signature look tenant-scoped
 *     while it is not would be worse than the honest cross-tenant shape, because it would pass a
 *     reviewer's glance.
 *
 * Listed in `isolation.integration.test.ts` under `ADMIN_AGGREGATE_ALLOWLIST` — deliberately its
 * own list rather than joining `CONTENT_ADDRESSED_ALLOWLIST`, because the two are sound for
 * completely different reasons. Content-addressed access is self-authorising (you must already
 * hold the document to reach its graph); this is not self-authorising at all and rests entirely
 * on an external gate.
 *
 * COST SEMANTICS. `costMicros` is `null` for a model this build cannot price and `0` for something
 * that genuinely cost nothing (cache, demo, a `:free` model). The two are never conflated: totals
 * sum only priced rows and the unpriced ones are counted separately, so an out-of-date price table
 * shows up as a visible warning rather than as a smaller number (`lib/ai/pricing.ts`).
 */

/** Micros in one US dollar — the unit `usage_ledger.costMicros` is stored in (docs/03). */
export const MICROS_PER_USD = 1_000_000;

export type UserUsageRow = {
  userId: string;
  email: string | null;
  name: string | null;
  generations: number;
  tokensIn: number;
  tokensOut: number;
  /** Summed over PRICED rows only. */
  costMicros: number;
  /** Rows whose model this build cannot price — excluded from `costMicros` above. */
  unpricedRows: number;
  lastActiveAt: Date | null;
};

/**
 * Per-user totals over the window, busiest spender first.
 *
 * `generations` counts rows that represent real model work — `tier` free or paid. Cache hits and
 * demo fallbacks are deliberately NOT counted as generations: a cache hit is the system working
 * (docs/05 W4 step 8, the single highest-value line in the system), and counting it here would
 * make the dedupe cache look like usage instead of savings.
 */
export async function usageByUser(sinceDays: number): Promise<UserUsageRow[]> {
  const since = daysAgo(sinceDays);
  return withDbRetry(async () => {
    const rows = await db
      .select({
        userId: usageLedger.userId,
        email: user.email,
        name: user.name,
        generations: sql<number>`count(*) filter (where ${usageLedger.tier} in ('free','paid'))::int`,
        tokensIn: sql<number>`coalesce(sum(${usageLedger.tokensIn}),0)::int`,
        tokensOut: sql<number>`coalesce(sum(${usageLedger.tokensOut}),0)::int`,
        costMicros: sql<number>`coalesce(sum(${usageLedger.costMicros}),0)::int`,
        unpricedRows: sql<number>`count(*) filter (where ${usageLedger.costMicros} is null)::int`,
        lastActiveAt: sql<Date | null>`max(${usageLedger.createdAt})`,
      })
      .from(usageLedger)
      .leftJoin(user, sql`${user.id} = ${usageLedger.userId}`)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.userId, user.email, user.name)
      .orderBy(desc(sql`coalesce(sum(${usageLedger.costMicros}),0)`));
    return rows;
  });
}

export type TierBreakdownRow = { tier: string | null; rows: number };

/**
 * Row counts per tier — the denominator for both headline rates.
 *
 * Returned raw rather than pre-divided so the caller can show the counts alongside the percentage.
 * A rate with no denominator is unreadable in exactly the situation it matters: "demo tier is 100%"
 * means something very different at 3 requests than at 3,000.
 */
export async function tierBreakdown(sinceDays: number): Promise<TierBreakdownRow[]> {
  const since = daysAgo(sinceDays);
  return withDbRetry(async () =>
    db
      .select({
        tier: usageLedger.tier,
        rows: sql<number>`count(*)::int`,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.tier),
  );
}

export type OutcomeBreakdownRow = { outcome: string | null; rows: number };

/** Row counts per outcome — `ok` / `retried` / `fallback` / `demo` / `failed` (docs/03). */
export async function outcomeBreakdown(sinceDays: number): Promise<OutcomeBreakdownRow[]> {
  const since = daysAgo(sinceDays);
  return withDbRetry(async () =>
    db
      .select({
        outcome: usageLedger.outcome,
        rows: sql<number>`count(*)::int`,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(usageLedger.outcome),
  );
}

export type DailySpendRow = {
  day: string;
  costMicros: number;
  generations: number;
  unpricedRows: number;
};

/**
 * Spend per UTC day. The shape of this line is the point — a step change is what a runaway looks
 * like before the billing cap notices, and the cap lags by hours (docs/09 §1.4).
 */
export async function dailySpend(sinceDays: number): Promise<DailySpendRow[]> {
  const since = daysAgo(sinceDays);
  return withDbRetry(async () =>
    db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageLedger.createdAt}), 'YYYY-MM-DD')`,
        costMicros: sql<number>`coalesce(sum(${usageLedger.costMicros}),0)::int`,
        generations: sql<number>`count(*) filter (where ${usageLedger.tier} in ('free','paid'))::int`,
        unpricedRows: sql<number>`count(*) filter (where ${usageLedger.costMicros} is null)::int`,
      })
      .from(usageLedger)
      .where(gte(usageLedger.createdAt, since))
      .groupBy(sql`date_trunc('day', ${usageLedger.createdAt})`)
      .orderBy(sql`date_trunc('day', ${usageLedger.createdAt})`),
  );
}

export type ModelUsageRow = {
  modelId: string | null;
  rows: number;
  costMicros: number;
  priced: boolean;
};

/**
 * Usage per model id, and whether this build could price it.
 *
 * The `priced: false` rows are the ones that matter operationally: they are real spend that the
 * totals elsewhere on the page do NOT include, because `lib/ai/pricing.ts` has no rate for that
 * id. Free-tier ids rotate with little notice, so this WILL happen eventually and needs to be
 * visible when it does rather than silently shrinking the reported cost.
 */
export async function usageByModel(sinceDays: number): Promise<ModelUsageRow[]> {
  const since = daysAgo(sinceDays);
  return withDbRetry(async () =>
    db
      .select({
        modelId: usageLedger.modelId,
        rows: sql<number>`count(*)::int`,
        costMicros: sql<number>`coalesce(sum(${usageLedger.costMicros}),0)::int`,
        priced: sql<boolean>`bool_and(${usageLedger.costMicros} is not null)`,
      })
      .from(usageLedger)
      .where(
        and(
          gte(usageLedger.createdAt, since),
          sql`${usageLedger.tier} in ('free','paid')`,
        ),
      )
      .groupBy(usageLedger.modelId)
      .orderBy(desc(sql`count(*)`)),
  );
}

export type QuotaTodayRow = { userId: string; generations: number };

/**
 * Today's quota consumption per user, read from `usage_counters` — the table quota enforcement
 * actually uses, not recomputed from the ledger.
 *
 * Deliberately the same source `lib/quota.ts` writes: a dashboard that recomputed "generations
 * today" from `usage_ledger` could disagree with the number the enforcement path is using, and
 * then the page would be actively misleading about whether a user is near their limit. When two
 * numbers must agree, read the one that decides.
 */
export async function quotaUsedToday(day: string): Promise<QuotaTodayRow[]> {
  return withDbRetry(async () =>
    db
      .select({
        userId: usageCounters.userId,
        generations: usageCounters.generations,
      })
      .from(usageCounters)
      .where(sql`${usageCounters.day} = ${day}`),
  );
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

import { describe, expect, it } from "vitest";
import { createTestUser } from "@/test/factories";
import { costMicrosFor } from "@/lib/ai/pricing";
import { recordLedger } from "./ledger";
import {
  dailySpend,
  outcomeBreakdown,
  quotaUsedToday,
  tierBreakdown,
  usageByModel,
  usageByUser,
} from "./usage-admin";

/**
 * The usage dashboard's aggregates, against real Postgres (docs/06 Phase 7).
 *
 * These are the numbers an operator will make spending decisions from, so the assertions are about
 * ARITHMETIC rather than "the query returns rows". A dashboard that renders confidently and sums
 * the wrong column is worse than no dashboard — which is precisely how the defect that prompted
 * this work survived: `costMicros` was written `0` on every row for four phases and every query
 * over it worked perfectly.
 */

const PAID = "openai/gpt-4o-mini";
const FREE = "google/gemma-4-26b-a4b-it:free";
const UNPRICED = "vendor/model-not-in-the-price-table";

/** Record a generation the way `generate.ts` does — cost priced at record time. */
async function generation(
  userId: string,
  modelId: string,
  tier: "free" | "paid",
  tokensIn: number,
  tokensOut: number,
) {
  await recordLedger(userId, {
    operation: "quick_notes",
    modelId,
    tier,
    tokensIn,
    tokensOut,
    costMicros: costMicrosFor(modelId, tokensIn, tokensOut),
    outcome: "ok",
  });
}

describe("usageByUser", () => {
  it("sums spend and tokens per user, and never mixes two users together", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();

    await generation(alice, PAID, "paid", 10_000, 2_000);
    await generation(alice, PAID, "paid", 5_000, 1_000);
    await generation(bob, PAID, "paid", 1_000, 100);

    const rows = await usageByUser(30);
    const a = rows.find((r) => r.userId === alice)!;
    const b = rows.find((r) => r.userId === bob)!;

    expect(a.generations).toBe(2);
    expect(a.tokensIn).toBe(15_000);
    expect(a.tokensOut).toBe(3_000);
    // 15,000 in at $0.15/M + 3,000 out at $0.60/M = 2,250 + 1,800 micros.
    expect(a.costMicros).toBe(4_050);

    // Bob's much smaller usage must not have absorbed any of Alice's — the failure mode of a
    // GROUP BY that loses its key.
    expect(b.generations).toBe(1);
    expect(b.costMicros).toBe(costMicrosFor(PAID, 1_000, 100));
    expect(b.costMicros).toBeLessThan(a.costMicros);
  });

  it("counts free/paid as generations but NOT cache or demo", async () => {
    const userId = await createTestUser();
    await generation(userId, FREE, "free", 1_000, 500);
    await recordLedger(userId, {
      operation: "quick_notes",
      tier: "cache",
      outcome: "ok",
      tokensIn: 0,
      tokensOut: 0,
      costMicros: 0,
    });
    await recordLedger(userId, {
      operation: "quick_notes",
      tier: "demo",
      outcome: "demo",
      costMicros: 0,
    });

    const row = (await usageByUser(30)).find((r) => r.userId === userId)!;
    /**
     * A cache hit is the system WORKING (docs/05 W4 step 8 — the highest-value line in the
     * system). Counting it as a generation would make the dedupe cache look like usage instead of
     * savings, and the cache-hit rate beside it would be measuring against an inflated total.
     */
    expect(row.generations, "cache or demo rows were counted as generations").toBe(1);
  });

  it("keeps unpriced rows OUT of the cost total and counts them separately", async () => {
    const userId = await createTestUser();
    await generation(userId, PAID, "paid", 1_000, 1_000); // priced
    await generation(userId, UNPRICED, "paid", 500_000, 500_000); // huge, but unpriceable

    const row = (await usageByUser(30)).find((r) => r.userId === userId)!;

    expect(row.unpricedRows).toBe(1);
    // The total reflects ONLY the priced row. This is the honest behaviour: silently pricing the
    // unknown model at zero would under-report by a factor of 500 here with nothing looking wrong.
    expect(row.costMicros).toBe(costMicrosFor(PAID, 1_000, 1_000));
    expect(row.tokensIn).toBe(501_000); // tokens are still counted — only the COST is unknown
  });
});

describe("rates the operator actually watches", () => {
  it("tierBreakdown gives the denominators for cache-hit and demo rates", async () => {
    const userId = await createTestUser();
    await generation(userId, FREE, "free", 100, 100);
    await recordLedger(userId, { operation: "quick_notes", tier: "cache", outcome: "ok", costMicros: 0 });
    await recordLedger(userId, { operation: "quick_notes", tier: "cache", outcome: "ok", costMicros: 0 });

    const byTier = new Map((await tierBreakdown(30)).map((t) => [t.tier, t.rows]));
    expect((byTier.get("cache") ?? 0)).toBeGreaterThanOrEqual(2);
    expect((byTier.get("free") ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("outcomeBreakdown covers every LedgerOutcome, including the rare ones", async () => {
    const userId = await createTestUser();
    for (const outcome of ["ok", "retried", "fallback", "demo", "failed"] as const) {
      await recordLedger(userId, {
        operation: "quick_notes",
        tier: outcome === "demo" || outcome === "failed" ? "demo" : "free",
        outcome,
        costMicros: 0,
      });
    }
    const seen = new Set((await outcomeBreakdown(30)).map((o) => o.outcome));
    // `retried` is the one that had NO coverage anywhere until Phase 3's AC6 — an outcome the
    // dashboard cannot show is an outcome nobody will ever investigate.
    for (const outcome of ["ok", "retried", "fallback", "demo", "failed"]) {
      expect(seen.has(outcome), `${outcome} is missing from the breakdown`).toBe(true);
    }
  });
});

describe("dailySpend", () => {
  it("buckets by day and sums only priced rows", async () => {
    const userId = await createTestUser();
    await generation(userId, PAID, "paid", 2_000, 500);
    await generation(userId, UNPRICED, "paid", 9_000, 9_000);

    const today = new Date().toISOString().slice(0, 10);
    const row = (await dailySpend(30)).find((d) => d.day === today)!;

    expect(row, "no bucket for today").toBeDefined();
    expect(row.generations).toBeGreaterThanOrEqual(2);
    expect(row.unpricedRows).toBeGreaterThanOrEqual(1);
    expect(row.costMicros).toBeGreaterThanOrEqual(costMicrosFor(PAID, 2_000, 500)!);
  });
});

describe("usageByModel", () => {
  it("flags an unpriced model rather than reporting it as free", async () => {
    const userId = await createTestUser();
    await generation(userId, UNPRICED, "paid", 1_000, 1_000);
    await generation(userId, PAID, "paid", 1_000, 1_000);

    const rows = await usageByModel(30);
    const unpriced = rows.find((m) => m.modelId === UNPRICED)!;
    const priced = rows.find((m) => m.modelId === PAID)!;

    /**
     * The operational point of this panel. An unpriced model is real spend the totals elsewhere on
     * the page exclude — if it rendered as `$0.00` it would be indistinguishable from a free model
     * and nobody would ever add it to the price table.
     */
    expect(unpriced.priced).toBe(false);
    expect(priced.priced).toBe(true);
    expect(priced.costMicros).toBeGreaterThan(0);
  });
});

describe("quotaUsedToday", () => {
  /**
   * Reads `usage_counters` — the table quota enforcement actually writes — rather than recomputing
   * from the ledger. If the dashboard recomputed, it could disagree with the counter that decides
   * whether a user is blocked, and then the page would be confidently wrong about the one thing a
   * user would contact you about.
   */
  it("reports the counter that enforcement itself uses", async () => {
    const { consumeQuota } = await import("@/lib/quota");
    const { dayKey } = await import("@/lib/quota");
    const userId = await createTestUser();

    await consumeQuota(userId);
    await consumeQuota(userId);

    const row = (await quotaUsedToday(dayKey())).find((q) => q.userId === userId);
    expect(row?.generations).toBe(2);
  });

  it("a user who has generated nothing today has no row, rather than someone else's count", async () => {
    const { dayKey } = await import("@/lib/quota");
    const fresh = await createTestUser();
    const rows = await quotaUsedToday(dayKey());
    expect(rows.find((q) => q.userId === fresh)).toBeUndefined();
  });
});

describe("NEGATIVE CONTROL — the aggregates would notice a zero-cost regression", () => {
  /**
   * The defect that prompted this whole module: every row priced at zero. Reconstructed here by
   * writing rows the OLD way — no `costMicros` — and confirming they land as unpriced rather than
   * silently summing to a plausible-looking zero.
   *
   * Before the fix, `recordLedger` defaulted `costMicros` to `0`, so these rows would have been
   * indistinguishable from genuinely free ones and this test would pass with `unpricedRows: 0`.
   */
  it("a ledger row written without a cost is unpriced, not free", async () => {
    const userId = await createTestUser();
    await recordLedger(userId, {
      operation: "quick_notes",
      modelId: PAID,
      tier: "paid",
      tokensIn: 10_000,
      tokensOut: 10_000,
      outcome: "ok",
      // costMicros deliberately omitted — the pre-fix shape of every write in the codebase.
    });

    const row = (await usageByUser(30)).find((r) => r.userId === userId)!;
    expect(
      row.unpricedRows,
      "a row with no cost was recorded as costing zero — the original silent-zero defect",
    ).toBe(1);
    expect(row.costMicros).toBe(0); // excluded from the total, and flagged above
  });
});

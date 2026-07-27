import { desc, eq } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { usageLedger } from "../schema";

/**
 * usage_ledger writes — the append-only record of every model call (docs/03). It carries a
 * userId, so it lives in the userId-first query layer (AGENTS.md rule 2): `recordLedger` takes
 * `userId` first. This is how quotas, cost visibility and abuse detection all work.
 */

export type LedgerTier = "cache" | "free" | "paid" | "demo";
export type LedgerOutcome =
  | "ok"
  | "retried"
  | "fallback"
  | "demo"
  | "failed";

export type LedgerEntry = {
  operation: string;
  modelId?: string | null;
  tier: LedgerTier;
  tokensIn?: number;
  tokensOut?: number;
  costMicros?: number | null;
  latencyMs?: number | null;
  outcome: LedgerOutcome;
};

export async function recordLedger(
  userId: string,
  entry: LedgerEntry,
): Promise<void> {
  await withDbRetry(async () => {
    await db.insert(usageLedger).values({
      userId,
      operation: entry.operation,
      modelId: entry.modelId ?? null,
      tier: entry.tier,
      tokensIn: entry.tokensIn ?? 0,
      tokensOut: entry.tokensOut ?? 0,
      costMicros: entry.costMicros ?? 0,
      latencyMs: entry.latencyMs ?? null,
      outcome: entry.outcome,
    });
  });
}

export type LedgerRow = typeof usageLedger.$inferSelect;

/** Read a user's ledger rows, newest first (tests + the Phase 7 usage dashboard). */
export async function readLedger(userId: string): Promise<LedgerRow[]> {
  return withDbRetry(async () =>
    db
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.userId, userId))
      .orderBy(desc(usageLedger.createdAt)),
  );
}

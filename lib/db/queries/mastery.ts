import { and, eq, exists, sql } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { concepts, graphs, mastery } from "../schema";

/**
 * Per-user concept progress (W6, docs/05). No model calls — this path must never fail or show a
 * busy state.
 *
 * `mastery` DOES carry a `userId` (it is keyed `(userId, conceptId)`), so reads are directly
 * scoped. The subtle case is the WRITE: the primary key alone would happily accept a
 * `conceptId` belonging to someone else's graph. That leaks nothing by itself — the row lands
 * under the caller's own `userId` — but it lets a caller probe which concept uuids exist and
 * accumulate rows against another user's graph. So `upsertMastery` gates the write on the
 * concept resolving through a graph the caller owns, and reports whether anything was written.
 */

export type Mastery = typeof mastery.$inferSelect;

/** The prototype's three states; readiness scoring maps them 1 / 0.5 / 0 client-side (W6). */
export type MasteryState = "locked" | "learning" | "known";

/**
 * Upsert one concept's state. Returns false when the concept does not exist or belongs to
 * another user's graph, in which case NO row is written.
 *
 * The ownership check is part of the same statement (`INSERT … SELECT … WHERE EXISTS`) rather
 * than a read followed by a write: a separate check would be both an extra round trip and a
 * TOCTOU gap.
 */
export async function upsertMastery(
  userId: string,
  conceptId: string,
  state: MasteryState,
): Promise<boolean> {
  return withDbRetry(async () => {
    const source = db
      .select({
        userId: sql<string>`${userId}`.as("user_id"),
        conceptId: concepts.id,
        state: sql<string>`${state}`.as("state"),
        updatedAt: sql<Date>`now()`.as("updated_at"),
      })
      .from(concepts)
      .where(
        and(
          eq(concepts.id, conceptId),
          exists(
            db
              .select({ id: graphs.id })
              .from(graphs)
              .where(
                and(
                  eq(graphs.id, concepts.graphId),
                  eq(graphs.userId, userId),
                ),
              ),
          ),
        ),
      );

    const rows = await db
      .insert(mastery)
      .select(source)
      .onConflictDoUpdate({
        target: [mastery.userId, mastery.conceptId],
        set: { state, updatedAt: new Date() },
      })
      .returning({ conceptId: mastery.conceptId });

    return rows.length > 0;
  });
}

/** The caller's mastery rows for one graph. Empty when the graph is not theirs. */
export async function listMastery(
  userId: string,
  graphId: string,
): Promise<Mastery[]> {
  return withDbRetry(async () =>
    db
      .select({
        userId: mastery.userId,
        conceptId: mastery.conceptId,
        state: mastery.state,
        updatedAt: mastery.updatedAt,
      })
      .from(mastery)
      .innerJoin(concepts, eq(concepts.id, mastery.conceptId))
      .innerJoin(graphs, eq(graphs.id, concepts.graphId))
      .where(
        and(
          eq(mastery.userId, userId),
          eq(concepts.graphId, graphId),
          // Belt and braces: `mastery.userId` already scopes the read, but a graph the caller
          // does not own must return nothing even if a stale row somehow referenced it.
          eq(graphs.userId, userId),
        ),
      ),
  );
}

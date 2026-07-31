import { and, eq, exists } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { edges, graphs } from "../schema";

/**
 * Edge queries — the second JOIN-THROUGH case.
 *
 * Like `concepts`, the `edges` table has NO `userId` column (docs/03): the owner lives on the
 * graph. Rule 3 of .claude/rules/database.md is satisfied through an EXISTS subquery pinning
 * `graphs.id = edges.graph_id AND graphs.user_id = $userId`. Dropping it exposes another user's
 * prerequisite structure to a guessed graph uuid.
 *
 * Edges are written only by the transactional path in graphs.ts (`finishGraph`,
 * `cloneGraphByContentHash`).
 */

export type Edge = typeof edges.$inferSelect;

/** EXISTS(graph is this user's) — the isolation predicate. */
function ownedByUser(userId: string) {
  return exists(
    db
      .select({ id: graphs.id })
      .from(graphs)
      .where(and(eq(graphs.id, edges.graphId), eq(graphs.userId, userId))),
  );
}

/** A graph's prerequisite edges. Empty when the graph is not the caller's. */
export async function listEdges(
  userId: string,
  graphId: string,
): Promise<Edge[]> {
  return withDbRetry(async () =>
    db
      .select()
      .from(edges)
      .where(and(eq(edges.graphId, graphId), ownedByUser(userId))),
  );
}

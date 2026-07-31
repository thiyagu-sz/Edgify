import { and, asc, eq, exists } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { concepts, graphs } from "../schema";

/**
 * Concept queries — the JOIN-THROUGH case.
 *
 * `concepts` has NO `userId` column (docs/03): a concept belongs to a graph, and the graph
 * carries the owner. Rule 3 of .claude/rules/database.md ("every SELECT/UPDATE/DELETE includes
 * eq(table.userId, userId)") is therefore satisfied INDIRECTLY, through an EXISTS subquery on
 * `graphs` that pins both the graph link and `graphs.userId`:
 *
 *     exists(select 1 from graphs
 *            where graphs.id = concepts.graph_id and graphs.user_id = $userId)
 *
 * Dropping that subquery from any function here turns a guessed uuid into a read of another
 * user's coursework. That is not a theoretical claim: `isolation.integration.test.ts` runs the
 * unscoped form inline and asserts it DOES return the wrong user's row, so the isolation
 * assertions next to it can never pass vacuously.
 *
 * The transactional INSERT path lives in graphs.ts (`finishGraph`, `cloneGraphByContentHash`) —
 * see the note at the top of that file.
 */

export type Concept = typeof concepts.$inferSelect;

/** EXISTS(graph is this user's) — the isolation predicate every function below applies. */
function ownedByUser(userId: string) {
  return exists(
    db
      .select({ id: graphs.id })
      .from(graphs)
      .where(and(eq(graphs.id, concepts.graphId), eq(graphs.userId, userId))),
  );
}

/** A graph's concepts, in stable layout order. Empty when the graph is not the caller's. */
export async function listConcepts(
  userId: string,
  graphId: string,
): Promise<Concept[]> {
  return withDbRetry(async () =>
    db
      .select()
      .from(concepts)
      .where(and(eq(concepts.graphId, graphId), ownedByUser(userId)))
      // Layer-major, then left-to-right: the order the graph renders in.
      .orderBy(asc(concepts.layoutY), asc(concepts.layoutX), asc(concepts.slug)),
  );
}

/** Single concept by id, filtered on BOTH the id and the owning graph's user (rule 4). */
export async function getConcept(
  userId: string,
  conceptId: string,
): Promise<Concept | undefined> {
  return withDbRetry(async () => {
    const [row] = await db
      .select()
      .from(concepts)
      .where(and(eq(concepts.id, conceptId), ownedByUser(userId)))
      .limit(1);
    return row;
  });
}

/**
 * Persist a lazily-generated concept explanation (W5 step 4). Returns false when the concept is
 * missing or belongs to someone else, so an unowned uuid writes nothing.
 *
 * Only ever called with VALIDATED model output (AGENTS.md rule 5), and never with demo content —
 * `detailJson` is a row in the user's own workspace, so a curated sample written here would
 * misrepresent their document exactly as a demo graph would (docs/03 §graphs, docs/04 §2).
 */
export async function setConceptDetail(
  userId: string,
  conceptId: string,
  detailJson: unknown,
): Promise<boolean> {
  return withDbRetry(async () => {
    const rows = await db
      .update(concepts)
      .set({ detailJson, detailGeneratedAt: new Date() })
      .where(and(eq(concepts.id, conceptId), ownedByUser(userId)))
      .returning({ id: concepts.id });
    return rows.length > 0;
  });
}

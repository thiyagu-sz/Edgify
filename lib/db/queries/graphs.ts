import { and, asc, desc, eq } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { concepts, documents, edges, graphs } from "../schema";

/**
 * Knowledge-graph queries (W4, docs/05).
 *
 * AGENTS.md rule 2 / .claude/rules/database.md: there is no row-level security, so every
 * exported function takes `userId` FIRST and applies it. `graphs.userId` is denormalised on
 * purpose (docs/03) so a graph read needs no join.
 *
 * This module also owns the two COMPOSITE writes that touch `concepts` and `edges` inside a
 * transaction (`finishGraph`, `cloneGraphByContentHash`). They live here rather than in
 * concepts.ts/edges.ts because splitting them would mean exporting `tx`-taking helpers that do
 * not take `userId` first — which would hollow out the isolation coverage guard in
 * isolation.integration.test.ts. Reads and per-row updates for those tables stay in their own
 * modules.
 */

export type Graph = typeof graphs.$inferSelect;

/** `demo` is reserved for Phase 6's /demo route and is NEVER written by this path (docs/03). */
export type GraphStatus = "processing" | "ready" | "failed";

export type NewGraph = {
  documentId: string;
  title?: string | null;
  /**
   * The model we INTEND to use — `graphs.modelId` is NOT NULL and the row is created before the
   * ladder runs. `finishGraph` overwrites it with the model that actually answered, which may be
   * a different rung (docs/04 §1).
   */
  modelId: string;
  promptVersion: string;
};

/** A concept as the build produces it: model output, sanitised, with layout already computed. */
export type ConceptInput = {
  slug: string;
  name: string;
  difficulty: string;
  summary: string;
  estimatedMinutes: number;
  layoutX: number;
  layoutY: number;
  layoutW: number;
};

/** An edge in SLUG space. Ids are assigned at insert time and remapped here. */
export type EdgeInput = { prerequisite: string; dependent: string };

export async function createGraph(
  userId: string,
  input: NewGraph,
): Promise<Graph> {
  return withDbRetry(async () => {
    const [row] = await db
      .insert(graphs)
      .values({ userId, status: "processing", ...input })
      .returning();
    return row;
  });
}

export async function getGraph(
  userId: string,
  graphId: string,
): Promise<Graph | undefined> {
  return withDbRetry(async () =>
    db.query.graphs.findFirst({
      where: and(eq(graphs.id, graphId), eq(graphs.userId, userId)),
    }),
  );
}

/**
 * The caller's most recent graph, or undefined when they have none.
 *
 * `/graph` has no id in its path, so the workspace opens on the graph the user was last working
 * on — the same behaviour as the prototype, which keeps one graph in memory. Ordered by
 * `createdAt` descending, which the existing `graphs_user_created_idx` serves directly.
 *
 * Any status is eligible, deliberately: a `processing` graph is exactly the one whose build the
 * user is waiting for, and a `failed` one must still be reachable so they see the W4 message
 * rather than an empty workspace that looks like their upload vanished.
 */
export async function getLatestGraph(userId: string): Promise<Graph | undefined> {
  return withDbRetry(async () =>
    db.query.graphs.findFirst({
      where: eq(graphs.userId, userId),
      orderBy: desc(graphs.createdAt),
    }),
  );
}

/**
 * Complete a build: flip `processing` → `ready` and insert the concepts and edges, atomically.
 * Returns false when the graph is missing, not the caller's, or no longer `processing`.
 *
 * ORDER INSIDE THE TRANSACTION MATTERS. The conditional UPDATE runs FIRST and takes the row
 * lock, so a second concurrent build for the same graph blocks on it, then sees `ready`, matches
 * zero rows, and rolls back without inserting anything. Doing the inserts first would let the
 * loser collide on the `(graphId, slug)` unique constraint — or worse, half-write a second copy.
 *
 * What this closes and what it does not (decided 2026-07-30, docs/06 Phase 5):
 *  - CORRUPTION is fully closed. Two simultaneous builds can never produce duplicate concepts,
 *    duplicate edges, or a `ready` graph with a partial node set. A re-fire after the build has
 *    finished is a no-op, and cannot overwrite a finished graph.
 *  - SPEND has a bounded accepted window: at most ONE wasted model call, only when two builds for
 *    the same graph are genuinely simultaneous (both passed the route's `status === "processing"`
 *    pre-check before either committed). The loser discovers it lost only here, after its model
 *    call. Closing that too would need a `building` claim status, which docs/03 does not define —
 *    the four statuses there are exhaustive and `demo` is reserved. The waste is bounded by the
 *    per-user daily quota and the client fires the build once, so the window is accepted rather
 *    than papered over with a schema change.
 */
export async function finishGraph(
  userId: string,
  graphId: string,
  result: {
    title: string;
    modelId: string;
    concepts: ConceptInput[];
    edges: EdgeInput[];
  },
): Promise<boolean> {
  return withDbRetry(async () =>
    db.transaction(async (tx) => {
      const claimed = await tx
        .update(graphs)
        .set({
          status: "ready",
          title: result.title,
          modelId: result.modelId,
        })
        .where(
          and(
            eq(graphs.id, graphId),
            eq(graphs.userId, userId),
            eq(graphs.status, "processing"),
          ),
        )
        .returning({ id: graphs.id });

      if (claimed.length === 0) return false;

      await insertConceptsAndEdges(tx, graphId, result.concepts, result.edges);
      return true;
    }),
  );
}

/**
 * Mark a build failed (docs/05 W4). Conditional on `processing` for the same reason as
 * `finishGraph`: a late failure must never overwrite a graph that has since gone `ready`.
 *
 * `failureReason` is INTERNAL ONLY and is never returned to the user (docs/03) — the route maps
 * this state to the fixed W4 message.
 */
export async function failGraph(
  userId: string,
  graphId: string,
  failureReason: string,
): Promise<boolean> {
  return withDbRetry(async () => {
    const rows = await db
      .update(graphs)
      .set({ status: "failed", failureReason })
      .where(
        and(
          eq(graphs.id, graphId),
          eq(graphs.userId, userId),
          eq(graphs.status, "processing"),
        ),
      )
      .returning({ id: graphs.id });
    return rows.length > 0;
  });
}

/**
 * W4 step 8 — "the single highest-value line in the system". Ten students in one class upload one
 * lecture PDF; nine of them get an instant graph for zero tokens.
 *
 * THIS IS THE ONE FUNCTION IN `queries/` THAT READS ACROSS USERS, and that is deliberate. The
 * source lookup joins `documents` on `contentHash` and is NOT filtered by `userId`.
 *
 * Why that is sound — it is exactly the `generation_cache` argument in docs/03 ("Privacy note on
 * the shared cache"), applied to derived rows instead of a derived blob:
 *
 *  - What is shared is OUTPUT DERIVED FROM AN INPUT, addressed by the hash of that input. A caller
 *    can only reach a source graph by supplying a document that hashes identically, which means
 *    they already hold that document. Nothing is enumerable: there is no way to ask this function
 *    for "some graph" — only for the graph of a document you can already produce byte-for-byte.
 *  - Nothing owned by the source user is RETURNED. Every row this function writes — the graph, its
 *    concepts, its edges — is inserted under the CALLER's `userId`. The caller receives the id of
 *    their own new graph and never learns that a source existed, who owned it, or its id.
 *  - The caller's `mastery` starts empty, because mastery is keyed `(userId, conceptId)` and the
 *    concept ids here are freshly minted. Progress never leaks in either direction.
 *
 * It is therefore allowlisted in isolation.integration.test.ts under
 * CONTENT_ADDRESSED_ALLOWLIST rather than treated as a plain writer, and carries its own
 * BIDIRECTIONAL isolation case: the clone is invisible to the source user AND the source is
 * invisible to the caller.
 *
 * Returns the new graph id, or null when no `ready` graph exists for that hash yet.
 */
export async function cloneGraphByContentHash(
  userId: string,
  contentHash: string,
  documentId: string,
): Promise<string | null> {
  return withDbRetry(async () =>
    db.transaction(async (tx) => {
      // Oldest READY graph for this content, any owner. `processing` and `failed` sources carry
      // no concepts worth cloning; `demo` is never written by this path (docs/03).
      const [source] = await tx
        .select({
          id: graphs.id,
          title: graphs.title,
          modelId: graphs.modelId,
          promptVersion: graphs.promptVersion,
        })
        .from(graphs)
        .innerJoin(documents, eq(documents.id, graphs.documentId))
        .where(
          and(
            eq(documents.contentHash, contentHash),
            eq(graphs.status, "ready"),
          ),
        )
        .orderBy(asc(graphs.createdAt))
        .limit(1);

      if (!source) return null;

      const sourceConcepts = await tx
        .select()
        .from(concepts)
        .where(eq(concepts.graphId, source.id));

      // A `ready` graph with no concepts cannot exist through `finishGraph` (sanitizeGraph
      // enforces >= 3), but cloning zero nodes would hand the user an empty "ready" graph, which
      // is worse than falling through to a real build.
      if (sourceConcepts.length === 0) return null;

      const sourceEdges = await tx
        .select()
        .from(edges)
        .where(eq(edges.graphId, source.id));

      // Edges reference concept ids, and the clone mints new ones — remap through slugs.
      const idToSlug = new Map(sourceConcepts.map((c) => [c.id, c.slug]));

      const [clone] = await tx
        .insert(graphs)
        .values({
          userId,
          documentId,
          title: source.title,
          status: "ready",
          modelId: source.modelId,
          promptVersion: source.promptVersion,
        })
        .returning({ id: graphs.id });

      await insertConceptsAndEdges(
        tx,
        clone.id,
        sourceConcepts.map((c) => ({
          slug: c.slug,
          name: c.name,
          difficulty: c.difficulty ?? "Intermediate",
          summary: c.summary ?? "",
          estimatedMinutes: c.estimatedMinutes ?? 0,
          layoutX: c.layoutX ?? 0,
          layoutY: c.layoutY ?? 0,
          layoutW: c.layoutW ?? 0,
          // detailJson is deliberately NOT copied: it is generated lazily per user (W5) and
          // starts null, exactly as it would after a real build.
        })),
        sourceEdges.flatMap((e) => {
          const prerequisite = idToSlug.get(e.prerequisiteId);
          const dependent = idToSlug.get(e.dependentId);
          return prerequisite && dependent ? [{ prerequisite, dependent }] : [];
        }),
      );

      return clone.id;
    }),
  );
}

/**
 * Insert a graph's nodes and its edges, remapping slug-space edges onto the ids just assigned.
 * Transaction-scoped and module-private — see the note at the top of this file for why it is not
 * exported from concepts.ts/edges.ts.
 */
async function insertConceptsAndEdges(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  graphId: string,
  conceptRows: ConceptInput[],
  edgeRows: EdgeInput[],
): Promise<void> {
  if (conceptRows.length === 0) return;

  const inserted = await tx
    .insert(concepts)
    .values(conceptRows.map((c) => ({ graphId, ...c })))
    .returning({ id: concepts.id, slug: concepts.slug });

  const slugToId = new Map(inserted.map((row) => [row.slug, row.id]));

  const mapped = edgeRows.flatMap((edge) => {
    const prerequisiteId = slugToId.get(edge.prerequisite);
    const dependentId = slugToId.get(edge.dependent);
    // Dangling edges are already dropped by sanitizeGraph (docs/04 §3); this is the last guard
    // before a foreign key would reject the whole transaction.
    if (!prerequisiteId || !dependentId || prerequisiteId === dependentId) {
      return [];
    }
    return [{ graphId, prerequisiteId, dependentId }];
  });

  if (mapped.length > 0) {
    // The model can emit the same pair twice; the primary key would reject the batch.
    await tx.insert(edges).values(mapped).onConflictDoNothing();
  }
}

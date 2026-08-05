import { and, asc, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
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
 *  - SPEND used to have a bounded accepted window here — at most one wasted model call when two
 *    builds were genuinely simultaneous, the loser discovering it lost only at this point, after
 *    its model call. **CLOSED 2026-08-05 by `claimGraphBuild`**, which claims the row before the
 *    ladder runs, so the loser now returns without spending.
 *
 *    The old note said closing it would need a `building` claim status "which docs/03 does not
 *    define — the four statuses there are exhaustive". That was sound but incomplete: a nullable
 *    claim TIMESTAMP does the same work as a claim STATUS, and leaves the four statuses
 *    exhaustive because it is not one of them. The window was framed as a status problem because
 *    the guard in front of it was a status check.
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
 * Claim this graph's build before spending anything on it (docs/09 §1.6).
 *
 * WHAT THIS FIXES. The route's `status === "processing"` pre-check distinguishes FINISHED from
 * UNFINISHED, not LIVE from ABANDONED — and nothing in the schema recorded which a `processing`
 * row was. `createdAt` cannot answer it: the row is created at upload, before the client fires the
 * build, so an old `createdAt` says nothing about whether anything is still running.
 *
 * `buildStartedAt IS NULL` is the claim condition, so exactly ONE build can ever take a given row.
 * Two consequences:
 *
 *  - An abandoned row is never silently rebuilt. Reclaiming it would re-spend, which is the
 *    expensive consequence of `ZOMBIE-PROCESSING-ROW`; `reapAbandonedGraph` retires it instead.
 *  - IT ALSO CLOSES THE ACCEPTED SPEND WINDOW recorded on `finishGraph` below. Two genuinely
 *    simultaneous builds used to both pass the route's pre-check and both call the model, with the
 *    loser discovering it lost only afterwards. Now the loser fails its claim and returns BEFORE
 *    the model call. That window is closed without a `building` status, so docs/03's four statuses
 *    stay exhaustive.
 *
 * Returns false when the graph is missing, not the caller's, no longer `processing`, or already
 * claimed by another build.
 */
export async function claimGraphBuild(
  userId: string,
  graphId: string,
): Promise<boolean> {
  return withDbRetry(async () => {
    const rows = await db
      .update(graphs)
      .set({ buildStartedAt: new Date() })
      .where(
        and(
          eq(graphs.id, graphId),
          eq(graphs.userId, userId),
          eq(graphs.status, "processing"),
          isNull(graphs.buildStartedAt),
        ),
      )
      .returning({ id: graphs.id });
    return rows.length > 0;
  });
}

/**
 * Retire a build that was claimed and never finished — the backstop for the case the wall-clock
 * budget cannot cover, where the process itself is gone (crash, instance eviction, `kill -9`) and
 * so nothing ran to write `failed`.
 *
 * Without this the row stays `processing` FOREVER: the poll reports `processing` indefinitely, so
 * the never-fail promise (docs/04) becomes never-RESOLVE — a worse failure than an honest error,
 * because nothing surfaces it.
 *
 * `staleBefore` must sit ABOVE the wall-clock budget, or this races the very builds it backs up
 * and marks a legitimately slow one `failed` underneath itself. `buildStartedAt IS NOT NULL` is
 * required: a null claim means no build ever ran, which is a graph waiting to be built, not an
 * abandoned one — and reaping those would fail every upload whose client had not yet fired.
 *
 * Conditional on `processing` for the same reason as `failGraph`: this must never overwrite a
 * graph that has since gone `ready`.
 */
export async function reapAbandonedGraph(
  userId: string,
  graphId: string,
  staleBefore: Date,
): Promise<boolean> {
  return withDbRetry(async () => {
    const rows = await db
      .update(graphs)
      .set({ status: "failed", failureReason: "build abandoned — no result within the budget" })
      .where(
        and(
          eq(graphs.id, graphId),
          eq(graphs.userId, userId),
          eq(graphs.status, "processing"),
          isNotNull(graphs.buildStartedAt),
          lt(graphs.buildStartedAt, staleBefore),
        ),
      )
      .returning({ id: graphs.id });
    return rows.length > 0;
  });
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

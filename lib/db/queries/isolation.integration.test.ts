import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser } from "@/test/factories";
import { db } from "../client";
import {
  concepts as conceptsTable,
  edges as edgesTable,
  mastery as masteryTable,
} from "../schema";
import { getConcept, listConcepts, setConceptDetail } from "./concepts";
import {
  countUserDocuments,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
} from "./documents";
import { listEdges } from "./edges";
import {
  cloneGraphByContentHash,
  createGraph,
  failGraph,
  finishGraph,
  getGraph,
} from "./graphs";
import { readLedger, recordLedger } from "./ledger";
import { listMastery, upsertMastery } from "./mastery";
import { createNote, getNote, listNotes } from "./notes";

// `import.meta.glob` is a Vite/Vitest feature statically replaced at transform time (so it must
// be called by its full name). Type it here since the app tsconfig doesn't load vite/client.
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { eager: true },
    ): Record<string, Record<string, unknown>>;
  }
}

/**
 * Cross-user isolation — the bug class that turns a project into an incident (docs/03,
 * docs/09 §1.2). There is no row-level security, so this test IS the guarantee.
 *
 * Every case pairs a POSITIVE control (the owner can see/affect their row — proving the query
 * actually touches seeded data, so a green result is never vacuous) with the ISOLATION
 * assertion (the other user sees/affects nothing). The `coverage guard` fails if a new query
 * function is ever added without an isolation case — so "every function" stays true.
 *
 * A positive control proves the query touches seeded data. It does NOT prove the seeded data was
 * reachable by the wrong user in the first place, and that is the half that rots. The final
 * describe block ("isolation assertions are non-vacuous") closes it permanently by running the
 * UNSCOPED form of each query inline and asserting it leaks. See the note there.
 *
 * Confirmed by mutation during Phase 2 (`getDocument`, documents) and again in Phase 5
 * (`listConcepts`, the join-through case) — see docs/06 Phase 5 results for the captured output.
 */

let A: string;
let B: string;

beforeAll(async () => {
  A = await createTestUser();
  B = await createTestUser();
});

let seq = 0;
function seed(userId: string) {
  seq += 1;
  return createDocument(userId, {
    title: `doc-${seq}`,
    contentHash: `hash-${userId}-${seq}-${Math.random()}`,
    extractedText: "secret coursework",
  });
}

/** Three concepts (the sanitizeGraph minimum) in a chain a → b → c. */
const GRAPH_CONCEPTS = ["a", "b", "c"].map((slug, i) => ({
  slug,
  name: `Concept ${slug.toUpperCase()}`,
  difficulty: "Foundational",
  summary: `secret summary ${slug}`,
  estimatedMinutes: 120,
  layoutX: i * 170,
  layoutY: 20,
  layoutW: 146,
}));
const GRAPH_EDGES = [
  { prerequisite: "a", dependent: "b" },
  { prerequisite: "b", dependent: "c" },
];

/** A complete `ready` graph — document, graph row, concepts and edges — owned by `userId`. */
async function seedGraph(userId: string, contentHash = `hash-${randomUUID()}`) {
  const doc = await createDocument(userId, {
    title: "lecture",
    contentHash,
    extractedText: "secret coursework",
  });
  const graph = await createGraph(userId, {
    documentId: doc.id,
    title: "Draft",
    modelId: "model-intended",
    promptVersion: "v1",
  });
  const finished = await finishGraph(userId, graph.id, {
    title: "Machine learning",
    modelId: "model-actual",
    concepts: GRAPH_CONCEPTS,
    edges: GRAPH_EDGES,
  });
  expect(finished, "seedGraph failed to complete the graph").toBe(true);
  return { doc, graphId: graph.id, contentHash };
}

// module.fn names proven below — checked by the coverage guard.
const CASE_NAMES = [
  "documents.getDocument",
  "documents.listDocuments",
  "documents.countUserDocuments",
  "documents.deleteDocument",
  "ledger.readLedger",
  "notes.getNote",
  "notes.listNotes",
  "graphs.getGraph",
  "graphs.finishGraph",
  "graphs.failGraph",
  "concepts.listConcepts",
  "concepts.getConcept",
  "concepts.setConceptDetail",
  "edges.listEdges",
  "mastery.upsertMastery",
  "mastery.listMastery",
];
// Writers that only ever create rows under the caller's own userId — no cross-user read path.
const WRITER_ALLOWLIST = [
  "documents.createDocument",
  "ledger.recordLedger",
  "notes.createNote",
  "graphs.createGraph",
];
/**
 * Functions that read CONTENT-ADDRESSED rows across users by design — currently exactly one.
 *
 * `cloneGraphByContentHash` is W4 step 8, the classroom case: a second student uploading the
 * same lecture PDF gets an instant graph for zero tokens. Its source lookup is deliberately NOT
 * filtered by `userId`, so it cannot sit in WRITER_ALLOWLIST, and pretending otherwise would
 * hide the one cross-user read in the codebase behind a list that promises there are none.
 *
 * It is sound for the same reason `generation_cache` is (docs/03, "Privacy note on the shared
 * cache"): the only way to reach a source graph is to supply a document that hashes identically,
 * which means already holding it; nothing is enumerable; and every row written lands under the
 * CALLER's userId while nothing owned by the source user is returned.
 *
 * Anything added to this list needs the BIDIRECTIONAL case below — clone invisible to source AND
 * source invisible to caller — not the one-way check the other functions get.
 */
const CONTENT_ADDRESSED_ALLOWLIST = ["graphs.cloneGraphByContentHash"];

describe("cross-user isolation: documents", () => {
  it("getDocument: owner sees the row; the other user sees nothing", async () => {
    const doc = await seed(A);
    expect((await getDocument(A, doc.id))?.id).toBe(doc.id); // positive control
    expect(await getDocument(B, doc.id)).toBeUndefined(); // isolation
  });

  it("listDocuments: each user sees only their own rows", async () => {
    const docA = await seed(A);
    const docB = await seed(B);
    const idsA = (await listDocuments(A)).map((d) => d.id);
    const idsB = (await listDocuments(B)).map((d) => d.id);
    expect(idsA).toContain(docA.id);
    expect(idsA).not.toContain(docB.id);
    expect(idsB).toContain(docB.id);
    expect(idsB).not.toContain(docA.id);
  });

  it("countUserDocuments: counts only the caller's rows", async () => {
    const freshA = await createTestUser();
    const freshB = await createTestUser();
    await seed(freshA);
    await seed(freshA);
    await seed(freshB);
    expect(await countUserDocuments(freshA)).toBe(2);
    expect(await countUserDocuments(freshB)).toBe(1);
  });

  it("deleteDocument: the other user cannot delete the owner's row; the owner can", async () => {
    const doc = await seed(A);
    expect(await deleteDocument(B, doc.id)).toBe(false); // isolation: nothing deleted
    expect((await getDocument(A, doc.id))?.id).toBe(doc.id); // still there
    expect(await deleteDocument(A, doc.id)).toBe(true); // positive control
    expect(await getDocument(A, doc.id)).toBeUndefined();
  });

  it("readLedger: each user sees only their own ledger rows", async () => {
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    await recordLedger(ownerA, { operation: "quick_notes", tier: "free", outcome: "ok" });
    const rowsA = await readLedger(ownerA);
    const rowsB = await readLedger(ownerB);
    expect(rowsA.length).toBeGreaterThanOrEqual(1); // positive control
    expect(rowsA.every((r) => r.userId === ownerA)).toBe(true);
    expect(rowsB.some((r) => r.userId === ownerA)).toBe(false); // isolation
  });

  it("getNote: owner sees the note; the other user sees nothing", async () => {
    const note = await createNote(A, { format: "key_points", contentMd: "secret notes" });
    expect((await getNote(A, note.id))?.id).toBe(note.id); // positive control
    expect(await getNote(B, note.id)).toBeUndefined(); // isolation
  });

  it("listNotes: each user sees only their own notes", async () => {
    const noteA = await createNote(A, { format: "summary", contentMd: "A's notes" });
    const noteB = await createNote(B, { format: "summary", contentMd: "B's notes" });
    const idsA = (await listNotes(A)).map((n) => n.id);
    const idsB = (await listNotes(B)).map((n) => n.id);
    expect(idsA).toContain(noteA.id);
    expect(idsA).not.toContain(noteB.id);
    expect(idsB).toContain(noteB.id);
    expect(idsB).not.toContain(noteA.id);
  });

  it("coverage guard: every exported query function has an isolation case or is allowlisted", () => {
    // Auto-discovers every non-test module in lib/db/queries/, so a query added in a later
    // phase without an isolation case fails here.
    const modules = import.meta.glob(["./*.ts", "!./*.test.ts"], { eager: true });

    const exported: string[] = [];
    for (const [path, mod] of Object.entries(modules)) {
      const modName = path.replace(/^\.\//, "").replace(/\.ts$/, "");
      for (const [name, val] of Object.entries(mod)) {
        if (typeof val === "function") exported.push(`${modName}.${name}`);
      }
    }

    const covered = new Set([
      ...CASE_NAMES,
      ...WRITER_ALLOWLIST,
      ...CONTENT_ADDRESSED_ALLOWLIST,
    ]);
    const uncovered = exported.filter((n) => !covered.has(n));
    expect(
      uncovered,
      `Query functions with no isolation coverage — add a case in isolation.integration.test.ts:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * The graph tables are the JOIN-THROUGH case: `concepts` and `edges` carry no `userId` column, so
 * their isolation rests entirely on an EXISTS subquery against `graphs.userId`. That makes them
 * the most fragile isolation surface in the project — the predicate is easy to drop while
 * refactoring and nothing about the resulting query looks wrong.
 */
describe("cross-user isolation: graphs, concepts, edges", () => {
  it("getGraph: owner sees the graph; the other user sees nothing", async () => {
    const { graphId } = await seedGraph(A);
    expect((await getGraph(A, graphId))?.id).toBe(graphId); // positive control
    expect(await getGraph(B, graphId)).toBeUndefined(); // isolation
  });

  it("listConcepts: owner sees the nodes; the other user sees none", async () => {
    const { graphId } = await seedGraph(A);
    const mine = await listConcepts(A, graphId);
    expect(mine.map((c) => c.slug)).toEqual(["a", "b", "c"]); // positive control
    expect(await listConcepts(B, graphId)).toEqual([]); // isolation
  });

  it("getConcept: owner sees the node; the other user sees nothing", async () => {
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);
    expect((await getConcept(A, concept.id))?.id).toBe(concept.id); // positive control
    expect(await getConcept(B, concept.id)).toBeUndefined(); // isolation
  });

  it("setConceptDetail: the other user cannot write to the owner's node; the owner can", async () => {
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);

    expect(await setConceptDetail(B, concept.id, { definition: "injected" })).toBe(false);
    expect((await getConcept(A, concept.id))?.detailJson).toBeNull(); // nothing written

    expect(await setConceptDetail(A, concept.id, { definition: "mine" })).toBe(true);
    expect((await getConcept(A, concept.id))?.detailJson).toEqual({ definition: "mine" });
  });

  it("setConceptDetail: first commit wins — a second write is refused, not applied", async () => {
    /**
     * The write is conditional on `detailJson IS NULL`, in the same statement as the update, so
     * two concurrent requests cannot both succeed and the loser is TOLD it lost.
     *
     * That matters because the two results are not interchangeable: they are separate
     * generations, and the client caches whichever it is handed. A last-write-wins update would
     * leave two tabs — or two users of the same graph — permanently holding different
     * explanations of one concept, with no way to tell which is stored.
     *
     * The accepted cost is a bounded spend window: at most one wasted model call when a user
     * double-clicks fast enough that both requests pass the route's stored-detail check before
     * either commits. Recorded in docs/06 Phase 5 beside the graph-build window.
     */
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);

    expect(await setConceptDetail(A, concept.id, { definition: "first" })).toBe(true);
    expect(await setConceptDetail(A, concept.id, { definition: "second" })).toBe(false);
    expect((await getConcept(A, concept.id))?.detailJson).toEqual({ definition: "first" });
  });

  it("setConceptDetail: two concurrent writers produce exactly one winner", async () => {
    // The sequential case above cannot prove the rule — by the time the second statement runs the
    // first has committed, so Postgres never arbitrates two live writes. Issuing them together is
    // what exercises the row lock.
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);

    const results = await Promise.all([
      setConceptDetail(A, concept.id, { definition: "writer-1" }),
      setConceptDetail(A, concept.id, { definition: "writer-2" }),
      setConceptDetail(A, concept.id, { definition: "writer-3" }),
    ]);

    expect(results.filter(Boolean), "more than one writer committed").toHaveLength(1);
    const stored = (await getConcept(A, concept.id))?.detailJson as { definition: string };
    expect(["writer-1", "writer-2", "writer-3"]).toContain(stored.definition);
  });

  it("listEdges: owner sees the prerequisite structure; the other user sees none", async () => {
    const { graphId } = await seedGraph(A);
    expect(await listEdges(A, graphId)).toHaveLength(2); // positive control
    expect(await listEdges(B, graphId)).toEqual([]); // isolation
  });

  it("finishGraph: the other user cannot complete the owner's build", async () => {
    const doc = await seed(A);
    const graph = await createGraph(A, {
      documentId: doc.id,
      modelId: "m",
      promptVersion: "v1",
    });

    expect(
      await finishGraph(B, graph.id, {
        title: "hijacked",
        modelId: "m",
        concepts: GRAPH_CONCEPTS,
        edges: GRAPH_EDGES,
      }),
    ).toBe(false); // isolation
    expect((await getGraph(A, graph.id))?.status).toBe("processing"); // untouched
    expect(await listConcepts(A, graph.id)).toEqual([]); // no rows written

    expect(
      await finishGraph(A, graph.id, {
        title: "mine",
        modelId: "m",
        concepts: GRAPH_CONCEPTS,
        edges: GRAPH_EDGES,
      }),
    ).toBe(true); // positive control
  });

  it("failGraph: the other user cannot fail the owner's build", async () => {
    const doc = await seed(A);
    const graph = await createGraph(A, {
      documentId: doc.id,
      modelId: "m",
      promptVersion: "v1",
    });

    expect(await failGraph(B, graph.id, "injected")).toBe(false); // isolation
    expect((await getGraph(A, graph.id))?.status).toBe("processing");

    expect(await failGraph(A, graph.id, "real reason")).toBe(true); // positive control
    expect((await getGraph(A, graph.id))?.status).toBe("failed");
  });

  it("upsertMastery: a concept in another user's graph writes nothing", async () => {
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);

    // B is a real user with a real session — the uuid is the only thing they guessed.
    expect(await upsertMastery(B, concept.id, "known")).toBe(false); // isolation
    expect(await listMastery(B, graphId)).toEqual([]); // and nothing landed

    expect(await upsertMastery(A, concept.id, "known")).toBe(true); // positive control
  });

  it("listMastery: each user sees only their own progress", async () => {
    const ownerA = await createTestUser();
    const ownerB = await createTestUser();
    const graphA = await seedGraph(ownerA);
    const graphB = await seedGraph(ownerB);
    const [conceptA] = await listConcepts(ownerA, graphA.graphId);
    const [conceptB] = await listConcepts(ownerB, graphB.graphId);

    await upsertMastery(ownerA, conceptA.id, "learning");
    await upsertMastery(ownerB, conceptB.id, "known");

    const rowsA = await listMastery(ownerA, graphA.graphId);
    expect(rowsA).toHaveLength(1); // positive control
    expect(rowsA[0].state).toBe("learning");
    expect(await listMastery(ownerB, graphA.graphId)).toEqual([]); // isolation
    expect(await listMastery(ownerA, graphB.graphId)).toEqual([]); // isolation, other way
  });
});

/**
 * `cloneGraphByContentHash` — the one sanctioned cross-user read (see
 * CONTENT_ADDRESSED_ALLOWLIST above). It gets a BIDIRECTIONAL case because it is the only
 * function where rows derived from one user's upload end up in another user's workspace, so
 * checking one direction would leave the interesting half untested.
 */
describe("cross-user isolation: cloneGraphByContentHash", () => {
  it("clones under the caller, and neither user can see the other's graph", async () => {
    const source = await createTestUser();
    const caller = await createTestUser();
    const sharedHash = `shared-${randomUUID()}`;

    // The classroom case: `source` uploaded the lecture PDF first.
    const seeded = await seedGraph(source, sharedHash);

    // `caller` uploads the identical file, so their own document row exists first (the schema
    // requires it: graphs.documentId is NOT NULL — docs/05 W4 step ordering corrected).
    const callerDoc = await createDocument(caller, {
      title: "same lecture",
      contentHash: sharedHash,
      extractedText: "secret coursework",
    });

    const cloneId = await cloneGraphByContentHash(caller, sharedHash, callerDoc.id);
    expect(cloneId, "no clone produced for an identical document").not.toBeNull();
    if (!cloneId) return;

    // The clone is the CALLER's, complete, and points at the CALLER's document.
    const clone = await getGraph(caller, cloneId);
    expect(clone?.userId).toBe(caller);
    expect(clone?.documentId).toBe(callerDoc.id);
    expect(clone?.status).toBe("ready");
    expect((await listConcepts(caller, cloneId)).map((c) => c.slug)).toEqual(["a", "b", "c"]);
    expect(await listEdges(caller, cloneId)).toHaveLength(2);

    // Direction 1: the clone is invisible to the SOURCE user.
    expect(await getGraph(source, cloneId)).toBeUndefined();
    expect(await listConcepts(source, cloneId)).toEqual([]);
    expect(await listEdges(source, cloneId)).toEqual([]);

    // Direction 2: the source graph stays invisible to the CALLER. They received a copy, not
    // access — the clone must not become a back door to the rows it was copied from.
    expect(await getGraph(caller, seeded.graphId)).toBeUndefined();
    expect(await listConcepts(caller, seeded.graphId)).toEqual([]);
    expect(await listEdges(caller, seeded.graphId)).toEqual([]);

    // Fresh concept ids, so mastery cannot leak in either direction.
    const sourceIds = (await listConcepts(source, seeded.graphId)).map((c) => c.id);
    const cloneIds = (await listConcepts(caller, cloneId)).map((c) => c.id);
    expect(cloneIds.some((id) => sourceIds.includes(id))).toBe(false);

    // detailJson is per-user and starts null, exactly as after a real build (W5).
    expect((await listConcepts(caller, cloneId)).every((c) => c.detailJson === null)).toBe(true);
  });

  it("returns null when no ready graph shares the hash", async () => {
    const caller = await createTestUser();
    const doc = await seed(caller);
    expect(await cloneGraphByContentHash(caller, `absent-${randomUUID()}`, doc.id)).toBeNull();
  });

  it("ignores a source graph that is still processing or failed", async () => {
    const source = await createTestUser();
    const caller = await createTestUser();
    const sharedHash = `unfinished-${randomUUID()}`;

    const sourceDoc = await createDocument(source, {
      contentHash: sharedHash,
      extractedText: "secret coursework",
    });
    const graph = await createGraph(source, {
      documentId: sourceDoc.id,
      modelId: "m",
      promptVersion: "v1",
    });

    const callerDoc = await createDocument(caller, {
      contentHash: sharedHash,
      extractedText: "secret coursework",
    });
    // status = "processing": nothing to clone yet.
    expect(await cloneGraphByContentHash(caller, sharedHash, callerDoc.id)).toBeNull();

    await failGraph(source, graph.id, "extraction failed");
    // status = "failed": still nothing to clone.
    expect(await cloneGraphByContentHash(caller, sharedHash, callerDoc.id)).toBeNull();
  });
});

/**
 * ── The non-vacuity control. COMMITTED INFRASTRUCTURE, NOT A ONE-OFF DRILL. ──────────────────
 *
 * Every isolation assertion above is of the form "B sees nothing". That shape passes for two
 * very different reasons: because the query filters correctly, or because the seeded rows were
 * never reachable in the first place. A green suite proves the first only if the second is ruled
 * out — and on `concepts` and `edges` the second is exactly what a refactor breaks, because
 * those tables carry no `userId` and their isolation is one EXISTS subquery that looks optional.
 *
 * So the tests below carry the MUTATION with them: `listConceptsUnscoped` and `listEdgesUnscoped`
 * are `listConcepts`/`listEdges` with the `graphs.userId` predicate deleted — the precise edit a
 * careless refactor makes — and they assert the wrong-user read SUCCEEDS.
 *
 * If someone ever makes the real functions leak, these still pass. That is fine: their job is
 * different. They guarantee the rows are genuinely cross-visible without the predicate, so the
 * "B sees nothing" assertions next to them can never be vacuous. If one of THESE ever goes red,
 * the seeding changed and the whole isolation suite above has quietly stopped proving anything.
 */
describe("isolation assertions are non-vacuous: the unscoped query really does leak", () => {
  /** `listConcepts` with the ownership EXISTS removed. The bug, frozen in the test suite. */
  async function listConceptsUnscoped(_userId: string, graphId: string) {
    return db
      .select()
      .from(conceptsTable)
      .where(eq(conceptsTable.graphId, graphId));
  }

  /** `listEdges` with the ownership EXISTS removed. */
  async function listEdgesUnscoped(_userId: string, graphId: string) {
    return db.select().from(edgesTable).where(eq(edgesTable.graphId, graphId));
  }

  it("without the graphs.userId predicate, B reads A's concepts", async () => {
    const { graphId } = await seedGraph(A);

    const leaked = await listConceptsUnscoped(B, graphId);
    expect(
      leaked.map((c) => c.slug),
      "the unscoped query returned nothing — the isolation assertions above are now vacuous",
    ).toEqual(["a", "b", "c"]);
    expect(leaked.map((c) => c.summary)).toContain("secret summary a");

    // Same user, same graph id, same moment: only the predicate differs.
    expect(await listConcepts(B, graphId)).toEqual([]);
  });

  it("without the graphs.userId predicate, B reads A's edges", async () => {
    const { graphId } = await seedGraph(A);

    expect(
      await listEdgesUnscoped(B, graphId),
      "the unscoped query returned nothing — the isolation assertions above are now vacuous",
    ).toHaveLength(2);

    expect(await listEdges(B, graphId)).toEqual([]);
  });

  it("without the id+userId pair, B reads A's concept by a guessed uuid", async () => {
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);

    const [leaked] = await db
      .select()
      .from(conceptsTable)
      .where(eq(conceptsTable.id, concept.id));
    expect(
      leaked?.summary,
      "the unscoped lookup returned nothing — getConcept's isolation case is now vacuous",
    ).toBe("secret summary a");

    expect(await getConcept(B, concept.id)).toBeUndefined();
  });

  it("without the ownership gate, B's mastery write against A's concept lands", async () => {
    const { graphId } = await seedGraph(A);
    const [concept] = await listConcepts(A, graphId);
    const intruder = await createTestUser();

    // The unguarded upsert: PK is (userId, conceptId), so nothing stops this at the schema level.
    const written = await db
      .insert(masteryTable)
      .values({ userId: intruder, conceptId: concept.id, state: "known" })
      .returning({ conceptId: masteryTable.conceptId });
    expect(
      written,
      "the unguarded write was rejected — upsertMastery's isolation case is now vacuous",
    ).toHaveLength(1);

    // Clean up so the row cannot affect later assertions, then prove the guarded path refuses.
    await db
      .delete(masteryTable)
      .where(
        and(
          eq(masteryTable.userId, intruder),
          eq(masteryTable.conceptId, concept.id),
        ),
      );
    expect(await upsertMastery(intruder, concept.id, "known")).toBe(false);
    expect(await listMastery(intruder, graphId)).toEqual([]);
  });
});

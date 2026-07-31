import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestUser } from "@/test/factories";
import { listConcepts } from "@/lib/db/queries/concepts";
import { countUserDocuments, createDocument, getDocument } from "@/lib/db/queries/documents";
import { PARSE_MESSAGES } from "@/lib/parse";
import { encryptedPdf, scannedPdf } from "@/test/fixtures/pdf";
import { listEdges } from "@/lib/db/queries/edges";
import { createGraph, finishGraph, getGraph } from "@/lib/db/queries/graphs";
import { readLedger } from "@/lib/db/queries/ledger";
import { getRemaining } from "@/lib/quota";

/**
 * Phase 5 proofs 7 and 8, against the real database and the real routes.
 *
 * The model is the ONLY thing faked — through `runModel`, the seam the ladder already exposes for
 * exactly this (docs/06 Phase 3: "test the ladder by breaking things on purpose"). Everything
 * else is genuine: the routes, the query layer, the transaction, the ledger, the quota counter.
 */

/** Set per test: what the fake model returns, and how many times it was called. */
const model = vi.hoisted(() => ({
  calls: [] as { modelId: string; prompt: string }[],
  reply: null as unknown,
  /** When set, every call returns this in sequence (index clamped to the last entry). */
  replies: null as unknown[] | null,
}));

vi.mock("@/lib/ai/models", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/models")>("@/lib/ai/models");
  return {
    ...actual,
    realRunModel: async ({ modelId, prompt }: { modelId: string; prompt: string }) => {
      model.calls.push({ modelId, prompt });
      const data = model.replies
        ? model.replies[Math.min(model.calls.length - 1, model.replies.length - 1)]
        : model.reply;
      return { data, tokensIn: 10, tokensOut: 20 };
    },
  };
});

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        session.userId ? { user: { id: session.userId } } : null,
    },
  },
}));

const { POST: postDocuments } = await import("../documents/route");
const { POST: postBuild } = await import("./[id]/build/route");
const { GET: getGraphRoute } = await import("./[id]/route");

/** A valid structure the sanitiser accepts: 4 concepts, an acyclic chain. */
const GOOD_STRUCTURE = {
  title: "Machine learning",
  concepts: [
    { slug: "calc", name: "Calculus", difficulty: "Foundational", summary: "Rates of change." },
    { slug: "linalg", name: "Linear algebra", difficulty: "Foundational", summary: "Vectors." },
    { slug: "gd", name: "Gradient descent", difficulty: "Intermediate", summary: "Optimisation." },
    { slug: "nn", name: "Neural networks", difficulty: "Advanced", summary: "Layers." },
  ],
  edges: [
    { prerequisite: "calc", dependent: "gd" },
    { prerequisite: "linalg", dependent: "gd" },
    { prerequisite: "gd", dependent: "nn" },
  ],
};

function upload(text: string, filename = "lecture.txt"): Request {
  const form = new FormData();
  form.set("file", new File([text], filename, { type: "text/plain" }));
  return new Request("http://localhost/api/documents", { method: "POST", body: form });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Ledger rows that represent a real model call (not a cache hit or a failure record). */
function generationRows(rows: { tier: string | null; operation: string | null }[]) {
  return rows.filter(
    (r) => r.operation === "graph_structure" && (r.tier === "free" || r.tier === "paid"),
  );
}

/**
 * Long enough to be a real document, unique per test so hashes never collide across runs.
 * Trimmed, because `extractDocument` trims what it decodes — so `extractedText` round-trips
 * exactly and the survival assertion below compares like with like.
 */
const documentText = (marker: string) =>
  (`${marker}. ` + "Gradient descent follows the slope of the loss surface. ".repeat(20)).trim();

beforeEach(() => {
  model.calls.length = 0;
  model.reply = null;
  model.replies = null;
});

// ── Proof 7 — the classroom case ────────────────────────────────────────────
describe("proof 7: a second user uploading an identical file clones the graph", () => {
  it("clones for zero model calls, under their own userId, with a cache-tier ledger row and untouched quota", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const text = documentText(`shared-${randomUUID()}`);

    // Alice uploads and builds for real.
    session.userId = alice;
    model.reply = GOOD_STRUCTURE;
    const aliceUpload = await postDocuments(upload(text));
    const { graphId: aliceGraphId, status } = await aliceUpload.json();
    expect(status).toBe("processing");
    await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(aliceGraphId));
    expect((await getGraph(alice, aliceGraphId))?.status).toBe("ready");

    const callsAfterAlice = model.calls.length;
    expect(callsAfterAlice).toBeGreaterThan(0); // Alice really did spend a generation

    // ── Bob uploads the identical file ──
    session.userId = bob;
    const quotaBefore = await getRemaining(bob);

    const bobUpload = await postDocuments(upload(text, "same-lecture.txt"));
    const bobBody = await bobUpload.json();

    // Instant: ready on upload, no build request needed.
    expect(bobBody.status).toBe("ready");
    expect(bobBody.graphId).toBeTruthy();
    expect(bobBody.graphId).not.toBe(aliceGraphId);

    // 1. ZERO model calls.
    expect(
      model.calls.length,
      "the clone path called the model",
    ).toBe(callsAfterAlice);

    // 2. His own rows, under his own userId.
    const bobConcepts = await listConcepts(bob, bobBody.graphId);
    expect([...bobConcepts.map((c) => c.slug)].sort()).toEqual(
      ["calc", "gd", "linalg", "nn"], // sorted: the set, independent of render order
    );
    // `listConcepts` returns RENDER order — layer-major from the top, so the most advanced
    // concept comes first (layout puts foundational concepts at the bottom, at the largest Y).
    expect(bobConcepts.map((c) => c.slug)).toEqual(["nn", "gd", "calc", "linalg"]);
    expect(await listEdges(bob, bobBody.graphId)).toHaveLength(3);
    expect((await getGraph(bob, bobBody.graphId))?.userId).toBe(bob);
    // And invisible to Alice, whose upload they were derived from.
    expect(await getGraph(alice, bobBody.graphId)).toBeUndefined();
    expect(await listConcepts(alice, bobBody.graphId)).toEqual([]);

    // 3. Quota unchanged.
    const quotaAfter = await getRemaining(bob);
    expect(
      quotaAfter.remaining,
      "the clone consumed a generation from the daily allowance",
    ).toBe(quotaBefore.remaining);

    // 4. A ledger row with tier "cache" — the saving has to be visible on the cost dashboard.
    const bobLedger = await readLedger(bob);
    expect(bobLedger).toHaveLength(1);
    expect(bobLedger[0].operation).toBe("graph_structure");
    expect(bobLedger[0].tier).toBe("cache");
    expect(bobLedger[0].outcome).toBe("ok");
    expect(bobLedger[0].tokensIn).toBe(0);
    expect(bobLedger[0].tokensOut).toBe(0);

    // 5. No generation-tier row at all for Bob.
    expect(
      generationRows(bobLedger),
      "the clone was recorded as a paid or free generation",
    ).toEqual([]);

    // The graph reads back through the polled route exactly as a built one would.
    const read = await getGraphRoute(new Request("http://localhost/g"), ctx(bobBody.graphId));
    const readBody = await read.json();
    expect(readBody.status).toBe("ready");
    expect(readBody.concepts).toHaveLength(4);
    expect(readBody.edges).toContainEqual({ prerequisite: "gd", dependent: "nn" });
  });

  /**
   * THE NEGATIVE CONTROL for the assertions above.
   *
   * "Zero model calls", "quota unchanged" and "no generation-tier ledger row" are all assertions
   * that something did NOT happen — and `POST /api/documents` never consumes quota on any path,
   * so on its own "quota unchanged" is trivially true and proves nothing about the clone.
   *
   * This runs the SAME harness with DIFFERENT text, so no clone is available and the build path
   * is taken. Every counter the test above asserts stayed still must move here. If this ever goes
   * green in the same shape as the clone case, the proof above is measuring nothing.
   */
  it("negative control: with different text there is no clone, and a generation IS charged", async () => {
    const carol = await createTestUser();

    session.userId = carol;
    model.reply = GOOD_STRUCTURE;

    const quotaBefore = await getRemaining(carol);
    const uploaded = await postDocuments(upload(documentText(`unique-${randomUUID()}`)));
    const { graphId, status } = await uploaded.json();

    // Not cloned: it needs a build.
    expect(status, "an unrelated document was served from someone else's graph").toBe("processing");

    const callsBefore = model.calls.length;
    await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(graphId));

    // The model WAS called…
    expect(model.calls.length).toBeGreaterThan(callsBefore);
    // …quota DID move…
    const quotaAfter = await getRemaining(carol);
    expect(quotaAfter.remaining).toBe(quotaBefore.remaining - 1);
    // …and a free/paid ledger row exists, which the clone case asserted was absent.
    const rows = await readLedger(carol);
    expect(generationRows(rows).length).toBe(1);
    expect(rows.some((r) => r.tier === "cache")).toBe(false);
  });
});

// ── Proof 8 — the graph failure ladder ──────────────────────────────────────
describe("proof 8: an unusable structure walks the ladder to failed", () => {
  it("sub-3-concept output → one repair per rung → tier 6 → status failed with the W4 message", async () => {
    const dave = await createTestUser();
    session.userId = dave;

    // Two concepts: below the MIN_CONCEPTS floor, so docs/04 §3 says failed extraction, not a
    // small graph. Returned on every call, so the repair attempt fails too.
    model.reply = {
      title: "Too small",
      concepts: [
        { slug: "a", name: "A", difficulty: "Foundational", summary: "one" },
        { slug: "b", name: "B", difficulty: "Advanced", summary: "two" },
      ],
      edges: [{ prerequisite: "a", dependent: "b" }],
    };

    const uploaded = await postDocuments(upload(documentText(`fail-${randomUUID()}`)));
    const { graphId } = await uploaded.json();

    const response = await postBuild(
      new Request("http://localhost/build", { method: "POST" }),
      ctx(graphId),
    );
    const body = await response.json();

    // The ladder: 3 rungs (free, free fallback, paid) × (1 attempt + 1 repair) = 6 calls.
    // A malformed result is NOT retried within a rung — it repairs once, then moves on.
    expect(
      model.calls.length,
      "the repair/fallback pattern changed — expected one repair per rung across three rungs",
    ).toBe(6);
    expect(model.calls.filter((c) => /previous response was invalid/i.test(c.prompt))).toHaveLength(3);

    // No demo graph exists, so tier 5 collapses into tier 6 → failed.
    expect(body.status).toBe("failed");
    expect(body.message).toBe(
      "Couldn't map this document's structure. Quick Notes still works on it.",
    );
    expect((await getGraph(dave, graphId))?.status).toBe("failed");

    // The user never sees the internal cause.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/ladder|tier|concept|model|openrouter|stack|429|50\d/i);

    // No half-written graph.
    expect(await listConcepts(dave, graphId)).toEqual([]);
    expect(await listEdges(dave, graphId)).toEqual([]);
  });

  it("empty output fails the same way, rather than succeeding with nothing", async () => {
    const erin = await createTestUser();
    session.userId = erin;
    model.reply = { title: "", concepts: [], edges: [] };

    const uploaded = await postDocuments(upload(documentText(`empty-${randomUUID()}`)));
    const { graphId } = await uploaded.json();

    const body = await (
      await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(graphId))
    ).json();

    expect(body.status).toBe("failed");
    expect((await getGraph(erin, graphId))?.status).toBe("failed");
  });

  /**
   * The promise the W4 message makes: "Quick Notes still works on it." A failed graph must leave
   * the document — and its extracted text — completely intact, or that sentence is a lie.
   */
  it("the document and its extractedText survive a failed graph, so Quick Notes still works", async () => {
    const frank = await createTestUser();
    session.userId = frank;
    const text = documentText(`survives-${randomUUID()}`);
    model.reply = { title: "nope", concepts: [], edges: [] };

    const uploaded = await postDocuments(upload(text, "lecture-notes.txt"));
    const { graphId } = await uploaded.json();
    const graph = await getGraph(frank, graphId);

    await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(graphId));
    expect((await getGraph(frank, graphId))?.status).toBe("failed");

    // The document row is untouched.
    const document = await getDocument(frank, graph!.documentId);
    expect(document, "the document was removed when its graph failed").toBeDefined();
    expect(document?.extractedText).toBe(text);
    expect(document?.title).toBe("lecture-notes");
    expect(document?.charCount).toBe(text.length);

    // And it is genuinely usable as Quick Notes source material: the text is there, above the
    // 200-character floor the notes route enforces (docs/04 §4).
    expect(document!.extractedText!.trim().length).toBeGreaterThan(200);
  });

  it("a re-fire after failure is a no-op and cannot resurrect the graph", async () => {
    const gina = await createTestUser();
    session.userId = gina;
    model.reply = { title: "", concepts: [], edges: [] };

    const uploaded = await postDocuments(upload(documentText(`refire-${randomUUID()}`)));
    const { graphId } = await uploaded.json();
    await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(graphId));

    const callsAfterFirst = model.calls.length;
    model.reply = GOOD_STRUCTURE; // even if the model would now succeed

    const body = await (
      await postBuild(new Request("http://localhost/build", { method: "POST" }), ctx(graphId))
    ).json();

    expect(body.status).toBe("failed");
    expect(
      model.calls.length,
      "the idempotency pre-check let a re-fire spend another model call",
    ).toBe(callsAfterFirst);
  });
});

/**
 * The Phase 5 intake criteria, on the GRAPH upload route specifically.
 *
 * `/api/documents/extract` already proves these for W3, and both routes share
 * `readUploadedFile` + `extractDocument`. They are re-proven here because the criteria are about
 * the upload the USER performs, and W4 is a different route with a different consequence: a
 * failure here must leave no document row and no graph row behind, which the extract route —
 * being deliberately side-effect free — cannot demonstrate.
 */
describe("POST /api/documents: intake failures write nothing", () => {
  async function expectRejected(request: Request, expectedMessage: string) {
    const before = await countUserDocuments(session.userId);
    const body = await (await postDocuments(request)).json();

    expect(body.message).toBe(expectedMessage);
    expect(body.graphId, "a rejected upload still created a graph").toBeUndefined();
    expect(
      await countUserDocuments(session.userId),
      "a rejected upload still created a document row",
    ).toBe(before);
  }

  it("rejects an 11 MB declared upload", async () => {
    session.userId = await createTestUser();
    // Declared via Content-Length, so the gate answers before the body is read.
    const request = new Request("http://localhost/api/documents", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(11 * 1024 * 1024),
      },
      body: "ignored",
    });
    await expectRejected(request, PARSE_MESSAGES.too_large);
  });

  it("diagnoses a scanned PDF instead of building an empty graph", async () => {
    session.userId = await createTestUser();
    const form = new FormData();
    form.set("file", new File([scannedPdf(4)], "phone-photos.pdf", { type: "application/pdf" }));
    await expectRejected(
      new Request("http://localhost/api/documents", { method: "POST", body: form }),
      PARSE_MESSAGES.scanned,
    );
  });

  it("reports an encrypted PDF clearly, not as a crash", async () => {
    session.userId = await createTestUser();
    const form = new FormData();
    form.set("file", new File([encryptedPdf()], "protected.pdf", { type: "application/pdf" }));
    await expectRejected(
      new Request("http://localhost/api/documents", { method: "POST", body: form }),
      PARSE_MESSAGES.encrypted,
    );
  });

  it("refuses an unsupported type", async () => {
    session.userId = await createTestUser();
    const form = new FormData();
    form.set("file", new File(["x".repeat(500)], "deck.pptx", { type: "application/vnd.ms-powerpoint" }));
    await expectRejected(
      new Request("http://localhost/api/documents", { method: "POST", body: form }),
      PARSE_MESSAGES.unsupported_type,
    );
  });

  it("never spends a model call on a rejected upload", async () => {
    session.userId = await createTestUser();
    const form = new FormData();
    form.set("file", new File([scannedPdf(3)], "scan.pdf", { type: "application/pdf" }));
    await postDocuments(new Request("http://localhost/api/documents", { method: "POST", body: form }));
    expect(model.calls).toEqual([]);
  });
});

// ── Ownership on the build and read routes ──────────────────────────────────
describe("graph routes: ownership", () => {
  it("another user cannot build or read someone else's graph", async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();

    const doc = await createDocument(owner, {
      contentHash: `own-${randomUUID()}`,
      extractedText: documentText("owned"),
    });
    const graph = await createGraph(owner, {
      documentId: doc.id,
      modelId: "m",
      promptVersion: "v1",
    });

    session.userId = intruder;
    const build = await postBuild(
      new Request("http://localhost/build", { method: "POST" }),
      ctx(graph.id),
    );
    expect(build.status).toBe(404);
    expect(model.calls).toEqual([]); // and it cost nothing

    const read = await getGraphRoute(new Request("http://localhost/g"), ctx(graph.id));
    expect(read.status).toBe(404);

    // The owner's graph is untouched.
    expect((await getGraph(owner, graph.id))?.status).toBe("processing");
  });

  it("never returns failureReason to the client", async () => {
    const owner = await createTestUser();
    const doc = await createDocument(owner, {
      contentHash: `reason-${randomUUID()}`,
      extractedText: documentText("reason"),
    });
    const graph = await createGraph(owner, {
      documentId: doc.id,
      modelId: "m",
      promptVersion: "v1",
    });
    await finishGraph(owner, graph.id, {
      title: "t",
      modelId: "m",
      concepts: GOOD_STRUCTURE.concepts.map((c, i) => ({
        ...c,
        estimatedMinutes: 120,
        layoutX: i * 170,
        layoutY: 20,
        layoutW: 146,
      })),
      edges: GOOD_STRUCTURE.edges,
    });

    session.userId = owner;
    const body = await (
      await getGraphRoute(new Request("http://localhost/g"), ctx(graph.id))
    ).json();

    expect(body.status).toBe("ready");
    expect(JSON.stringify(body)).not.toMatch(/failureReason|failure_reason/i);
  });
});

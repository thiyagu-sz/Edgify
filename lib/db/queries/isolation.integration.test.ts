import { beforeAll, describe, expect, it } from "vitest";
import { createTestUser } from "@/test/factories";
import {
  countUserDocuments,
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
} from "./documents";
import { readLedger, recordLedger } from "./ledger";
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
 * assertion (the other user sees/affects nothing). The final `coverage guard` fails if a new
 * query function is ever added without an isolation case — so "every function" stays true.
 *
 * To confirm the harness has teeth, remove the `eq(documents.userId, userId)` predicate from
 * `getDocument` and re-run: the isolation assertion goes red. (Demonstrated during Phase 2
 * verification, not committed.)
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

// module.fn names proven below — checked by the coverage guard.
const CASE_NAMES = [
  "documents.getDocument",
  "documents.listDocuments",
  "documents.countUserDocuments",
  "documents.deleteDocument",
  "ledger.readLedger",
  "notes.getNote",
  "notes.listNotes",
];
// Writers that only ever create rows under the caller's own userId — no cross-user read path.
const WRITER_ALLOWLIST = [
  "documents.createDocument",
  "ledger.recordLedger",
  "notes.createNote",
];

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

  it("coverage guard: every exported query function has an isolation case or is an allowlisted writer", () => {
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

    const covered = new Set([...CASE_NAMES, ...WRITER_ALLOWLIST]);
    const uncovered = exported.filter((n) => !covered.has(n));
    expect(
      uncovered,
      `Query functions with no isolation coverage — add a case in isolation.integration.test.ts:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });
});

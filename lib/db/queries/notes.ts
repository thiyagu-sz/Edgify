import { and, desc, eq } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { notes } from "../schema";

/**
 * Quick Notes persistence (W2 step 10, docs/05).
 *
 * AGENTS.md rule 2 / .claude/rules/database.md: no row-level security, so every exported
 * function takes `userId` FIRST and filters on it. Persisting a note is best-effort from the
 * caller's point of view — a failed write must never surface to the user (docs/04 §7) — but the
 * write itself still goes through the userId-scoped query layer, never a raw query in the route.
 */

export type Note = typeof notes.$inferSelect;

/** Fields a caller supplies when saving a note. `userId` is passed separately. */
export type NewNote = {
  /** Null when the user pasted text directly (the Phase 4 path); set once uploads land in Phase 5. */
  documentId?: string | null;
  format: string;
  /** Markdown for prose formats; a serialised payload for quiz formats. */
  contentMd?: string | null;
  modelId?: string | null;
  promptVersion?: string | null;
};

export async function createNote(userId: string, input: NewNote): Promise<Note> {
  return withDbRetry(async () => {
    const [row] = await db
      .insert(notes)
      .values({ userId, ...input })
      .returning();
    return row;
  });
}

/** A user's notes, newest first (their own rows only). */
export async function listNotes(userId: string): Promise<Note[]> {
  return withDbRetry(async () =>
    db
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(desc(notes.createdAt)),
  );
}

export async function getNote(userId: string, noteId: string): Promise<Note | undefined> {
  return withDbRetry(async () =>
    db.query.notes.findFirst({
      where: and(eq(notes.id, noteId), eq(notes.userId, userId)),
    }),
  );
}

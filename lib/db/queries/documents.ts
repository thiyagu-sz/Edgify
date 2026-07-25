import { and, count, desc, eq } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { documents } from "../schema";

/**
 * Document queries.
 *
 * AGENTS.md rule 2 / .claude/rules/database.md: there is no row-level security, so tenant
 * isolation is application code. Every exported function in this directory takes `userId` as
 * its FIRST parameter and applies it in the WHERE clause. Single-row lookups filter on BOTH
 * the id and the `userId`, so a guessed uuid can never read or delete another user's row.
 *
 * The cross-user isolation guarantee for every function here is proven in
 * `lib/db/queries/isolation.test.ts`.
 */

/** A persisted document row. */
export type Document = typeof documents.$inferSelect;

/** Fields a caller supplies when creating a document. `userId` is passed separately. */
export type NewDocument = {
  title?: string | null;
  contentHash: string;
  charCount?: number | null;
  pageCount?: number | null;
  sourceType?: string | null;
  extractedText?: string | null;
};

export async function countUserDocuments(userId: string): Promise<number> {
  return withDbRetry(async () => {
    const [row] = await db
      .select({ value: count() })
      .from(documents)
      .where(eq(documents.userId, userId));
    return row?.value ?? 0;
  });
}

export async function createDocument(
  userId: string,
  input: NewDocument,
): Promise<Document> {
  return withDbRetry(async () => {
    const [row] = await db
      .insert(documents)
      .values({ userId, ...input })
      .returning();
    return row;
  });
}

export async function getDocument(
  userId: string,
  documentId: string,
): Promise<Document | undefined> {
  return withDbRetry(async () =>
    db.query.documents.findFirst({
      where: and(eq(documents.id, documentId), eq(documents.userId, userId)),
    }),
  );
}

export async function listDocuments(userId: string): Promise<Document[]> {
  return withDbRetry(async () =>
    db
      .select()
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.createdAt)),
  );
}

/** Deletes the document if it belongs to `userId`. Returns whether a row was removed. */
export async function deleteDocument(
  userId: string,
  documentId: string,
): Promise<boolean> {
  return withDbRetry(async () => {
    const deleted = await db
      .delete(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
      .returning({ id: documents.id });
    return deleted.length > 0;
  });
}

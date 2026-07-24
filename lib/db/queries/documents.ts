import { count, eq } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { documents } from "../schema";

/**
 * Document queries.
 *
 * AGENTS.md rule 2: there is no row-level security, so tenant isolation is application code.
 * Every exported function in this directory takes `userId` as its FIRST parameter and applies
 * it in the WHERE clause. Single-row lookups filter on both the id and the `userId`.
 */
export async function countUserDocuments(userId: string): Promise<number> {
  return withDbRetry(async () => {
    const [row] = await db
      .select({ value: count() })
      .from(documents)
      .where(eq(documents.userId, userId));
    return row?.value ?? 0;
  });
}

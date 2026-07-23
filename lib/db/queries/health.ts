import { count, eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "../client";
import { documents } from "../schema";

/**
 * Infrastructure connectivity check (not user data). Wrapped in withDbRetry so it survives a
 * Neon cold start — this is what proves the Phase 1 "query works after Neon idled" criterion.
 */
export async function pingDatabase(): Promise<boolean> {
  return withDbRetry(async () => {
    const result = await db.execute(sql`select 1 as ok`);
    return result.rows.length > 0;
  });
}

/**
 * Example tenant-scoped query. Per docs/03-data-model.md every query function takes `userId`
 * first and filters on it — there is no row-level security, so isolation is our code's job.
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

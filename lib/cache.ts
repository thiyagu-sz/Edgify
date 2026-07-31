import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, withDbRetry } from "./db/client";
import { generationCache } from "./db/schema";

/**
 * Content-addressed generation cache — "what keeps the system affordable" (docs/03). Deliberately
 * NOT user-scoped: two students uploading the same lecture PDF share the entry (the exact
 * classroom scenario the cache exists for). Never expose `cacheKey` in an API response.
 *
 * This module is the one sanctioned place for non-tenant DB access outside lib/db/queries/ — the
 * architecture guard allowlists it.
 */

/**
 * Normalise text before hashing so the *same* document always produces the *same* key.
 * Inconsistent whitespace silently defeats deduplication and is invisible until you check
 * (docs/09 §3.4).
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `sha256(normalisedText : format : promptVersion)`. Keyed on the *logical* generation, not the
 * model that produced it, so the free→paid fallback ladder and two identical uploads all share
 * one entry (reconciles docs/03; the cache table stores no model id). A PROMPT_VERSION bump
 * changes the key and thus invalidates old entries.
 */
export function cacheKey(
  text: string,
  format: string,
  promptVersion: string,
): string {
  return createHash("sha256")
    .update(`${normalizeText(text)}\n${format}\n${promptVersion}`)
    .digest("hex");
}

/**
 * `sha256(normalisedText)` — the `documents.contentHash` (docs/03), and the key W4 step 8 dedupes
 * on so a second student uploading the same lecture PDF clones an existing graph for zero tokens.
 *
 * Shares `normalizeText` with `cacheKey` deliberately: if the two normalisations ever diverged,
 * the cache and the clone path would disagree about what "the same document" means, and the
 * classroom case would half-work in a way nothing would report.
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeText(text)).digest("hex");
}

/** Return the cached payload and bump hit stats, or null on a miss. */
export async function getCached(key: string): Promise<unknown | null> {
  return withDbRetry(async () => {
    const rows = await db
      .update(generationCache)
      .set({
        hitCount: sql`${generationCache.hitCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(generationCache.cacheKey, key))
      .returning({ resultJson: generationCache.resultJson });
    return rows.length > 0 ? rows[0].resultJson : null;
  });
}

/**
 * Store a result. Uses ON CONFLICT DO NOTHING: two users generating the same content race on the
 * same key, and without this one of them errors on the duplicate (.claude/rules/database.md).
 */
export async function setCached(key: string, result: unknown): Promise<void> {
  await withDbRetry(async () => {
    await db
      .insert(generationCache)
      .values({ cacheKey: key, resultJson: result })
      .onConflictDoNothing();
  });
}

import { getPool } from "@/lib/db/client";

/**
 * Count the SQL statements a block of code actually issues.
 *
 * docs/06 Phase 2 requires the rate-limit round-trip check to "assert the query count, not the
 * wall-clock time, so the check does not depend on network distance". A timing assertion against
 * a container on localhost proves nothing about a remote Neon instance where each round trip
 * costs ~275ms; counting statements measures the property that actually travels.
 *
 * Drizzle's node-postgres driver issues every statement through `pool.query`, so patching that
 * one method captures all of them regardless of which query builder produced them.
 */
type PoolQuery = ReturnType<typeof getPool>["query"];

export async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; queries: string[] }> {
  const pool = getPool();
  const original = pool.query.bind(pool) as PoolQuery;
  const queries: string[] = [];

  pool.query = ((...args: Parameters<PoolQuery>) => {
    const first: unknown = args[0];
    queries.push(
      typeof first === "string"
        ? first
        : ((first as { text?: string })?.text ?? String(first)),
    );
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as PoolQuery;

  try {
    const result = await fn();
    return { result, queries };
  } finally {
    pool.query = original;
  }
}

/** How many of `queries` are statements of the given kind. Case- and whitespace-insensitive. */
export function countOf(queries: string[], kind: "insert" | "delete" | "select" | "update"): number {
  return queries.filter((q) => q.trim().toLowerCase().startsWith(kind)).length;
}

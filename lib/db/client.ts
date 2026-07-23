import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as appSchema from "./schema";
import * as authSchema from "./auth-schema";

/** Combined Drizzle schema: application tables + Better Auth tables. */
export const schema = { ...appSchema, ...authSchema };

/**
 * Postgres access for a long-lived Cloud Run container: a standard pooled `pg` connection
 * against Neon's POOLED connection string (not the serverless HTTP driver — see
 * docs/02-tech-stack.md).
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const url = env.DATABASE_URL;
    const useSsl = !/localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      max: 10,
      // Neon can take a few seconds to resume from suspend; allow for it.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return pool;
}

export const db = drizzle(getPool(), { schema });

/**
 * Neon suspends after ~5 minutes idle; the first query after a quiet period can fail or hang
 * while compute resumes. This retries CONNECTION-class errors only (never a genuine SQL error,
 * which would mask real bugs) with short, JITTERED backoff. Wrap every query function with it.
 * See docs/02-tech-stack.md — skipping this presents as random production failures.
 */
const RETRIABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now (server starting up)
  "XX000", // internal_error — Neon emits this during some resume races
]);

function isRetriableConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && RETRIABLE_CODES.has(code);
}

export async function withDbRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !isRetriableConnectionError(error)) {
        throw error;
      }
      // Jittered exponential backoff: ~150ms, ~300ms, … plus up to 150ms of random jitter,
      // so retries after a cold start do not thundering-herd.
      const backoffMs = 150 * 2 ** attempt + Math.random() * 150;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

import { sql } from "drizzle-orm";
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
      /**
       * VERIFY the server certificate. This is the user-data database; encryption without
       * authentication protects the bytes in flight but not who you are talking to.
       *
       * THE URL WINS, NOT THIS LINE. `pg` builds its config as
       * `Object.assign({}, config, parse(connectionString))`, so a `sslmode` in `DATABASE_URL`
       * overrides whatever is passed here; this option applies only when the URL carries no
       * `sslmode` at all. Measured against the live endpoint on 2026-08-04, not assumed:
       * `sslmode=verify-full` + a deliberately bogus `ca` still connected (the ca was discarded),
       * while the same bogus `ca` with no `sslmode` in the URL failed with
       * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
       *
       * So this read `rejectUnauthorized: false` until 2026-08-04 without weakening anything —
       * `sslmode=require` was present and, in pg 8.x, means verify-full. It was a LATENT footgun
       * rather than a live hole: drop `sslmode` from the URL and the fallback would have silently
       * stopped verifying. Now the fallback is the safe one, and the URL says `verify-full`
       * explicitly so a future pg major (which weakens `require` to libpq semantics) cannot
       * downgrade it either.
       *
       * Neon's certificates are publicly trusted, so no CA bundle is needed. Localhost — the
       * testcontainer suites — has no TLS at all, hence the branch.
       */
      ssl: useSsl ? { rejectUnauthorized: true } : false,
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

/**
 * Infrastructure connectivity check. Deliberately NOT in lib/db/queries/ — that directory is
 * reserved for tenant-scoped data access where every exported function takes `userId` first
 * (AGENTS.md rule 2). This touches no user data; it only proves the connection is alive, and
 * exercises the Neon cold-start retry.
 */
export async function pingDatabase(): Promise<boolean> {
  return withDbRetry(async () => {
    const result = await db.execute(sql`select 1 as ok`);
    return result.rows.length > 0;
  });
}

import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Handshake file between the integration `globalSetup` (which starts one Postgres container
 * and writes the connection string here) and the per-worker `setupFiles` (which reads it and
 * sets `DATABASE_URL` before `lib/db/client.ts` is imported and builds its pool).
 */
export const DB_URL_FILE = join(tmpdir(), "edgify-test-db-url");

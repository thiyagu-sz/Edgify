import { readFileSync } from "node:fs";
import { DB_URL_FILE } from "./db-url";
import { applyTestEnvDefaults } from "./test-env";

/**
 * Per-worker setup for integration tests. Runs BEFORE the test module (and therefore before
 * `lib/db/client.ts` builds its pool), so `DATABASE_URL` must be in place here. The container
 * URL is produced by `global-setup.ts`.
 */
const url = readFileSync(DB_URL_FILE, "utf8").trim();
if (!url) {
  throw new Error(
    "Integration DB URL is empty — is Docker running and did global-setup start?",
  );
}
process.env.DATABASE_URL = url;
applyTestEnvDefaults();

import { applyTestEnvDefaults } from "./test-env";

/**
 * Per-worker setup for UNIT tests (no database). Provides a syntactically valid `DATABASE_URL`
 * plus the other required env vars so modules that read `env` (e.g. `dayKey` via
 * `QUOTA_TIMEZONE`) validate cleanly. Nothing here ever opens a connection — unit tests do not
 * run queries.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/edgify_unit";
applyTestEnvDefaults();

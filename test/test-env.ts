/**
 * Dummy values for the required env vars that `lib/env.ts` validates at first access. Tests
 * that import `lib/db/client.ts` (or anything reaching `env`) trigger full validation; these
 * placeholders let that pass. They are never used to reach a real service — the DB tests point
 * `DATABASE_URL` at the throwaway container instead.
 */
export function applyTestEnvDefaults(): void {
  // NODE_ENV is already "test" under vitest and is typed read-only, so it is not set here.
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";
}

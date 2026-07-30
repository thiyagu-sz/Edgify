import { randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import pg from "pg";

/**
 * Mint a signed Better Auth session for the browser proofs.
 *
 * Quick Notes lives behind the protected route group, so every browser check needs a session —
 * but the only configured provider is Google, and that consent flow cannot be driven headlessly.
 * The standard way through is to seed the session the same way the server would and hand the
 * browser the cookie.
 *
 * This is TEST-ONLY and lives outside `app/` and `lib/` on purpose: there is no auth bypass in
 * the application itself, no test-only branch in a route handler, and nothing here ships. The
 * server validates this session exactly as it validates a real one — the only thing skipped is
 * Google's consent screen.
 *
 * The seeded user is a normal row, so the userId-scoped query layer applies to it unchanged;
 * these runs exercise the same isolation rules as any other user.
 *
 * Usage:  node test/e2e/seed-session.mjs            → prints JSON {cookieName, cookieValue, userId, email}
 *         node test/e2e/seed-session.mjs --cleanup  → removes previously seeded e2e users
 */

const E2E_EMAIL_DOMAIN = "e2e.edgify.invalid";

function readEnv() {
  const url = process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return { url, secret, baseUrl };
}

/**
 * Better Auth names the session cookie `better-auth.session_token`, prefixed with `__Secure-`
 * when the base URL is https. Local proof runs are http, so the plain name applies — but derive
 * it rather than hard-coding, so a run against a deployed https origin still works.
 */
function cookieNameFor(baseUrl) {
  return baseUrl.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
}

async function seed() {
  const { url, secret, baseUrl } = readEnv();
  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });

  try {
    const userId = `e2e-${randomUUID()}`;
    const email = `${userId}@${E2E_EMAIL_DOMAIN}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await pool.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, $2, $3, true, $4, $4)`,
      [userId, "E2E Proof Run", email, now],
    );

    // Better Auth's session token: random, opaque, stored verbatim and signed in the cookie.
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `insert into session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
       values ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [randomUUID(), expiresAt, token, now, "127.0.0.1", "playwright-proof-run", userId],
    );

    // The cookie carries `<token>.<hmac>`; the server recomputes the hmac and rejects a mismatch.
    const signature = await makeSignature(token, secret);
    const cookieValue = `${token}.${signature}`;

    return {
      cookieName: cookieNameFor(baseUrl),
      cookieValue,
      token,
      userId,
      email,
      baseUrl,
    };
  } finally {
    await pool.end();
  }
}

async function cleanup() {
  const { url } = readEnv();
  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
  try {
    // Sessions, notes and ledger rows cascade from the user row.
    const result = await pool.query(`delete from "user" where email like $1`, [
      `%@${E2E_EMAIL_DOMAIN}`,
    ]);
    return { deletedUsers: result.rowCount ?? 0 };
  } finally {
    await pool.end();
  }
}

const isCleanup = process.argv.includes("--cleanup");
const result = isCleanup ? await cleanup() : await seed();
console.log(JSON.stringify(result, null, 2));

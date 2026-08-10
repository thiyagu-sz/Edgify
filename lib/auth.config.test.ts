import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { MIN_PASSWORD_LENGTH } from "./auth-credentials";

/**
 * The authentication configuration, pinned.
 *
 * These are not tests of Better Auth — they are tests that OUR configuration still says what we
 * decided it should say. Every one of them corresponds to a decision that would be invisible if
 * it regressed: account linking is the security-critical one, and a future "make Google linking
 * just work" edit is exactly the change that would silently open the takeover path described in
 * lib/auth.ts.
 *
 * The database is faked because instantiating Better Auth otherwise opens a pool; nothing here
 * touches Postgres.
 */

vi.mock("./db/client", () => ({
  db: {},
  withDbRetry: async <T>(fn: () => Promise<T>) => fn(),
  getPool: vi.fn(),
  pingDatabase: vi.fn(),
  schema: {},
}));

const { auth } = await import("./auth");

/**
 * Widened deliberately. `auth.options` is inferred as the exact object literal passed to
 * `betterAuth`, so the keys these tests care about MOST — the account-linking ones — are not
 * even addressable on it, and `expect(...).not.toBe(false)` would not compile. Reading it as the
 * full option surface is what lets a future addition of `account.accountLinking` be caught.
 */
const options = auth.options as BetterAuthOptions;

describe("email/password", () => {
  it("is enabled", () => {
    expect(options.emailAndPassword?.enabled).toBe(true);
  });

  it("takes its minimum length from the one place the form also reads", () => {
    // Two hard-coded 8s drift; the form would then accept what the server rejects.
    expect(options.emailAndPassword?.minPasswordLength).toBe(MIN_PASSWORD_LENGTH);
  });

  it("signs the user in on sign-up, so a new account lands in the workspace", () => {
    expect(options.emailAndPassword?.autoSignIn).toBe(true);
  });

  it("does not require email verification, because nothing can send the email", () => {
    // If this ever flips to true without a mail provider, every new account is locked out.
    expect(options.emailAndPassword?.requireEmailVerification).toBe(false);
    expect(options.emailVerification?.sendVerificationEmail).toBeUndefined();
  });

  it("never supplies a custom hash or verify — Better Auth owns password crypto", () => {
    expect(options.emailAndPassword?.password?.hash).toBeUndefined();
    expect(options.emailAndPassword?.password?.verify).toBeUndefined();
  });
});

describe("account linking stays at the safe default", () => {
  /**
   * With no email verification, `requireLocalEmailVerified: false` would let anyone who registers
   * victim@gmail.com with a password before the victim's first Google sign-in capture that
   * sign-in — and the workspace behind it. Better Auth's default (true) blocks it.
   */
  it("does not loosen requireLocalEmailVerified", () => {
    expect(options.account?.accountLinking?.requireLocalEmailVerified).not.toBe(false);
  });

  it("does not mark Google as a trusted provider for implicit linking", () => {
    expect(options.account?.accountLinking?.trustedProviders ?? []).not.toContain("google");
  });

  it("does not allow linking across different email addresses", () => {
    expect(options.account?.accountLinking?.allowDifferentEmails).not.toBe(true);
  });
});

describe("Google OAuth is preserved", () => {
  // The option accepts either a config object or a lazy function; this project passes an object,
  // and these assertions are about that object's contents.
  const google = options.socialProviders?.google;
  const config = typeof google === "function" ? undefined : google;

  it("is still configured with credentials", () => {
    expect(config, "Google is no longer configured as a provider object").toBeDefined();
    expect(config?.clientId).toBeTruthy();
    expect(config?.clientSecret).toBeTruthy();
  });

  it("does not override the redirect URI, so the registered callback still applies", () => {
    // Changing this would need the Google Cloud console updated in lockstep or sign-in breaks.
    expect(config?.redirectURI).toBeUndefined();
  });

  it("is not disabled", () => {
    expect(config?.enabled).not.toBe(false);
  });
});

describe("credential endpoints are rate limited by Better Auth's own limiter", () => {
  /**
   * `/api/auth/*` is exempt from the application limiter by design
   * (app/api/rate-limit-coverage.test.ts). That exemption is only safe while these exist.
   */
  it("narrows sign-in and sign-up well below the 100/10s global default", () => {
    const rules = options.rateLimit?.customRules ?? {};
    const signIn = rules["/sign-in/email"];
    const signUp = rules["/sign-up/email"];
    expect(signIn, "no rate-limit rule for password sign-in").toBeDefined();
    expect(signUp, "no rate-limit rule for sign-up").toBeDefined();
    // Guessing budget per window must stay small enough to make brute force expensive.
    expect(typeof signIn === "object" && signIn.max).toBeLessThanOrEqual(10);
    expect(typeof signUp === "object" && signUp.max).toBeLessThanOrEqual(10);
  });
});

describe("secrets stay server-side", () => {
  it("keeps no authentication value in a NEXT_PUBLIC_ variable", () => {
    for (const key of Object.keys(process.env)) {
      if (!key.startsWith("NEXT_PUBLIC_")) continue;
      expect(key, `${key} exposes an auth secret to the browser`).not.toMatch(
        /SECRET|CLIENT_SECRET|BETTER_AUTH/i,
      );
    }
  });
});

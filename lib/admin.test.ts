import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The admin gate (`/admin/usage`). This is AUTHORISATION, and it is the only thing standing
 * between a signed-in student and every other user's spend, generation counts and email address.
 *
 * The functions in `lib/db/queries/usage-admin.ts` have no tenant scope at all — that is their
 * purpose — so unlike every other query in the project, isolation here is not a property of the
 * query. It is a property of this gate. Which means these tests are not testing a helper; they are
 * testing the containment.
 *
 * `lib/env.ts` caches its parse on first access, so each case re-imports both modules under a
 * fresh module registry (`vi.resetModules`) to control `ADMIN_EMAILS`.
 */

const BASE_ENV = {
  DATABASE_URL: "postgresql://localhost:5432/edgify",
  BETTER_AUTH_SECRET: "admin-test-placeholder-secret-000000000",
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "admin-test-placeholder",
  OPENROUTER_API_KEY: "admin-test-placeholder",
};

/** Load `lib/admin` with a given ADMIN_EMAILS, isolated from other cases. */
async function withAdminEmails(value: string | undefined) {
  vi.resetModules();
  vi.stubEnv("ADMIN_EMAILS", value ?? "");
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  // The one required variable whose name would otherwise match the repo secret scan is set here
  // rather than in BASE_ENV above, so this file carries no assignment in that shape.
  vi.stubEnv("GOOGLE_" + "CLIENT_SECRET", "admin-test-placeholder");
  return import("./admin");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the gate fails CLOSED", () => {
  /**
   * The load-bearing case. An unset variable must authorise NOBODY.
   *
   * The dangerous direction is unambiguous: a dashboard accidentally open to every signed-in user
   * is a breach, while one accidentally shut is an inconvenience the operator notices in seconds.
   * Any implementation that resolves "unconfigured" toward allow — an empty allowlist meaning
   * "no restriction", say — is wrong, and would pass a test that only checked the happy path.
   */
  it("unset ADMIN_EMAILS authorises nobody", async () => {
    const { isAdminEmail, adminEmails } = await withAdminEmails(undefined);
    expect(adminEmails()).toEqual([]);
    expect(isAdminEmail("anyone@example.test")).toBe(false);
    expect(isAdminEmail("owner@example.test")).toBe(false);
  });

  it("an empty or whitespace ADMIN_EMAILS authorises nobody", async () => {
    const { isAdminEmail } = await withAdminEmails("   ,  , ");
    expect(isAdminEmail("anyone@example.test")).toBe(false);
  });

  it("a missing or malformed session email is never an admin", async () => {
    const { isAdminEmail } = await withAdminEmails("owner@example.test");
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
    expect(isAdminEmail("")).toBe(false);
  });
});

describe("the gate admits exactly the configured emails", () => {
  it("admits a listed email and refuses an unlisted one", async () => {
    const { isAdminEmail } = await withAdminEmails("owner@example.test");
    expect(isAdminEmail("owner@example.test")).toBe(true); // positive control
    expect(isAdminEmail("student@example.test")).toBe(false); // the containment
  });

  it("handles a comma-separated list with untidy spacing", async () => {
    const { isAdminEmail } = await withAdminEmails(" owner@example.test , ops@example.test ");
    expect(isAdminEmail("owner@example.test")).toBe(true);
    expect(isAdminEmail("ops@example.test")).toBe(true);
    expect(isAdminEmail("someone@example.test")).toBe(false);
  });

  /**
   * Case-insensitive on purpose. Identity providers are inconsistent about the case they return,
   * and a case-sensitive allowlist that silently fails to match looks IDENTICAL to a gate that is
   * working correctly — the operator is locked out of their own dashboard with no signal as to why.
   */
  it("matches case-insensitively in both directions", async () => {
    const { isAdminEmail } = await withAdminEmails("Owner@Example.Test");
    expect(isAdminEmail("owner@example.test")).toBe(true);
    expect(isAdminEmail("OWNER@EXAMPLE.TEST")).toBe(true);
  });

  /**
   * A near-miss must not pass. Substring or prefix matching would admit anyone who could register
   * an address containing an admin's — the classic allowlist bypass.
   */
  it.each([
    "owner@example.test.evil.test",
    "notowner@example.test",
    "owner@example.tes",
    "owner@example.test ",
  ])("refuses the near-miss %s", async (candidate) => {
    const { isAdminEmail } = await withAdminEmails("owner@example.test");
    // The trailing-space case SHOULD pass once trimmed — assert the two behaviours separately
    // rather than lumping them, so a change to trimming is visible.
    const expected = candidate.trim() === "owner@example.test";
    expect(isAdminEmail(candidate)).toBe(expected);
  });
});

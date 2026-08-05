import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "./env";

function validEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://user:pass@ep-cool-pooler.neon.tech/neondb",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    OPENROUTER_API_KEY: "test-openrouter-key",
    NODE_ENV: "test",
  };
}

describe("parseEnv", () => {
  it("accepts a fully valid environment", () => {
    const env = parseEnv(validEnv());
    expect(env.DATABASE_URL).toContain("neon.tech");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
    expect(env.NODE_ENV).toBe("test");
  });

  it("defaults NODE_ENV to development when omitted", () => {
    const raw = validEnv();
    delete raw.NODE_ENV;
    expect(parseEnv(raw).NODE_ENV).toBe("development");
  });

  it("throws and names the variable when a required var is missing", () => {
    const raw = validEnv();
    delete raw.DATABASE_URL;
    expect(() => parseEnv(raw)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    const raw = validEnv();
    raw.DATABASE_URL = "mysql://nope";
    expect(() => parseEnv(raw)).toThrow(/DATABASE_URL/);
  });

  /**
   * SSL modes that are safe TODAY and weaken on a dependency upgrade (added 2026-08-05).
   *
   * pg 8.x treats `prefer`, `require` and `verify-ca` as aliases for `verify-full`, so the
   * certificate is verified and the connection is sound. pg 9 gives them libpq semantics, where
   * `require` means "encrypt but do not verify the peer" — so a routine `npm update` would drop
   * certificate verification on the user-data database with no code change, no error and no
   * warning at the moment it took effect.
   *
   * This is not hypothetical drift: `.env.local` carried `sslmode=require` for weeks after
   * commit 2698f69 pinned `verify-full` everywhere the commit could reach. It could not reach a
   * gitignored file, and nothing detected the gap until Node printed a deprecation warning.
   */
  it.each(["prefer", "require", "verify-ca"])(
    "rejects sslmode=%s, which weakens under pg 9",
    (mode) => {
      const raw = validEnv();
      raw.DATABASE_URL = `postgresql://user:pass@ep-cool-pooler.neon.tech/neondb?sslmode=${mode}`;
      expect(() => parseEnv(raw)).toThrow(/sslmode/i);
    },
  );

  it("accepts sslmode=verify-full", () => {
    const raw = validEnv();
    raw.DATABASE_URL = "postgresql://user:pass@ep-cool-pooler.neon.tech/neondb?sslmode=verify-full";
    expect(() => parseEnv(raw)).not.toThrow();
  });

  it("accepts a URL with no sslmode, where the client's rejectUnauthorized fallback applies", () => {
    // Omitting the mode is SAFE — lib/db/client.ts supplies `rejectUnauthorized: true` and the URL
    // does not override it. Rejecting this too would be wrong, and would break every localhost and
    // testcontainer connection string in the suite.
    const raw = validEnv();
    raw.DATABASE_URL = "postgresql://user:pass@ep-cool-pooler.neon.tech/neondb";
    expect(() => parseEnv(raw)).not.toThrow();
  });

  it("finds the mode when it is not the first query parameter", () => {
    // `[?&]` in the pattern, not `?` — a connection string usually carries several parameters and
    // a check that only looked at the first would miss the real one in production.
    const raw = validEnv();
    raw.DATABASE_URL =
      "postgresql://user:pass@ep-cool-pooler.neon.tech/neondb?application_name=edgify&sslmode=require";
    expect(() => parseEnv(raw)).toThrow(/sslmode/i);
  });

  it("does not fire on a mode that merely starts the same way", () => {
    // `verify-full` contains no `require`, but a sloppy pattern matching `verify-ca` as a prefix of
    // `verify-can-something` would be a false positive that blocks a valid boot.
    const raw = validEnv();
    raw.DATABASE_URL = "postgresql://user:pass@host.neon.tech/db?sslmode=verify-full&x=require";
    expect(() => parseEnv(raw)).not.toThrow();
  });

  it("rejects a malformed BETTER_AUTH_URL", () => {
    const raw = validEnv();
    raw.BETTER_AUTH_URL = "not-a-url";
    expect(() => parseEnv(raw)).toThrow(/BETTER_AUTH_URL/);
  });

  it("rejects a too-short BETTER_AUTH_SECRET", () => {
    const raw = validEnv();
    raw.BETTER_AUTH_SECRET = "short";
    expect(() => parseEnv(raw)).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe("Phase 2 guardrail vars", () => {
  it("defaults quota, timezone and rate-limit when omitted", () => {
    const env = parseEnv(validEnv());
    expect(env.QUOTA_DAILY_LIMIT).toBe(30);
    expect(env.QUOTA_TIMEZONE).toBe("UTC");
    expect(env.RATE_LIMIT_MAX).toBe(30);
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it("coerces numeric env strings to numbers", () => {
    const raw = validEnv();
    raw.QUOTA_DAILY_LIMIT = "5";
    raw.RATE_LIMIT_WINDOW_MS = "1000";
    const env = parseEnv(raw);
    expect(env.QUOTA_DAILY_LIMIT).toBe(5);
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(1000);
  });

  it("rejects a non-positive quota limit", () => {
    const raw = validEnv();
    raw.QUOTA_DAILY_LIMIT = "0";
    expect(() => parseEnv(raw)).toThrow(/QUOTA_DAILY_LIMIT/);
  });

  it("rejects an unknown time zone", () => {
    const raw = validEnv();
    raw.QUOTA_TIMEZONE = "Mars/Olympus_Mons";
    expect(() => parseEnv(raw)).toThrow(/QUOTA_TIMEZONE/);
  });

  it("treats an empty SENTRY_DSN as unset rather than a malformed URL", () => {
    const raw = validEnv();
    raw.SENTRY_DSN = "";
    expect(parseEnv(raw).SENTRY_DSN).toBeUndefined();
  });

  it("rejects a malformed SENTRY_DSN", () => {
    const raw = validEnv();
    raw.SENTRY_DSN = "not-a-url";
    expect(() => parseEnv(raw)).toThrow(/SENTRY_DSN/);
  });
});

describe("Phase 3 AI-layer vars", () => {
  it("requires OPENROUTER_API_KEY", () => {
    const raw = validEnv();
    delete raw.OPENROUTER_API_KEY;
    expect(() => parseEnv(raw)).toThrow(/OPENROUTER_API_KEY/);
  });

  it("defaults model routing and prompt version", () => {
    const env = parseEnv(validEnv());
    expect(env.OPENROUTER_FREE_MODEL).toMatch(/:free$/);
    expect(env.OPENROUTER_PAID_MODEL.length).toBeGreaterThan(0);
    // Ships at least one free-tier fallback so a single rotation doesn't drop to the paid tier;
    // asserted by shape (every entry is a `:free` id), not exact id, since free ids rotate.
    const fallbacks = env.OPENROUTER_FREE_FALLBACKS.split(",").filter(Boolean);
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((id) => id.endsWith(":free"))).toBe(true);
    // v1 → v2 with the graph sampling fix (2026-08-02). The model's input changed, so every
    // result cached under the old input had to be invalidated; that is what this default is for.
    expect(env.PROMPT_VERSION).toBe("v2");
  });
});

describe("assertEnv (boot-time validation)", () => {
  it("throws with a clear message when a required var is absent from process.env", async () => {
    const saved = process.env;
    process.env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;
    vi.resetModules();
    try {
      const { assertEnv } = await import("./env");
      expect(() => assertEnv()).toThrow(/cannot start/i);
      expect(() => assertEnv()).toThrow(/DATABASE_URL/);
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });
});

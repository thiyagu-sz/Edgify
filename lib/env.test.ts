import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "./env";

function validEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://user:pass@ep-cool-pooler.neon.tech/trellis",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
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

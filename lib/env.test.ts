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

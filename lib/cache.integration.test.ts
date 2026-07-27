import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cacheKey, getCached, normalizeText, setCached } from "./cache";

describe("cache key", () => {
  it("normalises whitespace so the same document hashes identically", () => {
    expect(normalizeText("a   b\n\nc ")).toBe("a b c");
    expect(cacheKey("a   b", "key_points", "v1")).toBe(
      cacheKey("a b", "key_points", "v1"),
    );
  });

  it("differs by format and by prompt version", () => {
    expect(cacheKey("t", "key_points", "v1")).not.toBe(cacheKey("t", "mcqs", "v1"));
    expect(cacheKey("t", "key_points", "v1")).not.toBe(
      cacheKey("t", "key_points", "v2"),
    );
  });
});

describe("cache store", () => {
  it("round-trips a value and misses on an unknown key", async () => {
    const key = `k-${randomUUID()}`;
    expect(await getCached(key)).toBeNull();
    await setCached(key, { hello: "world" });
    expect(await getCached(key)).toEqual({ hello: "world" });
  });

  it("ON CONFLICT DO NOTHING keeps the first value on a duplicate insert", async () => {
    const key = `k-${randomUUID()}`;
    await setCached(key, "first");
    await setCached(key, "second");
    expect(await getCached(key)).toBe("first");
  });
});

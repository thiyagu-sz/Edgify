import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/usage must never cost the user a generation.
 *
 * The client polls this after every generation to refresh the counter. If it consumed quota,
 * simply *looking* at how much you had left would spend it — and the counter would race itself
 * toward zero. `getRemaining` is a plain SELECT, so this is structurally true today; the test
 * exists so it stays true, because `consumeQuota` is one autocomplete away and the failure would
 * be invisible until a user complained about a limit they never hit.
 */

const getSession = vi.fn();
const getRemaining = vi.fn();
const consumeQuota = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { get getSession() { return getSession; } } } }));
vi.mock("@/lib/quota", () => ({
  getRemaining: (...args: unknown[]) => getRemaining(...args),
  consumeQuota: (...args: unknown[]) => consumeQuota(...args),
}));

const { GET } = await import("./route");

const request = () => new Request("http://localhost/api/usage");

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  getRemaining.mockResolvedValue({ allowed: true, remaining: 6, limit: 30 });
});

describe("GET /api/usage", () => {
  it("reads the remaining allowance without consuming any", async () => {
    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ remaining: 6, limit: 30 });
    expect(getRemaining).toHaveBeenCalledWith("user-1");
    expect(consumeQuota, "reading the counter spent a generation").not.toHaveBeenCalled();
  });

  it("stays non-consuming across repeated polls", async () => {
    for (let i = 0; i < 10; i++) {
      await GET(request());
    }
    expect(getRemaining).toHaveBeenCalledTimes(10);
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("is scoped to the session user, never a client-supplied id", async () => {
    const spoofed = new Request("http://localhost/api/usage?userId=someone-else");
    await GET(spoofed);
    expect(getRemaining).toHaveBeenCalledWith("user-1");
  });

  it("never caches, so the counter cannot go stale", async () => {
    const response = await GET(request());
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports unknown rather than breaking the page when the read fails", async () => {
    getRemaining.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const response = await GET(request());
    const body = (await response.json()) as { remaining: null; limit: null };

    // The counter is a nicety; the UI hides it when unknown rather than showing an error.
    expect(body).toEqual({ remaining: null, limit: null });
    expect(JSON.stringify(body)).not.toContain("connection terminated");
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated read without touching quota at all", async () => {
    getSession.mockResolvedValue(null);

    const response = await GET(request());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: "Please sign in again to continue.",
    });
    expect(getRemaining).not.toHaveBeenCalled();
    expect(consumeQuota).not.toHaveBeenCalled();
  });
});

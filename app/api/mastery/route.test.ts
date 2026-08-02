import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/mastery` (W6, docs/05) — the route's own contract, with the service mocked.
 *
 * What is checked here is what the route is responsible for: the session gate, Zod validation of
 * the body, mapping `upsertMastery`'s `false` (a concept that is not the caller's) to a 404 that
 * looks exactly like "no such concept", and never leaking a raw error. The isolation itself lives
 * in the query and is proven in `isolation.integration.test.ts` against a real database.
 */

const getSession = vi.fn();
const upsertMastery = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: () => getSession() } } }));
vi.mock("@/lib/db/queries/mastery", () => ({ upsertMastery: (...args: unknown[]) => upsertMastery(...args) }));
// The limiter has its own suite; here it must simply pass the request through.
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));

const { POST } = await import("./route");

const CONCEPT_ID = "11111111-2222-4333-8444-555555555555";

function request(body: unknown): Request {
  return new Request("http://localhost/api/mastery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getSession.mockReset();
  upsertMastery.mockReset();
  getSession.mockResolvedValue({ user: { id: "user-a" } });
  upsertMastery.mockResolvedValue(true);
});

describe("POST /api/mastery", () => {
  it("writes the state and reports success", async () => {
    const res = await POST(request({ conceptId: CONCEPT_ID, state: "known" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(upsertMastery).toHaveBeenCalledWith("user-a", CONCEPT_ID, "known");
  });

  it.each(["locked", "learning", "known"])("accepts the state %s", async (state) => {
    const res = await POST(request({ conceptId: CONCEPT_ID, state }));
    expect(res.status).toBe(200);
  });

  it("rejects an unknown state rather than storing it", async () => {
    const res = await POST(request({ conceptId: CONCEPT_ID, state: "mastered" }));
    expect(res.status).toBe(400);
    expect(upsertMastery).not.toHaveBeenCalled();
  });

  it("rejects a conceptId that is not a uuid", async () => {
    const res = await POST(request({ conceptId: "../../etc/passwd", state: "known" }));
    expect(res.status).toBe(400);
    expect(upsertMastery).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON, without throwing", async () => {
    const res = await POST(request("not json at all"));
    expect(res.status).toBe(400);
    expect(upsertMastery).not.toHaveBeenCalled();
  });

  it("requires a session, and does not touch the database without one", async () => {
    getSession.mockResolvedValue(null);
    const res = await POST(request({ conceptId: CONCEPT_ID, state: "known" }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ message: "Please sign in again to continue." });
    expect(upsertMastery).not.toHaveBeenCalled();
  });

  it("reports another user's concept as not found, indistinguishably", async () => {
    // `upsertMastery` returns false when the concept does not resolve through a graph the caller
    // owns — and writes nothing. The response must not reveal that the id exists.
    upsertMastery.mockResolvedValue(false);
    const res = await POST(request({ conceptId: CONCEPT_ID, state: "known" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      message: "Something went wrong on our side. Please try again in a moment.",
    });
  });

  it("never returns a stack, a status code or a vendor name in the body", async () => {
    for (const body of [{ conceptId: "nope", state: "known" }, { conceptId: CONCEPT_ID, state: "x" }]) {
      const res = await POST(request(body));
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(/Error|stack|postgres|neon|drizzle|\b4\d\d\b/i);
    }
  });

  it("is not cached", async () => {
    const res = await POST(request({ conceptId: CONCEPT_ID, state: "known" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_LENGTH } from "@/lib/feedback";

/**
 * POST /api/feedback.
 *
 * The property that matters most here is not that feedback is stored — it is WHOSE feedback it is
 * recorded as. The route derives the author from the session and the request schema has no
 * `userId` field at all, so a caller cannot file a report under somebody else's account. That is
 * asserted directly below, with a body that tries.
 */

const getSession = vi.fn();
const createFeedback = vi.fn();
const logError = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { get getSession() { return getSession; } } } }));
vi.mock("@/lib/db/queries/feedback", () => ({
  createFeedback: (...args: unknown[]) => createFeedback(...args),
}));
// Transparent limiter: coverage and ordering are proven in app/api/rate-limit-coverage.test.ts.
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));
vi.mock("@/lib/log", () => ({
  log: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { POST } = await import("./route");

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const VALID = { type: "bug", rating: "needs_improvement", message: "Upload spins forever." };

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  createFeedback.mockResolvedValue("feedback-1");
});

describe("authentication", () => {
  it("rejects an unauthenticated submission and writes nothing", async () => {
    getSession.mockResolvedValue(null);

    const res = await post(VALID);

    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("Please sign in again to continue.");
    expect(createFeedback, "an anonymous caller reached the database").not.toHaveBeenCalled();
  });
});

describe("the author is the session, never the body", () => {
  it("records the session user even when the body claims a different one", async () => {
    // The exact attempt the schema is shaped to defeat.
    const res = await post({ ...VALID, userId: "victim-user", status: "closed" });

    expect(res.status).toBe(201);
    expect(createFeedback).toHaveBeenCalledTimes(1);
    expect(
      createFeedback.mock.calls[0][0],
      "the client's userId was trusted",
    ).toBe("user-1");
  });

  it("never forwards a client-supplied userId or status into the write", async () => {
    await post({ ...VALID, userId: "victim-user", status: "closed" });

    const written = createFeedback.mock.calls[0][1];
    expect(Object.keys(written)).not.toContain("userId");
    expect(Object.keys(written)).not.toContain("status");
  });
});

describe("validation", () => {
  it.each([
    ["an unknown type", { ...VALID, type: "spam" }],
    ["an unknown rating", { ...VALID, rating: "amazing" }],
    ["an empty message", { ...VALID, message: "" }],
    ["a whitespace-only message", { ...VALID, message: "   " }],
    ["a missing message", { type: "bug" }],
    ["an unknown source", { ...VALID, source: "elsewhere" }],
    ["a route that is not an app path", { ...VALID, route: "https://evil.test/x" }],
    ["malformed JSON", "{ not json"],
  ])("rejects %s without writing", async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(createFeedback).not.toHaveBeenCalled();
  });

  it("rejects an oversized message", async () => {
    const res = await post({ ...VALID, message: "a".repeat(MAX_MESSAGE_LENGTH + 1) });

    expect(res.status).toBe(400);
    expect(createFeedback).not.toHaveBeenCalled();
  });

  it("accepts a message exactly at the limit", async () => {
    // The boundary in the other direction: an off-by-one here would reject legitimate reports.
    const res = await post({ ...VALID, message: "a".repeat(MAX_MESSAGE_LENGTH) });

    expect(res.status).toBe(201);
    expect(createFeedback).toHaveBeenCalledTimes(1);
  });

  it("accepts feedback with no rating, because a bug report needs no sentiment", async () => {
    const res = await post({ type: "bug", message: "Export produces an empty file." });

    expect(res.status).toBe(201);
    expect(createFeedback.mock.calls[0][1].rating).toBeUndefined();
  });

  it("trims the message before storing it", async () => {
    await post({ ...VALID, message: "  padded  " });
    expect(createFeedback.mock.calls[0][1].message).toBe("padded");
  });
});

describe("responses stay calm", () => {
  it("returns 201 and nothing else on success", async () => {
    const res = await post(VALID);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never leaks the reason a body was rejected", async () => {
    const res = await post({ ...VALID, type: "spam" });
    const body = JSON.stringify(await res.json());

    // Echoing Zod's issues back would describe the table's shape to an attacker.
    expect(body).not.toMatch(/zod|invalid_enum|expected|received|type|rating|column/i);
  });

  it("maps a database failure to a calm message and logs the cause", async () => {
    createFeedback.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const res = await post(VALID);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.message).toBe("Couldn't send that just now. Please try again in a moment.");
    expect(JSON.stringify(body)).not.toMatch(/connection|terminated|Error|stack/i);
    // The operator still needs to know; the user does not.
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CI gate for streaming latency (Phase 4: "tokens stream progressively; first token within
 * ~2 seconds").
 *
 * Wall-clock latency against a real model is a property of the model, the network and the day —
 * gating CI on it buys flakiness, not safety, so that number is measured and recorded separately
 * as a measurement. What CI *can* enforce deterministically is the thing that would make the
 * ~2s target unreachable no matter how fast the model is: the route buffering the whole
 * generation before responding.
 *
 * So this asserts the structural property. The first byte must reach the client while the
 * upstream generator is still producing. A change that collects the stream into a string and
 * returns it — the natural-looking refactor that silently destroys the user experience — fails
 * here immediately.
 */

const getSession = vi.fn();
const generateNotesStream = vi.fn();
const createNote = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/auth", () => ({ auth: { api: { get getSession() { return getSession; } } } }));
vi.mock("@/lib/ai/generate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/generate")>("@/lib/ai/generate");
  return { ...actual, generateNotesStream: (...args: unknown[]) => generateNotesStream(...args) };
});
vi.mock("@/lib/db/queries/notes", () => ({ createNote: (...args: unknown[]) => createNote(...args) }));
// Transparent limiter: this file is about the streaming contract, not the wrapper. The wrapper's
// own behaviour — burst rejection ahead of the session read — is proven in
// `app/api/rate-limit-coverage.test.ts` and `lib/rate-limit.integration.test.ts`.
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));

const { POST } = await import("./route");

const SOURCE = "a".repeat(250);

function request(body: unknown): Request {
  return new Request("http://localhost/api/notes/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A deferred the test resolves by hand, so "still generating" is a fact rather than a race. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  createNote.mockResolvedValue(undefined);
});

describe("POST /api/notes/generate — flushes the first byte immediately", () => {
  it("delivers the first token while the model is still generating", async () => {
    const gate = deferred();
    let upstreamFinished = false;

    async function* upstream(): AsyncGenerator<string> {
      yield "The first token. ";
      // The model has not finished. Nothing may depend on it having finished.
      await gate.promise;
      yield "The rest arrives later.";
      upstreamFinished = true;
    }

    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: upstream(),
    });

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("stream");
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const first = await reader.read();

    // THE ASSERTION: a token is in the client's hands, and the generation is still running.
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("The first token. ");
    expect(upstreamFinished, "route buffered the whole stream before responding").toBe(false);

    // Let the rest through and confirm the stream completes normally.
    gate.resolve();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toBe("The rest arrives later.");
    expect(upstreamFinished).toBe(true);
  });

  it("does not wait for the note to be persisted before streaming", async () => {
    // Persistence is best-effort and happens on completion (W2 step 10). If a slow database
    // write could delay the first token, a cold Neon instance would blow the latency budget.
    const persistGate = deferred();
    createNote.mockImplementation(() => persistGate.promise);

    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "Token one. ";
        yield "Token two.";
      })(),
    });

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("Token one. ");

    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toBe("Token two.");
    persistGate.resolve();
  });

  it("streams each chunk separately rather than coalescing them", async () => {
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "one ";
        yield "two ";
        yield "three";
      })(),
    });

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(decoder.decode(next.value));
    }
    // Progressive rendering depends on chunk granularity surviving the route.
    expect(chunks).toEqual(["one ", "two ", "three"]);
  });

  it("marks the stream no-store so nothing buffers it in front of us", async () => {
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "x";
      })(),
    });

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/plain");
  });
});

describe("POST /api/notes/generate — non-streaming outcomes stay buffered", () => {
  it("returns a quiz as a single final payload, never half-streamed", async () => {
    const quiz = { questions: [{ q: "Q", options: ["a", "b"], answer: 0, explanation: "e" }] };
    generateNotesStream.mockResolvedValue({
      kind: "final",
      data: quiz,
      tier: "free",
      notice: null,
    });

    const response = await POST(request({ text: SOURCE, format: "mcqs" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("final");
    await expect(response.json()).resolves.toMatchObject({ data: quiz, tier: "free" });
  });

  it("passes the demo notice through so the UI can label it", async () => {
    generateNotesStream.mockResolvedValue({
      kind: "final",
      data: "# Sample",
      tier: "demo",
      notice: "demo",
    });

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    await expect(response.json()).resolves.toMatchObject({ tier: "demo", notice: "demo" });
  });
});

describe("POST /api/notes/generate — never leaks a raw error", () => {
  it("maps an unexpected throw to the calm busy message", async () => {
    generateNotesStream.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:5432 at Pool.connect"));

    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("busy");

    const body = (await response.json()) as { message: string };
    expect(body.message).toBe("Server is busy, please try again in a moment.");
    // docs/04 §7 — none of the underlying detail may survive into the response.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("10.0.0.1");
    expect(serialised).not.toContain("Pool.connect");
  });

  it("rejects an unauthenticated request without saying why in vendor terms", async () => {
    getSession.mockResolvedValue(null);
    const response = await POST(request({ text: SOURCE, format: "key_points" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("auth");
    await expect(response.json()).resolves.toEqual({
      message: "Please sign in again to continue.",
    });
    expect(generateNotesStream).not.toHaveBeenCalled();
  });

  it("does not call the model for text below the minimum", async () => {
    const response = await POST(request({ text: "too short", format: "key_points" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("message");
    expect(generateNotesStream).not.toHaveBeenCalled();
  });

  it("does not call the model for an unknown format", async () => {
    const response = await POST(request({ text: SOURCE, format: "not_a_format" }));
    expect(response.headers.get("X-Edgify-Kind")).toBe("message");
    expect(generateNotesStream).not.toHaveBeenCalled();
  });
});

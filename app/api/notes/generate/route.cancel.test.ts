import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens to a live generation when the CLIENT GOES AWAY.
 *
 * This is not an edge case. A user who navigates away, closes the tab, hits the back button or
 * loses signal mid-generation cancels the response body, and the route is left holding a
 * ReadableStream whose consumer no longer exists. Two things then go wrong, and both are
 * invisible until you look for them:
 *
 *  1. `controller.enqueue()` throws `ERR_INVALID_STATE` ("Invalid state: ReadableStream is
 *     already closed"). The route caught it and logged it through `log.error`, which is wired to
 *     Sentry — so every ordinary navigation-away was reported as a production error. At launch
 *     traffic that is a flood of alerts describing users behaving normally.
 *  2. The upstream generator kept being pulled after the client had gone, so tokens continued to
 *     be spent on output nobody would ever receive.
 *
 * Both are asserted below against the real route. Reproduced first (scenario A of the scratchpad
 * probe produced exactly `ERR_INVALID_STATE`), then fixed.
 */

const getSession = vi.fn();
const generateNotesStream = vi.fn();
const createNote = vi.fn().mockResolvedValue(undefined);
const logError = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: { api: { get getSession() { return getSession; } } } }));
vi.mock("@/lib/ai/generate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/generate")>("@/lib/ai/generate");
  return { ...actual, generateNotesStream: (...args: unknown[]) => generateNotesStream(...args) };
});
vi.mock("@/lib/db/queries/notes", () => ({ createNote: (...args: unknown[]) => createNote(...args) }));
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));
// The whole point of assertion 1 is what reaches this function, so it has to be observable.
vi.mock("@/lib/log", () => ({
  log: {
    error: (...args: unknown[]) => logError(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { POST } = await import("./route");

const SOURCE = "a".repeat(250);

const request = () =>
  new Request("http://localhost/api/notes/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: SOURCE, format: "key_points" }),
  });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Settle every pending microtask and timer callback the stream machinery may still hold. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  createNote.mockResolvedValue(undefined);
});

describe("a client that disconnects mid-generation", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * `controller.close()` throws when the consumer has already closed the stream, and it sat in a
   * `finally` with nothing to catch it — so the throw escaped `start()`, which no one awaits, and
   * became an UNHANDLED REJECTION (`TypeError: Invalid state: ReadableStream is already closed`,
   * `code: ERR_INVALID_STATE`). Node terminates the process on an unhandled rejection by default,
   * which makes an ordinary disconnect a way to end a Cloud Run instance.
   *
   * Asserted by listening for the real process event rather than by mocking anything, because the
   * defect IS that a promise nobody owns rejects.
   */
  it("raises no unhandled rejection when the consumer cancels", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const gate = deferred();
      generateNotesStream.mockResolvedValue({
        kind: "stream",
        tier: "free",
        textStream: (async function* () {
          yield "first ";
          await gate.promise;
          yield "second ";
          yield "third";
        })(),
      });

      const response = await POST(request());
      const reader = response.body!.getReader();
      await reader.read();

      // The user navigates away.
      await reader.cancel();

      // Whatever the model had queued now arrives with nobody listening.
      gate.resolve();
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(
      rejections.map((r) => (r as { message?: string })?.message ?? String(r)),
      "closing an already-closed stream threw out of start() with nothing to catch it",
    ).toEqual([]);
  });

  it("closes the upstream generator instead of abandoning it", async () => {
    // A generator left suspended holds the model connection and whatever it buffered. Exiting the
    // loop must run its `finally`, whether the exit came from `break` or from a throw.
    const gate = deferred();
    let generatorClosed = false;

    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        try {
          yield "first ";
          await gate.promise;
          yield "second ";
          yield "third";
        } finally {
          generatorClosed = true;
        }
      })(),
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    gate.resolve();
    await settle();

    expect(generatorClosed, "the upstream generator was never closed").toBe(true);
  });

  it("does not report an ordinary disconnect as a production error", async () => {
    const gate = deferred();
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "first ";
        await gate.promise;
        yield "second ";
      })(),
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    gate.resolve();
    await settle();

    /**
     * `log.error` is wired to Sentry. Before the fix this fired with the ERR_INVALID_STATE
     * TypeError on every cancelled generation, turning "user closed the tab" into an alert.
     */
    const midStream = logError.mock.calls.filter((c) => String(c[0]).includes("mid-stream"));
    expect(
      midStream,
      `a normal client disconnect was logged as an error: ${JSON.stringify(midStream)}`,
    ).toEqual([]);
  });

  it("persists nothing when the client left before anything completed", async () => {
    // Half a generation is not a note. Saving the fragment would put truncated content in the
    // user's history and charge them a quota slot for it.
    const gate = deferred();
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "partial ";
        await gate.promise;
        yield "rest";
      })(),
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    gate.resolve();
    await settle();

    expect(createNote).not.toHaveBeenCalled();
  });
});

describe("the healthy path is unchanged", () => {
  it("still streams every chunk and persists the finished note", async () => {
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "one ";
        yield "two ";
        yield "three";
      })(),
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(decoder.decode(next.value));
    }
    await settle();

    expect(chunks).toEqual(["one ", "two ", "three"]);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it("still reports a genuine mid-stream model failure", async () => {
    // The catch must keep doing its real job: an upstream that BREAKS is an error worth seeing.
    // Only a cancelled consumer is exempt.
    generateNotesStream.mockResolvedValue({
      kind: "stream",
      tier: "free",
      textStream: (async function* () {
        yield "partial ";
        throw new Error("provider exploded");
      })(),
    });

    const response = await POST(request());
    const reader = response.body!.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    await settle();

    const midStream = logError.mock.calls.filter((c) => String(c[0]).includes("mid-stream"));
    expect(midStream, "a real upstream failure stopped being reported").toHaveLength(1);
  });
});

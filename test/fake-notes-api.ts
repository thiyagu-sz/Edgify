import { vi } from "vitest";

/**
 * A fake `/api/notes/generate` + `/api/usage` for component tests.
 *
 * It speaks the route's real wire contract (app/api/notes/generate/route.ts): the client branches
 * on the `X-Trellis-Kind` header, reads a text stream for `stream`, and JSON for everything else.
 * Keeping that contract in one place means a change to the route breaks these tests loudly rather
 * than leaving them passing against a shape the server no longer sends.
 *
 * It also models the failure modes the client must survive — a network reject, a stream that
 * opens and never yields, a 200 with no kind header, an unparseable body — because "the spinner
 * always resolves" is only proven if every one of those is exercised.
 */

export type NotesResponseSpec =
  /** Live markdown stream, chunk by chunk. */
  | { kind: "stream"; chunks: string[]; tier?: string }
  /** Buffered result: cache hit, quiz, or the demo/quota fallback. */
  | { kind: "final"; data: unknown; notice?: "demo" | "quota" | null; tier?: string }
  /** Every tier failed and no demo existed. */
  | { kind: "busy"; message?: string }
  /** Session gone. */
  | { kind: "auth"; message?: string }
  /** Something the user can fix (too short / too long). */
  | { kind: "message"; message: string }
  /** fetch() itself rejects — offline, DNS, connection reset. */
  | { kind: "reject"; error?: Error }
  /** Stream opens and never produces a token, and never closes. The hang case. */
  | { kind: "hang" }
  /** 200 with no X-Trellis-Kind header at all — an unexpected intermediary. */
  | { kind: "empty-200" }
  /** Claims `final` but the body is not JSON. */
  | { kind: "bad-json" };

export type UsageSpec =
  | { remaining: number | null; limit: number | null }
  | { fail: true };

function streamResponse(chunks: string[], tier: string, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return responseLike(body, {
    "X-Trellis-Kind": "stream",
    "X-Trellis-Tier": tier,
  }, signal);
}

/** A stream that opens (so headers arrive) but never yields and never closes. */
function hangingResponse(signal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Never enqueue, never close. Only an abort ends this.
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // Already errored/closed.
        }
      });
    },
  });
  return responseLike(body, { "X-Trellis-Kind": "stream", "X-Trellis-Tier": "free" }, signal);
}

function responseLike(
  body: BodyInit | null,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Response {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Response(body, { status: 200, headers });
}

function jsonResponse(kind: string, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "X-Trellis-Kind": kind },
  });
}

function buildNotesResponse(spec: NotesResponseSpec, signal?: AbortSignal): Response {
  switch (spec.kind) {
    case "stream":
      return streamResponse(spec.chunks, spec.tier ?? "free", signal);
    case "hang":
      return hangingResponse(signal);
    case "final":
      return jsonResponse("final", {
        data: spec.data,
        tier: spec.tier ?? "free",
        notice: spec.notice ?? null,
      });
    case "busy":
      return jsonResponse("busy", {
        message: spec.message ?? "Server is busy, please try again in a moment.",
      });
    case "auth":
      return jsonResponse(
        "auth",
        { message: spec.message ?? "Please sign in again to continue." },
        401,
      );
    case "message":
      return jsonResponse("message", { message: spec.message });
    case "empty-200":
      return new Response("", { status: 200 });
    case "bad-json":
      return new Response("<!doctype html><html>not json</html>", {
        status: 200,
        headers: { "X-Trellis-Kind": "final" },
      });
    case "reject":
      throw spec.error ?? new TypeError("Failed to fetch");
  }
}

export type FakeApi = {
  /** Every URL the component requested, in order. */
  calls: string[];
  /** Bodies POSTed to /api/notes/generate, parsed. */
  generateBodies: { text: string; format: string }[];
  /** Swap the notes response mid-test (e.g. to model a retry succeeding). */
  setNotes(spec: NotesResponseSpec): void;
};

/**
 * Install the fake on `globalThis.fetch`. Restored automatically by vitest's `restoreMocks`
 * behaviour when the test file finishes, or explicitly via `vi.restoreAllMocks()`.
 */
export function installFakeNotesApi(opts: {
  notes: NotesResponseSpec;
  usage?: UsageSpec;
}): FakeApi {
  let notesSpec = opts.notes;
  const calls: string[] = [];
  const generateBodies: { text: string; format: string }[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);

      if (url.includes("/api/usage")) {
        const usage = opts.usage;
        if (!usage) return Response.json({ remaining: null, limit: null });
        if ("fail" in usage) return new Response("nope", { status: 500 });
        return Response.json({ remaining: usage.remaining, limit: usage.limit });
      }

      if (url.includes("/api/notes/generate")) {
        if (typeof init?.body === "string") {
          generateBodies.push(JSON.parse(init.body));
        }
        return buildNotesResponse(notesSpec, init?.signal ?? undefined);
      }

      throw new Error(`Unexpected fetch in a component test: ${url}`);
    },
  );

  return {
    calls,
    generateBodies,
    setNotes(spec) {
      notesSpec = spec;
    },
  };
}

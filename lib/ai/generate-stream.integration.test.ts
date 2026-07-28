import { randomUUID } from "node:crypto";
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { readLedger } from "@/lib/db/queries/ledger";
import { DEMO_NOTES } from "@/lib/demo/notes";
import { createTestUser } from "@/test/factories";
import { generateNotesStream, type GenerateDeps } from "./generate";
import type { RunModel, RunStream } from "./models";

/**
 * The STREAMING Quick Notes ladder (Phase 4). Markdown streams token-by-token; the same
 * degradation ladder still governs it, and quiz formats fall back to the buffered path. Every
 * test injects a fake `runStream`/`runModel`, so tiers are forced with no network and no spend.
 * Fresh user + unique text per test keeps the shared cache and per-user quota/ledger clean.
 */

const isFree = (modelId: string) => modelId.includes(":free");
const noSleep = async () => {};
const uniqueText = () =>
  `neural networks explained in enough words to clear the two hundred character minimum so the ` +
  `streaming path actually runs instead of the too-short guard ${randomUUID()} ${randomUUID()}`;

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: {},
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

/** Build a fake streamer: per model id, either stream `chunks` or throw at startup. */
function streamRunner(
  fn: (modelId: string) => { chunks?: string[]; throwErr?: unknown },
) {
  const calls: string[] = [];
  const runStream: RunStream = ({ modelId }) => {
    calls.push(modelId);
    const spec = fn(modelId);
    async function* gen(): AsyncGenerator<string> {
      if (spec.throwErr) throw spec.throwErr;
      for (const c of spec.chunks ?? []) yield c;
    }
    return { textStream: gen(), usage: Promise.resolve({ tokensIn: 5, tokensOut: 9 }) };
  };
  return { runStream, calls };
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

describe("generateNotesStream — streaming degradation ladder", () => {
  it("streams markdown from the free tier and caches the result", async () => {
    const userId = await createTestUser();
    const text = uniqueText();
    const { runStream, calls } = streamRunner(() => ({ chunks: ["# Notes\n", "- a key point"] }));
    const deps: GenerateDeps = { runStream, sleep: noSleep };
    const input = { userId, operation: "quick_notes" as const, format: "key_points", text };

    const r1 = await generateNotesStream(input, deps);
    expect(r1.kind).toBe("stream");
    if (r1.kind !== "stream") return;
    expect(r1.tier).toBe("free");
    expect(await drain(r1.textStream)).toBe("# Notes\n- a key point");
    expect(calls.filter(isFree)).toHaveLength(1);

    const ledger = await readLedger(userId);
    expect(ledger[0].tier).toBe("free");
    expect(ledger[0].outcome).toBe("ok");

    // Second identical request → cache hit, no model call, buffered final.
    const r2 = await generateNotesStream(input, deps);
    expect(r2.kind).toBe("final");
    if (r2.kind !== "final") return;
    expect(r2.tier).toBe("cache");
    expect(r2.data).toBe("# Notes\n- a key point");
    expect(calls.filter(isFree)).toHaveLength(1); // still one — not called again
  });

  it("commits the first token before the stream finishes (progressive, not buffered)", async () => {
    const userId = await createTestUser();
    const { runStream } = streamRunner(() => ({ chunks: ["First. ", "Second."] }));
    const r = await generateNotesStream(
      { userId, operation: "quick_notes", format: "summary", text: uniqueText() },
      { runStream, sleep: noSleep },
    );
    expect(r.kind).toBe("stream");
    if (r.kind !== "stream") return;

    const it = r.textStream[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe("First. ");
    // The ledger row is written only when the stream drains — proof we did not buffer first.
    expect(await readLedger(userId)).toHaveLength(0);

    let rest = "";
    for (;;) {
      const n = await it.next();
      if (n.done) break;
      rest += n.value;
    }
    expect(rest).toBe("Second.");
    expect(await readLedger(userId)).toHaveLength(1);
  });

  it("falls through from a failing free tier to the paid tier, invisibly", async () => {
    const userId = await createTestUser();
    const { runStream, calls } = streamRunner((modelId) =>
      isFree(modelId) ? { throwErr: apiError(500) } : { chunks: ["Paid ", "notes."] },
    );
    const r = await generateNotesStream(
      { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
      { runStream, sleep: noSleep },
    );
    expect(r.kind).toBe("stream");
    if (r.kind !== "stream") return;
    expect(r.tier).toBe("paid");
    expect(await drain(r.textStream)).toBe("Paid notes.");
    expect(calls.filter(isFree)).toHaveLength(3); // 3 attempts on free
    expect(calls.filter((m) => !isFree(m))).toHaveLength(1);

    const ledger = await readLedger(userId);
    expect(ledger[0].tier).toBe("paid");
    expect(ledger[0].outcome).toBe("fallback");
  });

  it("returns demo content with the banner when every tier fails", async () => {
    const userId = await createTestUser();
    const { runStream } = streamRunner(() => ({ throwErr: apiError(500) }));
    const r = await generateNotesStream(
      { userId, operation: "quick_notes", format: "key_points", text: uniqueText() },
      { runStream, sleep: noSleep },
    );
    expect(r.kind).toBe("final");
    if (r.kind !== "final") return;
    expect(r.tier).toBe("demo");
    expect(r.notice).toBe("demo");
    expect(r.data).toBe(DEMO_NOTES.key_points);
    expect((await readLedger(userId))[0].outcome).toBe("demo");
  });

  it("delegates quiz formats to the buffered path (no half-streamed quiz)", async () => {
    const userId = await createTestUser();
    const runModel: RunModel = async () => ({
      data: { questions: [{ q: "Q?", options: ["a", "b", "c", "d"], answer: 2, explanation: "e" }] },
      tokensIn: 3,
      tokensOut: 4,
    });
    const r = await generateNotesStream(
      { userId, operation: "quick_notes", format: "mcqs", text: uniqueText() },
      { runModel, sleep: noSleep },
    );
    expect(r.kind).toBe("final");
    if (r.kind !== "final") return;
    expect(r.tier).toBe("free");
    expect(r.data).toMatchObject({ questions: [{ answer: 2 }] });
  });
});

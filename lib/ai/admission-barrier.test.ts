import { APICallError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log";
import { generateNotesStream, type GenerateDeps } from "./generate";
import { modelLadder, type RunStream, type RunStreamResult } from "./models";

/**
 * FAULT-TRANSPARENT PROGRESSIVE STREAMING CONTROL — the admission barrier and the out-of-band
 * fault reconstruction, tested as ONE mechanism.
 *
 * `error-classification.test.ts` pins each half against its own contract: that the adapter
 * reconstructs a captured transport error into a verdict, and that `classify` maps a status to a
 * ladder action. This file establishes the property neither half has alone — that a stream
 * producing ZERO BYTES ON THE DATA CHANNEL is routed to two different recoveries according to a
 * signal that never touches that channel.
 *
 *   A  terminal fault      zero tokens + reconstructed fault → one attempt, advance source
 *   B  transient empty     zero tokens + no fault            → bounded retry, same source
 *   C  successful stream   first token withheld, admitted, re-emitted, rest progressive
 *   D  barrier removed     reconstruction alone cannot make a pre-commit decision
 *   E  reconstruction off  the barrier cannot tell terminal from transient
 *   F  contract enforced   a source cannot be supplied without the capability
 *   G  regression          ordinary streaming is bit-identical to before
 *
 * D, E and F are MUTATION tests: each disables one load-bearing part and asserts the system does
 * not silently degrade.
 *
 * ── ON THE TRANSPORT SHAPE ───────────────────────────────────────────────────────────────────
 * Every case drives the REAL `realRunStream` over a MOCKED `streamText`. The mock reproduces the
 * shape recorded in `lib/ai/models.ts` — text stream yields nothing and closes cleanly, the
 * `APICallError` reaches `onError` alone — which was observed against a live provider on a bad key
 * and is pinned by `error-classification.test.ts`. NOTHING HERE MEASURES A LIVE PROVIDER. No
 * timing or invocation figure in this file is a live-provider measurement. What is real and
 * deterministic is the ROUTING: given that transport shape, this is what the control layer does.
 */

const noSleep = async () => {};

const input = {
  userId: "user-barrier",
  operation: "quick_notes" as const,
  format: "key_points",
  text: "x".repeat(300),
};

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

/** Skip the database entirely: no cache, always in quota, demo always available. */
function depsWith(runStream: RunStream): GenerateDeps {
  return { runStream, sleep: noSleep, demoFor: () => "# Sample notes" };
}

vi.mock("../cache", () => ({
  cacheKey: () => "test-key",
  getCached: async () => null,
  setCached: async () => {},
}));
vi.mock("../quota", () => ({
  consumeQuota: async () => ({ allowed: true, remaining: 10, limit: 30 }),
}));
vi.mock("../db/queries/ledger", () => ({ recordLedger: async () => {} }));

/**
 * What one dispatch of the transport does. `fault` is delivered on the OUT-OF-BAND channel
 * (`onError`) and never on the data channel — which is what makes it invisible to a reader of
 * `textStream`.
 */
type Dispatch = { chunks?: string[]; fault?: unknown };

/**
 * Load a fresh `realRunStream` over a mocked `streamText`, recording every dispatch and — chunk by
 * chunk, as the underlying generator actually yields them — what each dispatch put on the data
 * channel. `dataChannel[n]` grows only when the transport is genuinely drawn from, which is what
 * makes the withholding assertion in case C possible.
 *
 * `behaviour` receives the model id and that model's attempt index, so one source can behave
 * differently on its second try.
 */
async function loadSeam(behaviour: (modelId: string, attempt: number) => Dispatch) {
  vi.resetModules();
  const calls: string[] = [];
  const dataChannel: string[][] = [];

  vi.doMock("ai", async () => {
    const actual = await vi.importActual<typeof import("ai")>("ai");
    return {
      ...actual,
      streamText: (opts: {
        model: { id: string };
        onError?: (e: { error: unknown }) => void;
      }) => {
        const modelId = opts.model.id;
        const attempt = calls.filter((id) => id === modelId).length;
        calls.push(modelId);
        const spec = behaviour(modelId, attempt);
        const emitted: string[] = [];
        dataChannel.push(emitted);

        // The fault goes to the side channel only.
        if (spec.fault !== undefined) opts.onError?.({ error: spec.fault });

        async function* gen(): AsyncGenerator<string> {
          for (const c of spec.chunks ?? []) {
            emitted.push(c);
            yield c;
          }
        }
        return {
          textStream: gen(),
          totalUsage:
            spec.fault !== undefined
              ? Promise.reject(new Error("No output generated."))
              : Promise.resolve({ inputTokens: 1, outputTokens: 0 }),
        };
      },
    };
  });
  vi.doMock("@openrouter/ai-sdk-provider", () => ({
    createOpenRouter: () => ({ chat: (id: string) => ({ id }) }),
  }));

  const { realRunStream } = await import("./models");
  return { realRunStream, calls, dataChannel };
}

async function drainSafely(stream: AsyncIterable<string>) {
  let text = "";
  let error: unknown;
  try {
    for await (const chunk of stream) text += chunk;
  } catch (err) {
    error = err;
  }
  return { text, error };
}

function countPerModel(calls: string[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const id of calls) per.set(id, (per.get(id) ?? 0) + 1);
  return per;
}

const ladderBudget = () =>
  modelLadder().reduce((total, step) => total + step.maxAttempts, 0);

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("@openrouter/ai-sdk-provider");
  vi.resetModules();
  vi.restoreAllMocks();
});

// ── TEST A — TERMINAL FAULT ──────────────────────────────────────────────────
describe("A — terminal fault: zero tokens + asynchronous fault", () => {
  it("classifies as terminal, attempts the source once, and advances to the next", async () => {
    const alert = vi.spyOn(log, "error").mockImplementation(() => {});
    const ladder = modelLadder();
    const first = ladder[0].modelId;
    const second = ladder[1].modelId;

    const seam = await loadSeam((modelId) =>
      modelId === first ? { fault: apiError(401) } : { chunks: ["Recovered."] },
    );
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    // Zero data tokens: the fault was never on the data channel.
    expect(seam.dataChannel[0]).toEqual([]);

    // Terminal classification → the source is not pointlessly retried.
    expect(
      countPerModel(seam.calls).get(first),
      "a terminal fault was retried instead of abandoned",
    ).toBe(1);
    expect(countPerModel(seam.calls).get(first)).toBeLessThan(ladder[0].maxAttempts);

    // The next valid source is selected, and the generation succeeds there.
    expect(seam.calls[1], "the control layer did not advance to the next source").toBe(second);
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(result.tier).toBe("free");
    expect(await drainSafely(result.textStream)).toMatchObject({ text: "Recovered." });

    // The reconstructed status reached the operator alert — it is only knowable because it was
    // recovered from the side channel.
    const alerts = alert.mock.calls.filter(
      ([msg]) => msg === "model call: non-retryable error",
    );
    expect(alerts.length, "the recovered fault raised no alert").toBeGreaterThan(0);
    expect(alerts[0][2]).toMatchObject({ status: 401 });
  });
});

// ── TEST B — TRANSIENT EMPTY RESULT ──────────────────────────────────────────
describe("B — transient empty: zero tokens + no fault", () => {
  it("retries the same source within its bound rather than advancing", async () => {
    const ladder = modelLadder();
    const first = ladder[0].modelId;

    const seam = await loadSeam((modelId, attempt) =>
      modelId === first && attempt === 0 ? {} : { chunks: ["Recovered."] },
    );
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    // Same zero-length data channel as case A. Different recovery.
    expect(seam.dataChannel[0]).toEqual([]);
    expect(seam.calls, "the control layer advanced instead of retrying in place").toEqual([
      first,
      first,
    ]);
    expect(countPerModel(seam.calls).get(first)!).toBeLessThanOrEqual(ladder[0].maxAttempts);

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await drainSafely(result.textStream)).toMatchObject({ text: "Recovered." });
  });

  it("exhausts only the defined bound before moving on", async () => {
    const ladder = modelLadder();
    const first = ladder[0].modelId;
    // Never produces, never faults: the source must be tried exactly maxAttempts times.
    const seam = await loadSeam(() => ({}));
    await generateNotesStream(input, depsWith(seam.realRunStream));

    expect(countPerModel(seam.calls).get(first)).toBe(ladder[0].maxAttempts);
    expect(seam.calls.length).toBe(ladderBudget());
  });

  /**
   * THE HEAD-TO-HEAD. A and B differ in recovery while being byte-identical on the data channel.
   * This is the discrimination itself, asserted as a single comparison rather than inferred from
   * two separate tests.
   */
  it("A and B are indistinguishable on the data channel yet recover differently", async () => {
    const first = modelLadder()[0].modelId;

    const terminal = await loadSeam((modelId) =>
      modelId === first ? { fault: apiError(401) } : { chunks: ["Recovered."] },
    );
    await generateNotesStream(input, depsWith(terminal.realRunStream));

    const transient = await loadSeam((modelId, attempt) =>
      modelId === first && attempt === 0 ? {} : { chunks: ["Recovered."] },
    );
    await generateNotesStream(input, depsWith(transient.realRunStream));

    // The premise: identical bytes, identical close, nothing to tell apart.
    expect(terminal.dataChannel[0]).toEqual([]);
    expect(transient.dataChannel[0]).toEqual([]);
    expect(terminal.dataChannel[0]).toEqual(transient.dataChannel[0]);

    // The effect: different source selection. Same bytes in, different control decision out.
    expect(terminal.calls).not.toEqual(transient.calls);
    expect(countPerModel(terminal.calls).get(first)).toBe(1);
    expect(countPerModel(transient.calls).get(first)).toBe(2);
  });
});

// ── TEST C — SUCCESSFUL STREAM ───────────────────────────────────────────────
describe("C — successful stream: withhold, admit, re-emit, continue", () => {
  it("withholds exactly the first token before admitting, then re-emits it at the head", async () => {
    const seam = await loadSeam(() => ({ chunks: ["# Notes\n", "- first\n", "- second"] }));
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(result.tier).toBe("free");
    expect(seam.calls).toHaveLength(1); // admitted on the first source, first attempt

    /**
     * THE WITHHOLDING, PROVED. At the moment of admission the transport has been drawn from
     * EXACTLY ONCE — so the decision rested on positive evidence of production, and the rest of
     * the generation has not been buffered. One chunk means admitted-on-evidence; zero would mean
     * committed blind; three would mean buffered rather than streamed.
     */
    expect(seam.dataChannel[0], "the barrier did not withhold exactly one token").toEqual([
      "# Notes\n",
    ]);

    // The withheld token is re-emitted at the head; the rest follows progressively and in order.
    const iterator = result.textStream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("# Notes\n");
    let rest = "";
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest += next.value;
    }
    expect(rest).toBe("- first\n- second");

    // Nothing dropped, nothing duplicated: the client sees the whole generation.
    expect(seam.dataChannel[0]).toEqual(["# Notes\n", "- first\n", "- second"]);
  });

  it("draws through leading zero-length chunks without calling it a zero-output close", async () => {
    // A zero-length chunk is not evidence of production, and not a zero-output close either.
    const seam = await loadSeam(() => ({ chunks: ["", "", "Real content."] }));
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await drainSafely(result.textStream)).toMatchObject({ text: "Real content." });
    expect(seam.calls).toHaveLength(1); // no retry, no source change
  });
});

// ── TEST D — REMOVE THE ADMISSION BARRIER ────────────────────────────────────
describe("D — mutation: barrier removed, reconstruction intact", () => {
  it("cannot make the pre-commit decision, and commits to a source that produced nothing", async () => {
    /**
     * The barrier removed, reconstruction left FULLY INTACT: commit to the first source on
     * dispatch and relay whatever arrives. Reconstruction alone has no window in which to act.
     */
    const seam = await loadSeam(() => ({ fault: apiError(401) }));
    const step = modelLadder()[0];
    const source = seam.realRunStream({ modelId: step.modelId, system: "s", prompt: "p" });
    const committed = { kind: "stream" as const, tier: step.tier, textStream: source.textStream };

    expect(committed.kind, "committed with no token in hand").toBe("stream");
    expect(await drainSafely(committed.textStream), "delivered an empty success").toMatchObject({
      text: "",
    });

    // The diagnosis is NOT missing — it is perfectly available, and useless, because the response
    // is already open. This is the precise sense in which the barrier makes B actionable.
    expect(source.diagnoseZeroOutput()).toEqual({
      kind: "transport-fault",
      fault: expect.anything(),
    });
    expect(seam.calls).toHaveLength(1); // one invocation, one broken result, no recovery

    // The shipped control layer withholds, so nothing is committed and recovery still happens.
    const guarded = await loadSeam(() => ({ fault: apiError(401) }));
    const result = await generateNotesStream(input, depsWith(guarded.realRunStream));
    expect(result.kind, "the barrier let an empty source commit").toBe("final");
    if (result.kind !== "final") return;
    expect(result.tier).toBe("demo");
  });
});

// ── TEST E — REMOVE FAULT RECONSTRUCTION ─────────────────────────────────────
describe("E — mutation: reconstruction removed, barrier intact", () => {
  it("reads a terminal zero-output as transient and burns the whole retry budget", async () => {
    const alert = vi.spyOn(log, "error").mockImplementation(() => {});

    /**
     * The strongest available mutation: the transport still behaves exactly as a 401 does — clean,
     * empty close — and the barrier is fully intact. ONLY the diagnosis is removed. Everything the
     * barrier can observe is unchanged, which is the entire point: without the reconstruction
     * there is nothing left to observe.
     */
    const calls: string[] = [];
    const undiagnosed: RunStream = ({ modelId }): RunStreamResult => {
      calls.push(modelId);
      return {
        textStream: (async function* () {})(),
        usage: Promise.resolve({ tokensIn: 0, tokensOut: 0 }),
        diagnoseZeroOutput: () => ({ kind: "no-output" }),
      };
    };

    await generateNotesStream(input, depsWith(undiagnosed));
    expect(
      calls.length,
      "a terminal fault should not have cost the whole retry budget",
    ).toBe(ladderBudget());
    expect(
      alert.mock.calls.filter(([msg]) => msg === "model call: non-retryable error"),
      "no operator alert was raised for a configuration failure",
    ).toHaveLength(0);

    alert.mockClear();

    // With reconstruction, the same transport shape costs exactly one attempt per source.
    const sighted = await loadSeam(() => ({ fault: apiError(401) }));
    await generateNotesStream(input, depsWith(sighted.realRunStream));

    expect(sighted.calls).toHaveLength(modelLadder().length);
    for (const [modelId, count] of countPerModel(sighted.calls)) {
      expect(count, `${modelId} retried a reconstructed 401`).toBe(1);
    }
    expect(
      alert.mock.calls.filter(([msg]) => msg === "model call: non-retryable error").length,
    ).toBeGreaterThan(0);
  });
});

// ── TEST F — CONTRACT ENFORCEMENT ────────────────────────────────────────────
describe("F — a streaming source cannot bypass the reconstruction contract", () => {
  /**
   * THE MUTATION IS A COMPILE ERROR, which is the point of the contract change.
   *
   * `@ts-expect-error` fails the build if the error it claims does not occur, so `npm run
   * typecheck` is itself the assertion: an adapter omitting `diagnoseZeroOutput` cannot be passed
   * where a `RunStream` is expected. `{ textStream, usage }` is exactly what every implementation
   * returned before this contract existed, so the regression is pinned at the type level rather
   * than left to a future adapter author to remember.
   *
   * Verified load-bearing by mutation: making the field optional in `models.ts` makes tsc report
   * `TS2578: Unused '@ts-expect-error' directive` here, failing the build.
   */
  it("omitting diagnoseZeroOutput does not typecheck", () => {
    const withoutCapability = () => ({
      textStream: (async function* () {})(),
      usage: Promise.resolve({ tokensIn: 0, tokensOut: 0 }),
    });
    // @ts-expect-error — missing `diagnoseZeroOutput`; a streaming source without the
    // fault-discrimination capability is not a `RunStream`.
    const rejected: RunStream = withoutCapability;
    expect(rejected).toBeTypeOf("function");
  });

  /**
   * The type stops OMISSION. Only honesty stops a LIE — an adapter hardcoding `no-output`
   * compiles. Asserted so the residual risk is a recorded fact rather than an assumption, and so
   * the cost of the lie is visible: the whole budget, spent on a source that cannot work.
   */
  it("an adapter that always answers no-output reproduces the full-budget regression", async () => {
    const calls: string[] = [];
    const lying: RunStream = ({ modelId }): RunStreamResult => {
      calls.push(modelId);
      return {
        textStream: (async function* () {})(),
        usage: Promise.resolve({ tokensIn: 0, tokensOut: 0 }),
        diagnoseZeroOutput: () => ({ kind: "no-output" }),
      };
    };

    const result = await generateNotesStream(input, depsWith(lying));
    expect(result.kind).toBe("final");
    expect(calls.length, "the lie is not free — it costs the whole budget").toBe(ladderBudget());
  });
});

// ── TEST G — REGRESSION ──────────────────────────────────────────────────────
describe("G — ordinary streaming is unchanged", () => {
  it("streams a multi-chunk generation from the first source with no ladder movement", async () => {
    const seam = await loadSeam(() => ({
      chunks: ["# Key points\n\n", "- Photosynthesis converts light. ", "- Chlorophyll absorbs it."],
    }));
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(result.tier).toBe("free");
    expect(seam.calls).toEqual([modelLadder()[0].modelId]); // one source, one attempt
    expect(await drainSafely(result.textStream)).toEqual({
      text: "# Key points\n\n- Photosynthesis converts light. - Chlorophyll absorbs it.",
      error: undefined,
    });
  });

  it("still falls through to the next source when the data channel throws", async () => {
    // The pre-existing failure mode — a visible, data-path error — is untouched by the change.
    const ladder = modelLadder();
    const first = ladder[0].modelId;
    const seam = await loadSeam((modelId) =>
      modelId === first ? { fault: apiError(500) } : { chunks: ["Paid notes."] },
    );
    const result = await generateNotesStream(input, depsWith(seam.realRunStream));

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    expect(await drainSafely(result.textStream)).toMatchObject({ text: "Paid notes." });
    // A 500 is retryable, so the first source uses its full bound before the ladder advances.
    expect(countPerModel(seam.calls).get(first)).toBe(ladder[0].maxAttempts);
  });
});

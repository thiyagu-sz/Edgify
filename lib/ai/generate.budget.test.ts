import { describe, expect, it, vi } from "vitest";

/**
 * `LADDER-EXCEEDS-TIMEOUT` (docs/09 §1.6, docs/06 Phase 5) — the wall-clock budget.
 *
 * THE DEFECT. At the measured ~65s median single-call latency, the ladder can run longer than the
 * 300s Cloud Run request timeout: 3 rungs x (1 attempt + 1 repair) = 6 calls = ~390s. The platform
 * kills the request mid-flight, which is worse than failing, because nothing writes
 * `status = "failed"` (that is the coupled `ZOMBIE-PROCESSING-ROW` defect — see
 * app/api/graph/graph-zombie.integration.test.ts). This is the ORDINARY case under free-tier rate
 * limiting, not a tail: the ladder's whole reason for existing is the first rung not answering.
 *
 * WHY THE CLOCK IS INJECTED RATHER THAN REAL. `generate` already takes `now` in `deps`, so the
 * budget is driven deterministically at the seam the ladder already exposes. A test that actually
 * waited 200s would be untestable in CI and would measure the machine rather than the ladder.
 * Every number below is simulated wall clock, advanced by the fake model and the fake sleep.
 *
 * WHY THE NEGATIVE CONTROL AT THE BOTTOM IS LOAD-BEARING. Every assertion here is that something
 * did NOT take too long — which passes trivially if the harness never pushes past the deadline in
 * the first place. The control runs the SAME harness with the budget lifted and asserts the ladder
 * really does sail past 300s. If it ever goes green, this file has stopped proving anything.
 */

// The ladder's DB neighbours, stubbed: this is a unit test of wall clock, not of persistence.
vi.mock("../cache", () => ({
  cacheKey: () => "budget-test-key",
  getCached: async () => null,
  setCached: async () => {},
}));
vi.mock("../quota", () => ({
  consumeQuota: async () => ({ allowed: true, remaining: 29, limit: 30 }),
}));
vi.mock("../db/queries/ledger", () => ({
  recordLedger: async () => {},
}));

const { generate, ServiceBusyError } = await import("./generate");
type RunModelResult = import("./models").RunModelResult;

/** The platform deadline we must land inside (docs/07, docs/09 §1.6). */
const CLOUD_RUN_REQUEST_TIMEOUT_MS = 300_000;
/** The budget itself — deliberately below the deadline, with room to write `failed` and respond. */
const BUDGET_MS = 200_000;
/** Measured median single-call latency for a graph build (docs/06 Phase 5 end-to-end timing). */
const CALL_MS = 65_000;

/** Below the 3-concept floor, so `sanitizeGraph` rejects it: a malformed result on every rung. */
const TOO_SMALL = {
  title: "Too small",
  concepts: [
    { slug: "a", name: "A", difficulty: "Foundational", summary: "one" },
    { slug: "b", name: "B", difficulty: "Advanced", summary: "two" },
  ],
  edges: [{ prerequisite: "a", dependent: "b" }],
};

const graphInput = {
  userId: "user-budget",
  operation: "graph_structure" as const,
  text: "gradient descent follows the slope of the loss surface. ".repeat(20),
};

/**
 * A fake ladder environment on a SIMULATED clock, so a 200-second budget is provable in
 * milliseconds of real time.
 *
 * The clock is advanced by exactly two things, matching production: a model call (`callMs`) and a
 * backoff `sleep`. The `deadline` seam does NOT advance it — it observes it. A call that cannot
 * finish inside the remaining budget therefore never resolves on its own; it fires the deadline
 * instead, which moves the clock to exactly the deadline and lets the ladder abort the call. That
 * is what a provider still working when the budget runs out looks like.
 */
function harness(
  options: {
    callMs?: number;
    reply?: unknown;
    stall?: boolean;
    /** The budget the ladder is being run with — the harness needs it to know what fits. */
    budgetMs?: number;
  } = {},
) {
  const callMs = options.callMs ?? CALL_MS;
  const budgetMs = options.budgetMs ?? BUDGET_MS;
  let clock = 0;
  const calls: { modelId: string; signalled: boolean }[] = [];
  /** Set when the ladder arms a deadline for the call it is about to make. */
  let fireDeadline: (() => void) | null = null;

  const aborted = () => new DOMException("The operation was aborted.", "AbortError");

  return {
    calls,
    elapsed: () => clock,
    deps: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      random: () => 0.5,
      // Graph structure has no demo tier (docs/03) — tier 5 collapses into tier 6.
      demoFor: () => null,
      deadline: (ms: number) =>
        new Promise<void>((resolve) => {
          fireDeadline = () => {
            clock += ms; // time advances to the deadline, and no further
            resolve();
          };
        }),
      runModel: async ({
        modelId,
        signal,
      }: {
        modelId: string;
        signal?: AbortSignal;
      }): Promise<RunModelResult> => {
        calls.push({ modelId, signalled: signal !== undefined });

        /**
         * A call that cannot complete inside the budget — either because it has STALLED (a
         * provider that accepted the connection and went quiet) or simply because there is not
         * enough clock left for it. Both never return on their own; only an abort ends them.
         *
         * With no signal there is nothing to end them at all, which is the defect: a
         * between-rungs check never runs, because the check only runs when a call returns.
         */
        if (options.stall || clock + callMs > budgetMs) {
          fireDeadline?.();
          return new Promise<RunModelResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(aborted()));
          });
        }

        clock += callMs;
        return { data: options.reply ?? TOO_SMALL, tokensIn: 10, tokensOut: 20 };
      },
    },
  };
}

describe("the graph build cannot outlive its own request", () => {
  it("abandons the ladder before the platform deadline, and lands on the busy tail", async () => {
    const h = harness();

    await expect(
      generate(graphInput, h.deps, { budgetMs: BUDGET_MS }),
    ).rejects.toThrow(ServiceBusyError);

    expect(
      h.elapsed(),
      "the ladder ran past its wall-clock budget — on Cloud Run this request is killed mid-flight " +
        "and the graph row stays `processing` forever",
    ).toBeLessThanOrEqual(BUDGET_MS);

    expect(
      h.elapsed(),
      "the ladder outlived the 300s Cloud Run request timeout",
    ).toBeLessThan(CLOUD_RUN_REQUEST_TIMEOUT_MS);

    // It must stop SHORT of the full ladder: 3 rungs x (attempt + repair) = 6 calls is the
    // unbounded walk. Bounded, it cannot afford all of them.
    expect(h.calls.length).toBeLessThan(6);
  });

  it("the abandonment is distinguishable from an exhausted ladder", async () => {
    const h = harness();
    const error = await generate(graphInput, h.deps, { budgetMs: BUDGET_MS }).catch((e) => e);

    // Same user-facing outcome as any other tier-6 failure (the route maps both to the W4
    // message), but the cause is recorded internally so `failureReason` can tell them apart.
    expect(error).toBeInstanceOf(ServiceBusyError);
    expect(error.name).toBe("GenerationBudgetExceededError");
  });

  it("starts no further call once the budget is spent — including the REPAIR", async () => {
    /**
     * A budget that exactly three calls consume, so the clock lands on zero remaining with a
     * repair as the next thing the ladder would do.
     *
     * The repair is the easiest place in the ladder to get this wrong: it doubles a rung's
     * wall-clock cost and it happens INSIDE the rung, where no between-rungs check can see it. A
     * fix that guarded only the rung boundary passes every other test in this file and still lets
     * a build start a second full-length model call with nothing left on the clock.
     */
    const exactly3Calls = CALL_MS * 3;
    const h = harness({ budgetMs: exactly3Calls });

    await generate(graphInput, h.deps, { budgetMs: exactly3Calls }).catch(() => {});

    expect(h.calls.length, "the ladder started a call it had no budget for").toBe(3);
    expect(h.elapsed()).toBe(exactly3Calls);
  });

  it("bounds a STALLED call, which a between-rungs check alone cannot", async () => {
    const h = harness({ stall: true });

    await expect(
      generate(graphInput, h.deps, { budgetMs: BUDGET_MS }),
    ).rejects.toThrow(ServiceBusyError);

    // Every call carried an abort signal — without one, a stalled call is bounded by nothing
    // below the platform deadline itself.
    expect(
      h.calls.every((c) => c.signalled),
      "a model call was issued with no abort signal, so a stalled provider hangs the request",
    ).toBe(true);
    expect(h.elapsed()).toBeLessThanOrEqual(BUDGET_MS);
  });

  it("an aborted call is not retried as if it were a transport blip", async () => {
    const h = harness({ stall: true });
    await generate(graphInput, h.deps, { budgetMs: BUDGET_MS }).catch(() => {});

    /**
     * An abort throws an error with no HTTP status, and `classify` maps statusless errors to
     * "retry". So the budget check has to run BEFORE classification in the catch, or the ladder
     * politely retries the call it just cancelled and the budget buys nothing.
     */
    expect(
      h.calls.length,
      "the ladder retried a call it had aborted for budget — the budget check must precede classification",
    ).toBe(1);
  });

  it("Quick Notes is unaffected: with no budget the ladder walks as before", async () => {
    const h = harness({ callMs: 1_000, budgetMs: Number.POSITIVE_INFINITY });

    await expect(generate(graphInput, h.deps)).rejects.toThrow(ServiceBusyError);

    // No budget passed → the full unbounded walk, exactly as Phase 3 proved it, and no call
    // carries an abort signal because there is no deadline to enforce.
    expect(h.calls.length).toBe(6);
    expect(h.calls.some((c) => c.signalled)).toBe(false);
  });

  /**
   * THE NEGATIVE CONTROL for every assertion above.
   *
   * "Did not exceed the budget" is a claim about something NOT happening, and it is trivially true
   * of a harness that never gets near the deadline. This runs the identical harness with the
   * budget lifted above the platform timeout, and asserts the ladder genuinely sails past 300s —
   * which is the defect, measured. If this test ever goes green in the same shape as the ones
   * above, the injection has lost its teeth and none of them prove anything.
   */
  it("control: without the budget the ladder really does outlive the 300s deadline", async () => {
    const anHour = 60 * 60_000;
    const h = harness({ budgetMs: anHour });

    await generate(graphInput, h.deps, { budgetMs: anHour }).catch(() => {});

    expect(h.calls.length).toBe(6); // the full ladder: 3 rungs x (attempt + repair)
    expect(
      h.elapsed(),
      "the harness no longer pushes the ladder past the Cloud Run deadline, so the bounded " +
        "assertions above are passing vacuously",
    ).toBeGreaterThan(CLOUD_RUN_REQUEST_TIMEOUT_MS);
  });
});

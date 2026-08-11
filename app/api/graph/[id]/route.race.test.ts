import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/graph/:id — the reap/report race, at the unit level.
 *
 * WHY THIS EXISTS ALONGSIDE THE INTEGRATION TEST. `graph-zombie.integration.test.ts` caught this
 * defect, but only by winning a genuine timing race against a hanging request — it reproduced on a
 * slow container and passed on a fast one, which is exactly the property that lets a bug survive
 * review. Here the race is not raced: the two states are simply the two values `getGraph` returns,
 * so the regression is deterministic, runs in milliseconds, and needs no Docker.
 *
 * THE DEFECT. The poll reads the row, decides it is stale, and issues a conditional UPDATE
 * (`... WHERE status = 'processing'`). When another writer — the build route's own reaper,
 * `finishGraph`, or a concurrent poll — transitions the row first, that UPDATE matches ZERO rows.
 * The route used to fall through and report the status captured BEFORE the write, so the database
 * said `failed` while the response said `processing`.
 */

const getSession = vi.fn();
const getGraph = vi.fn();
const reapAbandonedGraph = vi.fn();
const listConcepts = vi.fn();
const listEdges = vi.fn();
const listMastery = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } },
}));
vi.mock("@/lib/db/queries/graphs", () => ({
  getGraph: (...a: unknown[]) => getGraph(...a),
  reapAbandonedGraph: (...a: unknown[]) => reapAbandonedGraph(...a),
}));
vi.mock("@/lib/db/queries/concepts", () => ({ listConcepts: (...a: unknown[]) => listConcepts(...a) }));
vi.mock("@/lib/db/queries/edges", () => ({ listEdges: (...a: unknown[]) => listEdges(...a) }));
vi.mock("@/lib/db/queries/mastery", () => ({ listMastery: (...a: unknown[]) => listMastery(...a) }));
// Transparent limiter — the wrapper's own behaviour is proven in app/api/rate-limit-coverage.test.ts.
vi.mock("@/lib/rate-limit", () => ({
  withRateLimit: (_name: string, handler: unknown) => handler,
}));

const { GET } = await import("./route");
// The real budget arithmetic, deliberately: a stubbed threshold would let the staleness rule drift.
const { abandonedBefore } = await import("@/lib/graph/build-budget");

const BUILD_FAILED_MESSAGE =
  "Couldn't map this document's structure. Quick Notes still works on it.";

const GRAPH_ID = "11111111-1111-1111-1111-111111111111";
const ctx = { params: Promise.resolve({ id: GRAPH_ID }) };
const request = () => new Request("http://localhost/api/graph/x");

/** A row as the route consumes it. `buildStartedAt` is what decides live vs abandoned. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: GRAPH_ID,
  userId: "user-1",
  title: "Machine learning",
  status: "processing",
  buildStartedAt: null,
  ...over,
});

/** Claimed long enough ago to be past the budget + grace threshold. */
const STALE_CLAIM = new Date(abandonedBefore().getTime() - 60_000);
/** Claimed just now — a live build. */
const LIVE_CLAIM = new Date();

const call = async () => (await GET(request(), ctx)).json();

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: "user-1" } });
  reapAbandonedGraph.mockResolvedValue(false);
  listConcepts.mockResolvedValue([]);
  listEdges.mockResolvedValue([]);
  listMastery.mockResolvedValue([]);
});

describe("losing the reap race must not report a stale status", () => {
  it("reports `failed` when another writer reaped the row first", async () => {
    // First read: stale and processing. The UPDATE then matches nothing because the build route's
    // own reaper already flipped it — this is the integration failure, reproduced deterministically.
    getGraph
      .mockResolvedValueOnce(row({ buildStartedAt: STALE_CLAIM }))
      .mockResolvedValueOnce(row({ status: "failed", buildStartedAt: STALE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(false);

    const body = await call();

    expect(
      body.status,
      "the poll reported the status it read BEFORE its own failed UPDATE — the row is `failed`",
    ).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);
    expect(getGraph, "the route did not re-read after its UPDATE matched nothing").toHaveBeenCalledTimes(2);
  });

  it("reports `ready` when the race was lost to a build that actually finished", async () => {
    /**
     * The reason the fix re-reads instead of assuming `failed`. A slow build can commit `ready`
     * between our read and our UPDATE; answering `failed` there would throw away a graph that
     * exists and tell the user their upload failed when it did not.
     */
    getGraph
      .mockResolvedValueOnce(row({ buildStartedAt: STALE_CLAIM }))
      .mockResolvedValueOnce(row({ status: "ready", buildStartedAt: STALE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(false);

    const body = await call();

    expect(body.status).toBe("ready");
    expect(body.title).toBe("Machine learning");
  });

  it("still reports `failed` when its own reap wins", async () => {
    getGraph.mockResolvedValue(row({ buildStartedAt: STALE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(true);

    const body = await call();

    expect(body.status).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);
    // The winner already knows the outcome; a second read would be a wasted round trip.
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("never leaks the internal failure reason", async () => {
    getGraph.mockResolvedValue(row({ buildStartedAt: STALE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(true);
    const body = await call();
    expect(JSON.stringify(body)).not.toMatch(/failureReason|failure_reason|abandon|budget|ladder/i);
  });
});

describe("the DATABASE decides abandonment, not this route", () => {
  /**
   * THE REGRESSION THAT MATTERS. The route used to gate the reaper behind its own in-memory
   * staleness test, so a snapshot that disagreed with the committed row — for any reason — meant
   * the reaper was never consulted at all and the poll answered `processing` forever.
   *
   * `reapAbandonedGraph` already encodes every condition (`processing`, claimed, past the
   * threshold) and evaluates them against the real row. It must therefore be ASKED, not
   * second-guessed.
   */
  it("consults the reaper even when the snapshot's claim looks live", async () => {
    getGraph.mockResolvedValue(row({ buildStartedAt: LIVE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(false);

    await call();

    expect(
      reapAbandonedGraph,
      "the route skipped the reaper on its own in-memory judgement — the original defect",
    ).toHaveBeenCalledTimes(1);
  });

  it("consults the reaper even when the snapshot shows no claim at all", async () => {
    // A null claim in our snapshot is exactly the case that cannot be trusted: the row may have
    // been claimed and aged since. SQL's `buildStartedAt IS NOT NULL` still protects unclaimed rows.
    getGraph.mockResolvedValue(row({ buildStartedAt: null }));
    reapAbandonedGraph.mockResolvedValue(false);

    await call();

    expect(reapAbandonedGraph).toHaveBeenCalledTimes(1);
  });

  it("retires the build whenever the reaper says it matched, whatever the snapshot said", async () => {
    // The snapshot claims the build is live; the database disagrees and reaps it. The database wins.
    getGraph.mockResolvedValue(row({ buildStartedAt: LIVE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(true);

    const body = await call();

    expect(body.status).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);
  });
});

describe("healthy builds still behave, and the hot path stays cheap", () => {
  it("a LIVE build reports processing and is not re-read", async () => {
    getGraph.mockResolvedValue(row({ buildStartedAt: LIVE_CLAIM }));
    reapAbandonedGraph.mockResolvedValue(false);

    const body = await call();

    expect(body.status).toBe("processing");
    // One read plus the reaper's no-op UPDATE. A second read here would double the cost of the
    // request the client repeats every 1.5s for 90s.
    expect(getGraph, "the hot polling path re-read the row unnecessarily").toHaveBeenCalledTimes(1);
  });

  it("an unclaimed graph reports processing", async () => {
    getGraph.mockResolvedValue(row({ buildStartedAt: null }));
    reapAbandonedGraph.mockResolvedValue(false);

    const body = await call();

    expect(body.status).toBe("processing");
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("a READY graph is never reaped, however old its claim looks", async () => {
    getGraph.mockResolvedValue(row({ status: "ready", buildStartedAt: STALE_CLAIM }));

    const body = await call();

    expect(body.status).toBe("ready");
    expect(
      reapAbandonedGraph,
      "a finished graph was offered to the reaper — a late reap must never undo `ready`",
    ).not.toHaveBeenCalled();
    expect(getGraph).toHaveBeenCalledTimes(1);
  });

  it("an already-failed graph is never reaped", async () => {
    getGraph.mockResolvedValue(row({ status: "failed", buildStartedAt: STALE_CLAIM }));

    const body = await call();

    expect(body.status).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);
    expect(reapAbandonedGraph).not.toHaveBeenCalled();
  });
});

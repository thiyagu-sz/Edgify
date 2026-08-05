import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db/client";
import { getGraph } from "@/lib/db/queries/graphs";
import { getRemaining } from "@/lib/quota";
import { createTestUser } from "@/test/factories";

/**
 * `ZOMBIE-PROCESSING-ROW` (docs/09 §1.6, docs/06 Phase 5) — against the real database and the
 * real routes. The model is the only thing faked.
 *
 * THE DEFECT. A mid-flight platform kill writes nothing: `failGraph` is never reached, so
 * `graphs.status` stays `"processing"` forever. Three consequences, and the third is the expensive
 * one:
 *
 *   1. `GET /api/graph/:id` reports `processing` indefinitely. The never-fail promise (docs/04)
 *      becomes NEVER-RESOLVE, which is worse than an honest error because nothing surfaces it.
 *   2. The client polls to its 90s timeout over a graph that will never resolve.
 *   3. `POST /api/graph/:id/build` is idempotent on `status = "processing"` — it refuses FINISHED
 *      graphs. A zombie is still `processing`, so a retry is PERMITTED and RE-SPENDS. There is no
 *      reaper, so this repeats indefinitely.
 *
 * HOW THE KILL IS SIMULATED, and why it is faithful. The fake model returns a promise that is
 * never settled, and the test never awaits the route call. So the handler never returns and
 * nothing is written — which is precisely what a `kill -9`, an instance eviction or a platform
 * timeout leaves behind. The fake deliberately IGNORES the abort signal the wall-clock budget
 * passes: this test is about the case the budget cannot save you from (the process is simply
 * gone), so it must not be quietly rescued by it. The budget's own path is proven separately in
 * lib/ai/generate.budget.test.ts.
 *
 * WHY THE ROW IS AGED WITH SQL RATHER THAN A MOCKED CLOCK. Staleness is a fact about the database,
 * so the test makes it one: it shifts `buildStartedAt` ten minutes into the past, which is what an
 * abandoned row genuinely looks like ten minutes later. `COALESCE` so it works whether or not the
 * build got far enough to claim the row.
 */

/** Set per test: what the fake model does, and how many times it was called. */
const model = vi.hoisted(() => ({
  calls: [] as string[],
  reply: null as unknown,
  /** When true, the call never settles — the process is gone. */
  hang: false,
}));

vi.mock("@/lib/ai/models", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/models")>("@/lib/ai/models");
  return {
    ...actual,
    realRunModel: async ({ modelId }: { modelId: string }) => {
      model.calls.push(modelId);
      if (model.hang) return new Promise(() => {}); // never settles, never aborts
      return { data: model.reply, tokensIn: 10, tokensOut: 20 };
    },
  };
});

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
    },
  },
}));

const { POST: postDocuments } = await import("../documents/route");
const { POST: postBuild } = await import("./[id]/build/route");
const { GET: getGraphRoute } = await import("./[id]/route");

const BUILD_FAILED_MESSAGE =
  "Couldn't map this document's structure. Quick Notes still works on it.";

/** A valid structure, for the runs that are allowed to succeed. */
const GOOD_STRUCTURE = {
  title: "Machine learning",
  concepts: [
    { slug: "calc", name: "Calculus", difficulty: "Foundational", summary: "Rates of change." },
    { slug: "linalg", name: "Linear algebra", difficulty: "Foundational", summary: "Vectors." },
    { slug: "gd", name: "Gradient descent", difficulty: "Intermediate", summary: "Optimisation." },
    { slug: "nn", name: "Neural networks", difficulty: "Advanced", summary: "Layers." },
  ],
  edges: [
    { prerequisite: "calc", dependent: "gd" },
    { prerequisite: "linalg", dependent: "gd" },
    { prerequisite: "gd", dependent: "nn" },
  ],
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * EVERY REQUEST HERE CARRIES A UNIQUE CLIENT IP, and it has to.
 *
 * `withRateLimit` buckets per IP, and a `Request` with no `x-forwarded-for` resolves to the
 * literal key `unknown` — so every test in the suite that omits the header shares ONE bucket, and
 * `graph-build` allows 20/minute. This file fires enough builds to consume half of that on its
 * own, which is exactly how it broke a passing ownership test in `graph-build.integration.test.ts`
 * the first time both ran together: that test got a calm 429 where it asserted a 404, in a file it
 * shares no data with. A cross-file coupling through a rate-limit bucket is invisible at the point
 * of failure, so this file opts out of the shared bucket entirely.
 */
let ipSeq = 0;
const uniqueIp = () => `203.0.113.${++ipSeq % 254}.${Date.now() % 1000}`;
const headers = () => ({ "x-forwarded-for": uniqueIp() });

const buildRequest = () =>
  new Request("http://localhost/build", { method: "POST", headers: headers() });
const readRequest = () => new Request("http://localhost/g", { headers: headers() });

const documentText = (marker: string) =>
  (`${marker}. ` + "Gradient descent follows the slope of the loss surface. ".repeat(20)).trim();

function upload(text: string, filename = "lecture.txt"): Request {
  const form = new FormData();
  form.set("file", new File([text], filename, { type: "text/plain" }));
  return new Request("http://localhost/api/documents", { method: "POST", body: form });
}

/**
 * Make an abandoned row look its age. Relative (`coalesce`), so it works whether or not the build
 * got far enough to claim the row. Seconds rather than minutes because `make_interval(mins => …)`
 * takes an integer, and the threshold cases below are deliberately fractional.
 */
async function ageBuild(graphId: string, seconds: number) {
  await db.execute(
    sql`update graphs
        set build_started_at = coalesce(build_started_at, now()) - make_interval(secs => ${seconds})
        where id = ${graphId}::uuid`,
  );
}

/** Upload a document and abandon its build mid-flight, exactly as a platform kill would. */
async function abandonedBuild(userId: string) {
  session.userId = userId;
  const uploaded = await postDocuments(upload(documentText(`zombie-${randomUUID()}`)));
  const { graphId } = await uploaded.json();

  model.hang = true;
  const killed = postBuild(buildRequest(), ctx(graphId));
  // The handler is still inside the model call and will never return. Nothing has been written.
  const settled = await Promise.race([
    killed.then(() => "returned"),
    new Promise((r) => setTimeout(() => r("pending"), 50)),
  ]);
  expect(settled, "the build returned — this no longer simulates a mid-flight kill").toBe("pending");
  model.hang = false;

  return graphId as string;
}

beforeEach(() => {
  model.calls.length = 0;
  model.reply = GOOD_STRUCTURE;
  model.hang = false;
});

describe("a build killed mid-flight cannot leave a zombie row", () => {
  it("the poll RESOLVES instead of reporting processing forever", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);

    // The premise: the kill wrote nothing, so the row is still `processing`.
    expect((await getGraph(userId, graphId))?.status).toBe("processing");

    // Ten minutes later, with no process alive to finish it.
    await ageBuild(graphId, 600); // ten minutes

    const body = await (await getGraphRoute(readRequest(), ctx(graphId))).json();

    expect(
      body.status,
      "the poll still reports `processing` on an abandoned build — never-fail has become never-resolve",
    ).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);

    // And the row itself is now honestly failed, not just reported as such.
    expect((await getGraph(userId, graphId))?.status).toBe("failed");

    // The user never learns why (docs/03 — `failureReason` is internal).
    expect(JSON.stringify(body)).not.toMatch(/failureReason|failure_reason|budget|ladder|abandon/i);
  });

  it("a retry on a stale row does NOT re-spend — the expensive consequence", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);
    await ageBuild(graphId, 600); // ten minutes

    const callsBeforeRetry = model.calls.length;
    const quotaBeforeRetry = (await getRemaining(userId)).remaining;

    const body = await (await postBuild(buildRequest(), ctx(graphId))).json();

    expect(
      model.calls.length,
      "re-firing the build on a zombie row spent another generation — with no reaper this repeats indefinitely",
    ).toBe(callsBeforeRetry);
    expect(
      (await getRemaining(userId)).remaining,
      "the retry consumed a generation from the daily allowance",
    ).toBe(quotaBeforeRetry);

    expect(body.status).toBe("failed");
    expect(body.message).toBe(BUILD_FAILED_MESSAGE);
  });

  it("repeated retries stay free, rather than re-spending each time", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);
    await ageBuild(graphId, 600); // ten minutes

    const callsBefore = model.calls.length;
    for (let i = 0; i < 3; i++) {
      await postBuild(buildRequest(), ctx(graphId));
    }

    expect(
      model.calls.length - callsBefore,
      "each retry on the zombie spent another generation",
    ).toBe(0);
  });

  /**
   * THE NEGATIVE CONTROL for every assertion above.
   *
   * The three tests above all assert that a stale row is reaped and cannot be rebuilt. A reaper
   * that failed EVERY `processing` row would satisfy all of them — and would kill every live build
   * in production, turning a rare zombie into a total outage. This proves the reaper discriminates:
   * a build claimed seconds ago is LIVE, must not be touched, and must still report `processing`.
   */
  it("control: a LIVE build is not reaped, and still reports processing", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);

    // No ageing: this row was claimed moments ago and, as far as anyone knows, is still running.
    const body = await (await getGraphRoute(readRequest(), ctx(graphId))).json();

    expect(
      body.status,
      "a live in-flight build was reaped as abandoned — this would fail every build in production",
    ).toBe("processing");
    expect((await getGraph(userId, graphId))?.status).toBe("processing");
  });

  /**
   * The second half of the same control. A live row must also be refused by the BUILD route
   * without spending — the pre-existing idempotency behaviour — rather than being reclaimed as
   * though it were abandoned.
   */
  it("control: a LIVE build is refused by the build route without a second model call", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);

    const callsBefore = model.calls.length;
    const body = await (await postBuild(buildRequest(), ctx(graphId))).json();

    expect(body.status).toBe("processing");
    expect(
      model.calls.length,
      "a concurrent build for a live row spent a second model call",
    ).toBe(callsBefore);
  });

  /**
   * The staleness threshold must sit ABOVE the wall-clock budget, or the reaper races the build it
   * is supposed to be a backstop for: a legitimately slow build, still inside its budget and about
   * to succeed, would be marked `failed` underneath itself and its result thrown away.
   */
  it("a build still inside the wall-clock budget is never reaped", async () => {
    const userId = await createTestUser();
    const graphId = await abandonedBuild(userId);

    // 200s budget: at three and a half minutes this build is slow, but entirely legitimate.
    await ageBuild(graphId, 210); // three and a half minutes

    const body = await (await getGraphRoute(readRequest(), ctx(graphId))).json();
    expect(
      body.status,
      "a build inside its wall-clock budget was reaped — the threshold is racing the budget",
    ).toBe("processing");
  });
});

describe("the reaper does not disturb builds that finish normally", () => {
  it("a healthy build still goes to ready and reads back intact", async () => {
    const userId = await createTestUser();
    session.userId = userId;

    const uploaded = await postDocuments(upload(documentText(`healthy-${randomUUID()}`)));
    const { graphId } = await uploaded.json();

    const build = await (await postBuild(buildRequest(), ctx(graphId))).json();
    expect(build.status).toBe("ready");

    const body = await (await getGraphRoute(readRequest(), ctx(graphId))).json();
    expect(body.status).toBe("ready");
    expect(body.concepts).toHaveLength(4);
  });

  it("a graph that reached `ready` is never reaped, however old its claim looks", async () => {
    const userId = await createTestUser();
    session.userId = userId;

    const uploaded = await postDocuments(upload(documentText(`old-ready-${randomUUID()}`)));
    const { graphId } = await uploaded.json();
    await postBuild(buildRequest(), ctx(graphId));

    // An hour later. The claim is ancient, but the graph finished — status is what decides.
    await ageBuild(graphId, 3600); // an hour

    const body = await (await getGraphRoute(readRequest(), ctx(graphId))).json();
    expect(body.status, "a finished graph was reaped because its claim looked old").toBe("ready");
  });
});

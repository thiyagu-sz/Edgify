import { auth } from "@/lib/auth";
import { listConcepts } from "@/lib/db/queries/concepts";
import { listEdges } from "@/lib/db/queries/edges";
import { listMastery } from "@/lib/db/queries/mastery";
import { getGraph, reapAbandonedGraph } from "@/lib/db/queries/graphs";
import { abandonedBefore } from "@/lib/graph/build-budget";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/graph/:id — the graph, and the status the client polls on (W4, docs/05).
 *
 * `failureReason` is INTERNAL ONLY (docs/03) and never appears in the response. A failed graph
 * returns the fixed W4 message and nothing else — no cause, no status code, no vendor name.
 *
 * RATE LIMIT ARITHMETIC, and why it is coupled to next-slice polling backoff. The client polls
 * every 1.5s for up to 90s, so ONE user costs ~40 requests/minute. At 600/min per IP that is
 * ~15 concurrent builders behind a single address — and a shared campus NAT puts a whole class
 * behind one address, which is exactly the population this feature is designed for. A class of 30
 * uploading together would need ~1200/min and would start seeing calm 429s.
 *
 * So 600 is not a number that holds on its own. What makes it hold is the polling backoff in the
 * next slice's UI — 1.5s for the first ~15s, then 3s — which roughly halves the steady-state cost
 * and brings a 30-student class inside the budget. THAT BACKOFF IS PART OF THIS LIMIT, not
 * optional polish: shipping the graph UI with a flat 1.5s poll would turn this route into the
 * feature's own bottleneck. The route itself is cheap (one indexed read while processing, no
 * spend), which is why the limit is generous rather than tight.
 *
 * Response contract:
 *   200 `{ status: "processing" }`                     — still building; one round trip
 *   200 `{ status: "ready", title, concepts, edges, mastery }`  — the graph
 *   200 `{ status: "failed", message }`                — the W4 message
 *   401 / 404 `{ message }`
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const BUILD_FAILED_MESSAGE =
  "Couldn't map this document's structure. Quick Notes still works on it.";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request, ctx: RouteContext): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }
  const userId = session.user.id;
  const { id: graphId } = await ctx.params;

  const graph = await getGraph(userId, graphId);
  if (!graph) {
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 404);
  }

  if (graph.status === "failed") {
    return json({ status: "failed", message: BUILD_FAILED_MESSAGE });
  }

  // While processing, the poll costs exactly ONE round trip — there is nothing to read yet, and
  // this is the state the client sits in for up to 90 seconds.
  if (graph.status !== "ready") {
    /**
     * THE POLL IS WHERE AN ABANDONED BUILD IS RETIRED (docs/09 §1.6).
     *
     * A build killed mid-flight writes nothing, so its row stays `processing` forever and this
     * route would answer `processing` indefinitely — the never-fail promise (docs/04) becoming
     * never-RESOLVE, which is worse than an honest error because nothing surfaces it. Retiring it
     * here means the transition happens exactly when somebody is waiting on the answer, which is
     * why no background reaper is needed.
     *
     * THE ROUND-TRIP COST IS UNCHANGED on the normal path: staleness is decided in memory from the
     * row already fetched above, so only a genuinely abandoned build pays for the write. That
     * matters — this is the request the client repeats every 1.5s for up to 90s, and the 600/min
     * limit on this route is built on it costing one query.
     */
    const stale =
      graph.buildStartedAt !== null && graph.buildStartedAt < abandonedBefore();
    if (stale && (await reapAbandonedGraph(userId, graphId, abandonedBefore()))) {
      return json({ status: "failed", message: BUILD_FAILED_MESSAGE });
    }
    return json({ status: graph.status, title: graph.title });
  }

  /**
   * Independent reads of different tables, none depending on another's result — issued together
   * rather than paying three sequential round trips.
   *
   * `mastery` joined this payload in the UI slice. It has to arrive with the graph: node colour,
   * every readiness ring and the whole study plan are functions of it, so fetching it separately
   * would mean either a second round trip before the first paint or a visible flash of an
   * all-locked graph that then recolours. It is the caller's own row set, keyed
   * `(userId, conceptId)`, so it costs one indexed read and reveals nothing new.
   */
  const [concepts, edges, mastery] = await Promise.all([
    listConcepts(userId, graphId),
    listEdges(userId, graphId),
    listMastery(userId, graphId),
  ]);

  // Concept ids are internal; edges are re-expressed in SLUG space so the client never needs them
  // and the payload stays stable across a clone (which mints fresh ids for the same slugs).
  const slugById = new Map(concepts.map((c) => [c.id, c.slug]));

  return json({
    status: "ready",
    title: graph.title,
    concepts: concepts.map((concept) => ({
      id: concept.id,
      slug: concept.slug,
      name: concept.name,
      difficulty: concept.difficulty,
      summary: concept.summary,
      estimatedMinutes: concept.estimatedMinutes,
      layoutX: concept.layoutX,
      layoutY: concept.layoutY,
      layoutW: concept.layoutW,
      // Whether the lazy W5 detail has been generated — not the payload itself, which the
      // concept-detail route serves on demand.
      hasDetail: concept.detailJson !== null,
    })),
    // Slug-keyed like `edges`, so the client never handles concept ids for readiness maths and
    // the payload survives a clone unchanged (a clone mints fresh ids for the same slugs).
    mastery: mastery.flatMap((row) => {
      const slug = slugById.get(row.conceptId);
      return slug && row.state ? [{ slug, state: row.state }] : [];
    }),
    edges: edges.flatMap((edge) => {
      const prerequisite = slugById.get(edge.prerequisiteId);
      const dependent = slugById.get(edge.dependentId);
      return prerequisite && dependent ? [{ prerequisite, dependent }] : [];
    }),
  });
}

export const GET = withRateLimit<RouteContext>("graph-read", handler, {
  limit: 600,
  windowMs: 60_000,
});

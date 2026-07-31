import { ServiceBusyError, generate } from "@/lib/ai/generate";
import { auth } from "@/lib/auth";
import { getDocument } from "@/lib/db/queries/documents";
import { failGraph, finishGraph, getGraph } from "@/lib/db/queries/graphs";
import { computeLayout, estimatedMinutesFor } from "@/lib/graph/layout";
import { log } from "@/lib/log";
import { withRateLimit } from "@/lib/rate-limit";
import type { Graph } from "@/lib/ai/schemas";

/**
 * POST /api/graph/:id/build — run the structure extraction (W4 steps 12–17, docs/05).
 *
 * WHY THIS IS A SEPARATE, CLIENT-FIRED REQUEST rather than `after()` inside POST /api/documents:
 * `after()` depends on Cloud Run keeping CPU allocated after the response is sent, which this
 * project has not configured or verified. If that assumption is wrong the build is throttled or
 * killed mid-flight and EVERY upload silently ends in `failed`, with no application-level
 * symptom. Folding it back in is a Phase 7 optimisation to adopt only once CPU-after-response is
 * confirmed, keeping this route as the fallback (docs/06 Phase 7). Do not reverse the order.
 *
 * IDEMPOTENT on `status = "processing"`. The cheap pre-check below rejects a re-fire before
 * spending a model call; the authoritative guard is the conditional UPDATE inside `finishGraph`,
 * which holds the row lock so two simultaneous builds can never both write concepts.
 *
 * BOTH LADDER TIERS 5 AND 6 LAND ON `failed` HERE. There is no demo graph: substituting curated
 * content would persist concepts and edges under the user's own graphId describing a document
 * they never uploaded (docs/03 §graphs). `lib/demo/index.ts` does not answer `graph_structure`,
 * so the ladder cannot reach one by accident, and the user gets the honest W4 message over a
 * document they still own — with Quick Notes still working on it.
 *
 * Response contract:
 *   200 `{ status }`             — "ready", or "processing"/"ready"/"failed" from a no-op re-fire
 *   200 `{ status, message }`    — "failed", with the W4 message
 *   401 `{ message }`            — no session
 *   404 `{ message }`            — not this user's graph (or no such graph)
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** docs/04 §7 — the exact string, never a paraphrase. */
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

  // Step 12: ownership. `getGraph` filters on BOTH the id and the userId, so a guessed uuid is
  // indistinguishable from a missing graph — which is what we want it to look like.
  const graph = await getGraph(userId, graphId);
  if (!graph) {
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 404);
  }

  /**
   * Idempotency, cheap half. A retry or a double-fire after the build finished stops here without
   * touching a model. The expensive half — two builds that BOTH pass this check before either
   * commits — is closed by the conditional UPDATE in `finishGraph`; the accepted cost there is at
   * most one wasted model call (see that function's note).
   */
  if (graph.status !== "processing") {
    return json({
      status: graph.status,
      ...(graph.status === "failed" ? { message: BUILD_FAILED_MESSAGE } : {}),
    });
  }

  const document = await getDocument(userId, graph.documentId);
  if (!document?.extractedText) {
    log.error("graph build: document text missing", undefined, { userId, graphId });
    await failGraph(userId, graphId, "document text missing");
    return json({ status: "failed", message: BUILD_FAILED_MESSAGE });
  }

  // Steps 13–14: the ladder, then Zod validation with one repair, dangling edges dropped and
  // cycles broken. All of that lives inside `generate` / `sanitizeGraph` — never here.
  let result;
  try {
    result = await generate({
      userId,
      operation: "graph_structure",
      text: document.extractedText,
    });
  } catch (error) {
    if (!(error instanceof ServiceBusyError)) {
      log.error("graph build: unexpected failure", error, { userId, graphId });
    }
    // Tier 5 and tier 6 both land here, because there is no demo graph to serve.
    await failGraph(
      userId,
      graphId,
      error instanceof ServiceBusyError ? "ladder exhausted" : "unexpected build failure",
    );
    return json({ status: "failed", message: BUILD_FAILED_MESSAGE });
  }

  const structure = result.data as Graph;

  // Step 15: layer-based layout, computed once and stored (docs/03).
  const { placed } = computeLayout(structure.concepts, structure.edges);
  const layoutBySlug = new Map(placed.map((p) => [p.slug, p]));

  // Steps 16–17: insert concepts and edges and flip to `ready`, atomically.
  const committed = await finishGraph(userId, graphId, {
    title: structure.title || (document.title ?? "Your document"),
    modelId: result.modelId ?? graph.modelId,
    concepts: structure.concepts.map((concept) => {
      const layout = layoutBySlug.get(concept.slug);
      return {
        slug: concept.slug,
        name: concept.name,
        difficulty: concept.difficulty,
        summary: concept.summary,
        estimatedMinutes: estimatedMinutesFor(concept.difficulty),
        layoutX: layout?.layoutX ?? 0,
        layoutY: layout?.layoutY ?? 0,
        layoutW: layout?.layoutW ?? 146,
      };
    }),
    edges: structure.edges,
  });

  if (!committed) {
    // Another build won the race and already finished this graph. Report its real state rather
    // than inventing one — this is a no-op, not a failure.
    const current = await getGraph(userId, graphId);
    return json({
      status: current?.status ?? "failed",
      ...(current?.status === "failed" ? { message: BUILD_FAILED_MESSAGE } : {}),
    });
  }

  return json({ status: "ready" });
}

export const POST = withRateLimit<RouteContext>("graph-build", handler, {
  limit: 20,
  windowMs: 60_000,
});

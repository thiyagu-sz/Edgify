import { auth } from "@/lib/auth";
import { getOrCreateConceptDetail } from "@/lib/graph/concept-detail";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/concepts/:id/detail — the lazy concept explanation (W5, docs/05).
 *
 * Thin by design (AGENTS.md): session, delegate to `lib/graph/concept-detail`, shape the
 * response. The ownership walk, the ladder and the persist all live in the service.
 *
 * RATE LIMIT: 30/min per IP, matching `/api/documents` rather than the generous `graph-read`
 * budget, because this route CAN SPEND. One click is one request and a real session clicks a
 * handful of concepts a minute, so 30 is far above human use while still capping what a single
 * address can drive into the model tier. A campus NAT shares it, but the per-user daily quota is
 * the binding constraint there anyway, and a cache hit — the common case for a class working from
 * one lecture PDF — costs no tokens at all.
 *
 * Response contract:
 *   200 `{ status: "ready", detail, cached }`     — the explanation
 *   200 `{ status: "unavailable", summary, message }` — ladder exhausted; panel falls back
 *   401 `{ message }` — no session
 *   404 `{ message }` — not this user's concept (or no such concept)
 * Never a stack, a status code, or a vendor name in the body (docs/04 §7).
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** docs/04 §7 — the W5 fallback line, never a paraphrase. */
const DETAIL_UNAVAILABLE_MESSAGE = "A detailed explanation couldn't be generated.";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request, ctx: RouteContext): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }
  const { id: conceptId } = await ctx.params;

  const result = await getOrCreateConceptDetail(session.user.id, conceptId);

  if (result.status === "not_found") {
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 404);
  }
  if (result.status === "unavailable") {
    return json({
      status: "unavailable",
      summary: result.summary,
      message: DETAIL_UNAVAILABLE_MESSAGE,
    });
  }
  return json({ status: "ready", detail: result.detail, cached: result.cached });
}

export const POST = withRateLimit<RouteContext>("concept-detail", handler, {
  limit: 30,
  windowMs: 60_000,
});

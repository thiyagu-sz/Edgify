import { auth } from "@/lib/auth";
import { log } from "@/lib/log";
import { getRemaining } from "@/lib/quota";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * GET /api/usage — the user's remaining daily generations, for the UI counter (docs/04 §5).
 *
 * Read-only and non-consuming (`getRemaining`, not `consumeQuota`): showing the counter must
 * never cost the user a generation. Thin (AGENTS.md): session → query → shape.
 *
 * Rate limited per IP ahead of the session lookup (docs/06 Phase 2): unwrapped, an
 * unauthenticated caller drives a session DB read on every request before being rejected. The
 * limit is generous — the UI polls this after every generation, and a shared campus NAT puts a
 * whole class behind one address.
 */

export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json(
      { message: "Please sign in again to continue." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { remaining, limit } = await getRemaining(session.user.id);
    return Response.json(
      { remaining, limit },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // The counter is a nicety; a DB hiccup must not break the page. Report "unknown" calmly.
    log.error("usage: failed to read remaining quota", err, { userId: session.user.id });
    return Response.json(
      { remaining: null, limit: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = withRateLimit("usage", handler, {
  limit: 120,
  windowMs: 60_000,
});

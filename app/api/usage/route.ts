import { auth } from "@/lib/auth";
import { log } from "@/lib/log";
import { getRemaining } from "@/lib/quota";

/**
 * GET /api/usage — the user's remaining daily generations, for the UI counter (docs/04 §5).
 *
 * Read-only and non-consuming (`getRemaining`, not `consumeQuota`): showing the counter must
 * never cost the user a generation. Thin (AGENTS.md): session → query → shape.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
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

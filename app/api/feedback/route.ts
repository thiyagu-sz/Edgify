import { auth } from "@/lib/auth";
import { createFeedback } from "@/lib/db/queries/feedback";
import { feedbackRequestSchema } from "@/lib/feedback";
import { log } from "@/lib/log";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/feedback — record one piece of product feedback.
 *
 * Thin, as AGENTS.md requires: session → validate → one query-layer call → shape the response.
 * No model call, no spend, one indexed insert.
 *
 * THE AUTHOR IS THE SESSION, NEVER THE BODY. `feedbackRequestSchema` has no `userId` field and no
 * `status` field, so neither can be supplied by a caller: authorship comes from
 * `session.user.id`, and status takes the column default. A schema that merely ignored a
 * client-sent `userId` would still be one careless spread away from trusting it.
 *
 * RATE LIMIT: 10/min per IP. Feedback is a deliberate, typed act — nobody legitimately files ten
 * reports a minute — but the limit is per IP and a campus NAT puts a whole class behind one
 * address, so it is set to absorb several people reporting the same outage at once rather than to
 * ration one person. The wrapper runs BEFORE the session lookup, which is what stops an
 * unauthenticated flood from driving a session read per request (docs/06 Phase 2).
 *
 * Response contract:
 *   201 `{ ok: true }`   — recorded
 *   400 `{ message }`    — body failed validation
 *   401 `{ message }`    — no session
 *   500 `{ message }`    — the write failed; nothing about why (docs/04 §7)
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }

  const body = await request.json().catch(() => null);
  const parsed = feedbackRequestSchema.safeParse(body);
  if (!parsed.success) {
    /**
     * The specific reason is deliberately not returned. The form validates the same schema before
     * submitting, so a request that reaches here with a bad body is a client bug or a hand-rolled
     * call — neither of which is helped by a field-level error, and echoing Zod's issues back
     * would leak the shape of the table (docs/04 §7).
     */
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 400);
  }

  try {
    await createFeedback(session.user.id, parsed.data);
  } catch (error) {
    // The user's words are gone if we do not say so; be honest rather than silently dropping it.
    log.error("feedback: write failed", error, { userId: session.user.id, type: parsed.data.type });
    return json({ message: "Couldn't send that just now. Please try again in a moment." }, 500);
  }

  return json({ ok: true }, 201);
}

export const POST = withRateLimit("feedback", handler, {
  limit: 10,
  windowMs: 60_000,
});

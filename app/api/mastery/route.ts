import { z } from "zod";
import { auth } from "@/lib/auth";
import { upsertMastery } from "@/lib/db/queries/mastery";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/mastery — record one concept's progress (W6, docs/05).
 *
 * "Pure client and database work. No model calls, so these must never fail or show a busy state."
 * The client recomputes readiness locally and re-renders immediately; this write is what makes
 * that survive a reload. Nothing here can cost money.
 *
 * RATE LIMIT: 120/min per IP, matching `/api/usage`. Marking mastery is a click, and a student
 * working through a study plan marks several in quick succession; a campus NAT puts a whole class
 * behind one address. The route does one indexed upsert and no model call, so a generous budget
 * costs nothing and a tight one would produce 429s during ordinary use.
 *
 * Response contract:
 *   200 `{ ok: true }`   — written
 *   400 `{ message }`    — body failed validation
 *   401 `{ message }`    — no session
 *   404 `{ message }`    — not this user's concept (or no such concept); nothing was written
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The prototype's three states (W6). Anything else is a client bug, not a new state. */
export const masteryRequestSchema = z.object({
  conceptId: z.string().uuid(),
  state: z.enum(["locked", "learning", "known"]),
});

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }

  const body = await request.json().catch(() => null);
  const parsed = masteryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 400);
  }

  /**
   * `upsertMastery` gates the write on the concept resolving through a graph the caller owns, in
   * the same statement as the insert. The primary key alone would happily accept another user's
   * `conceptId`: that leaks nothing (the row lands under the caller's own userId) but it would
   * let a caller probe which concept uuids exist. `false` means nothing was written.
   */
  const written = await upsertMastery(session.user.id, parsed.data.conceptId, parsed.data.state);
  if (!written) {
    return json({ message: "Something went wrong on our side. Please try again in a moment." }, 404);
  }

  return json({ ok: true });
}

export const POST = withRateLimit("mastery", handler, {
  limit: 120,
  windowMs: 60_000,
});

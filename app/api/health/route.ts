import { pingDatabase } from "@/lib/db/client";
import { log } from "@/lib/log";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * Unauthenticated health check. Reflects real dependency status (docs/09 §3.5): it pings the
 * database (exercising the Neon cold-start retry) rather than always returning "ok".
 *
 * It is the concrete unauthenticated route that carries per-IP rate limiting (docs/06 Phase 2).
 * The generous limit keeps Cloud Run's liveness probes well clear while still rejecting an
 * abusive burst from a single IP.
 */
async function handler(): Promise<Response> {
  let dbOk = false;
  try {
    dbOk = await pingDatabase();
  } catch (error) {
    log.error("health check: database ping failed", error);
    dbOk = false;
  }
  return Response.json(
    { status: dbOk ? "ok" : "degraded", db: dbOk },
    { status: dbOk ? 200 : 503 },
  );
}

export const GET = withRateLimit("health", handler, {
  limit: 120,
  windowMs: 60_000,
});

// Never cache a health check.
export const dynamic = "force-dynamic";

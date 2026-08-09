import { headers } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { isAdminEmail } from "@/lib/admin";
import { auth } from "@/lib/auth";
import { log } from "@/lib/log";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * TEMPORARY — DELETE AFTER THE SENTRY DSN IS CONFIRMED WORKING.
 *
 * Fires one deliberate error through the SAME path production code uses, to prove server-side
 * Sentry capture works before the docs/09 §3.1 failure-injection drills run. Running those drills
 * without this is running them blind: `lib/env.ts` types SENTRY_DSN as `optionalUrl`, so a missing
 * DSN makes `log.error`'s `Sentry.captureException` a silent no-op — the app boots fine and reports
 * nothing, which is indistinguishable from "no errors occurred".
 *
 * ADMIN-GATED, and that is not optional. Cloud Run runs `--allow-unauthenticated`, so an open
 * endpoint that manufactures errors is a Sentry-quota amplifier anyone can pull. Non-admins get
 * `notFound()` rather than 403, matching `/admin/usage` and docs/09 §2.6: a 403 confirms the route
 * exists and is worth probing.
 *
 * Goes through `log.error` rather than `throw`ing, deliberately. A bare throw would test Next's
 * error boundary; the drills produce `log.error`, so this tests the seam they actually use.
 */
async function handler() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdminEmail(session?.user?.email)) {
    // Same shape as an unmatched route — reveals nothing about what lives here.
    return new Response("Not Found", { status: 404 });
  }

  const marker = `sentry-check-${Date.now()}`;
  log.error("sentry-check: deliberate test error", new Error(`Edgify Sentry check ${marker}`), {
    marker,
    deliberate: true,
  });

  /**
   * Flush before returning, or this test can lie to you.
   *
   * Sentry batches events and sends them in the background. Cloud Run runs `--min-instances=0`, so
   * an idle instance can be reclaimed before the batch leaves — the error never arrives and you
   * conclude the DSN is broken when it is fine. Two seconds is ample for one event.
   */
  const flushed = await Sentry.flush(2000);

  // No DSN, no stack, no environment values — just enough to correlate with Sentry Issues.
  return Response.json({ ok: true, marker, flushed });
}

/**
 * Rate limited like every other API route (`app/api/rate-limit-coverage.test.ts` enforces this).
 * The ceiling is deliberately far below the usual 120/min: each call manufactures a Sentry event,
 * so an unbounded debug endpoint is a quota amplifier even behind the admin gate.
 */
export const GET = withRateLimit("sentry-check", handler, {
  limit: 5,
  windowMs: 60_000,
});

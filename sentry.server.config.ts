import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "./lib/sentry-scrub";

/**
 * Server-side Sentry. Imported once at boot from `instrumentation.ts` (Node runtime).
 *
 * DSN is optional so the app still boots in dev without Sentry configured; when unset, the SDK
 * initialises to a no-op and `Sentry.captureException` does nothing. Source-map upload and
 * release tracking are wired in Phase 7 deploy, not here — capture works without them.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: scrubPii,
});

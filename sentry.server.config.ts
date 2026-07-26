import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "./lib/sentry-scrub";

/**
 * Server-side Sentry. Imported once at boot from `instrumentation.ts` (Node runtime).
 *
 * DSN comes from the environment (optional, so the app still boots in dev without Sentry; the
 * SDK is a no-op when unset). `sendDefaultPii: false` plus `beforeSend: scrubPii` keep request
 * bodies (pasted/uploaded document text), cookies, authorization headers and IP addresses out
 * of every event (docs/09 §2.6). Source-map upload and release tracking are handled by
 * withSentryConfig at build time; capture works without them.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: scrubPii,
});

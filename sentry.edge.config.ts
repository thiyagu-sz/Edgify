import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "./lib/sentry-scrub";

/**
 * Edge-runtime Sentry (middleware, edge routes). Imported at boot from `instrumentation.ts`.
 *
 * Same hardening as the server config: DSN from the environment, and `sendDefaultPii: false`
 * plus `beforeSend: scrubPii` so document text, cookies, auth headers and IPs never leave the
 * process (docs/09 §2.6).
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: scrubPii,
});

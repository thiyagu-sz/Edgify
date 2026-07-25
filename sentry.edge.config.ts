import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "./lib/sentry-scrub";

/** Edge-runtime Sentry (middleware, edge routes). Imported at boot from `instrumentation.ts`. */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: scrubPii,
});

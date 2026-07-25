import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "./lib/sentry-scrub";

/**
 * Browser-side Sentry. The DSN is a PUBLIC ingestion key (not a secret), so `NEXT_PUBLIC_` is
 * intentional and does not match the secret-leak grep in docs/09 §1.1. When unset the SDK is a
 * no-op.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  beforeSend: scrubPii,
});

// Lets Sentry trace client-side navigations in the App Router.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

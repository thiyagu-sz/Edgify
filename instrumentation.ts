import * as Sentry from "@sentry/nextjs";

/**
 * Next.js runs `register()` once at server startup. Validating the environment here means a
 * missing or malformed variable stops the app at boot with a clear message, rather than
 * surfacing as a confusing failure on the first request. Sentry is initialised in the same
 * hook so error reporting is live before the first request is served.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./lib/env");
    assertEnv();
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forwards App Router server errors (route handlers, Server Components) to Sentry.
export const onRequestError = Sentry.captureRequestError;

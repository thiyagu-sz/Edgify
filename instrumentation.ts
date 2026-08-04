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
    try {
      assertEnv();
    } catch (error) {
      /**
       * EXIT, do not rethrow. Next CATCHES a throw from `register()`, logs it, and carries on
       * with a server that never prepared — measured 2026-08-04 against the real production
       * entrypoint (`node .next/standalone/server.js`, the one the Dockerfile runs): it printed
       * "Ready in 0ms", reported "Failed to prepare server … The app cannot start", and was
       * still alive when the test harness killed it 30 seconds later.
       *
       * On Cloud Run that is the worst shape of failure — a container that never serves and
       * never dies, so nothing crash-loops and the only signal is a startup-probe timeout well
       * after the fact. An invalid environment is unrecoverable by definition, so fail fast and
       * loudly instead. The message is already written for a human reading container logs: it
       * names every offending variable and what each one expected.
       */
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forwards App Router server errors (route handlers, Server Components) to Sentry.
export const onRequestError = Sentry.captureRequestError;

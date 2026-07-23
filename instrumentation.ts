/**
 * Next.js runs `register()` once at server startup. Validating the environment here means a
 * missing or malformed variable stops the app at boot with a clear message, rather than
 * surfacing as a confusing failure on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("./lib/env");
    assertEnv();
  }
}

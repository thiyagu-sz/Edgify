import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,
};

export default withSentryConfig(nextConfig, {
  // Sentry org/project for source-map upload. Upload needs SENTRY_AUTH_TOKEN at build time;
  // without it the build still succeeds and simply skips the upload. Verify `project` matches
  // your Sentry project slug before relying on readable stack traces.
  org: "solo-founer",
  project: "javascript-nextjs",

  // Only print source-map upload logs in CI.
  silent: !process.env.CI,

  // Upload a wider set of source maps for readable stack traces (slightly longer build).
  widenClientFileUpload: true,

  // Removed for Cloud Run:
  //   - tunnelRoute: routes browser telemetry through the app to dodge ad-blockers, at the cost
  //     of extra instance load and hosting spend — not worth it on a scale-to-zero service.
  //   - automaticVercelMonitors: Vercel-only cron instrumentation; we deploy to Cloud Run.
  webpack: {
    // Tree-shake Sentry debug logging out of the bundle.
    treeshake: {
      removeDebugLogging: true,
    },
  },
});

import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

/**
 * Content-Security-Policy, REPORT-ONLY on purpose (docs/09 §2.4: "Start report-only, review
 * violations, then enforce").
 *
 * Enforcing a first-draft CSP on a live service is how you take the app down for a header: this
 * one has to cover the ported prototype's inline styles and inline SVG, `marked` output, and the
 * Sentry browser SDK, and any of those getting it wrong is a blank page rather than a warning.
 * Report-only surfaces the violations with identical coverage and zero blast radius. Promote to
 * `Content-Security-Policy` once the violation reports are clean.
 *
 * `frame-ancestors 'none'` duplicates X-Frame-Options deliberately — the header is the one older
 * browsers honour, the directive is the one the spec supersedes it with (docs/09 §2.4 accepts
 * either; both is strictly safer).
 *
 * `connect-src` includes Sentry's ingest so browser events can be sent once NEXT_PUBLIC_SENTRY_DSN
 * is wired at build time. It does NOT include openrouter.ai, and that omission is load-bearing:
 * AGENTS.md rule 1 says the browser makes zero requests to the provider, so a CSP that permits it
 * would quietly license the exact bug the rule exists to prevent.
 */
const cspReportOnly = [
  "default-src 'self'",
  // Next injects inline bootstrap/hydration scripts; 'unsafe-inline' is required until a nonce
  // strategy is added. Tightening this is the main reason to keep the policy report-only for now.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.de.sentry.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  reactCompiler: true,

  /**
   * Security headers (docs/09 §2.4). Cloud Run terminates TLS and serves HTTPS only, so HSTS is
   * declarative reinforcement rather than the thing providing transport security.
   *
   * No CORS headers are set anywhere, and that is the intended state: absent
   * `Access-Control-Allow-Origin`, the browser enforces same-origin on `/api/*` by default, which
   * is what §2.4's "CORS is not wide open — the API is same-origin only" asks for. Adding a
   * permissive CORS header is the failure mode here, not omitting one.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
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

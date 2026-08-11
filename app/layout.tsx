import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { AnalyticsProvider } from "@/components/analytics/analytics-provider";
import { env } from "@/lib/env";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";
import "./globals.css";

/**
 * The prototype loads Inter and JetBrains Mono and binds them to `--sans` / `--mono`
 * (docs/reference/edgify-prototype.html head). The theme ported into globals.css asks for those
 * two families by name, so loading anything else silently falls the whole workspace back to
 * system-ui and no text matches the visual specification (.claude/rules/ui.md).
 *
 * Self-hosted through next/font rather than the prototype's Google Fonts <link>: same faces, no
 * third-party request at runtime.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

/**
 * Icons are picked up by Next's file conventions, not declared here: `app/favicon.ico`,
 * `app/icon.svg` and `app/apple-icon.png` each emit their own <link>. Declaring
 * `metadata.icons` as well would override those and take the file convention out of play.
 * The artwork is the prototype's own brand mark — see `edgify-logo-assets/README.md`.
 *
 * `metadataBase` resolves relative metadata URLs (the OG image, every canonical) to absolute ones.
 *
 * IT READS `SITE_URL`, NOT `BETTER_AUTH_URL`, AND THAT IS A BUG FIX RATHER THAN A PREFERENCE.
 * The two hold the same value in production, but this module is evaluated at BUILD time for every
 * statically prerendered page — and the Dockerfile builds with `BETTER_AUTH_URL` set to the
 * placeholder `http://localhost:3000`. Production therefore served
 * `og:image="http://localhost:3000/og-image.png"`: no preview image on Product Hunt, Twitter,
 * LinkedIn or Slack. Confirmed by reading `.next/server/app/index.html` from a real build.
 * `SITE_URL` defaults to the production origin, so the fix needs no deployment change (lib/env.ts).
 */
const SITE_URL = env.SITE_URL;

/** One sentence, reused as the default description and social copy. */
const TAGLINE =
  "Turn your notes, slides and PDFs into short, high-yield exam revision — and a dependency " +
  "graph that shows exactly what to learn first.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  /**
   * `template` applies to child pages that set a plain string title; `default` is used by pages
   * that set none. Without this every page inherited the bare word "Edgify" as its OG title,
   * which is what the landing page's share card actually said.
   */
  title: {
    default: "Edgify — cram fast, or understand deeply",
    template: "%s — Edgify",
  },
  description: TAGLINE,
  applicationName: "Edgify",
  // Modest and accurate: what the product literally is. Not a keyword-stuffing surface — Google
  // has ignored this tag for over a decade; it is here only for the minor engines that still read it.
  keywords: [
    "study notes generator",
    "AI revision notes",
    "exam revision",
    "PDF to study notes",
    "knowledge graph",
    "study workspace",
  ],
  authors: [{ name: "Edgify" }],
  creator: "Edgify",
  publisher: "Edgify",
  /**
   * NO ROOT CANONICAL, deliberately. `alternates` is inherited by every descendant that does not
   * set its own, so a canonical of "/" here made `/sign-in` and `/sign-up` both declare
   * themselves to be the home page — an instruction to Google to fold them into `/`. Each
   * indexable page states its own canonical instead (`/` and `/demo`); the noindex routes need
   * none.
   */
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      // Let Google show full-length previews and large image thumbnails rather than truncating.
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
  openGraph: {
    title: "Edgify — cram fast, or understand deeply",
    description: TAGLINE,
    siteName: "Edgify",
    type: "website",
    locale: "en_GB",
    url: "/",
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "Edgify — cram fast, or understand deeply",
    description: TAGLINE,
    images: TWITTER_IMAGES,
  },
};

/**
 * `themeColor` matches the landing/auth ground (`#0a0a0a`) and the PWA manifest, so the mobile
 * browser chrome does not flash a different colour on load. It belongs in `viewport`, not
 * `metadata` — Next warns and drops it from `metadata`.
 */
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
      // Browser extensions inject attributes onto <html> (e.g. `data-qb-installed`) before
      // hydration, so the client tree never matches the server's. Scoped to THIS element only —
      // it silences attribute mismatches here, not anywhere else in the tree.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {/* No-op unless NEXT_PUBLIC_POSTHOG_KEY was set at build time (lib/analytics.ts). */}
        <AnalyticsProvider />
        {children}
      </body>
    </html>
  );
}

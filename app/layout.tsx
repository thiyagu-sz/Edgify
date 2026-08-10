import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { env } from "@/lib/env";
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
 * `metadataBase` resolves the relative openGraph image to an absolute URL. BETTER_AUTH_URL is
 * this app's own origin and is already required, so it needs no new configuration — but note
 * it is read when this module is evaluated. A statically prerendered page therefore bakes in
 * whatever the value was at BUILD time, and the Dockerfile builds with the placeholder
 * `http://localhost:3000`. Pass the real origin at image-build time if the share card must be
 * correct for a Docker-built deployment.
 */
export const metadata: Metadata = {
  metadataBase: new URL(env.BETTER_AUTH_URL),
  title: "Edgify",
  description: "Academic study workspace — Quick Notes and Knowledge Graph.",
  openGraph: {
    title: "Edgify",
    description: "Academic study workspace — Quick Notes and Knowledge Graph.",
    siteName: "Edgify",
    type: "website",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Edgify" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Edgify",
    description: "Academic study workspace — Quick Notes and Knowledge Graph.",
    images: ["/og-image.png"],
  },
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

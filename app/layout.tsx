import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * The prototype loads Inter and JetBrains Mono and binds them to `--sans` / `--mono`
 * (docs/reference/trellis-prototype.html head). The theme ported into globals.css asks for those
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

export const metadata: Metadata = {
  title: "Trellis",
  description: "Academic study workspace — Quick Notes and Knowledge Graph.",
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
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

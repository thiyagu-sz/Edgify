import type { Metadata } from "next";
import { TrackOnMount } from "@/components/analytics/track-on-mount";
import { DemoWorkspace } from "@/components/demo/demo-workspace";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";

/**
 * `/demo` — the workspace, fully interactive, with no session required (docs/06 Phase 6).
 *
 * DELIBERATELY OUTSIDE the `(app)` route group. That group's layout resolves a session and
 * redirects to /sign-in when there isn't one, which is exactly the behaviour this route must not
 * inherit. Sitting outside it means the demo is signed-out by construction rather than by an
 * exemption someone has to remember — there is no auth check here to accidentally weaken.
 *
 * It is also fully static: no session read, no database access, no `force-dynamic`. Everything it
 * renders comes from `lib/demo/`, so it prerenders and costs nothing per visit — which matters,
 * because this is the page an unauthenticated visitor lands on from the landing page.
 */
const DESCRIPTION =
  "Try the Edgify workspace without signing in: a worked knowledge graph with per-concept " +
  "explanations, quizzes and flashcards, plus sample revision notes in every format.";

/**
 * Indexable, and one of only two URLs in the sitemap. It is real, substantial, static public
 * content that answers "what does this actually do" without a sign-up wall — the best possible
 * landing page for someone arriving from search on a "try X" intent.
 *
 * `title` is a plain string, so the root layout's `%s — Edgify` template applies.
 */
export const metadata: Metadata = {
  title: "Demo",
  description: DESCRIPTION,
  alternates: { canonical: "/demo" },
  openGraph: {
    title: "Edgify demo — a worked knowledge graph and sample revision notes",
    description: DESCRIPTION,
    url: "/demo",
    type: "website",
    // See lib/seo.ts — a page-level openGraph replaces the root's, images included.
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "Edgify demo — a worked knowledge graph and sample revision notes",
    description: DESCRIPTION,
    images: TWITTER_IMAGES,
  },
};

export default function DemoPage() {
  return (
    <>
      {/* Keeps this page a Server Component: the tracker is the only client island. */}
      <TrackOnMount event="demo_opened" />
      <DemoWorkspace />
    </>
  );
}

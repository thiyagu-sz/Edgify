import type { Metadata } from "next";
import { DemoWorkspace } from "@/components/demo/demo-workspace";

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
export const metadata: Metadata = {
  title: "Demo — Edgify",
  description:
    "Try the Edgify workspace without signing in: a worked knowledge graph with per-concept explanations, quizzes and flashcards, plus sample revision notes in every format.",
};

export default function DemoPage() {
  return <DemoWorkspace />;
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { KnowledgeGraph } from "@/components/graph/knowledge-graph";
import { auth } from "@/lib/auth";
import { getLatestGraph } from "@/lib/db/queries/graphs";

/**
 * Knowledge Graph — the second workspace feature (W4–W7, docs/05). Ported from the prototype's
 * `#feature-graph` (docs/reference/edgify-prototype.html).
 *
 * A thin Server Component: it resolves the session (the (app) layout guards too) and the graph to
 * open on, then hands off to the client island. Everything else — polling, the panel, readiness,
 * export — is client work, because it is either interactive or instant local computation (W6).
 *
 * `?g=<id>` opens a specific graph; without it the user's most recent one. That keeps a graph
 * addressable after an upload and, more usefully, means a reload during a long build returns to
 * the build in progress rather than to an empty workspace. The id is never trusted: every route
 * behind it filters on `userId`, so an id belonging to someone else reads exactly like one that
 * does not exist.
 *
 * A database hiccup degrades to the empty state rather than a broken page — the upload button
 * still works, which is the one thing the user needs from this screen (ui.md: render the shell,
 * not a blocking error).
 */
export const dynamic = "force-dynamic";

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ g?: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }

  const { g } = await searchParams;
  let graphId: string | null = g ?? null;
  if (!graphId) {
    try {
      const latest = await getLatestGraph(session.user.id);
      graphId = latest?.id ?? null;
    } catch {
      graphId = null;
    }
  }

  return (
    <main>
      <KnowledgeGraph initialGraphId={graphId} />
    </main>
  );
}

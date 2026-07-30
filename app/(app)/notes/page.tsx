import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { QuickNotes } from "@/components/notes/quick-notes";
import { auth } from "@/lib/auth";
import { getRemaining } from "@/lib/quota";

/**
 * Quick Notes — the primary workspace page (W2, docs/05). Ported from the prototype's
 * `#feature-notes` (docs/reference/edgify-prototype.html).
 *
 * Server Component: resolves the session (the (app) layout guards too) and seeds the quota
 * counter with a single fast indexed read (getRemaining, non-consuming). A DB hiccup degrades to
 * a hidden counter rather than a broken page — the rest of the UI still works.
 */
export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }

  let initialRemaining: number | null = null;
  let initialLimit: number | null = null;
  try {
    const quota = await getRemaining(session.user.id);
    initialRemaining = quota.remaining;
    initialLimit = quota.limit;
  } catch {
    // The counter is a nicety; never let it block or break the page (ui.md).
  }

  return (
    <main>
      <section className="feature">
        <div className="view-head">
          <h1>Quick notes</h1>
          <p>
            Built for the night before the exam. Paste or upload your material and get short,
            high-yield notes — only the points most likely to be tested, nothing padded.
          </p>
        </div>
        <QuickNotes initialRemaining={initialRemaining} initialLimit={initialLimit} />
      </section>
    </main>
  );
}

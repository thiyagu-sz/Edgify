// Phase 4 scaffolding — NOT finished UI. Phase 4 replaces this page with the real Quick Notes
// interface ported from docs/reference/trellis-prototype.html. It exists now only to prove the
// authed shell + a live DB read, and to establish the shell-renders-first pattern (below) that
// Phase 4 will inherit for the model stream.
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { pingDatabase } from "@/lib/db/client";
import { countUserDocuments } from "@/lib/db/queries/documents";
import { SignOutButton } from "@/components/sign-out-button";

export const dynamic = "force-dynamic";

const cardClass =
  "rounded-lg border border-zinc-200 p-6 dark:border-zinc-800";

/**
 * Data-dependent card, rendered behind <Suspense> so the shell paints immediately instead of
 * blocking on the database (ui.md: "render the shell and a skeleton immediately rather than
 * blocking on data"). This is the pattern Phase 4 reuses for the model stream, where blocking
 * would mean a blank screen for the length of a generation.
 */
async function DatabaseCard({ userId }: { userId: string }) {
  let dbStatus: string;
  let documentCount: number | null = null;
  try {
    const ok = await pingDatabase();
    documentCount = await countUserDocuments(userId);
    dbStatus = ok ? "connected" : "unexpected response";
  } catch {
    // ui.md: never surface a raw error to the UI.
    dbStatus = "unavailable";
  }

  return (
    <section className={cardClass}>
      <h2 className="text-sm font-medium text-zinc-500">Database</h2>
      <p className="mt-1">
        Status: <span className="font-medium">{dbStatus}</span>
      </p>
      {documentCount !== null && (
        <p className="text-sm text-zinc-500">Your documents: {documentCount}</p>
      )}
    </section>
  );
}

function DatabaseCardSkeleton() {
  return (
    <section className={cardClass} aria-hidden="true">
      <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="mt-3 h-5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
    </section>
  );
}

export default async function WorkspaceHome() {
  // Auth must resolve before a protected page renders — the (app)/layout.tsx guard depends on
  // it too — so this await is unavoidable. Only the data fetch is deferred below.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  const { user } = session;

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Trellis</h1>
        <SignOutButton />
      </header>

      <section className={cardClass}>
        <h2 className="text-sm font-medium text-zinc-500">Signed in as</h2>
        <p className="mt-1 text-lg">{user.name || user.email}</p>
        <p className="text-sm text-zinc-500">{user.email}</p>
      </section>

      <Suspense fallback={<DatabaseCardSkeleton />}>
        <DatabaseCard userId={user.id} />
      </Suspense>

      <p className="text-sm text-zinc-400">
        Phase 1 foundation. Features arrive in later phases.
      </p>
    </main>
  );
}

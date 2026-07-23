import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { countUserDocuments, pingDatabase } from "@/lib/db/queries/health";
import { SignOutButton } from "@/components/sign-out-button";

export const dynamic = "force-dynamic";

export default async function WorkspaceHome() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }
  const { user } = session;

  // A live database read proves connectivity (and, after a Neon idle, the cold-start retry).
  let dbStatus: string;
  let documentCount: number | null = null;
  try {
    const ok = await pingDatabase();
    documentCount = await countUserDocuments(user.id);
    dbStatus = ok ? "connected" : "unexpected response";
  } catch {
    dbStatus = "unavailable";
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Trellis</h1>
        <SignOutButton />
      </header>

      <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-500">Signed in as</h2>
        <p className="mt-1 text-lg">{user.name || user.email}</p>
        <p className="text-sm text-zinc-500">{user.email}</p>
      </section>

      <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-500">Database</h2>
        <p className="mt-1">
          Status: <span className="font-medium">{dbStatus}</span>
        </p>
        {documentCount !== null && (
          <p className="text-sm text-zinc-500">
            Your documents: {documentCount}
          </p>
        )}
      </section>

      <p className="text-sm text-zinc-400">
        Phase 1 foundation. Features arrive in later phases.
      </p>
    </main>
  );
}

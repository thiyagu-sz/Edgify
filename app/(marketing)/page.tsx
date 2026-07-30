import Link from "next/link";

/**
 * PLACEHOLDER — Phase 6 replaces this with the dark Fluxora landing page ported from
 * docs/reference/edgify-prototype.html (see docs/06-implementation-plan.md, Phase 6).
 * It exists now only so `/` resolves and so the (marketing) route group owns the index,
 * which is where AGENTS.md's directory layout puts the landing page.
 */
export default function LandingPlaceholder() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Edgify</h1>
        <p className="text-sm text-zinc-500">Academic study workspace.</p>
      </div>
      <Link
        href="/notes"
        className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Launch workspace
      </Link>
    </main>
  );
}

"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function SignInPage() {
  const [pending, setPending] = useState(false);

  async function handleGoogle() {
    setPending(true);
    await authClient.signIn.social({ provider: "google", callbackURL: "/notes" });
    // On success the browser is redirected to Google, then back to the workspace.
    setPending(false);
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Edgify</h1>
        <p className="text-sm text-zinc-500">Sign in to your study workspace.</p>
      </div>
      <button
        type="button"
        onClick={handleGoogle}
        disabled={pending}
        className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        {pending ? "Redirecting…" : "Continue with Google"}
      </button>
    </main>
  );
}

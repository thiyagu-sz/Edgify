import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

/**
 * NOINDEX. A sign-in page answers no search query, and letting it into the index means it
 * competes with the landing page for the brand query "edgify" — the one query that matters most
 * at launch. `follow` stays on so link equity still flows back to `/`.
 *
 * `app/robots.ts` also disallows this path. The two are complementary, not redundant: robots.txt
 * stops the crawl, this stops the indexing if the URL is ever discovered from an inbound link.
 *
 * `title` is a plain string so the root layout's `%s — Edgify` template applies — spelling out
 * "— Edgify" here as well would render "Sign in — Edgify — Edgify".
 */
export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Edgify study workspace.",
  robots: { index: false, follow: true },
};

/**
 * Sign in — Google or email/password (docs/02-tech-stack.md).
 *
 * `AuthForm` reads `?error=` with `useSearchParams`, which suspends during prerender, so it sits
 * behind a Suspense boundary. Without one this whole route would be forced dynamic.
 */
export default function SignInPage() {
  return (
    <AuthShell
      eyebrow="Edgify workspace"
      heading="Sign in"
      subheading="Pick up where you left off."
      display={
        <>
          Welcome <span className="accent">back.</span>
        </>
      }
      lede="Your notes, graphs and revision are where you left them. Sign in to keep going."
      footer={
        <>
          New to Edgify? <Link href="/sign-up">Create an account</Link>
        </>
      }
    >
      <Suspense fallback={<div className="auth-fallback" aria-hidden="true" />}>
        <AuthForm mode="sign-in" />
      </Suspense>
    </AuthShell>
  );
}

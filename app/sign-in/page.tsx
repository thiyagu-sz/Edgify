import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata: Metadata = {
  title: "Sign in — Edgify",
  description: "Sign in to your Edgify study workspace.",
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

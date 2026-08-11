import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

/** NOINDEX, for the same reasons as `/sign-in` — see the note there. */
export const metadata: Metadata = {
  title: "Create your account",
  description: "Create an Edgify account and start turning your material into high-yield notes.",
  robots: { index: false, follow: true },
};

/** Create an account — the same experience as /sign-in, in its other state. */
export default function SignUpPage() {
  return (
    <AuthShell
      eyebrow="Get started"
      heading="Create your workspace"
      // Deliberately descriptive rather than commercial: there is no billing in this product, so
      // a "free / no card needed" line would be a claim invented on a trust-sensitive page.
      subheading="Takes about a minute."
      display={
        <>
          Cram fast, or <span className="accent">understand deeply.</span>
        </>
      }
      lede="Turn your notes, slides and PDFs into short, high-yield revision — and a graph that shows exactly what to learn first."
      footer={
        <>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </>
      }
    >
      <Suspense fallback={<div className="auth-fallback" aria-hidden="true" />}>
        <AuthForm mode="sign-up" />
      </Suspense>
    </AuthShell>
  );
}

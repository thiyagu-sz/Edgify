import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { GOVERNING_LAW, LEGAL_ENTITY } from "@/lib/legal";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";

const DESCRIPTION =
  "The terms you agree to when using Edgify: acceptable use, your content, AI-generated output, " +
  "and the limits of what the service promises.";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: "Terms of Service — Edgify",
    description: DESCRIPTION,
    url: "/terms",
    type: "article",
    images: OG_IMAGES,
  },
  twitter: { card: "summary_large_image", title: "Terms of Service — Edgify", description: DESCRIPTION, images: TWITTER_IMAGES },
};

/**
 * NO GOVERNING LAW CLAUSE IS RENDERED while `GOVERNING_LAW` is null, and no operating entity is
 * named while `LEGAL_ENTITY` is null (lib/legal.ts).
 *
 * Both are conditional rather than filled with a placeholder, because a wrong jurisdiction is not
 * a cosmetic defect: a governing-law clause naming a country the operator has no connection to is
 * worse than silence, and a bracketed fill-me-in token visible in production undermines every
 * other sentence on the page. Supplying the value in lib/legal.ts renders the clause with no
 * change here.
 *
 * This comment deliberately does NOT spell that token out. `lib/legal.test.ts` scans these files
 * for placeholder shapes and cannot tell prose from a comment — correctly, since it is checking
 * that the shape appears nowhere. The same trap is recorded in test/deploy-env-docs.test.ts,
 * where an explanatory comment quoting the offending string tripped that project's own scanner.
 *
 * NO PAYMENT, SUBSCRIPTION OR REFUND TERMS appear: this repository contains no payment provider,
 * no billing tables and no pricing, so such terms would describe a product that does not exist.
 */
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro="These terms apply when you use Edgify. Please read them — particularly the sections on AI-generated output and the limits of liability."
      currentPath="/terms"
    >
      <h2>1. Agreement</h2>
      <p>
        By creating an account or using Edgify, you agree to these terms. If you do not agree, do
        not use the service.
      </p>

      <h2>2. What Edgify is</h2>
      <p>
        Edgify is an academic study workspace. You supply study material and Edgify uses automated
        systems to produce revision notes, summaries, quizzes, per-concept explanations and a
        concept dependency graph from it. It is a study aid, not a source of authoritative
        information.
      </p>

      <h2>3. Eligibility and accounts</h2>
      <p>
        You must be old enough to enter into these terms in your country. You are responsible for
        keeping your sign-in credentials secure and for activity that takes place under your
        account. Provide accurate information when registering.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>
          Upload material you do not own or have permission to use, including copyrighted course
          material you are not licensed to redistribute.
        </li>
        <li>
          Upload material containing other people&apos;s personal or confidential information.
        </li>
        <li>
          Use Edgify to produce work you present as your own where doing so breaches your
          institution&apos;s academic integrity rules. Complying with those rules is your
          responsibility.
        </li>
        <li>
          Attempt to circumvent usage limits or rate limits, or to access another user&apos;s data.
        </li>
        <li>
          Attempt to disrupt, overload, reverse-engineer or gain unauthorised access to the service
          or its infrastructure.
        </li>
        <li>Use Edgify for anything unlawful.</li>
      </ul>

      <h2>5. Your content</h2>
      <p>
        You keep ownership of the material you submit. You grant Edgify only the permission needed
        to operate the service: to process your material, transmit it to the AI providers described
        in the <a href="/privacy">Privacy Policy</a>, generate results from it, and store those
        results in your account so you can return to them.
      </p>
      <p>
        Uploaded files themselves are not retained — only the text extracted from them. Note that
        generated results are cached against a hash of the submitted content, and that cache is
        shared rather than per-account; this is described in section 5 of the Privacy Policy.
      </p>

      <h2>6. AI-generated output</h2>
      <p>
        Output is produced by automated language models and{" "}
        <strong>may be inaccurate, incomplete, outdated or entirely wrong</strong>. Edgify does not
        verify it. You must check anything you rely on against your own source material.
      </p>
      <p>
        Output is not professional advice of any kind — medical, legal, financial, or otherwise —
        and must not be relied on as such. See the <a href="/ai-disclaimer">AI Disclaimer</a>.
      </p>
      <p>
        Identical or similar output may be generated for other users who submit similar material.
        You should not assume output is unique to you.
      </p>

      <h2>7. Availability</h2>
      <p>
        Edgify is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis.{" "}
        <strong>No uptime, availability or service level is guaranteed.</strong> The service depends
        on third-party providers, and features may be unavailable, degraded or limited — including
        by daily generation quotas — at any time. Features may change or be withdrawn.
      </p>

      <h2>8. Suspension and termination</h2>
      <p>
        Access may be suspended or terminated if these terms are breached, or where necessary to
        protect the service or its users. You may stop using Edgify at any time; to request that
        your account and data be deleted, see section 11 of the{" "}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>9. Intellectual property</h2>
      <p>
        The Edgify name, interface and software remain the property of their owner. These terms
        grant you a limited, personal, non-transferable right to use the service; they transfer no
        ownership.
      </p>

      <h2>10. Third-party services</h2>
      <p>
        Edgify depends on third-party providers for authentication, hosting, database storage, AI
        generation, error monitoring and analytics. Their handling of your information is governed
        by their own terms. They are listed in the <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>11. Disclaimers</h2>
      <p>
        To the fullest extent permitted by law, Edgify is provided without warranties of any kind,
        whether express or implied, including any implied warranties of merchantability, fitness
        for a particular purpose, accuracy, or non-infringement.
      </p>

      <h2>12. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, Edgify and its operator are not liable for any
        indirect, incidental, special or consequential loss, nor for loss of data, loss of profits,
        or any academic, professional or examination outcome arising from your use of the service
        or from reliance on its output.
      </p>
      <p>
        Nothing in these terms excludes liability that cannot lawfully be excluded. Some
        jurisdictions do not allow certain exclusions, in which case those exclusions do not apply
        to you.
      </p>

      <h2>13. Changes</h2>
      <p>
        These terms may be updated as the service develops. The date at the top of this page records
        when they were last revised. Continuing to use Edgify after a change means you accept the
        revised terms.
      </p>

      {/* Rendered only once the operator supplies these facts — never as a placeholder. */}
      {LEGAL_ENTITY && (
        <>
          <h2>14. Operator</h2>
          <p>Edgify is operated by {LEGAL_ENTITY}.</p>
        </>
      )}
      {GOVERNING_LAW && (
        <>
          <h2>{LEGAL_ENTITY ? "15" : "14"}. Governing law</h2>
          <p>
            These terms are governed by the laws of {GOVERNING_LAW}, and the courts of{" "}
            {GOVERNING_LAW} have jurisdiction over any dispute arising from them.
          </p>
        </>
      )}
    </LegalPage>
  );
}

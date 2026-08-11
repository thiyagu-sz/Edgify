import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { CONTACT_LABEL, CONTACT_URL, SUBPROCESSORS } from "@/lib/legal";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";

const DESCRIPTION =
  "What Edgify collects, why, where it is stored, and who else processes it — described from " +
  "the actual implementation.";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: "Privacy Policy — Edgify",
    description: DESCRIPTION,
    url: "/privacy",
    type: "article",
    images: OG_IMAGES,
  },
  twitter: { card: "summary_large_image", title: "Privacy Policy — Edgify", description: DESCRIPTION, images: TWITTER_IMAGES },
};

/**
 * Every statement on this page is traceable to code:
 *  - account fields          lib/db/auth-schema.ts (`user`, `session`, `account`)
 *  - documents               lib/db/schema.ts (`documents` — extracted text only, never the file)
 *  - generated content       `notes`, `graphs`, `concepts`, `edges`, `mastery`
 *  - the shared cache        `generation_cache`, deliberately NOT user-scoped
 *  - operational records     `usage_counters`, `usage_ledger`, `rate_limits`
 *  - error reports           sentry.*.config.ts + lib/sentry-scrub.ts
 *  - analytics               lib/analytics.ts
 *
 * Claims that are NOT made, because nothing here proves them: a retention period, a deletion
 * guarantee, a data-residency region, GDPR/CCPA compliance, or any statement about whether model
 * providers train on submitted text. See lib/legal.ts.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="This policy describes what Edgify collects, why it collects it, and who else is involved in processing it. It describes how the service actually works today."
      currentPath="/privacy"
    >
      <h2>1. What Edgify is</h2>
      <p>
        Edgify is an academic study workspace. You provide study material — by pasting text or
        uploading a document — and Edgify uses automated systems to produce revision notes,
        explanations, quizzes and a concept dependency graph from it.
      </p>

      <h2>2. Information you give us</h2>
      <h3>Account information</h3>
      <p>
        When you create an account, Edgify stores your email address, a display name and, if you
        sign in with Google, the profile picture URL that Google provides. If you sign in with
        Google, Google supplies these to Edgify; if you register with an email address and
        password, the display name is derived from the part of your email address before the
        <code>@</code>.
      </p>
      <p>
        Passwords are never stored in a readable form. Password hashing is performed by our
        authentication library (Better Auth) using scrypt, and Edgify never receives, stores,
        logs or transmits your password in plain text.
      </p>

      <h3>Sign-in sessions</h3>
      <p>
        To keep you signed in, Edgify stores a session record containing a session token, an
        expiry time and — as recorded by the authentication library — the IP address and browser
        user-agent associated with the sign-in. Signing out invalidates the session.
      </p>

      <h3>Study material you submit</h3>
      <p>
        When you upload a document, Edgify extracts its text and{" "}
        <strong>stores only the extracted text — the original file is never saved</strong>.
        Extraction happens in memory during the request; the uploaded file is not written to disk
        or to any file storage service. Alongside the extracted text, Edgify stores a title, a
        character count, a page count, the source type (for example PDF or DOCX) and a
        content hash used for caching.
      </p>
      <p>
        Text you paste directly is submitted for generation in the same way. Please do not upload
        material you are not permitted to share, and be aware that anything you submit is sent to
        a third-party AI provider for processing, as described in section 4.
      </p>

      <h3>Content generated for you</h3>
      <p>
        Revision notes, concept graphs, per-concept explanations and your recorded progress
        against each concept are stored in your account so you can return to them.
      </p>

      <h2>3. Information generated automatically</h2>
      <ul>
        <li>
          <strong>Usage and quota records.</strong> Edgify records the number of generations you
          run each day to enforce a per-user daily limit, and keeps an operational log of each
          model call containing the operation type, the model used, token counts, an estimated
          cost, how long it took and whether it succeeded. This log does not contain your study
          material.
        </li>
        <li>
          <strong>Rate limiting.</strong> To protect the service from abuse, Edgify counts requests
          against short time windows. For requests made without a signed-in account, the counter is
          keyed by IP address.
        </li>
        <li>
          <strong>Error reports.</strong> When something fails, a technical error report is sent to
          Sentry. Request bodies, cookies, authorization headers and IP addresses are stripped from
          these reports before they are sent, so the text of your documents is not attached to
          them.
        </li>
        <li>
          <strong>Product analytics.</strong> Edgify uses PostHog to understand which features are
          used. See section 6.
        </li>
      </ul>

      <h2>4. AI processing</h2>
      <p>
        To generate notes, explanations, quizzes and graphs, the text you provide is transmitted to{" "}
        <strong>OpenRouter</strong>, which routes it to third-party AI model providers and returns
        the generated result. This means the study material you submit leaves Edgify&apos;s systems
        and is processed by companies other than Edgify.
      </p>
      <p>
        Those providers handle your text under their own terms and privacy policies.{" "}
        <strong>
          Edgify cannot and does not make any commitment about whether those providers retain
          submitted text or use it to train their models.
        </strong>{" "}
        If that matters to you, do not submit confidential or sensitive material.
      </p>

      <h2>5. Caching, and what it means for shared documents</h2>
      <p>
        To keep the service affordable, Edgify caches generated results against a hash of the
        submitted content. <strong>This cache is not partitioned per user.</strong> If another
        person submits exactly the same source text and requests the same output, they may be
        served the cached result that was generated from that identical content, rather than a new
        generation.
      </p>
      <p>
        The cache is keyed by content, not by account, and it does not reveal who submitted the
        content, their identity or any other information about them. It is described here because
        it is a real property of the system rather than one you could reasonably infer.
      </p>

      <h2>6. Analytics</h2>
      <p>
        Edgify uses PostHog to record how the product is used — for example that a generation was
        started, which revision format was chosen, and whether it succeeded or failed. This is
        deliberately constrained:
      </p>
      <ul>
        <li>Automatic capture of clicked-element text is disabled.</li>
        <li>Session recording and replay are disabled.</li>
        <li>
          You are identified by your internal database identifier, never by your email address.
        </li>
        <li>
          No document text, extracted text, generated notes, concept names, file names or prompt
          content is included in any analytics event.
        </li>
        <li>Browsers sending a &ldquo;Do Not Track&rdquo; signal are respected.</li>
      </ul>
      <p>
        Analytics events do record the page you are on, the referring site and any campaign
        parameters in the link you arrived through.
      </p>

      <h2>7. How your information is used</h2>
      <ul>
        <li>To create and maintain your account and keep you signed in.</li>
        <li>To generate the notes, explanations, quizzes and graphs you ask for.</li>
        <li>To store your material and results so you can return to them.</li>
        <li>To enforce daily usage limits and to protect the service from abuse.</li>
        <li>To diagnose and fix faults.</li>
        <li>To understand which features are used, so the product can be improved.</li>
      </ul>
      <p>Edgify does not sell your information, and does not serve advertising.</p>

      <h2>8. Who else processes your information</h2>
      <p>Edgify relies on the following third-party services:</p>
      <ul>
        {SUBPROCESSORS.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong> — {s.purpose}
          </li>
        ))}
      </ul>
      <p>Each processes your information under its own terms and privacy policy.</p>

      <h2>9. Isolation between users</h2>
      <p>
        Every query for account-specific data — documents, notes, graphs, concepts and progress —
        is filtered by your user identifier, so one account cannot read another account&apos;s
        material. This is enforced in application code and covered by automated tests. The single
        deliberate exception is the content-addressed cache described in section 5.
      </p>

      <h2>10. Data retention</h2>
      <p>
        Your account and the material associated with it are kept for as long as your account
        exists. <strong>Edgify does not currently operate a defined retention schedule</strong> and
        does not automatically delete study material after a fixed period. This is stated plainly
        rather than dressed up: a retention period is a promise, and Edgify does not yet have the
        mechanism to keep one.
      </p>

      <h2>11. Deleting your data</h2>
      <p>
        <strong>
          There is currently no self-service control in the interface for deleting your account or
          your stored material.
        </strong>{" "}
        To request deletion, open a request via {CONTACT_LABEL} at{" "}
        <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
          the Edgify repository
        </a>
        . Deletion of an account removes the records associated with it, including documents,
        notes, graphs, concepts, progress and usage records. Cached generated results, which are
        keyed by content rather than by account and are not linked to your identity, may persist.
      </p>
      <p>
        Because a public issue is visible to anyone, do not include private material or personal
        details in it.
      </p>

      <h2>12. Security</h2>
      <p>
        Edgify is served over HTTPS. Database connections require verified TLS. Credentials for
        third-party services are held server-side and are never exposed to the browser. Passwords
        are hashed by the authentication library. No system is perfectly secure, and Edgify does
        not claim to be.
      </p>

      <h2>13. Children</h2>
      <p>
        Edgify is intended for use by students in higher and further education. It is not directed
        at children, and accounts should not be created by anyone under the age at which they can
        agree to these terms in their country.
      </p>

      <h2>14. Changes to this policy</h2>
      <p>
        This policy may change as Edgify changes. The date at the top of this page records when it
        was last revised. Material changes will be reflected here.
      </p>
    </LegalPage>
  );
}

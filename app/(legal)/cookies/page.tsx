import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { COOKIES } from "@/lib/legal";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";

const DESCRIPTION =
  "The cookies Edgify actually sets: one to keep you signed in, and one for product analytics.";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description: DESCRIPTION,
  alternates: { canonical: "/cookies" },
  openGraph: {
    title: "Cookie Policy — Edgify",
    description: DESCRIPTION,
    url: "/cookies",
    type: "article",
    images: OG_IMAGES,
  },
  twitter: { card: "summary_large_image", title: "Cookie Policy — Edgify", description: DESCRIPTION, images: TWITTER_IMAGES },
};

/**
 * Cookie names come from the libraries themselves, not from memory: Better Auth's default session
 * cookie and PostHog's per-project cookie (lib/legal.ts records how each was verified).
 *
 * NO DURATIONS ARE STATED. This project does not configure `session.expiresIn`, so the session
 * lifetime is the library's default — a number that is not pinned in our own configuration is one
 * that can change on a dependency upgrade, silently making a published policy false.
 *
 * No advertising, tracking-pixel or third-party marketing cookie is mentioned, because none
 * exists in this codebase.
 */
export default function CookiesPage() {
  const essential = COOKIES.filter((c) => c.category === "Essential");
  const analytics = COOKIES.filter((c) => c.category === "Analytics");

  return (
    <LegalPage
      title="Cookie Policy"
      intro="Edgify uses a small number of cookies. This page lists each one, what it does, and how to control it."
      currentPath="/cookies"
    >
      <h2>1. What cookies are</h2>
      <p>
        Cookies are small text files a website stores in your browser. Edgify uses them for two
        purposes only: keeping you signed in, and understanding how the product is used.
      </p>
      <p>
        <strong>
          Edgify does not use advertising cookies, tracking pixels, or third-party marketing
          cookies, and does not sell information about you.
        </strong>
      </p>

      <h2>2. Essential cookies</h2>
      <p>
        These are required for the service to work. Without them you could not stay signed in.
      </p>
      {essential.map((c) => (
        <div key={c.name} className="legal-cookie">
          <p className="legal-cookie-name">
            <code>{c.name}</code>
          </p>
          <p>{c.purpose}</p>
        </div>
      ))}
      <p>
        This cookie is set by our authentication library when you sign in. Its lifetime is that
        library&apos;s default; Edgify does not override it, so no fixed duration is stated here
        rather than one that might drift out of date.
      </p>

      <h2>3. Analytics cookies</h2>
      <p>
        These help us understand which features are used so the product can be improved. They are
        not required for Edgify to function.
      </p>
      {analytics.map((c) => (
        <div key={c.name} className="legal-cookie">
          <p className="legal-cookie-name">
            <code>{c.name}</code>
          </p>
          <p>{c.purpose}</p>
        </div>
      ))}
      <p>
        Analytics is deliberately limited: automatic capture of clicked-element text is disabled,
        session recording and replay are disabled, and no document text, generated content, concept
        names or file names is ever included. Browsers sending a &ldquo;Do Not Track&rdquo; signal
        are respected, and no analytics cookie is set for them.
      </p>

      <h2>4. Controlling cookies</h2>
      <p>
        You can block or delete cookies through your browser settings, and you can enable
        &ldquo;Do Not Track&rdquo; to opt out of analytics.
      </p>
      <p>
        Note that blocking the essential sign-in cookie will prevent you from signing in, because
        that cookie is the mechanism by which Edgify recognises your session. The public pages —
        including the landing page, the demo and these legal pages — work without any cookie at
        all.
      </p>

      <h2>5. Changes</h2>
      <p>
        If the cookies Edgify uses change, this page will be updated. The date at the top records
        when it was last revised.
      </p>
    </LegalPage>
  );
}

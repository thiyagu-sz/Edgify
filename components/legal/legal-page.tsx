import Link from "next/link";
import { CONTACT_LABEL, CONTACT_URL, LAST_UPDATED, LAST_UPDATED_ISO, LEGAL_PAGES } from "@/lib/legal";

/**
 * The frame every legal document shares.
 *
 * Reuses the composition the authentication screens already established (app/globals.css
 * `.auth-*`): Edgify's own dark ground — `#0a0a0a`, faded grid, blurred glow — with the reading
 * content in a light card. That pairing is not decoration here; long legal prose on a dark
 * background is materially harder to read, and the light card is how this design system already
 * presents sustained text on the public surface.
 *
 * A SERVER COMPONENT with no client island at all: these pages hold no state, read no session,
 * make no database query and call no model. They must render when Postgres is down, because a
 * privacy policy that is unavailable during an incident is unavailable exactly when someone has
 * a reason to read it.
 */
export function LegalPage({
  title,
  intro,
  currentPath,
  children,
}: {
  title: string;
  intro: string;
  currentPath: string;
  children: React.ReactNode;
}) {
  return (
    <main className="legal">
      <div className="auth-grid-bg" aria-hidden="true" />
      <div className="auth-glow auth-glow-a" aria-hidden="true" />

      <div className="legal-wrap">
        <nav className="legal-top" aria-label="Breadcrumb">
          <Link href="/" className="legal-back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
            Back to Edgify
          </Link>
        </nav>

        <article className="legal-card">
          <header className="legal-head">
            <h1>{title}</h1>
            <p className="legal-intro">{intro}</p>
            <p className="legal-updated">
              Last updated <time dateTime={LAST_UPDATED_ISO}>{LAST_UPDATED}</time>
            </p>
          </header>

          <div className="legal-body">{children}</div>

          <section className="legal-contact" aria-labelledby="legal-contact-h">
            <h2 id="legal-contact-h">Contact</h2>
            <p>
              Questions about this document, or about how Edgify handles your information, can be
              raised on {/* The only contact destination this project actually has. */}
              <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
                {CONTACT_LABEL}
              </a>
              . Please do not include private study material or personal details in a public issue.
            </p>
          </section>
        </article>

        <nav className="legal-related" aria-label="Legal documents">
          {LEGAL_PAGES.map(({ href, label }) =>
            href === currentPath ? (
              <span key={href} className="legal-related-current" aria-current="page">
                {label}
              </span>
            ) : (
              <Link key={href} href={href}>
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </main>
  );
}

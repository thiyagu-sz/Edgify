import Link from "next/link";

/**
 * The frame both authentication screens share, so sign-in and sign-up read as two states of one
 * experience rather than two pages that happen to look alike.
 *
 * Dark and glassy, matching the supplied reference composition: a translucent panel over a dark
 * ground, a light form card on the left, display copy and feature highlights on the right.
 *
 * The vocabulary is Edgify's OWN dark language, not an imported one — the marketing landing page
 * (app/(marketing)/page.tsx) is already `#0a0a0a` with a faded 64px grid, blurred glows,
 * gradient hairline borders and `rgba(255,255,255,.05)` glass. Reusing it means the journey
 * reads as one product: dark landing → dark auth → light workspace. Type stays Inter and the
 * mark stays the existing one; nothing new was designed.
 *
 * A Server Component: only the form inside is a client island.
 */

function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="5.5" r="2.7" fill="currentColor" />
      <circle cx="5.5" cy="17.5" r="2.7" fill="currentColor" />
      <circle cx="18.5" cy="17.5" r="2.7" fill="currentColor" />
    </svg>
  );
}

export function AuthShell({
  eyebrow,
  heading,
  subheading,
  display,
  lede,
  children,
  footer,
}: {
  eyebrow: string;
  heading: string;
  subheading: string;
  display: React.ReactNode;
  lede: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <main className="auth">
      {/* Ground treatment, all decorative and all non-interactive. */}
      <div className="auth-grid-bg" aria-hidden="true" />
      <div className="auth-glow auth-glow-a" aria-hidden="true" />
      <div className="auth-glow auth-glow-b" aria-hidden="true" />

      <div className="auth-wrap">
        <div className="auth-shell">
          <div className="auth-layout">
            {/* ── Form card ─────────────────────────────────────────────── */}
            <div className="auth-formcol">
              <div className="auth-card">
                <div className="auth-cardhead">
                  <div className="auth-cardtitle">
                    <p className="eyebrow">{eyebrow}</p>
                    <h2>{heading}</h2>
                    <p className="sub">{subheading}</p>
                  </div>
                  <div className="auth-badge" aria-hidden="true">
                    <BrandMark />
                  </div>
                </div>
                {children}
                <p className="auth-alt">{footer}</p>
              </div>
            </div>

            {/* ── Copy + highlights ─────────────────────────────────────── */}
            <div className="auth-copy">
              <h1 className="auth-display">{display}</h1>
              <p className="auth-lede">{lede}</p>

              <div className="auth-highlights">
                <div className="auth-highlight">
                  <div className="ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
                    </svg>
                  </div>
                  <div>
                    <p className="t">Quick Notes</p>
                    <p className="d">Short, high-yield revision from your own notes, slides and PDFs.</p>
                  </div>
                </div>

                <div className="auth-highlight">
                  <div className="ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
                      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
                    </svg>
                  </div>
                  <div>
                    <p className="t">Knowledge Graph</p>
                    <p className="d">A dependency graph that shows exactly what to learn first.</p>
                  </div>
                </div>
              </div>

              {/* The reference put a named contact here. There is no support persona to name, and
                  inventing one would be a lie on a trust-sensitive page, so the slot carries the
                  brand and a way back instead. */}
              <div className="auth-strip">
                <span className="auth-strip-mark" aria-hidden="true">
                  <BrandMark />
                </span>
                <span className="auth-strip-text">
                  <span className="k">Edgify</span>
                  <span className="v">Academic study workspace</span>
                </span>
                <Link href="/" className="auth-strip-cta">
                  Back to home
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

import Link from "next/link";
import { CONTACT_LABEL, CONTACT_URL, LEGAL_PAGES, REPO_URL } from "@/lib/legal";

/**
 * The landing page footer.
 *
 * EXPANDED, NOT REPLACED. The previous footer carried the brand mark, the Features / How it
 * works / Try the demo / Launch app links and the "An academic study workspace" line. Every one
 * of those survives here — the columns are added around them, and the original single-row strip
 * becomes the bottom bar. Nothing that worked before has been removed or repointed.
 *
 * It stays inside `#landing`, so it inherits the Fluxora dark tokens already scoped there
 * (`.lx-*` in app/globals.css) rather than introducing a second dark theme. The brand mark is
 * passed in from the page so there is still exactly one copy of that SVG.
 *
 * EVERY LINK HERE RESOLVES TO SOMETHING THAT EXISTS. There is no "Docs", "Blog", "Careers" or
 * "About" column, because those pages do not exist and a footer full of dead links is worse than
 * a smaller honest one. `components/site-footer.test.tsx` fails if a link points at a route the
 * app does not serve.
 */
export function SiteFooter({ brandMark }: { brandMark: React.ReactNode }) {
  return (
    <footer className="lx-foot2">
      <div className="lx-foot2-cols">
        {/* Brand + description */}
        <div className="lx-foot2-brand">
          <div className="lx-brand" style={{ fontSize: 16 }}>
            {brandMark}
            edgify
          </div>
          <p className="lx-foot2-desc">
            An academic study workspace. Turn your notes, slides and PDFs into short, high-yield
            revision — and a dependency graph that shows what to learn first.
          </p>
        </div>

        <nav className="lx-foot2-col" aria-labelledby="foot-product">
          <h2 id="foot-product">Product</h2>
          <ul>
            <li><Link href="/demo">Try the demo</Link></li>
            <li><Link href="/notes">Launch workspace</Link></li>
            <li><Link href="/notes">Quick Notes</Link></li>
            <li><Link href="/graph">Knowledge Graph</Link></li>
          </ul>
        </nav>

        <nav className="lx-foot2-col" aria-labelledby="foot-learn">
          <h2 id="foot-learn">Learn more</h2>
          <ul>
            {/*
              ROOT-RELATIVE, not bare fragments. These are sections OF THE LANDING PAGE. While the
              footer rendered only there, `#lx-features` was correct; it now also renders on
              /pdf-to-study-notes and /concept-map-for-studying, where a bare fragment names an
              element that does not exist and the link silently scrolls nowhere. `/#lx-features`
              works from every page and is unchanged in behaviour on the landing page itself.
            */}
            <li><Link href="/#lx-features">Features</Link></li>
            <li><Link href="/#lx-modes">How it works</Link></li>
            <li><Link href="/#lx-start">Get started</Link></li>
          </ul>
        </nav>

        <nav className="lx-foot2-col" aria-labelledby="foot-contact">
          <h2 id="foot-contact">Contact</h2>
          <ul>
            <li>
              <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">
                Feedback &amp; support
                <ExternalIcon />
              </a>
            </li>
            <li>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
                {CONTACT_LABEL === "GitHub Issues" ? "Source on GitHub" : CONTACT_LABEL}
                <ExternalIcon />
              </a>
            </li>
          </ul>
        </nav>

        <nav className="lx-foot2-col" aria-labelledby="foot-legal">
          <h2 id="foot-legal">Legal</h2>
          <ul>
            {LEGAL_PAGES.map(({ href, label }) => (
              <li key={href}>
                <Link href={href}>{label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/*
        Carries the prototype's own `lx-foot` class as well as the new one, and that is a
        correctness requirement rather than tidiness. This row IS the prototype's footer — brand
        line and tagline in a space-between strip (docs/reference/edgify-prototype.html) — and
        `app/(marketing)/landing.test.tsx` derives its expected class list FROM that prototype,
        so dropping the class would mean the port no longer renders an element the visual
        specification defines (AGENTS.md rule 6). `.lx-foot2-bar` restyles it; it does not
        replace it.
      */}
      <div className="lx-foot lx-foot2-bar">
        <span className="c">An academic study workspace</span>
        <span className="lx-foot2-note">
          Notes and graphs are AI-generated and may contain errors —{" "}
          <Link href="/ai-disclaimer">always check them</Link>.
        </span>
      </div>
    </footer>
  );
}

/** Marks a link that leaves the site. Decorative — the surrounding text already names the target. */
function ExternalIcon() {
  return (
    <svg className="lx-foot2-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

import Link from "next/link";

/**
 * Workspace top bar — shared chrome for the authenticated app, ported from the prototype's
 * `#appHeader` (docs/reference/edgify-prototype.html). Server Component (static; no state).
 *
 * The two-mode switcher is part of the settled design, so both pills are rendered for fidelity.
 * "Quick notes" is the active route; "Knowledge graph" is DEFERRED to Phase 5 — rendered inert
 * (disabled) rather than linking to a route that does not exist yet. The brand returns home.
 */
export function TopBar() {
  return (
    <header className="topbar">
      <Link href="/" className="brand" aria-label="Edgify — home">
        <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="5.5" r="2.7" fill="#111" />
          <circle cx="5.5" cy="17.5" r="2.7" fill="#111" />
          <circle cx="18.5" cy="17.5" r="2.7" fill="#111" />
        </svg>
        <span className="word">edgify</span>
      </Link>
      <div className="nav-spacer" />
      <div className="pill-group" role="tablist" aria-label="Feature">
        <button className="seg" role="tab" aria-selected="true" type="button">
          Quick notes
        </button>
        {/* Knowledge graph arrives in Phase 5; inert until then. */}
        <button
          className="seg"
          role="tab"
          aria-selected="false"
          type="button"
          disabled
          title="Knowledge graph — coming soon"
        >
          Knowledge graph
        </button>
      </div>
      <div className="nav-spacer" />
    </header>
  );
}

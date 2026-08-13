"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FeedbackWidget } from "@/components/feedback/feedback-widget";
import { UserMenu } from "@/components/user-menu";

/**
 * Workspace top bar — shared chrome for the authenticated app, ported from the prototype's
 * `#appHeader` (docs/reference/edgify-prototype.html).
 *
 * The two-mode switcher is part of the settled design. Both pills are now live: "Knowledge graph"
 * was rendered inert through Phase 4 because `/graph` did not exist, and became a real link when
 * the graph UI landed. The active pill follows the route, so the switcher reflects where the user
 * actually is rather than a state this component holds. The brand returns home.
 *
 * A Client Component only because `usePathname` needs one — there is no other state here.
 */
export function TopBar({ userEmail }: { userEmail?: string }) {
  const pathname = usePathname();
  const onGraph = pathname?.startsWith("/graph") ?? false;

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
        <Link
          href="/notes"
          className="seg"
          role="tab"
          aria-selected={!onGraph}
        >
          Quick notes
        </Link>
        <Link
          href="/graph"
          className="seg"
          role="tab"
          aria-selected={onGraph}
        >
          Knowledge graph
        </Link>
      </div>
      <div className="nav-spacer" />
      {/* Optional so an unauthenticated surface renders no profile at all rather than a blank
          one — only the (app) layout, which has already proven a session, passes an address.
          Feedback rides the same signal: the endpoint requires a session, so offering it without
          one would produce a form that can only fail. */}
      {userEmail ? (
        <>
          <FeedbackWidget />
          <UserMenu email={userEmail} />
        </>
      ) : null}
    </header>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { resetAnalytics, track } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";

/**
 * The authenticated user's control in the top bar: their email, and a way out.
 *
 * The email arrives as a prop from the (app) layout's server-side session rather than from
 * `useSession()` — the layout has already resolved the session to guard the route, so asking the
 * browser to fetch it again would be a second round trip for something already known, and would
 * render an empty menu on first paint.
 *
 * Sign-out uses the existing Better Auth client (lib/auth-client), the same call the standalone
 * SignOutButton makes: `authClient.signOut()` clears the session cookie server-side, then
 * `router.refresh()` discards the cached authenticated render so the layout's own guard sees the
 * cleared session and no stale protected content survives the redirect.
 */
export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Escape closes from anywhere inside; a pointer press outside dismisses. Both are listeners
  // rather than a blur handler, so moving between the trigger and the menu does not close it.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);

  // Opening moves focus into the menu so the keyboard path matches the pointer one.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [open]);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // Better Auth's client is built on better-fetch, which RESOLVES with `{ error }` instead of
      // rejecting. A bare `await` therefore reads a failed sign-out as a success, so the result
      // has to be inspected rather than merely awaited.
      const result = (await authClient.signOut()) as { error?: unknown } | undefined;
      if (result?.error) throw new Error("sign-out did not succeed");
      /**
       * Only after the sign-out is confirmed. `reset` clears the distinct id so the next person
       * on a shared library machine is not attributed to this one — the same shared-machine case
       * the error path below is written for.
       */
      track("signout_completed");
      resetAnalytics();
      router.push("/sign-in");
      router.refresh();
    } catch {
      // The session may well still be live. Showing the sign-in page anyway would tell the user
      // they had logged out when they had not — the wrong answer on a shared library machine.
      // Stay put, say so plainly, and let them try again (docs/04 §7).
      setError("Couldn't log out. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="usermenu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-av" aria-hidden="true">
          {email.charAt(0).toUpperCase()}
        </span>
        {/* Hidden below 720px, where only the initial shows — the full address stays one tap away
            in the menu, and `title` surfaces it on a pointer device at any width. */}
        <span className="user-email" title={email}>
          {email}
        </span>
        <svg className="user-caret" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="user-pop" role="menu" aria-label="Account" ref={menuRef}>
          <div className="user-pop-head">
            <span className="lbl">Signed in as</span>
            {/* An email is user data; React escapes it. Long addresses wrap rather than overflow. */}
            <span className="addr">{email}</span>
          </div>
          <div className="user-pop-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="user-pop-item"
            onClick={() => void signOut()}
            disabled={pending}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 17l5-5-5-5M20 12H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 3H5a1 1 0 00-1 1v16a1 1 0 001 1h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {pending ? "Logging out…" : "Log out"}
          </button>
          {error && (
            <p className="user-pop-err" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

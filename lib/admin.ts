import { env } from "./env";

/**
 * Authorisation for the internal usage dashboard (docs/06 Phase 7).
 *
 * WHY A SEPARATE GATE AT ALL. Every other page in this app shows the caller their own data, so a
 * session IS the authorisation — `app/(app)/layout.tsx` redirects and that is the end of it. The
 * usage dashboard is the one page that inverts that: it reads every user's spend, generation
 * counts and email address across the whole tenancy. Session-gating it would mean any signed-in
 * student can read the fleet, which is a data leak wearing an internal-tool badge.
 *
 * FAILS CLOSED. An unset or empty `ADMIN_EMAILS` authorises NOBODY, including in development. The
 * dangerous direction here is unambiguous — a dashboard accidentally open to every user is a
 * breach, while one accidentally shut is an inconvenience the operator notices immediately and
 * fixes with an env var. Anything that resolves ambiguity toward "allow" is wrong.
 *
 * This is authorisation only. It assumes the caller is already AUTHENTICATED — that the email
 * came from a resolved Better Auth session and not from user input — because an allowlist checked
 * against an attacker-supplied string authorises the attacker.
 */

/** Emails permitted to view the dashboard. Empty when unconfigured, which authorises nobody. */
export function adminEmails(): string[] {
  return env.ADMIN_EMAILS.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this session's email an administrator?
 *
 * Compared case-insensitively: identity providers are inconsistent about the case they return, and
 * an allowlist that silently fails to match is a gate nobody can open — which looks identical to a
 * gate that is working correctly, and so goes undiagnosed.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowed = adminEmails();
  if (allowed.length === 0) return false; // fail closed: unconfigured authorises nobody
  return allowed.includes(email.trim().toLowerCase());
}

/**
 * Verified facts behind the legal pages, in one place.
 *
 * THE RULE FOR THIS FILE: nothing here may be asserted unless the repository, its configuration
 * or its documentation proves it. A privacy policy is a set of promises about a running system,
 * and a promise the code does not keep is worse than no policy — it is a false statement to
 * users and regulators.
 *
 * Facts NOT stated anywhere in the legal pages, because nothing in this repository establishes
 * them, are declared below as `null`. Every page renders around a null rather than printing a
 * placeholder, so an unresolved value can never reach a user. `lib/legal.test.ts` enforces both
 * halves of that: no placeholder text ships, and the pages stay coherent while the values are
 * absent. Filling one in is a one-line edit here and needs no change to any page.
 */

/**
 * Public contact destination.
 *
 * GitHub Issues on the project's own repository, VERIFIED PUBLIC on 2026-08-11 by an
 * unauthenticated request to the GitHub API (`visibility: "public"`, HTTP 200) rather than
 * assumed from the git remote — a private repository would render this a dead link on the one
 * page where a user is trying to reach a human.
 *
 * No email address appears anywhere in these pages: this project has none, and inventing one is
 * the exact failure this file exists to prevent.
 */
export const REPO_URL = "https://github.com/thiyagu-sz/Edgify";
export const CONTACT_URL = `${REPO_URL}/issues`;
export const CONTACT_LABEL = "GitHub Issues";

/** The date these documents were written. Not an "effective date" — they take effect on publication. */
export const LAST_UPDATED = "11 August 2026";
export const LAST_UPDATED_ISO = "2026-08-11";

/**
 * ── OWNER-SUPPLIED FACTS, DELIBERATELY UNSET ────────────────────────────────
 *
 * Each is a legal or business fact that only the operator can supply. None is guessable from
 * code, and each is the kind of statement that is actively harmful if wrong.
 */

/** The legal person operating Edgify (e.g. a registered company, or an individual's name). */
export const LEGAL_ENTITY: string | null = null;

/** Governing law and forum for disputes. Inventing one makes the whole Terms unenforceable. */
export const GOVERNING_LAW: string | null = null;

/** A direct contact address, if one is ever created. `CONTACT_URL` is used while this is null. */
export const CONTACT_EMAIL: string | null = null;

/**
 * Third-party processors, each confirmed by a dependency, an environment variable or a
 * deployment document in this repository. Nothing is listed speculatively.
 */
export const SUBPROCESSORS: Array<{ name: string; purpose: string; evidence: string }> = [
  {
    name: "Google (Sign in with Google)",
    purpose:
      "Authenticates you when you choose to sign in with Google, and provides your name, email address and profile picture to create your account.",
    evidence: "lib/auth.ts socialProviders.google; GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET",
  },
  {
    name: "Google Cloud Run",
    purpose: "Hosts and runs the Edgify application, and processes requests made to it.",
    evidence: "docs/07-deployment.md; .github/workflows/deploy.yml",
  },
  {
    name: "Neon",
    purpose: "Provides the PostgreSQL database in which your account and study material are stored.",
    evidence: "docs/02-tech-stack.md; DATABASE_URL",
  },
  {
    name: "OpenRouter",
    purpose:
      "Routes text you submit for generation to third-party AI model providers, and returns the generated result.",
    evidence: "@openrouter/ai-sdk-provider; OPENROUTER_API_KEY; lib/ai/generate.ts",
  },
  {
    name: "Sentry",
    purpose: "Receives technical error reports so faults can be diagnosed and fixed.",
    evidence: "@sentry/nextjs; sentry.server.config.ts; instrumentation-client.ts",
  },
  {
    name: "PostHog",
    purpose: "Receives product analytics events describing how Edgify's features are used.",
    evidence: "posthog-js; lib/analytics.ts; NEXT_PUBLIC_POSTHOG_KEY",
  },
];

/**
 * Cookies actually set, with the names taken from the libraries rather than from memory:
 * Better Auth's default session cookie, and PostHog's per-project cookie.
 *
 * No duration is stated for the session cookie. This project does not configure `session.expiresIn`,
 * so the lifetime is Better Auth's default — and a number that is not pinned in our own
 * configuration is a number that changes under us on a dependency upgrade, silently making the
 * published policy wrong.
 */
export const COOKIES: Array<{
  name: string;
  category: "Essential" | "Analytics";
  purpose: string;
}> = [
  {
    name: "better-auth.session_token",
    category: "Essential",
    purpose:
      "Keeps you signed in as you move between pages. Without it you would have to sign in again on every request. Set only after you sign in, and cleared when you log out.",
  },
  {
    name: "ph_<project>_posthog",
    category: "Analytics",
    purpose:
      "Set by PostHog to recognise a returning browser so that repeated visits are not counted as separate people. Contains a random identifier, not your name or email address.",
  },
];

/** The legal pages, in the order they appear in the in-page navigation and the footer. */
export const LEGAL_PAGES = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/cookies", label: "Cookie Policy" },
  { href: "/ai-disclaimer", label: "AI Disclaimer" },
] as const;

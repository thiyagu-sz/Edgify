import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * `/robots.txt`, generated rather than committed as a static file so the origin can never drift
 * from `SITE_URL` (lib/env.ts).
 *
 * WHAT IS BLOCKED, AND WHY EACH ONE. `Disallow` is a CRAWL directive, not a security control and
 * not reliably an indexing one — a disallowed URL can still be indexed from an inbound link,
 * because the crawler is forbidden from fetching it and therefore never sees a `noindex`. Every
 * private route below is consequently protected by BOTH: this file keeps well-behaved crawlers
 * out, and the routes themselves send `robots: noindex` (their own `metadata`), which is what
 * actually keeps them out of the index. Access control is a third, separate thing and lives in
 * `app/(app)/layout.tsx` and `lib/admin.ts` — nothing here is load-bearing for privacy.
 *
 *  - `/api/`      — no route returns HTML worth indexing; several are POST-only or user-scoped.
 *  - `/notes`,
 *    `/graph`     — the authenticated workspace. A crawler sees only the sign-in redirect, so
 *                   indexing them would put a login page in the results under a product name.
 *  - `/admin/`    — the internal usage dashboard. Never public.
 *  - `/sign-in`,
 *    `/sign-up`   — deliberately excluded. These pages have no content that answers a search, and
 *                   an indexed login page competes with the landing page for the brand query,
 *                   which is the one query that matters most at launch.
 *
 * Everything else is allowed, including `/demo`, which is genuine public content.
 */
const DISALLOW = ["/api/", "/notes", "/graph", "/admin/", "/sign-in", "/sign-up"];

/**
 * ── AI CRAWLERS: A DELIBERATE, DOCUMENTED DECISION ──────────────────────────────────────────
 *
 * THE DECISION: Edgify allows all of them, on exactly the same terms as any other crawler — the
 * public pages, and nothing private.
 *
 * THE REASONING, stated because "allow everything" is the kind of default that looks like nobody
 * thought about it. The only content these bots can reach is the marketing surface: what the
 * product does, what file types it takes, what the graph is for. That copy exists to be read and
 * repeated. Blocking the training crawlers would keep Edgify out of what a model knows by
 * default while protecting nothing — a student's uploaded coursework lives behind authentication
 * and is unreachable by any crawler, allowed or not. The genuine asset here is being described
 * accurately when someone asks an assistant for a study tool, and that argues for being read.
 *
 * Revisit this if the site ever publishes something whose value depends on people arriving to
 * read it rather than being told what it says.
 *
 * WHY THE GROUP IS WRITTEN OUT AT ALL, given that `User-agent: *` already permits every one of
 * these. Two reasons, and the second is the load-bearing one:
 *
 *  1. It makes the answer to "does this site allow AI citation?" readable in the served file,
 *     which is where anyone checking will look — including the operators of these crawlers.
 *  2. robots.txt group matching is WINNER-TAKE-ALL: a crawler that finds a group naming its own
 *     token obeys that group and ignores `*` entirely. So a named group that omits the disallow
 *     list does not inherit it — it silently opens `/api/` and the authenticated routes to that
 *     bot. Both groups therefore spread the SAME `DISALLOW` constant, which makes the drift
 *     impossible rather than merely unlikely, and `app/seo.test.ts` fails if a group is ever
 *     added without it.
 *
 * TOKENS VERIFIED AGAINST EACH OPERATOR'S OWN DOCUMENTATION on 2026-08-19, not from memory —
 * these names change, and a misspelled token is a rule that silently matches nothing:
 *
 *  - OpenAI (developers.openai.com/api/docs/bots): `OAI-SearchBot` surfaces sites in ChatGPT
 *    search, `GPTBot` collects training data, `ChatGPT-User` fetches a page a user asked for.
 *  - Anthropic (support.claude.com article 8896518): `Claude-SearchBot` improves search results,
 *    `ClaudeBot` collects training data, `Claude-User` handles user-initiated fetches.
 *  - Perplexity (docs.perplexity.ai/guides/bots): `PerplexityBot` builds the search index and is
 *    explicitly not a training crawler; `Perplexity-User` is user-initiated.
 *  - Google (developers.google.com/search/docs/crawling-indexing/google-common-crawlers):
 *    `Google-Extended` governs Gemini training AND grounding. Google states plainly that it
 *    "does not impact a site's inclusion in Google Search nor is it used as a ranking signal",
 *    so it is a Gemini decision only — allowed here for the grounding half.
 *  - `Applebot-Extended`, `CCBot`, `Meta-ExternalAgent`, `Amazonbot` — the remaining crawlers
 *    with published tokens, included so the policy is complete rather than partial.
 *
 * Two of these ignore robots.txt by design, and that is not an argument against listing them:
 * `ChatGPT-User` and `Perplexity-User` fetch because a person asked for the page, and both
 * operators say so. Naming them records that we would have allowed them anyway.
 */
const AI_CRAWLERS = [
  "OAI-SearchBot",
  "GPTBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Meta-ExternalAgent",
  "Amazonbot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOW,
      },
      {
        // Same terms as everyone else. See the note above for why this is written out.
        userAgent: AI_CRAWLERS,
        allow: "/",
        disallow: DISALLOW,
      },
    ],
    sitemap: `${env.SITE_URL}/sitemap.xml`,
    host: env.SITE_URL,
  };
}

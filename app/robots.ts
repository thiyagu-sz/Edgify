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
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/notes", "/graph", "/admin/", "/sign-in", "/sign-up"],
      },
    ],
    sitemap: `${env.SITE_URL}/sitemap.xml`,
    host: env.SITE_URL,
  };
}

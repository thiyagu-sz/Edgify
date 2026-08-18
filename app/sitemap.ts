import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { LEGAL_PAGES } from "@/lib/legal";

/**
 * `/sitemap.xml`.
 *
 * ONLY PUBLIC, INDEXABLE, CANONICAL URLS BELONG HERE. A sitemap is a statement to Google that
 * these pages are worth indexing, so listing anything that returns a redirect or carries
 * `noindex` produces "Submitted URL has crawl issue" / "Submitted URL marked noindex" in Search
 * Console — noise that buries the real problems on the one report checked after launch.
 *
 * That leaves eight URLs, and the small number is correct rather than an omission:
 *  - `/`          the landing page.
 *  - `/demo`      the signed-out workspace. Real, substantial, static public content.
 *  - two SEO landing pages, each answering one search intent with content that exists nowhere
 *    else on the site. They are static server components with no session and no model call.
 *  - the four legal documents, which are public by design.
 *
 * Deliberately absent: `/notes` and `/graph` (redirect to sign-in for a crawler), `/admin/usage`
 * (internal), `/sign-in` and `/sign-up` (thin, and they would compete with `/` for the brand
 * query), and every `/api/*` route. `app/robots.ts` blocks the same set — the two files must stay
 * consistent, and `app/seo.test.ts` asserts that they do.
 *
 * `lastModified` is intentionally the build time. These are hand-written pages with no CMS behind
 * them, so a build is the only moment their content can actually have changed; inventing a fixed
 * date would be a claim, and `new Date()` per request would tell Google the page changes
 * constantly and train it to ignore the signal.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    {
      url: `${env.SITE_URL}/`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${env.SITE_URL}/demo`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    /**
     * The SEO landing pages. Each targets one search intent — "PDF to study notes" and "concept
     * map for studying" — and describes a feature the product actually has. `monthly` because
     * they change when the feature does; `0.7` puts them below the demo, which is the stronger
     * conversion surface, and well above the legal pages.
     */
    {
      url: `${env.SITE_URL}/pdf-to-study-notes`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: `${env.SITE_URL}/concept-map-for-studying`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.7,
    },
    /**
     * The legal documents. Public, indexable and genuinely useful to a person deciding whether
     * to trust the product with their coursework — `noindex` on a privacy policy hides exactly
     * the page a cautious user goes looking for. Low priority because they are not what anyone
     * searches for, and `yearly` because they change when the product's handling changes, not
     * on a schedule.
     */
    ...LEGAL_PAGES.map(({ href }) => ({
      url: `${env.SITE_URL}${href}`,
      lastModified,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}

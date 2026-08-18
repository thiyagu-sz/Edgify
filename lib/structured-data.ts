/**
 * Schema.org JSON-LD for the public landing page.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: every value here must be a fact about Edgify that is
 * independently checkable on the page itself. Structured data is a machine-readable claim made
 * directly to Google, and a false one is not a harmless exaggeration — fabricated ratings, review
 * counts, prices or user numbers are a manual-action category, and the penalty lands on the whole
 * domain rather than the offending snippet.
 *
 * DELIBERATELY ABSENT, each for a reason:
 *
 *  - `aggregateRating` / `review` — Edgify has no reviews. This is the single most commonly faked
 *    property because it is what earns the star treatment in results; inventing one to get stars
 *    is exactly the manual action above.
 *  - `offers` / `price` — there is no billing in the product today, but "free" is still a
 *    forward-looking commercial claim, and `app/sign-up/page.tsx` already made the same call for
 *    the same reason. Its absence means SoftwareApplication will not qualify for a rich result;
 *    that is the correct trade, and adding a price to qualify is the wrong one. Revisit only if
 *    pricing genuinely exists.
 *  - `SearchAction` on WebSite — there is no site-wide search endpoint. Declaring one produces a
 *    search box in results that leads nowhere.
 *
 * Kept as data rather than JSX so `lib/structured-data.test.ts` can assert those absences
 * directly. Every string is a module constant — no user input, no model output reaches this.
 */

export type JsonLd = Record<string, unknown>;

const DESCRIPTION =
  "Edgify turns notes, slides and PDFs into short, high-yield exam revision, and builds a " +
  "concept dependency graph that shows which topics to learn first.";

/**
 * The `@graph` form: one script, several linked entities, each with an `@id` so they reference
 * one another instead of repeating themselves.
 */
export function landingJsonLd(siteUrl: string): JsonLd {
  const site = siteUrl.replace(/\/$/, "");
  const organisationId = `${site}/#organization`;
  const websiteId = `${site}/#website`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organisationId,
        name: "Edgify",
        url: `${site}/`,
        logo: `${site}/icon-512.png`,
        description: DESCRIPTION,
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: "Edgify",
        url: `${site}/`,
        description: DESCRIPTION,
        publisher: { "@id": organisationId },
        inLanguage: "en",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${site}/#software`,
        name: "Edgify",
        url: `${site}/`,
        description: DESCRIPTION,
        // Both are accurate and checkable: it runs in a browser, and it is a study tool.
        applicationCategory: "EducationalApplication",
        operatingSystem: "Web browser",
        browserRequirements: "Requires JavaScript.",
        publisher: { "@id": organisationId },
        // Each of these is visible on the landing page. Nothing here is aspirational.
        featureList: [
          "Generate high-yield revision notes from your own material",
          // EIGHT, corrected 2026-08-16. `lib/ai/prompts.ts` defines exactly eight formats — six
          // markdown (key points, main concepts, exam points, short notes, formulas & terms,
          // summary) and two quiz (MCQs, quick test). "Nine" was carried over from an early draft
          // and `docs/06` already recorded the correction for the landing copy. A miscount in
          // structured data is a machine-readable claim to Google that the page itself disproves.
          "Eight revision formats, including multiple-choice questions and a graded quick test",
          "Upload PDF, DOCX, TXT or Markdown, or paste text directly",
          "Concept dependency graph built from an uploaded document",
          "Per-concept explanations, quizzes and flashcards",
          "Learning-readiness scoring across prerequisites",
          "Export to PDF or Word",
        ],
        inLanguage: "en",
      },
    ],
  };
}

/**
 * `BreadcrumbList` for a second-level public page.
 *
 * WHY THIS AND NOTHING ELSE. The SEO landing pages deliberately do NOT repeat `Organization`,
 * `WebSite` or `SoftwareApplication` — those are stated once on `/` and re-declaring the same
 * entity on every page gives Google several copies to reconcile for no gain. A breadcrumb is the
 * opposite case: it is per-page by definition, it describes a real path a visitor can follow
 * (home → this page, both links that exist), and Google does still render breadcrumbs in results.
 *
 * `FAQPage` is deliberately absent too. Google restricted FAQ rich results to government and
 * health sites in August 2023, so marking up an FAQ now adds a claim with no visible benefit —
 * the same trade `landingJsonLd` refuses for `offers` and `aggregateRating`.
 *
 * `name` and `path` are module constants supplied by the calling page. Nothing user- or
 * model-generated reaches this function.
 */
export function breadcrumbJsonLd(siteUrl: string, name: string, path: string): JsonLd {
  const site = siteUrl.replace(/\/$/, "");
  const page = `${site}${path.startsWith("/") ? path : `/${path}`}`;

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${site}/` },
      // The last crumb carries no `item`: it is the current page, and self-linking the final
      // element is the most common way this markup is rejected.
      { "@type": "ListItem", position: 2, name },
    ],
    // Kept for the resolver's benefit — the page's own URL, not a second entity.
    "@id": `${page}#breadcrumb`,
  };
}

/**
 * Serialise for embedding in a `<script type="application/ld+json">`.
 *
 * `<` is escaped to its unicode form so a literal `</script>` can never appear in the output and
 * close the tag early. Nothing user-controlled reaches this function today, and this is what keeps
 * that true if anything ever does.
 */
export function serialiseJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

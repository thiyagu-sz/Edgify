import type { Metadata } from "next";

/**
 * Shared social-card constants.
 *
 * THIS MODULE EXISTS BECAUSE OF A NEXT.JS METADATA FOOTGUN, found by reading the built HTML
 * rather than by reasoning about it. Page-level `openGraph` / `twitter` objects REPLACE the
 * parent's wholesale — they are not deep-merged. So a page that overrides `openGraph` to set its
 * own title silently drops the root's `images`, and the card loses its picture. Worse, Twitter
 * downgrades a `summary_large_image` card with no image to a plain `summary`, so the failure
 * shows up as a small grey card rather than as an error.
 *
 * The first version of the launch SEO work did exactly this and shipped a landing page with NO
 * `og:image` at all — strictly worse than the wrong-URL bug it was fixing. Every page-level
 * override must therefore spread `OG_IMAGE` back in, and `lib/seo.test.ts` fails if one forgets.
 */

/** 1200×630, the size every major platform crops from. Lives at `public/og-image.png`. */
export const OG_IMAGE = {
  url: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "Edgify — an academic study workspace",
} as const;

/** Spread into any page-level `openGraph` block. */
export const OG_IMAGES: NonNullable<NonNullable<Metadata["openGraph"]>["images"]> = [{ ...OG_IMAGE }];

/** Spread into any page-level `twitter` block. */
export const TWITTER_IMAGES: NonNullable<NonNullable<Metadata["twitter"]>["images"]> = [
  OG_IMAGE.url,
];

import { describe, expect, it, vi } from "vitest";

/**
 * `next/font/google` is a build-time transform, not a runtime function — importing the root
 * layout outside `next build` throws "Inter is not a function". The loaders are stubbed with the
 * shape the layout actually consumes (a `variable` class name), which is unrelated to anything
 * asserted below.
 */
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "--font-inter" }),
  JetBrains_Mono: () => ({ variable: "--font-jetbrains-mono" }),
}));

const { metadata: rootMetadata } = await import("./layout");
import { metadata as landingMetadata } from "./(marketing)/page";
import { metadata as demoMetadata } from "./demo/page";
import { metadata as signInMetadata } from "./sign-in/page";
import { metadata as signUpMetadata } from "./sign-up/page";

/**
 * Page metadata, pinned — and specifically the merge behaviour that is easy to get wrong.
 *
 * NEXT REPLACES `openGraph` AND `twitter` WHOLESALE rather than deep-merging them with the
 * parent's. A page that overrides either to set its own title therefore DROPS the root's images
 * unless it restates them, and the symptom is not an error: the card just loses its picture, and
 * Twitter quietly downgrades `summary_large_image` to a small `summary`.
 *
 * That is not hypothetical here. The first pass of this work shipped a landing page with no
 * `og:image` at all — strictly worse than the wrong-URL bug it was fixing — and it was caught by
 * reading the built HTML, not by review. These assertions are what make it stay fixed.
 */

const PAGES = [
  ["landing", landingMetadata],
  ["demo", demoMetadata],
] as const;

describe("every indexable page ships a complete social card", () => {
  it.each(PAGES)("%s has an og:image", (_name, meta) => {
    const images = meta.openGraph?.images;
    expect(images, "openGraph.images is missing — the parent's is NOT inherited").toBeTruthy();
    expect([images].flat().length).toBeGreaterThan(0);
  });

  it.each(PAGES)("%s requests a large Twitter card and supplies its image", (_name, meta) => {
    // A large-image card with no image renders as a small grey one.
    expect(meta.twitter && "card" in meta.twitter ? meta.twitter.card : undefined).toBe(
      "summary_large_image",
    );
    expect([meta.twitter?.images].flat().filter(Boolean).length).toBeGreaterThan(0);
  });

  it.each(PAGES)("%s states its own canonical", (_name, meta) => {
    expect(meta.alternates?.canonical, "no canonical — it would inherit the root's").toBeTruthy();
  });

  it("gives the two pages DIFFERENT canonicals", () => {
    // The bug this catches: a root-level canonical inherited everywhere, so every page claims to
    // be the home page and asks Google to fold the others into it.
    expect(String(landingMetadata.alternates?.canonical)).not.toBe(
      String(demoMetadata.alternates?.canonical),
    );
  });

  it("gives the two pages different titles and descriptions", () => {
    expect(JSON.stringify(landingMetadata.title)).not.toBe(JSON.stringify(demoMetadata.title));
    expect(landingMetadata.description).not.toBe(demoMetadata.description);
  });
});

describe("the root layout", () => {
  it("resolves relative metadata against the canonical production origin", () => {
    // The P0: BETTER_AUTH_URL is the Dockerfile's localhost placeholder at build time, so every
    // production share card pointed at http://localhost:3000/og-image.png.
    // Typed `string | URL`; this project always passes a URL, and asserting on the parsed origin
    // rather than on string equality means a trailing slash cannot fail the test spuriously.
    const base = rootMetadata.metadataBase;
    expect(base).toBeInstanceOf(URL);
    expect((base as URL).origin).toBe("https://edgify.online");
  });

  it("sets NO canonical of its own, because `alternates` is inherited", () => {
    expect(rootMetadata.alternates?.canonical).toBeUndefined();
  });

  it("allows indexing by default", () => {
    const robots = rootMetadata.robots;
    expect(typeof robots === "object" && robots?.index).toBe(true);
  });
});

describe("private pages are not indexable", () => {
  it.each([
    ["sign-in", signInMetadata],
    ["sign-up", signUpMetadata],
  ])("%s is noindex", (_name, meta) => {
    const robots = meta.robots;
    expect(typeof robots === "object" && robots?.index).toBe(false);
  });

  it.each([
    ["sign-in", signInMetadata],
    ["sign-up", signUpMetadata],
  ])("%s claims no canonical, so it cannot claim to be the home page", (_name, meta) => {
    expect(meta.alternates?.canonical).toBeUndefined();
  });
});

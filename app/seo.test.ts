import { describe, expect, it } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";

/**
 * Crawlability and indexability, pinned.
 *
 * These are not tests that Next can generate a `robots.txt` — they are tests that OURS says what
 * we decided it should say. Every assertion here corresponds to a mistake that is silent at
 * deploy time and expensive weeks later: a `Disallow: /` shipped by accident deindexes the site
 * and nothing in the app misbehaves; an authenticated route in the sitemap produces "Submitted
 * URL marked noindex" in Search Console; a sitemap on the wrong origin is simply ignored.
 *
 * The canonical origin is asserted literally rather than read from `env.SITE_URL`, deliberately.
 * Deriving it would make these pass against whatever the variable happened to be — including the
 * `localhost:3000` that this whole change exists to stop shipping.
 */

const CANONICAL = "https://edgify.online";

/** Paths that must never be crawled or indexed. */
const PRIVATE_PATHS = ["/api/", "/notes", "/graph", "/admin/", "/sign-in", "/sign-up"];

describe("robots.txt", () => {
  const rules = () => {
    const r = robots().rules;
    return Array.isArray(r) ? r : [r];
  };

  it("does not block the whole site", () => {
    // The single most damaging one-character mistake available here.
    for (const rule of rules()) {
      const disallow = [rule.disallow ?? []].flat();
      expect(disallow, "robots.txt disallows everything — the site would be deindexed").not.toContain("/");
    }
  });

  it("allows the public site", () => {
    const allow = rules().flatMap((r) => [r.allow ?? []].flat());
    expect(allow).toContain("/");
  });

  it("blocks every private surface", () => {
    const disallow = rules().flatMap((r) => [r.disallow ?? []].flat());
    for (const path of PRIVATE_PATHS) {
      expect(disallow, `${path} is crawlable`).toContain(path);
    }
  });

  it("points at the sitemap on the canonical production origin", () => {
    // A Cloud Run URL here would submit a sitemap Google treats as a different site.
    expect(robots().sitemap).toBe(`${CANONICAL}/sitemap.xml`);
  });

  it("never advertises a non-production origin", () => {
    const serialised = JSON.stringify(robots());
    expect(serialised).not.toMatch(/localhost|127\.0\.0\.1|run\.app/i);
  });
});

describe("sitemap.xml", () => {
  it("lists exactly the public, indexable pages", () => {
    // The legal documents are deliberately included: `noindex` on a privacy policy hides the
    // page a cautious user goes looking for before trusting the product with their coursework.
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual([
      `${CANONICAL}/`,
      `${CANONICAL}/demo`,
      `${CANONICAL}/privacy`,
      `${CANONICAL}/terms`,
      `${CANONICAL}/cookies`,
      `${CANONICAL}/ai-disclaimer`,
    ]);
  });

  it("contains no private, authenticated or API route", () => {
    const urls = sitemap().map((e) => e.url);
    for (const path of PRIVATE_PATHS) {
      const offending = urls.filter((u) => u.includes(path));
      expect(
        offending,
        `${path} is in the sitemap — Search Console will report it as blocked or noindex`,
      ).toEqual([]);
    }
  });

  it("uses absolute URLs on the canonical origin", () => {
    for (const entry of sitemap()) {
      expect(entry.url.startsWith(`${CANONICAL}/`), `${entry.url} is not canonical`).toBe(true);
    }
  });

  it("never leaks a build-time or preview origin", () => {
    expect(JSON.stringify(sitemap())).not.toMatch(/localhost|127\.0\.0\.1|run\.app/i);
  });
});

describe("robots and the sitemap agree", () => {
  /**
   * The two files are written independently, so they can disagree — and a URL that is both
   * submitted and disallowed is the specific combination that fills Search Console's coverage
   * report with errors while looking fine in the code.
   */
  it("submits nothing it also disallows", () => {
    const disallow = [robots().rules].flat().flatMap((r) => [r?.disallow ?? []].flat());
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname;
      const blocked = disallow.filter((d) => d !== "/" && path.startsWith(d));
      expect(blocked, `${path} is in the sitemap and disallowed by robots.txt`).toEqual([]);
    }
  });
});

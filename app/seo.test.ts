import { existsSync } from "node:fs";
import { join } from "node:path";
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

  /**
   * THE ONE THAT MATTERS ONCE A SECOND GROUP EXISTS. robots.txt group matching is
   * winner-take-all: a crawler that finds a group naming its own user-agent obeys that group and
   * ignores `*` completely. It does NOT inherit the wildcard group's `Disallow` lines. So a
   * named group written without them hands that specific bot the API and the authenticated
   * workspace, while `/robots.txt` still looks correct to anyone reading the top of the file.
   */
  it("repeats the full disallow list in EVERY group, not just the wildcard", () => {
    for (const rule of rules()) {
      const agents = [rule.userAgent ?? "*"].flat().join(", ");
      const disallow = [rule.disallow ?? []].flat();
      for (const path of PRIVATE_PATHS) {
        expect(
          disallow,
          `the group for "${agents}" does not disallow ${path} — that group's crawlers ignore ` +
            `the wildcard rules entirely, so ${path} is open to them`,
        ).toContain(path);
      }
    }
  });

  /**
   * The AI-crawler decision, pinned so it cannot be reversed silently. Edgify allows these on the
   * same terms as any other crawler (app/robots.ts documents why). A future change of mind is
   * fine — it just has to be made here as well, deliberately, rather than by deleting a line.
   *
   * The search-time crawlers are asserted specifically: they are the ones that decide whether
   * Edgify can be CITED by an AI answer engine, which is the whole point of the exercise.
   */
  it("allows the AI search crawlers Edgify wants citations from", () => {
    const named = rules().flatMap((r) => [r.userAgent ?? []].flat());
    for (const bot of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"]) {
      expect(named, `${bot} is no longer named — the citation policy changed silently`).toContain(bot);
    }
    for (const rule of rules()) {
      const agents = [rule.userAgent ?? "*"].flat();
      if (!agents.includes("OAI-SearchBot")) continue;
      expect([rule.allow ?? []].flat(), "the AI-crawler group does not allow the public site").toContain("/");
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
    // The two SEO landing pages are public server components with no session and no model call.
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual([
      `${CANONICAL}/`,
      `${CANONICAL}/demo`,
      `${CANONICAL}/pdf-to-study-notes`,
      `${CANONICAL}/concept-map-for-studying`,
      `${CANONICAL}/privacy`,
      `${CANONICAL}/terms`,
      `${CANONICAL}/cookies`,
      `${CANONICAL}/ai-disclaimer`,
    ]);
  });

  it("submits only URLs that correspond to a page on disk", () => {
    /**
     * A sitemap entry for a route that does not exist is a 404 submitted to Google. The route
     * group `(marketing)` does not appear in the URL, so the mapping is checked rather than
     * assumed — this is the assertion that would have caught a typo in either new path.
     */
    const candidates = (path: string) => [
      join("app", "(marketing)", path, "page.tsx"),
      join("app", "(legal)", path, "page.tsx"),
      join("app", path, "page.tsx"),
    ];
    for (const { url } of sitemap()) {
      const path = new URL(url).pathname.replace(/^\/|\/$/g, "");
      if (path === "") continue; // `/` is the (marketing) index, asserted by landing.test.tsx
      const found = candidates(path).some((p) => existsSync(join(process.cwd(), p)));
      expect(found, `${url} has no page.tsx on disk`).toBe(true);
    }
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

import { describe, expect, it } from "vitest";
import { breadcrumbJsonLd, landingJsonLd, serialiseJsonLd } from "./structured-data";

/**
 * Structured data is a machine-readable claim made directly to Google, so the tests that matter
 * are the ones asserting what is NOT there. Fabricated ratings, review counts or prices are a
 * manual-action category, and the penalty applies to the whole domain rather than the snippet —
 * so "someone adds an aggregateRating to get stars in the results" is the exact regression worth
 * a permanent guard.
 */

const SITE = "https://edgify.online";
const data = landingJsonLd(SITE);
const serialised = serialiseJsonLd(data);

describe("no unsupported claims", () => {
  it.each([
    ["aggregateRating", /aggregateRating/i],
    ["review", /"review"|reviewCount|reviewBody/i],
    ["price", /"price"|priceCurrency|"offers"/i],
    ["user counts", /userInteractionCount|InteractionCounter/i],
  ])("declares no %s — Edgify has none to declare", (_label, pattern) => {
    expect(serialised).not.toMatch(pattern);
  });

  it("makes no superlative claim", () => {
    expect(serialised).not.toMatch(/\bbest\b|\bnumber one\b|#1|most advanced|leading/i);
  });
});

describe("the entities are well formed", () => {
  it("declares the three intended types and no others", () => {
    const graph = data["@graph"] as Array<{ "@type": string }>;
    expect(graph.map((n) => n["@type"]).sort()).toEqual([
      "Organization",
      "SoftwareApplication",
      "WebSite",
    ]);
  });

  it("cross-references the organisation by @id rather than repeating it", () => {
    const graph = data["@graph"] as Array<Record<string, unknown>>;
    const org = graph.find((n) => n["@type"] === "Organization");
    const site = graph.find((n) => n["@type"] === "WebSite");
    expect(site?.publisher).toEqual({ "@id": org?.["@id"] });
  });

  it("uses the canonical origin for every URL it states", () => {
    for (const url of serialised.match(/https?:\/\/[^"]+/g) ?? []) {
      // schema.org's own context URL is the one legitimate exception.
      if (url.startsWith("https://schema.org")) continue;
      expect(url.startsWith(SITE), `${url} is not on the canonical origin`).toBe(true);
    }
  });

  it("declares no SearchAction, because there is no site search endpoint", () => {
    expect(serialised).not.toMatch(/SearchAction|potentialAction/i);
  });
});

describe("the SEO landing pages state a breadcrumb and nothing else", () => {
  const crumb = breadcrumbJsonLd(SITE, "PDF to Study Notes", "/pdf-to-study-notes");
  const crumbJson = serialiseJsonLd(crumb);

  it("is a BreadcrumbList", () => {
    expect(crumb["@type"]).toBe("BreadcrumbList");
  });

  it("does not repeat the organisation, website or application entity", () => {
    // These are stated once, on `/`. Re-declaring the same entity per page gives Google several
    // copies of one thing to reconcile, which is the reason this helper is deliberately small.
    expect(crumbJson).not.toMatch(/Organization|WebSite|SoftwareApplication/);
  });

  it("does not self-link the final crumb", () => {
    // A last ListItem carrying its own `item` is the most common way this markup is rejected.
    const items = crumb.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[1]).not.toHaveProperty("item");
    expect(items[1].name).toBe("PDF to Study Notes");
  });

  it("points the first crumb at the canonical home page", () => {
    const items = crumb.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].item).toBe(`${SITE}/`);
  });

  it("normalises a trailing slash on the site URL", () => {
    const items = (breadcrumbJsonLd(`${SITE}/`, "X", "/x").itemListElement as Array<
      Record<string, unknown>
    >)[0];
    expect(items.item).toBe(`${SITE}/`);
  });

  it("uses the canonical origin for every URL it states", () => {
    for (const url of crumbJson.match(/https?:\/\/[^"]+/g) ?? []) {
      if (url.startsWith("https://schema.org")) continue;
      expect(url.startsWith(SITE), `${url} is not on the canonical origin`).toBe(true);
    }
  });
});

describe("serialisation is injection-safe", () => {
  it("escapes < so a payload can never close the script tag", () => {
    const escaped = serialiseJsonLd({ name: "</script><img onerror=alert(1)>" });
    expect(escaped).not.toContain("</script>");
    expect(escaped).toContain("\\u003c");
  });

  it("round-trips to valid JSON", () => {
    // The escape must not corrupt the document — JSON.parse reads < back as "<".
    expect(() => JSON.parse(serialised)).not.toThrow();
    expect(JSON.parse(serialiseJsonLd({ a: "<b>" })).a).toBe("<b>");
  });
});

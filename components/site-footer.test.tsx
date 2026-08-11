import { existsSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./site-footer";

/**
 * The footer, guarded against the two failures that matter.
 *
 * ONE: A DEAD LINK. A footer is where "Docs", "Blog", "About" and "Careers" get added because
 * the column looks thin, and each is a 404 on launch day. The test below resolves every internal
 * `href` against the App Router directory on disk, so a link to a route that does not exist fails
 * here rather than in front of a Product Hunt audience.
 *
 * TWO: A REGRESSION IN WHAT WAS ALREADY THERE. The previous footer carried Features, How it
 * works, Try the demo and Launch app. Expanding a footer is exactly when such links get dropped,
 * so each is asserted individually.
 */

const mark = <svg data-testid="brand-mark" />;

/** Does `href` correspond to a real page in the App Router? */
function routeExists(href: string): boolean {
  const path = href.split("#")[0].split("?")[0];
  if (path === "/") return existsSync(join(process.cwd(), "app", "(marketing)", "page.tsx"));
  const segment = path.replace(/^\//, "");
  // A page may live at the top level, in the (app) group, or in the (legal) group.
  return [
    join("app", segment, "page.tsx"),
    join("app", "(app)", segment, "page.tsx"),
    join("app", "(legal)", segment, "page.tsx"),
  ].some((p) => existsSync(join(process.cwd(), p)));
}

describe("no dead links", () => {
  it("every internal link resolves to a real route", () => {
    const { container } = render(<SiteFooter brandMark={mark} />);
    const internal = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("/"));

    expect(internal.length, "no internal links found — the test is not exercising anything").toBeGreaterThan(5);

    const broken = internal.filter((h) => !routeExists(h));
    expect(broken, `footer links point at routes that do not exist: ${broken.join(", ")}`).toEqual([]);
  });

  it("every in-page anchor targets a section id the landing page defines", () => {
    const { container } = render(<SiteFooter brandMark={mark} />);
    const anchors = [...container.querySelectorAll("a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("#"));

    // These ids are rendered by app/(marketing)/page.tsx.
    const KNOWN = ["#lx-features", "#lx-modes", "#lx-start"];
    for (const a of anchors) expect(KNOWN, `${a} is not a section on the landing page`).toContain(a);
  });

  it("external links open safely", () => {
    const { container } = render(<SiteFooter brandMark={mark} />);
    const external = [...container.querySelectorAll("a")].filter((a) =>
      (a.getAttribute("href") ?? "").startsWith("http"),
    );
    expect(external.length).toBeGreaterThan(0);
    for (const a of external) {
      // `noopener` matters: without it the opened page can reach back via window.opener.
      expect(a.getAttribute("rel") ?? "").toContain("noopener");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });
});

describe("nothing that already worked was removed", () => {
  it.each([
    ["Try the demo", "/demo"],
    ["Launch workspace", "/notes"],
    ["Quick Notes", "/notes"],
    ["Knowledge Graph", "/graph"],
  ])("still links %s → %s", (label, href) => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByRole("link", { name: new RegExp(`^${label}$`, "i" ) })).toHaveAttribute("href", href);
  });

  it.each(["Features", "How it works", "Get started"])("still links %s", (label) => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
  });

  it("keeps the brand mark and the product line", () => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByTestId("brand-mark")).toBeInTheDocument();
    expect(screen.getByText("An academic study workspace")).toBeInTheDocument();
  });
});

describe("legal and contact", () => {
  it.each([
    ["Privacy Policy", "/privacy"],
    ["Terms of Service", "/terms"],
    ["Cookie Policy", "/cookies"],
    ["AI Disclaimer", "/ai-disclaimer"],
  ])("links %s → %s", (label, href) => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
  });

  it("offers a real feedback destination", () => {
    render(<SiteFooter brandMark={mark} />);
    const feedback = screen.getByRole("link", { name: /feedback/i });
    expect(feedback.getAttribute("href")).toMatch(/^https:\/\/github\.com\/.+\/issues$/);
  });

  it("surfaces the AI caveat on the public page, not only in the disclaimer", () => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByText(/AI-generated and may contain errors/i)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("is a footer landmark", () => {
    render(<SiteFooter brandMark={mark} />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("groups links in labelled navigation regions", () => {
    render(<SiteFooter brandMark={mark} />);
    // Each column is its own <nav> with an accessible name, so a screen-reader user can skip
    // between them instead of hearing one undifferentiated list of sixteen links.
    for (const name of ["Product", "Learn more", "Contact", "Legal"]) {
      const nav = screen.getByRole("navigation", { name });
      expect(within(nav).getAllByRole("link").length).toBeGreaterThan(0);
    }
  });
});

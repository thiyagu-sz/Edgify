import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "@/components/top-bar";
import LandingPage from "./page";

// Hoisted by vitest regardless of position; declared here so the file reads in execution order.
vi.mock("next/navigation", () => ({ usePathname: () => "/graph" }));

/**
 * "Landing page matches the prototype" (docs/06 Phase 6).
 *
 * The comparison is derived from `docs/reference/edgify-prototype.html` at run time rather than
 * transcribed into a list here. A hand-written list of expected classes is a second copy of the
 * specification, and it goes stale silently — it would still pass after someone deleted a section
 * from the port, because the list would have been trimmed to match in the same commit.
 *
 * Reading the prototype means the test fails when the render stops matching THE SPEC, which is
 * the property AGENTS.md rule 6 actually asks for.
 */

const PROTOTYPE = readFileSync(
  join(process.cwd(), "docs/reference/edgify-prototype.html"),
  "utf8",
);

/** The prototype's landing block: `<div id="landing">` up to the workspace header that follows. */
function landingSource(): string {
  const start = PROTOTYPE.indexOf('<div id="landing">');
  const end = PROTOTYPE.indexOf('<header class="topbar"', start);
  expect(start, "the prototype no longer contains a #landing block").toBeGreaterThan(-1);
  expect(end, "could not find the end of the prototype's landing block").toBeGreaterThan(start);
  return PROTOTYPE.slice(start, end);
}

/**
 * Class tokens the port is not expected to carry.
 *
 * `js-launch` is the prototype's click hook for navigating without a router. Here those elements
 * are `<Link>`s, so the hook has no purpose — the BEHAVIOUR it stood for is asserted separately
 * below, which is the honest replacement for carrying a dead class name.
 */
const NOT_PORTED = new Set(["js-launch"]);

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/class="([^"]+)"/g)) {
    for (const token of match[1].split(/\s+/)) {
      if (token && !NOT_PORTED.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

function renderedTokens(root: HTMLElement): Set<string> {
  const tokens = new Set<string>();
  root.querySelectorAll("[class]").forEach((el) => {
    el.getAttribute("class")
      ?.split(/\s+/)
      .forEach((t) => t && tokens.add(t));
  });
  return tokens;
}

describe("the landing page matches the prototype", () => {
  it("renders every class the prototype's landing block uses", () => {
    const expected = classTokens(landingSource());
    // Premise guard: a bad slice would yield an empty set and pass everything below.
    expect(expected.size).toBeGreaterThan(25);

    const { container } = render(<LandingPage />);
    const actual = renderedTokens(container);

    const missing = [...expected].filter((t) => !actual.has(t)).sort();
    expect(missing, `classes present in the prototype but missing from the port: ${missing.join(", ")}`).toEqual([]);
  });

  it("renders every anchor target the prototype defines", () => {
    const expected = [...idsIn(landingSource())];
    expect(expected).toContain("lx-features");

    const { container } = render(<LandingPage />);
    for (const id of expected) {
      expect(container.querySelector(`#${id}`), `#${id} is missing from the port`).toBeTruthy();
    }
  });

  it("keeps the prototype's section counts", () => {
    const source = landingSource();
    const count = (html: string, cls: string) =>
      [...html.matchAll(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`, "g"))].length;

    const { container } = render(<LandingPage />);
    // Six bento cards, three steps, two mode panels — dropping one is the most likely way a port
    // silently diverges, and it is invisible to a class-name check.
    expect(container.querySelectorAll(".lx-card").length).toBe(count(source, "lx-card"));
    expect(container.querySelectorAll(".lx-step").length).toBe(count(source, "lx-step"));
    expect(container.querySelectorAll(".lx-mode").length).toBe(count(source, "lx-mode"));
  });

  it("is wrapped in #landing, so the dark theme is scoped", () => {
    const { container } = render(<LandingPage />);
    const root = container.querySelector("#landing");
    expect(root).toBeTruthy();
    // Everything the page renders must live inside it — a stray sibling would be unstyled.
    expect(container.children.length).toBe(1);
    expect(container.firstElementChild?.id).toBe("landing");
  });
});

describe("the landing page's entry points", () => {
  /**
   * UPDATED, not relaxed. This previously required all three launch actions to point at
   * `/notes`, which encoded the old CTA: "Launch workspace" as the primary call to action.
   *
   * That reads as an instruction to someone who already has an account. A first-time visitor has
   * no workspace to launch, and following it only produced a redirect to sign-in with no
   * explanation. The hero and closing CTA now ask for an account instead; the NAV keeps "Launch
   * app" → `/notes`, which is what still carries a signed-in visitor straight through.
   *
   * The assertions below are stricter than the one they replace: every account CTA is pinned to a
   * specific existing Better Auth route, and the nav's behaviour is pinned separately rather than
   * lumped in with the others.
   */
  it("asks an unauthenticated visitor to create an account", () => {
    render(<LandingPage />);
    const signUps = screen.getAllByRole("link", { name: /^sign up$/i });
    expect(signUps.length, "hero and closing CTA").toBeGreaterThanOrEqual(2);
    for (const link of signUps) expect(link.getAttribute("href")).toBe("/sign-up");
  });

  it("offers signing in alongside it, for visitors who already have an account", () => {
    render(<LandingPage />);
    const signIns = screen.getAllByRole("link", { name: /^sign in$/i });
    expect(signIns.length).toBeGreaterThanOrEqual(1);
    for (const link of signIns) expect(link.getAttribute("href")).toBe("/sign-in");
  });

  it("points every account CTA at the EXISTING auth routes, never a new one", () => {
    // Guards against a second authentication path being introduced alongside Better Auth.
    render(<LandingPage />);
    const auth = [
      ...screen.getAllByRole("link", { name: /^sign up$/i }),
      ...screen.getAllByRole("link", { name: /^sign in$/i }),
    ].map((l) => l.getAttribute("href"));
    for (const href of auth) expect(["/sign-up", "/sign-in"]).toContain(href);
  });

  it("still sends the nav's launch action to the workspace", () => {
    // The signed-in path. `/notes` is guarded by the (app) layout, which redirects anyone without
    // a session — so this one link is correct for both audiences and must not change.
    render(<LandingPage />);
    const launches = screen.getAllByRole("link", { name: /launch (workspace|app)/i });
    expect(launches.length).toBeGreaterThanOrEqual(1);
    for (const link of launches) expect(link.getAttribute("href")).toBe("/notes");
  });

  it("offers the demo, which the prototype has no equivalent for", () => {
    // The one deliberate addition to the port (docs/06 Phase 6 requires a demo entry point).
    render(<LandingPage />);
    const demo = screen.getAllByRole("link", { name: /try the demo/i });
    expect(demo.length).toBeGreaterThanOrEqual(2); // nav and hero at minimum
    for (const link of demo) expect(link.getAttribute("href")).toBe("/demo");
  });

  it("keeps the prototype's in-page anchors working", () => {
    render(<LandingPage />);
    for (const [name, target] of [
      [/features/i, "#lx-features"],
      [/how it works/i, "#lx-modes"],
    ] as const) {
      const links = screen.getAllByRole("link", { name });
      expect(links.some((l) => l.getAttribute("href") === target), `no anchor to ${target}`).toBe(true);
    }
  });
});

describe("the logo returns to the landing page from the app", () => {
  it("links the workspace brand to /", () => {
    render(<TopBar />);
    expect(screen.getByRole("link", { name: /edgify — home/i }).getAttribute("href")).toBe("/");
  });
});

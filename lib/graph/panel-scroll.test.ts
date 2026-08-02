import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "The panel scrolls independently; the page behind does not move" (docs/06 Phase 5).
 *
 * W5 is unusually explicit about this one: "`position: sticky`, `max-height: calc(100vh - 108px)`,
 * `overflow-y: auto`, `overscroll-behavior: contain`. This is already solved in the prototype;
 * port it exactly rather than re-deriving it."
 *
 * So the check is a comparison against the prototype's own rule, extracted from the reference
 * HTML — the same approach as the readiness oracle, and for the same reason: an expectation
 * hand-copied from the prototype can be hand-copied wrongly, and then agrees with the mistake.
 * `overscroll-behavior: contain` is the declaration most likely to be dropped as noise, and it is
 * the one that stops the scroll CHAINING to the page when the panel reaches its end.
 *
 * This is a static check, and it is deliberately not the whole proof: whether the page actually
 * stays put when the panel is scrolled to its end needs a real layout engine, which is
 * `test/e2e/graph-proofs.mjs`. What this catches is the regression that would otherwise reach
 * that run — someone tidying the CSS.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROTOTYPE = resolve(here, "../../docs/reference/edgify-prototype.html");
const APP_CSS = resolve(here, "../../app/globals.css");

/**
 * Extract one rule's declarations as a normalised `property: value` map.
 *
 * `selector` must match the whole selector text, so `.panel` does not accidentally pick up
 * `.panel .chip`. Comments are stripped first — the app's CSS documents this rule at length, and
 * the prototype's does not.
 */
function declarationsFor(css: string, selector: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const pattern = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const match = withoutComments.match(pattern);
  if (!match) throw new Error(`no rule found for selector "${selector}"`);

  const declarations: Record<string, string> = {};
  for (const part of match[2].split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim().replace(/\s+/g, " ");
    if (property) declarations[property] = value;
  }
  return declarations;
}

/** The `.panel` rule inside the `@media (max-width: 980px)` block. */
function mobilePanelDeclarations(css: string): Record<string, string> {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = withoutComments.match(/@media\s*\(\s*max-width:\s*980px\s*\)\s*\{([\s\S]*?)\n\}/);
  if (!block) throw new Error("no @media (max-width: 980px) block found");
  return declarationsFor(block[1], ".panel");
}

const prototypeCss = readFileSync(PROTOTYPE, "utf8");
const appCss = readFileSync(APP_CSS, "utf8");

describe("the concept panel's scroll behaviour is the prototype's, exactly", () => {
  const prototypePanel = declarationsFor(prototypeCss, ".panel");
  const appPanel = declarationsFor(appCss, ".panel");

  it("extracted a rule from each file (guards the premise)", () => {
    // Without this, a broken extractor would compare two empty objects and pass.
    expect(Object.keys(prototypePanel).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(appPanel).length).toBeGreaterThanOrEqual(6);
  });

  it("carries every declaration the prototype's rule carries, with the same value", () => {
    expect(appPanel).toEqual(prototypePanel);
  });

  /** Named individually so a failure says WHICH property broke and what it costs. */
  it.each([
    ["position", "sticky", "the panel would scroll away with the page instead of staying beside the graph"],
    ["top", "88px", "the panel would sit under the 64px top bar"],
    ["max-height", "calc(100vh - 108px)", "the panel would have no bound, so it could never scroll"],
    ["overflow-y", "auto", "the panel would clip its content instead of scrolling it"],
    ["overscroll-behavior", "contain", "reaching the panel's end would scroll the PAGE behind it"],
  ])("%s: %s — otherwise %s", (property, value) => {
    expect(appPanel[property]).toBe(value);
    expect(prototypePanel[property]).toBe(value);
  });

  it("releases the panel below 980px, as the prototype does", () => {
    // Under the breakpoint the panel sits beneath the graph with the whole page to grow into, so
    // a bounded scroller would trap content in a short box.
    const mobile = mobilePanelDeclarations(appCss);
    expect(mobile).toEqual({ position: "static", "max-height": "none", overflow: "visible" });
  });
});

describe("NEGATIVE CONTROL — the comparison detects a dropped declaration", () => {
  /**
   * Without this, the block above could pass because the extractor silently returned the same
   * thing for both files, or because `toEqual` was comparing something that never differs. Each
   * case removes exactly one declaration from the app's CSS text in memory and requires the
   * comparison to fail.
   */
  it.each(["position", "top", "max-height", "overflow-y", "overscroll-behavior"])(
    "fails when `%s` is removed",
    (property) => {
      const mutated = appCss.replace(
        /(\.panel\s*\{)([^}]*)(\})/,
        (_all, open, body, close) =>
          open +
          body
            .split(";")
            .filter((d: string) => d.split(":")[0].trim() !== property)
            .join(";") +
          close,
      );
      const mutatedPanel = declarationsFor(mutated, ".panel");
      expect(mutatedPanel[property]).toBeUndefined();
      expect(mutatedPanel).not.toEqual(declarationsFor(prototypeCss, ".panel"));
    },
  );
});

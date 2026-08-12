import { describe, expect, it } from "vitest";
import { fitNodeLabel } from "./knowledge-graph";

/**
 * Node labels must stay inside their own box.
 *
 * THE DEFECT THIS PINS. An SVG `<text>` neither wraps nor clips, and the node label is centred
 * with `text-anchor="middle"` — so a name wider than its box spills equally past BOTH edges and is
 * drawn over the neighbouring nodes. The boxes themselves are never overlapped: `lib/graph/layout`
 * keeps a 24px gap between siblings and 94px between layers. What overlapped was the TEXT.
 *
 * The numbers below are the ones the renderer actually uses: a full-width node is 146px at 12.5px,
 * and a crowded row shrinks toward 96px, at which point the renderer drops to 11px.
 */

/** Mirrors the renderer: `const fontSize = w < 118 ? 11 : 12.5`. */
const fontSizeFor = (w: number) => (w < 118 ? 11 : 12.5);

/** The same estimate the component uses, restated here so a silent change to it fails this test. */
const estimatedWidth = (label: string, fontSize: number) => label.length * fontSize * 0.55;

const FULL_WIDTH = 146;
const MIN_WIDTH = 96;

describe("a label always fits its box", () => {
  it.each([
    ["full-width node", FULL_WIDTH],
    ["shrunken node in a crowded row", MIN_WIDTH],
    ["an awkward intermediate width", 118],
  ])("%s", (_name, w) => {
    const fontSize = fontSizeFor(w);
    // Far longer than any sensible concept name, and `graphConceptSchema` allows it.
    const long = "Stochastic gradient descent with Nesterov momentum and weight decay";

    const fitted = fitNodeLabel(long, w, fontSize);

    expect(
      estimatedWidth(fitted, fontSize),
      `"${fitted}" is wider than its ${w}px box and would be drawn over the next node`,
    ).toBeLessThanOrEqual(w);
    expect(fitted.length).toBeLessThan(long.length);
    expect(fitted.endsWith("…"), "an elided label must show that it was cut").toBe(true);
  });

  it("leaves a label that already fits completely untouched", () => {
    // The common case. Existing graphs must look exactly as they do now.
    for (const name of ["Calculus", "Linear algebra", "Gradient descent", "Neural networks"]) {
      expect(fitNodeLabel(name, FULL_WIDTH, 12.5)).toBe(name);
    }
  });

  it("does not strand a trailing space before the ellipsis", () => {
    const fitted = fitNodeLabel("Backpropagation through time and space", FULL_WIDTH, 12.5);
    expect(fitted).not.toMatch(/\s…$/);
  });

  it("degrades to a bare ellipsis rather than overflowing an unusably narrow box", () => {
    // Defensive: a stored `layoutW` from a future layout change must never cause an overflow.
    expect(fitNodeLabel("Anything at all", 12, 12.5)).toBe("…");
  });

  it("never returns more characters than the box can hold, across many widths", () => {
    // A property check rather than a handful of cases: the guarantee is width-independent.
    const name = "A".repeat(200);
    for (let w = 40; w <= 300; w += 4) {
      const fontSize = fontSizeFor(w);
      expect(
        estimatedWidth(fitNodeLabel(name, w, fontSize), fontSize),
        `overflowed at width ${w}`,
      ).toBeLessThanOrEqual(w);
    }
  });
});

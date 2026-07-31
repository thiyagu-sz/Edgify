import { describe, expect, it } from "vitest";
import { computeLayout, estimatedMinutesFor, layerOf } from "./layout";

/**
 * Layout is a pure port of the prototype's `layout()` (AGENTS.md rule 6). These tests pin the
 * behaviour that matters visually — layer assignment, foundational-at-the-bottom, centring, and
 * the crowded-row shrink — plus the two properties that would take a request down rather than
 * merely look wrong: termination on a cyclic graph, and integer output.
 */

const chain = {
  concepts: [{ slug: "a" }, { slug: "b" }, { slug: "c" }],
  edges: [
    { prerequisite: "a", dependent: "b" },
    { prerequisite: "b", dependent: "c" },
  ],
};

describe("layerOf", () => {
  it("assigns 0 to concepts with no prerequisites and depth+1 downstream", () => {
    const layer = layerOf(chain.concepts, chain.edges);
    expect(layer.get("a")).toBe(0);
    expect(layer.get("b")).toBe(1);
    expect(layer.get("c")).toBe(2);
  });

  it("takes the DEEPEST prerequisite, not the first", () => {
    // d depends on both a (layer 0) and c (layer 2) → it must sit at 3, not 1.
    const layer = layerOf(
      [...chain.concepts, { slug: "d" }],
      [
        ...chain.edges,
        { prerequisite: "a", dependent: "d" },
        { prerequisite: "c", dependent: "d" },
      ],
    );
    expect(layer.get("d")).toBe(3);
  });

  it("ignores edges naming a concept that is not in the set", () => {
    const layer = layerOf(chain.concepts, [
      ...chain.edges,
      { prerequisite: "ghost", dependent: "a" },
      { prerequisite: "c", dependent: "ghost" },
    ]);
    expect(layer.get("a")).toBe(0); // the ghost prerequisite did not push it down
    expect(layer.has("ghost")).toBe(false);
  });

  it("terminates on a cyclic graph instead of recursing forever", () => {
    // sanitizeGraph breaks cycles before this runs, but layout must not depend on that.
    const cyclic = layerOf(chain.concepts, [
      { prerequisite: "a", dependent: "b" },
      { prerequisite: "b", dependent: "c" },
      { prerequisite: "c", dependent: "a" },
    ]);
    expect(cyclic.size).toBe(3);
  });
});

describe("computeLayout", () => {
  it("puts foundational concepts at the BOTTOM and advanced at the top", () => {
    const { placed } = computeLayout(chain.concepts, chain.edges);
    const y = new Map(placed.map((p) => [p.slug, p.layoutY]));
    expect(y.get("c")).toBeLessThan(y.get("b") as number);
    expect(y.get("b")).toBeLessThan(y.get("a") as number);
    // The prototype's constants: topPad 20, ySpace 94, maxLayer 2.
    expect(y.get("c")).toBe(20);
    expect(y.get("b")).toBe(114);
    expect(y.get("a")).toBe(208);
  });

  it("centres a single-node layer in the 760px viewport at the default width", () => {
    const { placed } = computeLayout([{ slug: "solo" }], []);
    expect(placed[0].layoutW).toBe(146);
    expect(placed[0].layoutX).toBe((760 - 146) / 2);
  });

  it("shrinks nodes when a layer would overflow, down to the 96px floor", () => {
    // Six siblings at 146px + 5 gaps = 996 > 760, so they must shrink.
    const wide = Array.from({ length: 6 }, (_, i) => ({ slug: `n${i}` }));
    const { placed } = computeLayout(wide, []);

    expect(placed.every((p) => p.layoutW < 146)).toBe(true);
    expect(placed.every((p) => p.layoutW >= 96)).toBe(true);
  });

  /**
   * A faithfully ported quirk, not a bug we introduced (AGENTS.md rule 6: do not redesign).
   *
   * `startX = max(8, (VIEW_WIDTH - total) / 2)` prefers an 8px LEFT margin over true centring.
   * When a shrunk row fills the viewport exactly, centring wants startX = 0, the clamp forces 8,
   * and the row's right edge lands up to 8px past the 760 viewBox — clipped, very slightly.
   *
   * Pinned rather than fixed: the prototype is the visual specification and this is what it does.
   * Changing the clamp here would make the app differ from the prototype in crowded layers, which
   * is the regression rule 6 exists to prevent. Recorded so a future reader knows it was seen and
   * decided, not missed.
   */
  it("inherits the prototype's 8px left-margin clamp, overhanging the right edge", () => {
    const wide = Array.from({ length: 6 }, (_, i) => ({ slug: `n${i}` }));
    const { placed } = computeLayout(wide, []);

    expect(placed[0].layoutX).toBe(8);
    const last = placed[placed.length - 1];
    expect(last.layoutX + last.layoutW).toBe(768); // 8 past the 760 viewBox
  });

  it("never places a node left of the 8px margin, even when the floor is hit", () => {
    const crowded = Array.from({ length: 12 }, (_, i) => ({ slug: `n${i}` }));
    const { placed } = computeLayout(crowded, []);
    expect(Math.min(...placed.map((p) => p.layoutX))).toBeGreaterThanOrEqual(8);
    expect(placed.every((p) => p.layoutW === 96)).toBe(true); // clamped at the floor
  });

  it("returns integers — the columns are integer typed (docs/03)", () => {
    const crowded = Array.from({ length: 7 }, (_, i) => ({ slug: `n${i}` }));
    const { placed } = computeLayout(crowded, []);
    for (const p of placed) {
      expect(Number.isInteger(p.layoutX), `layoutX ${p.layoutX}`).toBe(true);
      expect(Number.isInteger(p.layoutY), `layoutY ${p.layoutY}`).toBe(true);
      expect(Number.isInteger(p.layoutW), `layoutW ${p.layoutW}`).toBe(true);
    }
  });

  it("preserves the caller's concept order so stored rows line up with model output", () => {
    const { placed } = computeLayout(chain.concepts, chain.edges);
    expect(placed.map((p) => p.slug)).toEqual(["a", "b", "c"]);
  });

  it("sizes the viewBox height from the deepest layer", () => {
    expect(computeLayout(chain.concepts, chain.edges).height).toBe(20 + 3 * 94 + 20);
    expect(computeLayout([{ slug: "solo" }], []).height).toBe(20 + 94 + 20);
  });

  it("handles an empty graph without throwing", () => {
    expect(computeLayout([], [])).toEqual({ placed: [], height: 40 });
  });
});

describe("estimatedMinutesFor", () => {
  it("uses the prototype's diffMin numbers", () => {
    expect(estimatedMinutesFor("Foundational")).toBe(120);
    expect(estimatedMinutesFor("Intermediate")).toBe(150);
    expect(estimatedMinutesFor("Advanced")).toBe(180);
  });

  it("falls back to Intermediate for anything unrecognised", () => {
    expect(estimatedMinutesFor("")).toBe(150);
    expect(estimatedMinutesFor("wildly unexpected")).toBe(150);
  });
});

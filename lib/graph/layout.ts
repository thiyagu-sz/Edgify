/**
 * Layer-based graph layout (W4 step 15) — a direct port of the prototype's `layout()`
 * (docs/reference/edgify-prototype.html). AGENTS.md rule 6: the prototype is the visual
 * specification, so the constants below are ITS constants and are not up for re-derivation.
 *
 * Computed server-side ONCE and stored as `layoutX/layoutY/layoutW` (docs/03), so every client
 * renders the same picture and a re-render never reshuffles the graph under the user.
 *
 * Pure functions, no I/O — unit-tested in layout.test.ts.
 */

/** The prototype's SVG viewport width; node boxes are laid out to fit inside it. */
const VIEW_WIDTH = 760;
/** Horizontal gap between sibling nodes in a layer. */
const GAP = 24;
/** Vertical distance between layers. */
const Y_SPACE = 94;
/** Top padding before the first (most advanced) layer. */
const TOP_PAD = 20;
/** Default node width, and the floor it may shrink to when a layer is crowded. */
const NODE_W = 146;
const MIN_NODE_W = 96;

export type LayoutConcept = { slug: string };
export type LayoutEdge = { prerequisite: string; dependent: string };

export type PlacedConcept = {
  slug: string;
  layoutX: number;
  layoutY: number;
  layoutW: number;
};

export type LayoutResult = {
  placed: PlacedConcept[];
  /** SVG viewBox height the graph needs — the prototype's `graphViewH`. */
  height: number;
};

/**
 * Depth of each concept: 0 for a concept with no prerequisites, otherwise one more than its
 * deepest prerequisite.
 *
 * `sanitizeGraph` has already broken cycles by the time layout runs, but the `seen` guard is kept
 * from the prototype anyway: this must terminate on ANY input, including a graph assembled by a
 * future caller that skipped sanitisation. A layout that infinite-loops takes the whole request
 * down, which is a far worse failure than a slightly odd-looking graph.
 */
export function layerOf(
  concepts: LayoutConcept[],
  edges: LayoutEdge[],
): Map<string, number> {
  const prerequisites = new Map<string, string[]>();
  for (const { slug } of concepts) prerequisites.set(slug, []);
  for (const edge of edges) {
    // Ignore edges naming a concept that is not in the set (sanitizeGraph drops these already).
    if (!prerequisites.has(edge.dependent) || !prerequisites.has(edge.prerequisite)) {
      continue;
    }
    prerequisites.get(edge.dependent)?.push(edge.prerequisite);
  }

  const layer = new Map<string, number>();

  const resolve = (slug: string, seen: Set<string>): number => {
    const memo = layer.get(slug);
    if (memo !== undefined) return memo;
    if (seen.has(slug)) return 0; // cycle guard, as the prototype
    seen.add(slug);

    const parents = prerequisites.get(slug) ?? [];
    const depth =
      parents.length === 0
        ? 0
        : 1 + Math.max(...parents.map((parent) => resolve(parent, seen)));
    layer.set(slug, depth);
    return depth;
  };

  for (const { slug } of concepts) resolve(slug, new Set());
  return layer;
}

/**
 * Place every concept. Foundational concepts (layer 0) sit at the BOTTOM and the most advanced at
 * the top — the prototype's `(maxLayer - layer) * ySpace` — so the picture reads as building
 * upward from what the student already needs to know.
 *
 * A layer wider than the viewport shrinks its nodes down to `MIN_NODE_W` rather than overflowing.
 * Rows are centred.
 */
export function computeLayout(
  concepts: LayoutConcept[],
  edges: LayoutEdge[],
): LayoutResult {
  if (concepts.length === 0) return { placed: [], height: TOP_PAD * 2 };

  const layer = layerOf(concepts, edges);
  const maxLayer = Math.max(...concepts.map((c) => layer.get(c.slug) ?? 0));

  const byLayer = new Map<number, string[]>();
  for (const { slug } of concepts) {
    const depth = layer.get(slug) ?? 0;
    const row = byLayer.get(depth) ?? [];
    row.push(slug);
    byLayer.set(depth, row);
  }

  const placed: PlacedConcept[] = [];
  for (const [depth, row] of byLayer) {
    const n = row.length;
    let width = NODE_W;
    let total = n * width + (n - 1) * GAP;
    if (total > VIEW_WIDTH) {
      width = Math.max(MIN_NODE_W, (VIEW_WIDTH - (n - 1) * GAP) / n);
      total = n * width + (n - 1) * GAP;
    }
    const startX = Math.max(8, (VIEW_WIDTH - total) / 2);

    row.forEach((slug, i) => {
      placed.push({
        slug,
        // Stored as integers (docs/03) — the prototype's arithmetic can produce fractions when a
        // crowded row shrinks, and a half-pixel node offset is invisible.
        layoutX: Math.round(startX + i * (width + GAP)),
        layoutY: TOP_PAD + (maxLayer - depth) * Y_SPACE,
        layoutW: Math.round(width),
      });
    });
  }

  // Preserve the caller's concept order so the stored rows line up with the model's output.
  const order = new Map(concepts.map((c, i) => [c.slug, i]));
  placed.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));

  return { placed, height: TOP_PAD + (maxLayer + 1) * Y_SPACE + 20 };
}

/**
 * The SVG viewBox height for a graph whose lowest node sits at `maxLayoutY`.
 *
 * The client renders from STORED `layoutY` values and never re-runs `computeLayout`, so it cannot
 * read `LayoutResult.height` — but it must arrive at exactly the same number, or the graph is
 * cropped or floats in dead space. Both follow from the same constants:
 *
 *     maxLayoutY = TOP_PAD + maxLayer × Y_SPACE          (the layer-0 row, at the bottom)
 *     height     = TOP_PAD + (maxLayer + 1) × Y_SPACE + 20
 *                = maxLayoutY + Y_SPACE + 20
 *
 * Derived here rather than hardcoded so a change to `Y_SPACE` or `TOP_PAD` moves both together.
 */
export function viewBoxHeightFor(maxLayoutY: number): number {
  return maxLayoutY + Y_SPACE + 20;
}

/**
 * Study time from difficulty — the prototype's `diffMin`. docs/03 says `estimatedMinutes` is
 * "derived from difficulty"; these are the prototype's numbers.
 */
export function estimatedMinutesFor(difficulty: string): number {
  const normalised = difficulty.toLowerCase();
  if (normalised.startsWith("found")) return 120;
  if (normalised.startsWith("adv")) return 180;
  return 150;
}

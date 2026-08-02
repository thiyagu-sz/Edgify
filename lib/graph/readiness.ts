/**
 * Readiness, the study plan and the concept library (W6, docs/05) — a direct port of the
 * prototype's `closure`, `readiness`, `mval`, `layerOf` and `fmtTime`
 * (docs/reference/edgify-prototype.html). AGENTS.md rule 6: the prototype is the specification.
 *
 * Pure functions, no I/O, and deliberately CLIENT-SIDE (W6): marking one concept mastered changes
 * the readiness of every concept downstream of it, and recomputing that locally is instant and
 * needs no round trip. No model call is involved, so none of this can fail or show a busy state.
 *
 * ── THE FORMULA, AND A DOC CORRECTION ────────────────────────────────────────────────────────
 *
 * docs/05 W6 described this as weighting "each prerequisite by 1 / depth". That reads as though
 * only DIRECT prerequisites matter, which is a lossy paraphrase and produces different numbers:
 * the prototype walks the FULL TRANSITIVE CLOSURE, records each ancestor at its SHORTEST depth
 * from the target, and weights every one of them by `1 / depth`. A grandparent therefore counts
 * half as much as a parent, not zero. docs/05 has been corrected to the reference algorithm, and
 * `readiness.test.ts` pins it against the prototype's own JavaScript, extracted from the HTML and
 * executed as an oracle — so the formula cannot drift away from the prototype again without a
 * test failing.
 */

export type MasteryState = "locked" | "learning" | "known";

export type GraphConcept = {
  slug: string;
  name: string;
  difficulty: string;
  summary: string;
  estimatedMinutes: number;
};

export type GraphEdge = { prerequisite: string; dependent: string };

/** `known` counts fully, `learning` half, `locked` not at all — the prototype's `mval`. */
export function masteryValue(state: MasteryState | undefined): number {
  if (state === "known") return 1;
  if (state === "learning") return 0.5;
  return 0;
}

/** Direct prerequisites for every concept, in edge order. */
export function prerequisiteMap(
  concepts: GraphConcept[],
  edges: GraphEdge[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { slug } of concepts) map.set(slug, []);
  for (const edge of edges) {
    if (!map.has(edge.prerequisite) || !map.has(edge.dependent)) continue;
    const list = map.get(edge.dependent)!;
    if (!list.includes(edge.prerequisite)) list.push(edge.prerequisite);
  }
  return map;
}

/**
 * The prerequisite closure of `slug`: every transitive ancestor, mapped to its SHORTEST distance.
 *
 * Breadth-first from the direct prerequisites at depth 1, keeping the smallest depth seen for
 * each ancestor — the prototype's `closure`, including its `d < depth[c]` relaxation, which is
 * what makes "shortest" true when a concept is reachable by two paths of different lengths. The
 * target itself is never in its own closure.
 */
export function closure(
  slug: string,
  prerequisites: Map<string, string[]>,
): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: [string, number][] = (prerequisites.get(slug) ?? []).map((p) => [p, 1]);

  while (queue.length > 0) {
    const [current, d] = queue.shift()!;
    if (!prerequisites.has(current)) continue;
    const seen = depth.get(current);
    if (seen === undefined || d < seen) {
      depth.set(current, d);
      for (const parent of prerequisites.get(current) ?? []) {
        queue.push([parent, d + 1]);
      }
    }
  }
  return depth;
}

/**
 * How ready the student is to study `slug`, 0–100.
 *
 * Every concept in the prerequisite closure contributes weight `1 / depth` — nearer prerequisites
 * matter more — and scores `masteryValue`. A concept with no prerequisites is 100: there is
 * nothing standing between the student and it.
 */
export function readiness(
  slug: string,
  prerequisites: Map<string, string[]>,
  mastery: Map<string, MasteryState>,
): number {
  const depth = closure(slug, prerequisites);
  if (depth.size === 0) return 100;

  let numerator = 0;
  let denominator = 0;
  for (const [ancestor, d] of depth) {
    const weight = 1 / d;
    denominator += weight;
    numerator += weight * masteryValue(mastery.get(ancestor));
  }
  return Math.round((100 * numerator) / denominator);
}

/**
 * Depth of a concept for ORDERING (the prototype's `layerOf`): 0 with no prerequisites, else one
 * more than the deepest. `lib/graph/layout.ts` computes the same quantity for positioning; this
 * one works from the client's slug-space edges and is used to order the study guide export and
 * the concept library. The `seen` guard is the prototype's, and terminates on any input.
 */
export function layerOf(
  slug: string,
  prerequisites: Map<string, string[]>,
  seen: Set<string> = new Set(),
): number {
  if (seen.has(slug)) return 0;
  seen.add(slug);
  const parents = prerequisites.get(slug) ?? [];
  if (parents.length === 0) return 0;
  return 1 + Math.max(...parents.map((p) => layerOf(p, prerequisites, new Set(seen))));
}

/** "2h 30m" / "3h" / "45m" — the prototype's `fmtTime`. */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** `Foundational` / `Intermediate` / `Advanced` — the prototype's `normDiff`. */
export function normaliseDifficulty(value: string | null | undefined): string {
  const d = (value ?? "").toLowerCase();
  if (d.startsWith("found")) return "Foundational";
  if (d.startsWith("adv")) return "Advanced";
  return "Intermediate";
}

/**
 * Concepts RELATED to `slug` — connected by an edge in either direction, capped at four, in edge
 * order (the prototype's `rel`, built in `buildGraphFromDoc`). Derived rather than stored: it is
 * a pure function of the edges, so a column for it would be a second source of truth.
 */
export function relatedTo(slug: string, edges: GraphEdge[], limit = 4): string[] {
  const related: string[] = [];
  for (const edge of edges) {
    const other =
      edge.prerequisite === slug
        ? edge.dependent
        : edge.dependent === slug
          ? edge.prerequisite
          : null;
    if (other !== null && other !== slug && !related.includes(other)) {
      related.push(other);
    }
  }
  return related.slice(0, limit);
}

export type PlanStep = {
  slug: string;
  /** True when every direct prerequisite is already `known` — startable right now. */
  ready: boolean;
};

export type StudyPlan = {
  /** Closure size — every prerequisite of the goal, transitively. */
  total: number;
  /** Those already `known`. */
  covered: number;
  /** Those not yet `known`, deepest first, then alphabetical — the prototype's sort. */
  steps: PlanStep[];
  /** Estimated minutes remaining across `steps`. */
  minutesRemaining: number;
  readiness: number;
};

/**
 * The study plan for a goal concept (W6). Derived entirely from stored concepts, edges and
 * mastery — the concept library is the same data in a different view.
 *
 * The ordering is the prototype's: deepest prerequisite first (`dep[b] - dep[a]`), ties broken by
 * NAME rather than slug, which is what makes the rendered list read alphabetically.
 */
export function studyPlan(
  goal: string,
  concepts: GraphConcept[],
  edges: GraphEdge[],
  mastery: Map<string, MasteryState>,
): StudyPlan {
  const prerequisites = prerequisiteMap(concepts, edges);
  const byslug = new Map(concepts.map((c) => [c.slug, c]));
  const depth = closure(goal, prerequisites);
  const ids = [...depth.keys()];

  const covered = ids.filter((id) => mastery.get(id) === "known");
  const missing = ids
    .filter((id) => mastery.get(id) !== "known")
    .sort((a, b) => {
      const byDepth = (depth.get(b) ?? 0) - (depth.get(a) ?? 0);
      if (byDepth !== 0) return byDepth;
      return (byslug.get(a)?.name ?? a).localeCompare(byslug.get(b)?.name ?? b);
    });

  return {
    total: ids.length,
    covered: covered.length,
    steps: missing.map((slug) => ({
      slug,
      ready: (prerequisites.get(slug) ?? []).every((p) => mastery.get(p) === "known"),
    })),
    minutesRemaining: missing.reduce(
      (sum, slug) => sum + (byslug.get(slug)?.estimatedMinutes ?? 0),
      0,
    ),
    readiness: readiness(goal, prerequisites, mastery),
  };
}

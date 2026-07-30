import { DEMO_GRAPH } from "./graph";
import { DEMO_NOTES } from "./notes";

/**
 * Demo content lookup — tier 5 of the degradation ladder (docs/04 §1–2). Returns curated content
 * for the request, or `null` when nothing fits, which sends the ladder to the busy state rather
 * than substituting something misleading.
 *
 * GRAPHS ARE DELIBERATELY ABSENT. A Quick Notes demo is a banner above a panel: transient, and
 * the user can see at a glance it is a worked example. A graph is not — the build path persists
 * concepts and edges as rows under the user's own `graphId`, so serving DEMO_GRAPH here would
 * write a curated machine-learning graph into their workspace as if it were an analysis of the
 * document they uploaded. That is the one genuinely bad outcome docs/04 §2 names, and a banner
 * does not undo it once the rows exist. So for `graph_structure` the ladder ends at tier 6 and
 * the build is marked `failed`, which surfaces the honest W4 message ("Couldn't map this
 * document's structure. Quick Notes still works on it.") over content the user actually owns.
 *
 * `DEMO_GRAPH` itself is still exported — Phase 6's signed-out `/demo` route renders it directly,
 * where nothing is persisted and there is no user document to misrepresent.
 */
export type DemoInput = { operation: string; format: string };

export function demoContentFor(input: DemoInput): unknown | null {
  if (input.operation === "quick_notes") {
    return DEMO_NOTES[input.format] ?? null;
  }
  return null;
}

export { DEMO_GRAPH, DEMO_NOTES };

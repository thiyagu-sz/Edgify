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
 * CONCEPT DETAIL IS ABSENT FOR THE SAME REASON. Decided 2026-07-30; this deviates from the
 * literal reading of docs/05 W5 ("on demo tier: render sample detail + banner"), and W5 has been
 * corrected to match. Two independent reasons:
 *
 *  1. It persists. `concepts.detailJson` is a column on the user's own row (W5 step 4), so a demo
 *     detail is a written record, not a transient panel — precisely the distinction that denies
 *     graphs a demo tier.
 *  2. There is nothing honest to serve. The demo library holds details for the curated ML
 *     concepts only. The user clicked a node called "Photosynthesis"; rendering the calculus
 *     explanation under that heading is a misleading substitution whatever the banner says, and
 *     picking "the closest" curated concept is worse — it looks like it worked.
 *
 * So concept detail also ends at tier 6, and the panel falls back to the concept's own `summary`,
 * which WAS derived from the user's document during the structure pass. That is what the
 * prototype does on failure, and it is the only content available here that is actually about
 * their material.
 *
 * `DEMO_GRAPH` itself is still exported — Phase 6's signed-out `/demo` route renders it directly,
 * where nothing is persisted and there is no user document to misrepresent.
 */
export type DemoInput = { operation: string; format: string };

export function demoContentFor(input: DemoInput): unknown | null {
  if (input.operation === "quick_notes") {
    return DEMO_NOTES[input.format] ?? null;
  }
  // graph_structure and concept_detail: no demo, by design. See above.
  return null;
}

export { DEMO_GRAPH, DEMO_NOTES };

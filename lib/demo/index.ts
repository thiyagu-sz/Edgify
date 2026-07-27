import { DEMO_GRAPH } from "./graph";
import { DEMO_NOTES } from "./notes";

/**
 * Demo content lookup — tier 5 of the degradation ladder (docs/04 §1–2). Returns curated content
 * for the request, or `null` when nothing fits (an unknown format), which sends the ladder to the
 * busy state rather than substituting something misleading.
 */
export type DemoInput = { operation: string; format: string };

export function demoContentFor(input: DemoInput): unknown | null {
  if (input.operation === "quick_notes") {
    return DEMO_NOTES[input.format] ?? null;
  }
  if (input.operation === "graph_structure") {
    return DEMO_GRAPH;
  }
  return null;
}

export { DEMO_GRAPH, DEMO_NOTES };

import type { ConceptDetail } from "../ai/schemas";
import { layerOf, normaliseDifficulty, prerequisiteMap, type GraphConcept, type GraphEdge } from "./readiness";

/**
 * The graph export (W7, docs/05) — a direct port of the prototype's `graphToMarkdown`.
 *
 * Produces revision markdown that `lib/export.ts` then turns into a PDF (jsPDF, walking the text
 * line by line) or a Word-compatible `.doc`. Entirely client-side: no server cost and no failure
 * mode.
 *
 * Concepts are ordered foundational-first by prerequisite depth, ties broken by name — the
 * prototype's `layerOf(a)-layerOf(b) || name.localeCompare(name)` — so the guide reads in the
 * order the graph says to learn them.
 *
 * Every string in here is model output that has already been through the validation seam
 * (`lib/ai/schemas`), so it carries no markup. The `.doc` writer escapes again on the way out,
 * which is what keeps the W7 `</body>` trap closed: see lib/export.ts.
 */
export function graphToMarkdown(
  title: string,
  concepts: GraphConcept[],
  edges: GraphEdge[],
  details: Map<string, ConceptDetail>,
): string {
  const prerequisites = prerequisiteMap(concepts, edges);
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));
  const nameOf = (slug: string) => bySlug.get(slug)?.name ?? slug;

  const order = [...concepts].sort(
    (a, b) =>
      layerOf(a.slug, prerequisites) - layerOf(b.slug, prerequisites) ||
      a.name.localeCompare(b.name),
  );

  let md = `# Study guide — ${title}\n\n`;

  for (const concept of order) {
    const detail = details.get(concept.slug);
    // The prototype's `c.def || c.summary || ""` — a concept the user never opened still appears,
    // described by the summary the structure pass produced. A study guide that silently omitted
    // every unopened concept would be worse than one with shorter entries.
    const body = detail?.definition || concept.summary || "";
    md += `## ${concept.name}  (${normaliseDifficulty(concept.difficulty)})\n\n${body}\n\n`;

    const pre = prerequisites.get(concept.slug) ?? [];
    if (pre.length > 0) {
      md += `**Prerequisites:** ${pre.map(nameOf).join(", ")}\n\n`;
    }

    const example = detail?.example?.trim();
    if (example) md += `*Example:* ${example}\n\n`;
  }

  md += `\n---\n\n## Recommended study order\n\n${order
    .map((concept, i) => `${i + 1}. ${concept.name}`)
    .join("\n")}\n`;

  return md;
}

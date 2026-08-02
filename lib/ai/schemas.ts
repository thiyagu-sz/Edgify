import { z } from "zod";
import { sanitizeModelText } from "../sanitize";

/**
 * Zod schemas for structured model output, plus the validation guards from
 * docs/04-resilience.md §3. Models return malformed data — assume it every time. Nothing here
 * lets unvalidated output reach the database or the UI (AGENTS.md rule 5).
 *
 * These are pure functions with no I/O, unit-tested in schemas.test.ts.
 *
 * ── THIS IS ALSO THE SANITISATION SEAM, AND THAT IS DELIBERATE ───────────────────────────────
 *
 * Every `sanitize*` function here strips HTML from the strings it validates, because this is the
 * point where "raw model output" becomes "validated model output" — and it sits UPSTREAM of all
 * four places that output travels to:
 *
 *   generate() → generation_cache   (content-addressed; a second user with the same document is
 *                                    served the identical stored bytes)
 *   generate() → concepts.detailJson / concepts.name / summary   (persisted rows)
 *              → cloneGraphByContentHash   (copies names and summaries into another user's rows)
 *              → the UI
 *
 * Sanitising at render instead would leave every one of those copies dirty, and would make each
 * present and future consumer — panel, export, study plan, concept library, anything added later
 * — individually responsible for remembering. Cleaning here means there is no dirty copy to
 * distribute in the first place. The client still sanitises what it renders as HTML
 * (`renderMarkdown`); that is defence in depth, not the primary gate.
 *
 * Markdown survives untouched — `**bold**` and `- bullets` are not HTML — so nothing about the
 * intended formatting is lost. See `sanitizeModelText` in lib/sanitize.ts.
 */

// ── Quiz (MCQs / quick test) ────────────────────────────────────────────────
export const quizQuestionSchema = z.object({
  q: z.string().min(1),
  options: z.array(z.string().min(1)).min(2),
  answer: z.number().int(),
  explanation: z.string().default(""),
});
export const quizSchema = z.object({
  questions: z.array(quizQuestionSchema),
});
export type Quiz = z.infer<typeof quizSchema>;

/**
 * Parse + sanitise a quiz. Drops any question whose `answer` index falls outside its options
 * array (docs/04 §3). Returns null when the payload is unusable or nothing survives — the
 * caller treats null as a tier failure, never as a successful empty result.
 */
export function sanitizeQuiz(raw: unknown): Quiz | null {
  const parsed = quizSchema.safeParse(raw);
  if (!parsed.success) return null;
  const questions = parsed.data.questions
    .filter((question) => question.answer >= 0 && question.answer < question.options.length)
    .map((question) => ({
      q: sanitizeModelText(question.q),
      options: question.options.map(sanitizeModelText),
      answer: question.answer,
      explanation: sanitizeModelText(question.explanation),
    }));
  if (questions.length === 0) return null;
  return { questions };
}

// ── Concept detail (W5 — lazy, per-concept explanation) ─────────────────────
export const flashcardSchema = z.object({
  front: z.string().min(1),
  back: z.string().default(""),
});
export const conceptDetailSchema = z.object({
  definition: z.string().default(""),
  example: z.string().default(""),
  /** Optional: a detail without a usable check question is still worth rendering. */
  quiz: quizQuestionSchema.nullish(),
  flashcards: z.array(flashcardSchema).default([]),
});
export type ConceptDetail = {
  definition: string;
  example: string;
  quiz: z.infer<typeof quizQuestionSchema> | null;
  flashcards: z.infer<typeof flashcardSchema>[];
};

/**
 * Parse + sanitise a concept detail (docs/04 §3).
 *
 * The DEFINITION is the load-bearing field — it is what the panel exists to show — so an empty or
 * whitespace-only one is a failure, not a successful empty result, and returns null so the ladder
 * moves on. Everything else degrades in place rather than failing the whole detail:
 *  - a quiz whose `answer` index falls outside its options is DROPPED (the same guard as the
 *    Quick Notes quiz), because one bad question should not cost the user their explanation,
 *  - flashcards with an empty front are dropped individually.
 */
export function sanitizeConceptDetail(raw: unknown): ConceptDetail | null {
  const parsed = conceptDetailSchema.safeParse(raw);
  if (!parsed.success) return null;

  // Sanitised BEFORE the emptiness check, deliberately: a "definition" consisting only of markup
  // is not a definition, and must fail the tier rather than persist as an empty panel.
  const definition = sanitizeModelText(parsed.data.definition).trim();
  if (definition.length === 0) return null;

  const candidate = parsed.data.quiz;
  const quizQ = candidate ? sanitizeModelText(candidate.q).trim() : "";
  const quiz =
    candidate &&
    quizQ.length > 0 &&
    candidate.answer >= 0 &&
    candidate.answer < candidate.options.length
      ? {
          q: quizQ,
          options: candidate.options.map(sanitizeModelText),
          answer: candidate.answer,
          explanation: sanitizeModelText(candidate.explanation),
        }
      : null;

  return {
    definition,
    example: sanitizeModelText(parsed.data.example).trim(),
    quiz,
    flashcards: parsed.data.flashcards
      .map((c) => ({ front: sanitizeModelText(c.front), back: sanitizeModelText(c.back) }))
      .filter((c) => c.front.trim().length > 0),
  };
}

// ── Knowledge graph (used fully in Phase 5; guards built + tested now) ───────
export const graphConceptSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  difficulty: z
    .enum(["Foundational", "Intermediate", "Advanced"])
    .default("Intermediate"),
  summary: z.string().default(""),
});
export const graphEdgeSchema = z.object({
  // prerequisite must be learned before dependent
  prerequisite: z.string().min(1),
  dependent: z.string().min(1),
});
export const graphSchema = z.object({
  title: z.string().default(""),
  concepts: z.array(graphConceptSchema),
  edges: z.array(graphEdgeSchema).default([]),
});
export type Graph = z.infer<typeof graphSchema>;

const MIN_CONCEPTS = 3;

/**
 * Parse + sanitise a graph (docs/04 §3):
 *  - drop edges that reference a concept slug that does not exist,
 *  - break prerequisite cycles at the edge that closes them,
 *  - treat fewer than three concepts as a failed extraction (null), not a small graph.
 */
export function sanitizeGraph(raw: unknown): Graph | null {
  const parsed = graphSchema.safeParse(raw);
  if (!parsed.success) return null;

  /**
   * Sanitise FIRST, then match. The slug is model output too — it reaches the client as a
   * `data-*` attribute and as a React key — so it is cleaned like everything else; but cleaning
   * it after the edges were matched would leave every edge pointing at the pre-sanitisation
   * spelling and the whole graph would come out edgeless. Both sides are therefore put through
   * the same function before any comparison happens.
   */
  const concepts = parsed.data.concepts.map((c) => ({
    slug: sanitizeModelText(c.slug).trim(),
    name: sanitizeModelText(c.name).trim(),
    difficulty: c.difficulty,
    summary: sanitizeModelText(c.summary).trim(),
  }));

  // A concept whose slug or name sanitised away to nothing cannot be rendered or keyed.
  const usable = concepts.filter((c) => c.slug.length > 0 && c.name.length > 0);

  // Deduplicate on slug, keeping the first. `(graphId, slug)` is UNIQUE (docs/03), so a model
  // returning the same slug twice would otherwise fail the whole insert — and sanitisation can
  // newly collide two slugs that differed only in markup.
  const bySlug = new Map<string, (typeof usable)[number]>();
  for (const concept of usable) {
    if (!bySlug.has(concept.slug)) bySlug.set(concept.slug, concept);
  }
  const deduped = [...bySlug.values()];
  if (deduped.length < MIN_CONCEPTS) return null;

  const slugs = new Set(deduped.map((c) => c.slug));

  // Drop dangling edges and self-loops.
  const known = parsed.data.edges
    .map((e) => ({
      prerequisite: sanitizeModelText(e.prerequisite).trim(),
      dependent: sanitizeModelText(e.dependent).trim(),
    }))
    .filter(
      (e) => slugs.has(e.prerequisite) && slugs.has(e.dependent) && e.prerequisite !== e.dependent,
    );

  const edges = breakCycles(known);
  return { title: sanitizeModelText(parsed.data.title).trim(), concepts: deduped, edges };
}

/** Remove back-edges (DFS) so the prerequisite graph is acyclic — a cycle renders unusable. */
function breakCycles(edges: Graph["edges"]): Graph["edges"] {
  const adjacency = new Map<string, { to: string; edge: Graph["edges"][number] }[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.prerequisite) ?? [];
    list.push({ to: edge.dependent, edge });
    adjacency.set(edge.prerequisite, list);
  }

  const dropped = new Set<Graph["edges"][number]>();
  const state = new Map<string, "visiting" | "done">();

  const visit = (node: string) => {
    state.set(node, "visiting");
    for (const { to, edge } of adjacency.get(node) ?? []) {
      const s = state.get(to);
      if (s === "visiting") {
        dropped.add(edge); // back-edge → closes a cycle
      } else if (s === undefined) {
        visit(to);
      }
    }
    state.set(node, "done");
  };

  for (const node of adjacency.keys()) {
    if (!state.get(node)) visit(node);
  }
  return edges.filter((edge) => !dropped.has(edge));
}

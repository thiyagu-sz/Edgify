import { z } from "zod";

/**
 * Zod schemas for structured model output, plus the validation guards from
 * docs/04-resilience.md §3. Models return malformed data — assume it every time. Nothing here
 * lets unvalidated output reach the database or the UI (AGENTS.md rule 5).
 *
 * These are pure functions with no I/O, unit-tested in schemas.test.ts.
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
  const questions = parsed.data.questions.filter(
    (question) => question.answer >= 0 && question.answer < question.options.length,
  );
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

  const definition = parsed.data.definition.trim();
  if (definition.length === 0) return null;

  const candidate = parsed.data.quiz;
  const quiz =
    candidate &&
    candidate.q.trim().length > 0 &&
    candidate.answer >= 0 &&
    candidate.answer < candidate.options.length
      ? candidate
      : null;

  return {
    definition,
    example: parsed.data.example.trim(),
    quiz,
    flashcards: parsed.data.flashcards.filter((c) => c.front.trim().length > 0),
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

  const slugs = new Set(parsed.data.concepts.map((c) => c.slug));
  if (slugs.size < MIN_CONCEPTS) return null;

  // Drop dangling edges and self-loops.
  const known = parsed.data.edges.filter(
    (e) => slugs.has(e.prerequisite) && slugs.has(e.dependent) && e.prerequisite !== e.dependent,
  );

  const edges = breakCycles(known);
  return { title: parsed.data.title, concepts: parsed.data.concepts, edges };
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

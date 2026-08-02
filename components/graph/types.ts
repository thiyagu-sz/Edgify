import type { ConceptDetail } from "@/lib/ai/schemas";
import type { MasteryState } from "@/lib/graph/readiness";

/**
 * The client's view of a graph — exactly the shape `GET /api/graph/:id` returns.
 *
 * Concept ids are carried because `POST /api/concepts/:id/detail` and `POST /api/mastery` are
 * keyed on them, but everything else — edges, mastery, the readiness maths, the study plan — works
 * in SLUG space. That is what keeps the payload stable across a clone, which mints fresh ids for
 * the same slugs (docs/05 W4).
 */
export type GraphConceptView = {
  id: string;
  slug: string;
  name: string;
  difficulty: string | null;
  summary: string | null;
  estimatedMinutes: number | null;
  layoutX: number | null;
  layoutY: number | null;
  layoutW: number | null;
  /** Whether a detail has already been generated — not the payload, which is fetched on click. */
  hasDetail: boolean;
};

export type GraphView = {
  id: string;
  title: string;
  concepts: GraphConceptView[];
  edges: { prerequisite: string; dependent: string }[];
  mastery: { slug: string; state: MasteryState }[];
};

/** What the panel knows about one concept's lazily-loaded explanation. */
export type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; detail: ConceptDetail }
  /** The ladder was exhausted; the panel falls back to the concept's own summary (W5). */
  | { kind: "unavailable" };

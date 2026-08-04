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

/**
 * Everything `KnowledgeGraph` does that leaves the browser, in one object.
 *
 * Added in Phase 6 so `/demo` can render the real workspace signed out. The alternative — a
 * second, demo-only copy of the graph UI — was rejected: the acceptance criterion is about how
 * the actual interface behaves, and a copy starts drifting from it the day it is written.
 *
 * The point is what a demo transport does NOT have. `demoGraphTransport` (./demo-transport)
 * closes over static data and contains no `fetch` at any depth, so "demo content is never written
 * to any user's records" is a property of the object graph rather than a promise about which code
 * paths run. `knowledge-graph.demo-writes.test.tsx` asserts it by counting calls, with a
 * live-transport control that must fire.
 */
export type GraphTransport = {
  /** Resolve one concept's explanation. */
  loadDetail: (concept: GraphConceptView) => Promise<DetailState>;
  /** Persist a mastery change. Fire-and-forget: W6 forbids surfacing a failure here. */
  saveMastery: (concept: GraphConceptView, state: MasteryState) => void;
  /** Whether an upload path exists at all. When false the upload controls are not rendered. */
  canUpload: boolean;
};

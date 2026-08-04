import { DEMO_GRAPH, type DemoConcept } from "@/lib/demo/graph";
import type { GraphTransport, GraphView } from "./types";

/**
 * The signed-out `/demo` transport and the graph it renders.
 *
 * This module is the whole of Phase 6's "demo content is never written to any user's records"
 * guarantee, and it keeps it structurally rather than by discipline: **there is no `fetch` here,
 * and nothing it imports has one.** `DEMO_GRAPH` is a frozen literal in lib/demo/graph.ts. So the
 * demo cannot write to a user's records for the same reason a pure function cannot — it has no
 * means to, not merely no occasion.
 *
 * That matters more than it sounds. The natural implementation of a demo is the real component
 * pointed at a demo *account*, or writes suppressed behind an `isDemo` branch inside each handler.
 * Both keep the network calls in the object graph and reduce the guarantee to "no branch is
 * currently wrong", which no test can hold down for long. Removing the capability is checkable
 * once and stays checked.
 *
 * `hasDetail` is true for every concept because every curated concept carries its own
 * `definition`, `example`, `quiz` and `flashcards` — the panel resolves them from memory, so the
 * demo also issues no GET, not merely no writes.
 */

/**
 * Ids are synthetic and deliberately not uuid-shaped. Nothing in demo mode keys on them — the
 * graph, readiness and study plan all work in slug space — so if one ever reaches a route it will
 * be as obvious in a log as it is here.
 */
const demoIdFor = (slug: string) => `demo:${slug}`;

export function demoGraphView(): GraphView {
  return {
    id: "demo:graph",
    title: DEMO_GRAPH.title,
    concepts: DEMO_GRAPH.concepts.map((c) => ({
      id: demoIdFor(c.slug),
      slug: c.slug,
      name: c.name,
      difficulty: c.difficulty,
      summary: c.summary,
      estimatedMinutes: c.estimatedMinutes,
      layoutX: c.layoutX,
      layoutY: c.layoutY,
      /** The prototype's curated nodes carry no stored width; the renderer's own default applies. */
      layoutW: null,
      hasDetail: true,
    })),
    edges: DEMO_GRAPH.edges.map((e) => ({ prerequisite: e.prerequisite, dependent: e.dependent })),
    /** Nothing is mastered at the start of a demo; marking is session-local state. */
    mastery: [],
  };
}

const bySlug = new Map<string, DemoConcept>(DEMO_GRAPH.concepts.map((c) => [c.slug, c]));

export const demoGraphTransport: GraphTransport = {
  async loadDetail(concept) {
    const source = bySlug.get(concept.slug);
    if (!source) return { kind: "unavailable" };
    return {
      kind: "ready",
      detail: {
        definition: source.definition,
        example: source.example,
        quiz: source.quiz,
        flashcards: source.flashcards,
      },
    };
  },
  /**
   * Marking mastery in the demo re-colours the graph and recomputes readiness — all of which is
   * client-side (W6) — and then stops. Nothing persists, which is the honest behaviour for a
   * session with no account behind it.
   */
  saveMastery() {},
  canUpload: false,
};

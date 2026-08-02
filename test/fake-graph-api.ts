import { vi } from "vitest";
import type { ConceptDetail } from "@/lib/ai/schemas";

/**
 * A fake graph API for component tests.
 *
 * It speaks the real wire contract of the five routes the Knowledge Graph island talks to
 * (`app/api/graph/[id]`, `.../build`, `app/api/documents`, `app/api/concepts/[id]/detail`,
 * `app/api/mastery`). Keeping that contract in one place means a change to a route breaks these
 * tests loudly rather than leaving them passing against a shape the server no longer sends.
 *
 * Every call is counted. That is not bookkeeping — "clicking a concept generates detail once and
 * caches it" is an acceptance criterion (docs/06 Phase 5), and the only way to prove it is to
 * count the requests the component actually makes.
 */

export type FakeConcept = {
  id: string;
  slug: string;
  name: string;
  difficulty?: string;
  summary?: string;
  estimatedMinutes?: number;
  layoutX?: number;
  layoutY?: number;
  layoutW?: number;
  hasDetail?: boolean;
};

export type FakeGraph = {
  title: string;
  concepts: FakeConcept[];
  edges: { prerequisite: string; dependent: string }[];
  mastery?: { slug: string; state: "locked" | "learning" | "known" }[];
};

export type GraphResponseSpec =
  | { status: "ready"; graph: FakeGraph }
  | { status: "processing" }
  | { status: "failed"; message?: string }
  /** A transport-level failure — the poll must survive one and keep going. */
  | { status: "network-error" };

export type DetailResponseSpec =
  | { status: "ready"; detail: ConceptDetail }
  | { status: "unavailable"; summary: string }
  | { status: "network-error" };

export type FakeGraphApi = {
  /** Every URL requested, in order. */
  calls: string[];
  /** `POST /api/concepts/:id/detail` calls, by concept id, in order. */
  detailCalls: string[];
  /** `POST /api/mastery` bodies, in order. */
  masteryCalls: { conceptId: string; state: string }[];
  /** `GET /api/graph/:id` call count — the polling cost. */
  graphReads: number;
  /** `POST /api/graph/:id/build` call count. */
  buildFires: number;
  /** Swap what the graph endpoint returns from now on. */
  setGraph(spec: GraphResponseSpec): void;
  /** Swap what the detail endpoint returns from now on. */
  setDetail(spec: DetailResponseSpec | ((conceptId: string) => DetailResponseSpec)): void;
};

const DEFAULT_DETAIL: ConceptDetail = {
  definition: "A definition.",
  example: "An example.",
  quiz: { q: "A question?", options: ["a", "b"], answer: 0, explanation: "Because." },
  flashcards: [{ front: "Front", back: "Back" }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphResponse(spec: GraphResponseSpec): Response {
  if (spec.status === "processing") return json({ status: "processing", title: null });
  if (spec.status === "failed") {
    return json({
      status: "failed",
      message: spec.message ?? "Couldn't map this document's structure. Quick Notes still works on it.",
    });
  }
  // `network-error` is thrown by the caller before it reaches here; narrowing it away keeps this
  // function total rather than relying on the caller having remembered.
  if (spec.status === "network-error") throw new TypeError("Failed to fetch");
  const graph: FakeGraph = spec.graph;
  return json({
    status: "ready",
    title: graph.title,
    concepts: graph.concepts.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      difficulty: c.difficulty ?? "Intermediate",
      summary: c.summary ?? "",
      estimatedMinutes: c.estimatedMinutes ?? 120,
      layoutX: c.layoutX ?? 24,
      layoutY: c.layoutY ?? 20,
      layoutW: c.layoutW ?? 146,
      hasDetail: c.hasDetail ?? false,
    })),
    edges: graph.edges,
    mastery: graph.mastery ?? [],
  });
}

export function installFakeGraphApi(opts: {
  /** A single response, or a sequence consumed one per poll (the last one repeats). */
  graph: GraphResponseSpec | GraphResponseSpec[];
  detail?: DetailResponseSpec | ((conceptId: string) => DetailResponseSpec);
  /** `POST /api/documents` response. */
  upload?: { graphId: string; status: "ready" | "processing" } | { message: string };
}): FakeGraphApi {
  const graphQueue = Array.isArray(opts.graph) ? [...opts.graph] : [opts.graph];
  let graphSpec: GraphResponseSpec | null = null;
  let detailSpec = opts.detail ?? ({ status: "ready", detail: DEFAULT_DETAIL } as DetailResponseSpec);

  const api: FakeGraphApi = {
    calls: [],
    detailCalls: [],
    masteryCalls: [],
    graphReads: 0,
    buildFires: 0,
    setGraph(spec) {
      graphSpec = spec;
      graphQueue.length = 0;
    },
    setDetail(spec) {
      detailSpec = spec;
    },
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      api.calls.push(url);

      if (url.includes("/build")) {
        api.buildFires += 1;
        return json({ status: "processing" });
      }

      if (url.startsWith("/api/graph/")) {
        api.graphReads += 1;
        const spec = graphSpec ?? (graphQueue.length > 1 ? graphQueue.shift()! : graphQueue[0]);
        if (spec.status === "network-error") throw new TypeError("Failed to fetch");
        return graphResponse(spec);
      }

      if (url.startsWith("/api/concepts/")) {
        const conceptId = url.split("/")[3];
        api.detailCalls.push(conceptId);
        const spec = typeof detailSpec === "function" ? detailSpec(conceptId) : detailSpec;
        if (spec.status === "network-error") throw new TypeError("Failed to fetch");
        if (spec.status === "unavailable") {
          return json({
            status: "unavailable",
            summary: spec.summary,
            message: "A detailed explanation couldn't be generated.",
          });
        }
        return json({ status: "ready", detail: spec.detail, cached: false });
      }

      if (url.includes("/api/mastery")) {
        if (typeof init?.body === "string") api.masteryCalls.push(JSON.parse(init.body));
        return json({ ok: true });
      }

      if (url.includes("/api/documents")) {
        const upload = opts.upload ?? { graphId: "g-new", status: "processing" as const };
        return json(upload);
      }

      throw new Error(`Unexpected fetch in a component test: ${url}`);
    },
  );

  return api;
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConceptDetail } from "@/lib/ai/schemas";
import { track } from "@/lib/analytics";
import { exportDoc, exportPdf } from "@/lib/export";
import { viewBoxHeightFor } from "@/lib/graph/layout";
import {
  formatMinutes,
  prerequisiteMap,
  readiness,
  studyPlan,
  type GraphConcept,
  type GraphEdge,
  type MasteryState,
} from "@/lib/graph/readiness";
import { graphToMarkdown } from "@/lib/graph/study-guide";
import { plainText } from "@/lib/sanitize";
import { ConceptPanel, ReadinessRing } from "./concept-panel";
import type { DetailState, GraphConceptView, GraphTransport, GraphView } from "./types";

/**
 * The Knowledge Graph workspace (W4–W7, docs/05) — a faithful React port of the prototype's
 * `#feature-graph` (docs/reference/edgify-prototype.html).
 *
 * The prototype called the model from the browser and held one graph in memory. Here the graph is
 * persisted and every generation goes through our own routes, which own the key, the ladder and
 * the ledger (AGENTS.md #1/#3). What is unchanged is everything the user sees: the SVG dependency
 * graph, the independently-scrolling panel, the concept library, the study plan, the staged upload
 * modal, and the client-side PDF/DOC export.
 *
 * Readiness and the study plan are computed CLIENT-SIDE from stored concepts, edges and mastery
 * (W6) — no model call, no round trip, so marking a concept mastered re-colours the whole graph
 * instantly and can never show a busy state.
 */

/** Poll cadence (W4). See the note on `pollGraph` — this is load-bearing, not tuning. */
const POLL_FAST_MS = 1_500;
const POLL_SLOW_MS = 3_000;
const POLL_FAST_WINDOW_MS = 15_000;
const POLL_TIMEOUT_MS = 90_000;

const BUILD_FAILED_MESSAGE =
  "Couldn't map this document's structure. Quick Notes still works on it.";
const BUSY_MESSAGE = "Server is busy, please try again in a moment.";

/**
 * The real transport: the four network calls this workspace makes when a signed-in user drives
 * it. `/demo` swaps it for `demoGraphTransport`, which has no `fetch` at any depth — see the note
 * on `GraphTransport` in ./types.
 */
export const liveGraphTransport: GraphTransport = {
  async loadDetail(concept) {
    const res = await fetch(`/api/concepts/${concept.id}/detail`, { method: "POST" });
    const body = (await res.json()) as { status?: string; detail?: ConceptDetail };
    return body.status === "ready" && body.detail
      ? { kind: "ready", detail: body.detail }
      : { kind: "unavailable" };
  },
  saveMastery(concept, state) {
    void fetch("/api/mastery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conceptId: concept.id, state }),
    }).catch(() => {
      // W6: no model call, so this must never surface a busy state. The local view stays
      // correct for this session; a reload re-reads whatever was actually stored.
    });
  },
  canUpload: true,
};

type View = "graph" | "concepts" | "plan";
type SubTab = "overview" | "quiz" | "cards";

type Stage = "idle" | "reading" | "extracting" | "building" | "done" | "error";

type Status =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "processing"; graphId: string }
  | { kind: "ready" }
  | { kind: "failed"; message: string }
  | { kind: "busy"; graphId: string };

export function KnowledgeGraph({
  initialGraphId,
  initialGraph = null,
  transport = liveGraphTransport,
}: {
  initialGraphId: string | null;
  /**
   * A graph supplied up front instead of polled for. `/demo` uses this: the content is static, so
   * there is nothing to wait on and `pollGraph` never runs — which is also why the demo issues no
   * GET, not merely no writes.
   */
  initialGraph?: GraphView | null;
  transport?: GraphTransport;
}) {
  const [status, setStatus] = useState<Status>(
    initialGraph ? { kind: "ready" } : initialGraphId ? { kind: "loading" } : { kind: "empty" },
  );
  const [graph, setGraph] = useState<GraphView | null>(initialGraph);
  const [mastery, setMastery] = useState<Map<string, MasteryState>>(
    () => new Map((initialGraph?.mastery ?? []).map((m) => [m.slug, m.state])),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("graph");
  const [subTab, setSubTab] = useState<SubTab>("overview");
  const [cardIndex, setCardIndex] = useState(0);
  const [details, setDetails] = useState<Map<string, DetailState>>(new Map());
  /**
   * The same map, mirrored into a ref. `loadDetail` reads the ref, never the state: a state read
   * would be a stale closure from the render that created the callback, so a concept could be
   * fetched twice — which is exactly the property this slice has to prove. Writing through
   * `updateDetails` keeps the two in step.
   */
  const detailsRef = useRef<Map<string, DetailState>>(new Map());
  const updateDetails = useCallback(
    (mutate: (current: Map<string, DetailState>) => Map<string, DetailState>) => {
      detailsRef.current = mutate(detailsRef.current);
      setDetails(detailsRef.current);
    },
    [],
  );

  // Upload modal
  const [modalOpen, setModalOpen] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [modalFile, setModalFile] = useState<{ name: string; size: number } | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * Concept slugs whose detail request is in flight. A ref rather than state on purpose: two
   * renders in the same tick must not both start a fetch, and a state update would not be visible
   * to the second one until after it had already fired.
   */
  const detailInFlight = useRef<Set<string>>(new Set());
  /** Cancels an in-progress poll when the component unmounts or a new build starts. */
  const pollAbort = useRef<AbortController | null>(null);

  const concepts: GraphConcept[] = useMemo(
    () =>
      (graph?.concepts ?? []).map((c) => ({
        slug: c.slug,
        name: c.name,
        difficulty: c.difficulty ?? "Intermediate",
        summary: c.summary ?? "",
        estimatedMinutes: c.estimatedMinutes ?? 0,
      })),
    [graph],
  );
  const edges: GraphEdge[] = useMemo(() => graph?.edges ?? [], [graph]);

  // ── Concept detail, fetched once per concept (W5) ──────────────────────────

  const loadDetail = useCallback(
    async (concept: GraphConceptView) => {
      /**
       * The cache that makes "generates detail once" true. Three guards, and each catches a
       * different double-fetch:
       *   - `details` already holds a resolved entry → a revisit costs nothing,
       *   - `detailInFlight` holds the slug → two renders in one tick cannot both fire,
       *   - the server returns its stored `detailJson` when one exists → a reload costs no tokens.
       */
      if (detailsRef.current.has(concept.slug) || detailInFlight.current.has(concept.slug)) return;
      detailInFlight.current.add(concept.slug);
      updateDetails((prev) => new Map(prev).set(concept.slug, { kind: "loading" }));

      try {
        const resolved = await transport.loadDetail(concept);
        updateDetails((prev) => new Map(prev).set(concept.slug, resolved));
      } catch {
        updateDetails((prev) => new Map(prev).set(concept.slug, { kind: "unavailable" }));
      } finally {
        detailInFlight.current.delete(concept.slug);
      }
    },
    [transport, updateDetails],
  );

  // ── Loading and polling ────────────────────────────────────────────────────

  const applyGraph = useCallback((payload: GraphView) => {
    setGraph(payload);
    setMastery(new Map(payload.mastery.map((m) => [m.slug, m.state])));
    setStatus({ kind: "ready" });
    // W4: select the first foundational concept, so the panel is never empty on arrival.
    const prerequisites = prerequisiteMap(
      payload.concepts.map((c) => ({
        slug: c.slug,
        name: c.name,
        difficulty: c.difficulty ?? "Intermediate",
        summary: c.summary ?? "",
        estimatedMinutes: c.estimatedMinutes ?? 0,
      })),
      payload.edges,
    );
    const opening =
      payload.concepts.find((c) => (prerequisites.get(c.slug) ?? []).length === 0) ??
      payload.concepts[0];
    setSelected((current) =>
      current && payload.concepts.some((c) => c.slug === current)
        ? current
        : (opening?.slug ?? null),
    );
    // The opening concept's explanation starts loading here rather than in an effect watching
    // `selected`. Both paths that change the selection — this one and `selectConcept` — are
    // already async callbacks, so an effect would only add a render pass between the click and
    // the fetch, and React's own lint rule rejects setState called synchronously from an effect.
    if (opening) void loadDetail(opening);
  }, [loadDetail]);

  /**
   * Poll `GET /api/graph/:id` until it resolves (W4).
   *
   * THE BACKOFF IS PART OF THE ROUTE'S RATE LIMIT, not polish. That route allows 600 requests per
   * minute per IP, and a campus NAT puts a whole class behind one address. A flat 1.5s poll costs
   * ~40 req/min per builder, so 600 covers only ~15 concurrent uploads and a class of 30 would
   * start seeing 429s on their own progress modal. Fast for the first 15 seconds, then 3s, costs
   * ~23 req/min and brings a class of 30 inside the budget (see app/api/graph/[id]/route.ts).
   */
  const pollGraph = useCallback(
    async (graphId: string, startedAt = Date.now()) => {
      pollAbort.current?.abort();
      const controller = new AbortController();
      pollAbort.current = controller;
      // The graph id is ours, not the user's content — but it buys nothing in an event, so the
      // start is recorded bare and paired with completion/failure by the person's distinct id.
      track("graph_build_started");

      for (;;) {
        if (controller.signal.aborted) return;
        const elapsed = Date.now() - startedAt;
        if (elapsed > POLL_TIMEOUT_MS) {
          setStatus({ kind: "busy", graphId });
          return;
        }

        try {
          const res = await fetch(`/api/graph/${graphId}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const body = (await res.json()) as Partial<GraphView> & {
            status?: string;
            message?: string;
          };

          if (body.status === "ready" && body.concepts) {
            applyGraph({
              id: graphId,
              title: body.title ?? "Your document",
              concepts: body.concepts,
              edges: body.edges ?? [],
              mastery: body.mastery ?? [],
            });
            // A COUNT and a duration. Never `body.title` (the document's name) and never the
            // concepts, which are model output derived from the user's material.
            track({
              name: "graph_build_completed",
              props: { conceptCount: body.concepts.length, durationMs: Date.now() - startedAt },
            });
            return;
          }
          if (body.status === "failed") {
            setStatus({ kind: "failed", message: body.message ?? BUILD_FAILED_MESSAGE });
            // Not `body.message` — that is user-facing prose. A fixed reason is enough to watch
            // the failure rate; Sentry carries the detail.
            track({ name: "graph_build_failed", props: { reason: "build_failed" } });
            return;
          }
          if (!res.ok && res.status !== 429) {
            // 401/404 — nothing to wait for. A 429 is transient and worth another pass.
            setStatus({ kind: "failed", message: BUILD_FAILED_MESSAGE });
            track({ name: "graph_build_failed", props: { reason: "unavailable" } });
            return;
          }
        } catch (error) {
          if (controller.signal.aborted || (error as Error).name === "AbortError") return;
          // A dropped request mid-build is not a failed build; keep polling until the timeout.
        }

        setStatus({ kind: "processing", graphId });
        const wait = elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
    [applyGraph],
  );

  /**
   * Start polling for the graph this page opened on.
   *
   * `react-hooks/set-state-in-effect` is disabled for this one line, deliberately. The rule's own
   * carve-out is "subscribe for updates from some external system, calling setState in a
   * callback", which is precisely what this is: a long-lived poll against the build, cancelled by
   * the cleanup below. It fires because `pollGraph` is statically capable of calling `setStatus`
   * before its first `await` (the elapsed-time check, which cannot be true on the first pass), not
   * because a cascading render actually happens.
   *
   * The other two effects this component used to have were NOT like that — they were doing work
   * that belonged in the callbacks that caused it — and both were removed rather than suppressed:
   * concept detail now loads from `applyGraph` and `selectConcept` directly.
   */
  useEffect(() => {
    if (!initialGraphId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    void pollGraph(initialGraphId);
    return () => pollAbort.current?.abort();
  }, [initialGraphId, pollGraph]);

  // ── Upload → build (W4) ────────────────────────────────────────────────────

  const onFilePicked = useCallback(
    async (file: File) => {
      setModalOpen(true);
      setModalFile({ name: file.name, size: file.size });
      setModalError(null);
      setStage("reading");
      updateDetails(() => new Map());
      detailInFlight.current.clear();

      try {
        const form = new FormData();
        form.set("file", file);
        const res = await fetch("/api/documents", { method: "POST", body: form });
        const body = (await res.json()) as {
          graphId?: string;
          status?: string;
          message?: string;
        };

        if (!body.graphId) {
          // Every upload failure already carries its own next action (docs/04 §7) — the
          // scanned-PDF message points at pasting, the oversize one at a smaller file.
          setStage("error");
          setModalError(body.message ?? "That file couldn't be read. It may be damaged — try re-saving or exporting it again.");
          return;
        }

        setStage("extracting");

        if (body.status === "ready") {
          /**
           * The clone path (W4 step 8): another user already built a graph for this exact
           * content, so it was copied under this user for zero tokens and there is nothing to
           * build. Skip straight to reading it.
           */
          setStage("building");
          await pollGraph(body.graphId);
          setStage("done");
          setTimeout(() => setModalOpen(false), 500);
          return;
        }

        setStage("building");
        // Fire the build and do NOT await it — this request runs the ladder and can take a
        // minute or more. The poll below is what reports its outcome (W4).
        void fetch(`/api/graph/${body.graphId}/build`, { method: "POST" }).catch(() => {
          // A failed fire is not fatal: the poll still runs, and a build already in flight for
          // this graph (a double-fire) is refused by the route's idempotency check anyway.
        });
        await pollGraph(body.graphId);
        setStage("done");
        setTimeout(() => setModalOpen(false), 500);
      } catch {
        setStage("error");
        setModalError("Something went wrong on our side. Please try again in a moment.");
      }
    },
    [pollGraph, updateDetails],
  );

  // ── Mastery (W6) ───────────────────────────────────────────────────────────

  const setMasteryState = useCallback(
    (slug: string, state: MasteryState) => {
      const concept = graph?.concepts.find((c) => c.slug === slug);
      if (!concept) return;
      // Optimistic: readiness recomputes locally and the graph re-colours immediately. The write
      // is what makes it survive a reload, and it cannot fail in a way the user needs to see.
      // In demo mode there is no write at all, and the local recolour is the whole behaviour.
      setMastery((prev) => new Map(prev).set(slug, state));
      transport.saveMastery(concept, state);
    },
    [graph, transport],
  );

  const selectConcept = useCallback(
    (slug: string) => {
      setSelected((current) => {
        if (current !== slug) {
          setSubTab("overview");
          setCardIndex(0);
        }
        return slug;
      });
      // No identifier — the slug is model output derived from the user's document (see the note
      // on this event in lib/analytics.ts).
      track("concept_opened");
      const concept = graph?.concepts.find((c) => c.slug === slug);
      // No-op when the detail is already cached or in flight — that guard lives in `loadDetail`,
      // so every caller gets it.
      if (concept) void loadDetail(concept);
    },
    [graph, loadDetail],
  );

  // ── Export (W7) ────────────────────────────────────────────────────────────

  const exportMarkdown = useCallback((): string => {
    const resolved = new Map<string, ConceptDetail>();
    for (const [slug, state] of details) {
      if (state.kind === "ready") resolved.set(slug, state.detail);
    }
    return graphToMarkdown(plainText(graph?.title ?? "Your document"), concepts, edges, resolved);
  }, [graph, concepts, edges, details]);

  const exportTitle = `Edgify study guide — ${plainText(graph?.title ?? "Your document")}`;

  // ── Render ─────────────────────────────────────────────────────────────────

  const selectedConcept = graph?.concepts.find((c) => c.slug === selected) ?? null;

  return (
    <section className="feature">
      {/* No upload path in demo mode: the control, its file input and the modal are all absent,
          so there is no route from the UI to POST /api/documents rather than a disabled button. */}
      {transport.canUpload && (
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset first, so picking the same file twice still fires a change event.
            e.target.value = "";
            if (file) void onFilePicked(file);
          }}
        />
      )}

      <div className="gbar">
        <div className="pill-group mini" role="tablist" aria-label="Graph view">
          {(["graph", "concepts", "plan"] as const).map((v) => (
            <button
              key={v}
              className="seg"
              role="tab"
              type="button"
              aria-selected={view === v}
              onClick={() => setView(v)}
            >
              {v === "graph" ? "Graph" : v === "concepts" ? "Concepts" : "Study plan"}
            </button>
          ))}
        </div>
        <div className="gbar-right">
          <div className="legend">
            <span>
              <span className="swatch known" /> Mastered
            </span>
            <span>
              <span className="swatch learning" /> In progress
            </span>
            <span>
              <span className="swatch locked" /> Not started
            </span>
          </div>
          <button
            className="btn-secondary"
            type="button"
            disabled={status.kind !== "ready"}
            onClick={() => exportPdf(exportTitle, exportMarkdown())}
          >
            <IconDownload />
            <span>PDF</span>
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={status.kind !== "ready"}
            onClick={() => exportDoc(exportTitle, exportMarkdown())}
          >
            <IconDownload />
            <span>DOC</span>
          </button>
          {transport.canUpload && (
            <button className="btn-secondary" type="button" onClick={() => fileRef.current?.click()}>
              <IconUpload />
              <span>Upload document</span>
            </button>
          )}
        </div>
      </div>

      {status.kind !== "ready" || !graph ? (
        <GraphStatus
          status={status}
          onUpload={() => fileRef.current?.click()}
          onKeepWaiting={(graphId) => void pollGraph(graphId, Date.now())}
        />
      ) : (
        <>
          {view === "graph" && (
            <div className="grid">
              <div className="card graph-card">
                <div className="graph-head">
                  <h2>Dependency graph</h2>
                  <span className="hint">
                    Click a concept for a deep, document-grounded explanation
                  </span>
                </div>
                <DependencyGraph
                  concepts={graph.concepts}
                  edges={edges}
                  mastery={mastery}
                  selected={selected}
                  onSelect={selectConcept}
                />
              </div>
              {selectedConcept ? (
                <ConceptPanel
                  concept={selectedConcept}
                  concepts={concepts}
                  edges={edges}
                  mastery={mastery}
                  detail={details.get(selectedConcept.slug)}
                  subTab={subTab}
                  cardIndex={cardIndex}
                  onSubTab={setSubTab}
                  onSelect={selectConcept}
                  onToggleMastered={() =>
                    setMasteryState(
                      selectedConcept.slug,
                      mastery.get(selectedConcept.slug) === "known" ? "locked" : "known",
                    )
                  }
                  onQuizCorrect={() => {
                    // The prototype promotes a locked concept to "in progress" on a correct
                    // answer, and leaves a mastered one alone.
                    if ((mastery.get(selectedConcept.slug) ?? "locked") === "locked") {
                      setMasteryState(selectedConcept.slug, "learning");
                    }
                  }}
                  onCardIndex={setCardIndex}
                  onOpenPlan={() => setView("plan")}
                />
              ) : (
                <aside className="card panel" />
              )}
            </div>
          )}

          {view === "concepts" && (
            <ConceptLibrary
              concepts={graph.concepts}
              conceptList={concepts}
              edges={edges}
              mastery={mastery}
              details={details}
              onOpen={(slug) => {
                selectConcept(slug);
                setView("graph");
              }}
            />
          )}

          {view === "plan" && selectedConcept && (
            <StudyPlanView
              goal={selectedConcept}
              concepts={concepts}
              edges={edges}
              mastery={mastery}
              onOpen={(slug) => {
                selectConcept(slug);
                setView("graph");
              }}
            />
          )}
        </>
      )}

      {transport.canUpload && (
        <UploadModal
          open={modalOpen}
          stage={stage}
          file={modalFile}
          error={modalError}
          onClose={() => setModalOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * The SVG dependency graph — the prototype's `renderGraph`, node for node.
 *
 * Positions are the STORED `layoutX/Y/W` computed once server-side (docs/03), so every client
 * renders the same picture and a re-render never reshuffles the graph under the user.
 *
 * Every string here that came from the model — the node label, the `aria-label` — is a React
 * child or a React attribute, which React escapes. `knowledge-graph.sanitize.test.tsx` renders
 * the prototype's own unescaped `innerHTML` template of this same markup as a negative control,
 * and shows that one executing.
 */
/**
 * Horizontal breathing room inside a node box, each side. Matches the box's 11px corner radius,
 * so the label clears the rounded corners rather than touching them.
 */
const LABEL_PAD_X = 10;

/**
 * Inter's mean glyph advance at weight 600, in em. Used to estimate a label's rendered width.
 *
 * `getComputedTextLength()` would be exact, but it needs a ref, a second render pass and a layout
 * read for every node on every re-render of a 20-node graph — and it returns nothing during SSR.
 * That is a great deal of machinery for a text-fitting problem, so the width is estimated instead.
 * The constant is deliberately on the generous side: erring LONG re-introduces the overflow this
 * exists to prevent, while erring short costs at most one elided character.
 */
const AVG_CHAR_EM = 0.55;

/**
 * The longest prefix of `name` that fits inside a node box, elided with an ellipsis if it must be.
 *
 * WHY THIS IS NEEDED. An SVG `<text>` neither wraps nor clips. With `text-anchor="middle"` a long
 * label renders as a single line centred on the box and spills equally past BOTH edges, straight
 * over the neighbouring nodes — which reads as boxes overlapping, even though every box is exactly
 * where the layout put it (`lib/graph/layout.ts` keeps a 24px gap and never overlaps).
 *
 * The prototype has the same markup and never hit this: its demo concepts are "Calculus",
 * "Gradient descent", "Neural networks". Real names come from the model, and `graphConceptSchema`
 * puts NO maximum length on `name` — so the overflow is unbounded.
 *
 * The full, untruncated name is still available: it stays in the node's `aria-label` for assistive
 * technology, in the `<title>` tooltip on hover, and in the concept panel on click. Nothing is
 * lost — only the glyphs that would have been drawn on top of another node.
 */
export function fitNodeLabel(name: string, boxWidth: number, fontSize: number): string {
  const available = boxWidth - LABEL_PAD_X * 2;
  const maxChars = Math.floor(available / (fontSize * AVG_CHAR_EM));
  if (name.length <= maxChars) return name;
  // Below two characters there is no useful prefix to show, only the mark that something was cut.
  if (maxChars < 2) return "…";
  return `${name.slice(0, maxChars - 1).trimEnd()}…`;
}

function DependencyGraph({
  concepts,
  edges,
  mastery,
  selected,
  onSelect,
}: {
  concepts: GraphConceptView[];
  edges: GraphEdge[];
  mastery: Map<string, MasteryState>;
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));
  const maxY = Math.max(0, ...concepts.map((c) => c.layoutY ?? 0));
  const height = viewBoxHeightFor(maxY);

  const widthOf = (c: GraphConceptView) => c.layoutW ?? 146;
  const centreX = (c: GraphConceptView) => (c.layoutX ?? 0) + widthOf(c) / 2;

  return (
    <svg
      className="graph"
      viewBox={`0 0 760 ${height}`}
      role="img"
      aria-label="Concept dependency graph"
    >
      <defs>
        <marker
          id="ah"
          viewBox="0 0 10 10"
          refX="8.5"
          refY="5"
          markerWidth="6.5"
          markerHeight="6.5"
          orient="auto-start-reverse"
        >
          <path
            d="M2 1.5L8 5L2 8.5"
            fill="none"
            stroke="context-stroke"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <g>
        {edges.map((edge) => {
          const from = bySlug.get(edge.prerequisite);
          const to = bySlug.get(edge.dependent);
          if (!from || !to) return null;
          // "Hot" when either end is the selected concept — the prototype's `rel` set.
          const hot = edge.prerequisite === selected || edge.dependent === selected;
          return (
            <line
              key={`${edge.prerequisite}>${edge.dependent}`}
              className={`edge${hot ? " hot" : ""}`}
              x1={centreX(from)}
              y1={from.layoutY ?? 0}
              x2={centreX(to)}
              y2={(to.layoutY ?? 0) + 46}
              markerEnd="url(#ah)"
            />
          );
        })}
      </g>
      <g>
        {concepts.map((concept) => {
          const state = mastery.get(concept.slug) ?? "locked";
          const isSelected = concept.slug === selected;
          const w = widthOf(concept);
          const x = concept.layoutX ?? 0;
          const y = concept.layoutY ?? 0;
          const fontSize = w < 118 ? 11 : 12.5;
          const fullName = plainText(concept.name);
          return (
            <g
              key={concept.slug}
              className={`node-g n-${state}${isSelected ? " sel" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={fullName}
              onClick={() => onSelect(concept.slug)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(concept.slug);
                }
              }}
            >
              <rect
                className="halo"
                x={x - 4}
                y={y - 4}
                width={w + 8}
                height={54}
                rx={14}
                fill="none"
                stroke="#111"
                strokeOpacity="0.12"
                strokeWidth={6}
              />
              <rect className="box" x={x} y={y} width={w} height={46} rx={11} />
              <text
                className="lbl"
                x={centreX(concept)}
                y={y + 24}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fontSize}
                fontWeight={600}
                fontFamily="Inter, sans-serif"
                letterSpacing="-0.2"
              >
                {fitNodeLabel(fullName, w, fontSize)}
              </text>
              {/* Recovers the full name on hover when the label above had to be elided. A React
                  child, so it is escaped exactly as the label is (knowledge-graph.sanitize). */}
              <title>{fullName}</title>
              {state === "learning" && (
                <circle className="prq-dot" cx={x + w - 13} cy={y + 13} r={3.5} />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** The prototype's `renderConcepts` — the same data as the graph, ranked by readiness. */
function ConceptLibrary({
  concepts,
  conceptList,
  edges,
  mastery,
  details,
  onOpen,
}: {
  concepts: GraphConceptView[];
  conceptList: GraphConcept[];
  edges: GraphEdge[];
  mastery: Map<string, MasteryState>;
  details: Map<string, DetailState>;
  onOpen: (slug: string) => void;
}) {
  const prerequisites = prerequisiteMap(conceptList, edges);
  const ordered = [...concepts].sort(
    (a, b) =>
      readiness(b.slug, prerequisites, mastery) - readiness(a.slug, prerequisites, mastery),
  );

  return (
    <>
      <div className="view-head">
        <h1>Concept library</h1>
        <p>
          Every concept extracted from your material, ranked by how ready you are to study it in
          depth.
        </p>
      </div>
      <div className="concept-grid">
        {ordered.map((concept) => {
          const pct = readiness(concept.slug, prerequisites, mastery);
          const detail = details.get(concept.slug);
          const blurb =
            detail?.kind === "ready" ? detail.detail.definition : (concept.summary ?? "");
          return (
            <button
              key={concept.slug}
              className="cc"
              type="button"
              onClick={() => onOpen(concept.slug)}
            >
              <div className="cc-top">
                <span className="cc-name">{plainText(concept.name)}</span>
                <span className="cc-r">{pct}%</span>
              </div>
              <div className="cc-def">{plainText(blurb)}</div>
              <div className="cc-foot">
                <div className="bar">
                  {/* Width is a computed percentage, never model output. */}
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span>{concept.difficulty ?? "Intermediate"}</span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** The prototype's `renderPlan`. */
function StudyPlanView({
  goal,
  concepts,
  edges,
  mastery,
  onOpen,
}: {
  goal: GraphConceptView;
  concepts: GraphConcept[];
  edges: GraphEdge[];
  mastery: Map<string, MasteryState>;
  onOpen: (slug: string) => void;
}) {
  const plan = studyPlan(goal.slug, concepts, edges, mastery);
  const bySlug = new Map(concepts.map((c) => [c.slug, c]));

  if (plan.total === 0) {
    return (
      <div className="plan">
        <div className="plan-empty">
          <h1>{plainText(goal.name)} is a foundation</h1>
          <p style={{ marginTop: 10 }}>
            It has no prerequisites — it&apos;s a starting point others build on. Pick a more
            advanced concept to see a full path.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="plan">
      <div className="plan-hero">
        <ReadinessRing pct={plan.readiness} radius={56} className="big-ring" />
        <div>
          <h1>Path to {plainText(goal.name)}</h1>
          <div className="sub">
            A prerequisite-first route derived from the dependency graph. Mastering a concept
            updates readiness everywhere it&apos;s needed.
          </div>
          <div className="plan-stats">
            <div>
              <div className="v">
                {plan.covered}/{plan.total}
              </div>
              <div className="l">Prerequisites covered</div>
            </div>
            <div>
              <div className="v">{plan.steps.length}</div>
              <div className="l">Concepts to learn</div>
            </div>
            <div>
              <div className="v">{formatMinutes(plan.minutesRemaining) || "0m"}</div>
              <div className="l">Estimated time left</div>
            </div>
          </div>
        </div>
      </div>
      <div className="steps">
        <h3>Recommended order</h3>
        {plan.steps.length === 0 ? (
          <div className="step done">
            <div className="step-n">
              <IconCheckSmall />
            </div>
            <div className="step-body">
              <div className="sn">All prerequisites complete</div>
              <div className="sd">You&apos;re ready to focus on {plainText(goal.name)} itself</div>
            </div>
          </div>
        ) : (
          plan.steps.map((step, i) => (
            <button key={step.slug} className="step" type="button" onClick={() => onOpen(step.slug)}>
              <div className="step-n">{i + 1}</div>
              <div className="step-body">
                <div className="sn">{plainText(bySlug.get(step.slug)?.name ?? step.slug)}</div>
                <div className="sd">
                  {step.ready
                    ? "Ready to start — prerequisites met"
                    : "Unlocks once earlier steps are done"}
                </div>
              </div>
              <div className="step-time">
                {formatMinutes(bySlug.get(step.slug)?.estimatedMinutes ?? 0)}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Everything that is not a rendered graph: the first-visit empty state, the build in progress,
 * the honest W4 failure, and the poll timeout.
 *
 * The timeout offers "Keep waiting", which RESUMES POLLING rather than re-firing the build.
 *
 * REVISITED 2026-08-05, when `ZOMBIE-PROCESSING-ROW` was fixed (docs/09 §1.6), and the behaviour
 * is KEPT — for a better reason than the one it was chosen for. It was originally a safety
 * property: a build killed by the platform left its row `processing` forever, and the build
 * route's idempotency check refused only FINISHED graphs, so a re-fire was permitted and spent
 * again. That is now impossible — a stale row is retired to `failed` and a re-fire spends nothing.
 *
 * But re-firing is now also POINTLESS, which is the stronger argument for the same button.
 * Whatever the poll is waiting on either resolves on its own or gets retired by the reaper, and
 * polling is what surfaces both. A "Try again" that re-fires would, at best, be told `failed` by
 * the guard; the honest recovery from a genuinely dead build is a fresh upload.
 */
function GraphStatus({
  status,
  onUpload,
  onKeepWaiting,
}: {
  status: Status;
  onUpload: () => void;
  onKeepWaiting: (graphId: string) => void;
}) {
  if (status.kind === "empty") {
    return (
      <div className="card qn-output">
        <div className="empty">
          <svg className="eglyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <line x1="12" y1="5.5" x2="5.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="12" y1="5.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
            <line x1="5.5" y1="17.5" x2="18.5" y2="17.5" stroke="#111" strokeWidth="1.4" strokeLinecap="round" />
            <circle cx="12" cy="5.5" r="2.4" fill="#111" />
            <circle cx="5.5" cy="17.5" r="2.4" fill="#111" />
            <circle cx="18.5" cy="17.5" r="2.4" fill="#111" />
          </svg>
          <h3>Upload a document to build its knowledge graph</h3>
          <p>
            Edgify reads your document, finds its key concepts, and maps how they depend on each
            other for deep study.
          </p>
          <button className="btn-primary" type="button" onClick={onUpload}>
            <IconUpload /> Upload document
          </button>
        </div>
      </div>
    );
  }

  if (status.kind === "failed") {
    return (
      <div className="card qn-output">
        <div className="errbox">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8v5M12 16.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <h3>Couldn&apos;t map this document</h3>
          <p>{status.message}</p>
          <a className="btn-secondary" href="/notes">
            <span>Open Quick Notes</span>
          </a>
        </div>
      </div>
    );
  }

  if (status.kind === "busy") {
    return (
      <div className="card qn-output">
        <div className="errbox">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8v5M12 16.5v.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <h3>This is taking longer than usual</h3>
          <p>{BUSY_MESSAGE}</p>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => onKeepWaiting(status.graphId)}
          >
            <span>Keep waiting</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card qn-output">
      <div className="loading">
        <div className="spin" />
        <p>
          {status.kind === "processing"
            ? "Mapping the concepts in your document…"
            : "Loading your graph…"}
        </p>
      </div>
    </div>
  );
}

/** The staged progress modal (W4), ported from the prototype's `#overlay`. */
function UploadModal({
  open,
  stage,
  file,
  error,
  onClose,
}: {
  open: boolean;
  stage: Stage;
  file: { name: string; size: number } | null;
  error: string | null;
  onClose: () => void;
}) {
  const order: Stage[] = ["reading", "extracting", "building"];
  const activeIndex = order.indexOf(stage);

  function stageClass(index: number): string {
    if (stage === "done") return "stage done";
    if (stage === "error") {
      // The stage that was running when it failed is the one that failed.
      return index === Math.max(0, activeIndex) ? "stage err" : index < activeIndex ? "stage done" : "stage";
    }
    if (index < activeIndex) return "stage done";
    if (index === activeIndex) return "stage active";
    return "stage";
  }

  return (
    <div
      className={`overlay${open ? " open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && (stage === "error" || stage === "done")) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Build knowledge graph">
        <h3>Build a knowledge graph</h3>
        <p className="mp">
          Edgify reads your document, finds its key concepts, and maps how they depend on each
          other for deep study.
        </p>
        <div className="file-row">
          <div className="file-ic">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path
                d="M6 3h8l5 5v11a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            {/* A filename is user-supplied and untrusted; React escapes it (.claude/rules/ui.md). */}
            <div className="fn">{file?.name ?? "document"}</div>
            <div className="fs">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : ""}</div>
          </div>
        </div>
        <div>
          {["Reading your document", "Finding key concepts & prerequisites", "Building the dependency graph"].map(
            (label, i) => (
              <div key={label} className={stageClass(i)}>
                <div className="stg-ic">
                  <div className="mspin" />
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                {label}
              </div>
            ),
          )}
        </div>
        {error && <div className="modal-err">{error}</div>}
        <div className="modal-foot">
          {(stage === "error" || stage === "done") && (
            <button className="btn-secondary" type="button" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <div className="modal-note">Runs live on your document. PDF/DOCX/TXT/MD supported.</div>
      </div>
    </div>
  );
}

function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4M12 4l-5 5M12 4l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 16V4M12 16l-4-4M12 16l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconCheckSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

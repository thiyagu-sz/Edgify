import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeConceptDetail, sanitizeGraph, type ConceptDetail } from "@/lib/ai/schemas";
import { installFakeGraphApi, type FakeGraph } from "@/test/fake-graph-api";
import {
  ATTRIBUTE_BREAKOUT_PAYLOADS,
  ALL_PAYLOADS_COMBINED,
  breakoutsFor,
  JSDOM_FIREABLE_PAYLOADS,
  assertNoExecutableDom,
  fireDeferredHandlers,
  flushDeferredHandlers,
  resetXssSentinel,
  xssFired,
} from "@/test/xss-payloads";
import { KnowledgeGraph } from "./knowledge-graph";

/**
 * PROOF 5 — model-supplied strings cannot execute script, on every surface of the graph.
 *
 * This is the highest-severity bug class in the project (.claude/rules/ui.md), and it is worse
 * here than in Quick Notes because graph content is SHARED. The realistic attack is not one
 * user's session: a lecture PDF carries injected text, the model echoes it, and then
 *
 *   - `generation_cache` is content-addressed on the document text, so the next student to upload
 *     the same PDF is served the byte-identical stored payload without a model call;
 *   - `cloneGraphByContentHash` copies concept names and summaries into their own rows.
 *
 * That is stored XSS with a distribution mechanism attached. So the proof covers the three
 * different rendering CONTEXTS the strings reach, because they fail differently:
 *
 *   1. SVG `<text>` — the node labels. Concept `name`.
 *   2. HTML/SVG ATTRIBUTES — `aria-label`, `data-*`, keys. Concept `name` and `slug`.
 *   3. `innerHTML` — the markdown detail body. `definition` and `example`.
 *
 * ── HOW THIS FILE IS STRUCTURED ─────────────────────────────────────────────────────────────
 *
 * The first describe block is a NEGATIVE CONTROL and it must FAIL to be useful — it renders the
 * prototype's own unescaped string-concatenation templates and requires the sentinel to fire in
 * each of the three contexts. Without it, "the sentinel did not fire" would be equally true of a
 * corpus of inert strings, of a driver that dispatches nothing, and of a component that renders
 * no model output at all. Everything after it is only meaningful because that block is green.
 *
 * The sentinel is `document.title`, not `window.__xss`: measured 2026-07-31, a payload's `window`
 * write does not cross jsdom's realm boundary, so the old sentinel could never fire. See
 * test/xss-payloads.ts.
 */

const POISON = ATTRIBUTE_BREAKOUT_PAYLOADS;

beforeEach(() => {
  resetXssSentinel();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Drain any handler still queued from this test before clearing, so an asynchronous payload
  // cannot detonate inside the NEXT test. See `flushDeferredHandlers`.
  await flushDeferredHandlers();
  resetXssSentinel();
});

/** Render a raw HTML string into the live document and drive the deferred handlers. */
function renderDirty(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  fireDeferredHandlers(host);
  return host;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. NEGATIVE CONTROLS — each context, unescaped, must execute
// ────────────────────────────────────────────────────────────────────────────

describe("NEGATIVE CONTROL — the three contexts are live when nothing escapes them", () => {
  describe("context 1: SVG <text> node label", () => {
    for (const { name, payload } of breakoutsFor("svg-text")) {
      it(`fires from an unescaped node label: ${name}`, async () => {
        // The prototype's `renderGraph` template (proto:1083–1087) with `escapeHtml` removed —
        // the exact regression a careless port produces.
        const host = renderDirty(
          `<svg class="graph" viewBox="0 0 760 200"><g class="nodes">` +
            `<g class="node-g" data-id="calc"><rect class="box" x="0" y="0" width="146" height="46"/>` +
            `<text class="lbl" x="73" y="24">${payload}</text></g></g></svg>`,
        );
        const fired = xssFired() ?? (await flushDeferredHandlers());
        host.remove();
        expect(
          fired,
          `the SVG-text control did not fire for "${name}" — this suite proves nothing`,
        ).not.toBeNull();
      });
    }
  });

  describe("context 2a: double-quoted HTML/SVG attribute", () => {
    for (const { name, payload } of breakoutsFor("attr-double")) {
      it(`fires from an unescaped attribute value: ${name}`, async () => {
        // `aria-label="${c.name}"` and `data-id="${id}"` — proto:1083. The slug is model output
        // too, and it lands in `data-*`.
        const host = renderDirty(
          `<svg viewBox="0 0 760 200"><g class="node-g" data-id="${payload}" ` +
            `aria-label="${payload}" tabindex="0" role="button">` +
            `<rect class="box" x="0" y="0" width="146" height="46"/></g></svg>`,
        );
        const fired = xssFired() ?? (await flushDeferredHandlers());
        host.remove();
        expect(
          fired,
          `the attribute-breakout control did not fire for "${name}" — this suite proves nothing`,
        ).not.toBeNull();
      });
    }
  });

  describe("context 2b: single-quoted attribute", () => {
    for (const { name, payload } of breakoutsFor("attr-single")) {
      it(`fires from an unescaped single-quoted attribute: ${name}`, async () => {
        const host = renderDirty(
          `<svg viewBox="0 0 760 200"><g class='node-g' data-id='${payload}'>` +
            `<rect class="box" x="0" y="0" width="146" height="46"/></g></svg>`,
        );
        const fired = xssFired() ?? (await flushDeferredHandlers());
        host.remove();
        expect(
          fired,
          `the single-quoted control did not fire for "${name}" — this suite proves nothing`,
        ).not.toBeNull();
      });
    }
  });

  describe("context 3: innerHTML markdown body", () => {
    for (const { name, payload } of JSDOM_FIREABLE_PAYLOADS) {
      it(`fires from an unsanitised detail body: ${name}`, async () => {
        // The panel's `.def` written straight to innerHTML with no sanitiser in front of it.
        const host = renderDirty(`<div class="panel"><div class="def">${payload}</div></div>`);
        const fired = xssFired() ?? (await flushDeferredHandlers());
        host.remove();
        expect(
          fired,
          `the innerHTML control did not fire for "${name}" — this suite proves nothing`,
        ).not.toBeNull();
      });
    }
  });

  it("all three contexts fire together, from one poisoned graph", async () => {
    const host = renderDirty(
      `<svg viewBox="0 0 760 200"><g class="node-g" aria-label="${POISON[0].payload}">` +
        `<text class="lbl">${POISON[3].payload}</text></g></svg>` +
        `<div class="def">${ALL_PAYLOADS_COMBINED}</div>`,
    );
    const fired = xssFired() ?? (await flushDeferredHandlers());
    host.remove();
    expect(fired, "the combined control did not fire").not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. THE SEAM — nothing dirty is ever stored, so nothing dirty is distributed
// ────────────────────────────────────────────────────────────────────────────

describe("the storage seam strips markup before it can be shared", () => {
  it("strips it from the graph structure, which the clone copies verbatim", async () => {
    const structure = sanitizeGraph({
      title: `Topic ${POISON[0].payload}`,
      concepts: [
        { slug: `calc${POISON[1].payload}`, name: `Calculus ${POISON[0].payload}`, difficulty: "Foundational", summary: `S ${POISON[2].payload}` },
        { slug: "opt", name: "Optimisation", difficulty: "Intermediate", summary: "" },
        { slug: "gd", name: "Gradient descent", difficulty: "Advanced", summary: "" },
      ],
      edges: [{ prerequisite: `calc${POISON[1].payload}`, dependent: "opt" }],
    });

    // What `cloneGraphByContentHash` would copy into a second user's rows.
    for (const concept of structure!.concepts) {
      const host = renderDirty(
        `<svg><g aria-label="${concept.name}" data-id="${concept.slug}">` +
          `<text>${concept.name}</text></g></svg><div>${concept.summary}</div>`,
      );
      host.remove();
    }
    expect(await flushDeferredHandlers(), "a cloned concept string executed").toBeNull();
    // The edge still resolves — sanitising the slug must not silently disconnect the graph.
    expect(structure!.edges).toHaveLength(1);
  });

  it("strips it from the detail body, which the content-addressed cache serves to everyone", async () => {
    const detail = sanitizeConceptDetail({
      definition: `A gradient ${ALL_PAYLOADS_COMBINED}`,
      example: ALL_PAYLOADS_COMBINED,
      quiz: { q: POISON[0].payload, options: [POISON[1].payload, "b"], answer: 0, explanation: POISON[2].payload },
      flashcards: [{ front: POISON[3].payload, back: POISON[4].payload }],
    });

    // Exactly what a second user with the same document is handed from `generation_cache`.
    const host = renderDirty(
      `<div class="def">${detail!.definition}</div><div class="example">${detail!.example}</div>` +
        `<div>${detail!.quiz!.q}${detail!.quiz!.options.join("")}${detail!.quiz!.explanation}</div>` +
        `<div>${detail!.flashcards.map((c) => c.front + c.back).join("")}</div>`,
    );
    host.remove();

    expect(
      await flushDeferredHandlers(),
      "a cached detail string executed for the second user",
    ).toBeNull();
    expect(() => assertNoExecutableDom(document.body)).not.toThrow();
    expect(detail!.definition).toContain("A gradient");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. THE REAL COMPONENT — every surface, poisoned, contained
// ────────────────────────────────────────────────────────────────────────────

/** A graph whose every model-authored string carries a payload. */
function poisonedGraph(): FakeGraph {
  return {
    title: `Topic ${POISON[0].payload}`,
    concepts: [
      {
        id: "c1",
        slug: `calc-${POISON[1].payload}`,
        name: `Calculus ${POISON[0].payload}`,
        difficulty: "Foundational",
        summary: `Summary ${POISON[2].payload}`,
        layoutX: 24,
        layoutY: 114,
      },
      {
        id: "c2",
        slug: "opt",
        name: `Optimisation ${POISON[3].payload}`,
        difficulty: "Intermediate",
        summary: `Summary ${POISON[4].payload}`,
        layoutX: 24,
        layoutY: 20,
      },
      {
        id: "c3",
        slug: "gd",
        name: `Gradient descent ${POISON[4].payload}`,
        difficulty: "Advanced",
        summary: "Third",
        layoutX: 194,
        layoutY: 20,
      },
    ],
    edges: [
      { prerequisite: `calc-${POISON[1].payload}`, dependent: "opt" },
      { prerequisite: `calc-${POISON[1].payload}`, dependent: "gd" },
    ],
  };
}

/** A detail whose every field carries a payload — including the markdown body. */
function poisonedDetail(): ConceptDetail {
  return {
    definition: `A definition. ${ALL_PAYLOADS_COMBINED}`,
    example: `An example. ${ALL_PAYLOADS_COMBINED}`,
    quiz: {
      q: `Which ${POISON[0].payload}?`,
      options: [`A ${POISON[1].payload}`, `B ${POISON[2].payload}`],
      answer: 0,
      explanation: `Because ${POISON[3].payload}`,
    },
    flashcards: [{ front: `Front ${POISON[4].payload}`, back: `Back ${POISON[0].payload}` }],
  };
}

async function expectContained(): Promise<void> {
  fireDeferredHandlers(document.body);
  expect(await flushDeferredHandlers(), "injected script executed in the rendered graph").toBeNull();
  expect(() => assertNoExecutableDom(document.body)).not.toThrow();
}

async function renderGraph(detail: ConceptDetail = poisonedDetail()) {
  const api = installFakeGraphApi({
    graph: { status: "ready", graph: poisonedGraph() },
    detail: { status: "ready", detail },
  });
  const user = userEvent.setup();
  render(<KnowledgeGraph initialGraphId="g1" />);
  await waitFor(() => {
    expect(document.querySelector("svg.graph")).toBeTruthy();
  });
  return { api, user };
}

describe("the rendered graph contains every payload", () => {
  it("SVG node labels and their attributes (contexts 1 and 2)", async () => {
    await renderGraph();

    // The labels rendered, so this is not passing by rendering nothing.
    const labels = document.querySelectorAll("svg.graph text.lbl");
    expect(labels).toHaveLength(3);
    expect(labels[0].textContent).toContain("Calculus");

    // ...and the payload is inside the text node rather than parsed as markup beside it.
    expect(document.querySelector("svg.graph image")).toBeNull();
    expect(document.querySelector("svg.graph script")).toBeNull();
    await expectContained();
  });

  it("the markdown detail body (context 3)", async () => {
    await renderGraph();
    await waitFor(() => {
      expect(document.querySelector(".panel .def")).toBeTruthy();
    });
    // The body rendered and kept its legitimate content.
    expect(document.querySelector(".panel .def")?.textContent).toContain("A definition.");
    await expectContained();
  });

  it("the panel quiz and its explanation", async () => {
    const { user } = await renderGraph();
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());

    await user.click(screen.getByRole("tab", { name: "Quiz" }));
    await waitFor(() => expect(document.querySelector(".q-opt")).toBeTruthy());
    await expectContained();

    await user.click(document.querySelectorAll(".q-opt")[0] as HTMLButtonElement);
    await waitFor(() => expect(document.querySelector(".q-fb")).toBeTruthy());
    await expectContained();
  });

  it("the flashcards, front and back", async () => {
    const { user } = await renderGraph();
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());

    await user.click(screen.getByRole("tab", { name: "Cards" }));
    await waitFor(() => expect(document.querySelector(".flash")).toBeTruthy());
    expect(document.querySelector(".flash-front .ft")?.textContent).toContain("Front");
    expect(document.querySelector(".flash-back .bt")?.textContent).toContain("Back");
    await expectContained();
  });

  it("the concept library", async () => {
    const { user } = await renderGraph();
    await user.click(screen.getByRole("tab", { name: "Concepts" }));
    await waitFor(() => expect(document.querySelector(".cc")).toBeTruthy());
    expect(document.querySelectorAll(".cc")).toHaveLength(3);
    await expectContained();
  });

  it("the study plan", async () => {
    const { user } = await renderGraph();
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
    // Select a concept that HAS prerequisites, so the plan renders steps rather than the
    // foundational empty state.
    await user.click(document.querySelectorAll(".node-g")[0] as unknown as Element);
    await user.click(screen.getByRole("tab", { name: "Study plan" }));
    await waitFor(() => expect(document.querySelector(".plan")).toBeTruthy());
    await expectContained();
  });

  it("the prerequisite and related chips", async () => {
    const { user } = await renderGraph();
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
    // Click a dependent node so the panel shows its prerequisite chips.
    const nodes = document.querySelectorAll(".node-g");
    await user.click(nodes[1] as unknown as Element);
    await waitFor(() => expect(document.querySelector(".chip")).toBeTruthy());
    await expectContained();
  });

  it("stays contained when the detail is unavailable and the summary is shown instead", async () => {
    installFakeGraphApi({
      graph: { status: "ready", graph: poisonedGraph() },
      detail: { status: "unavailable", summary: `Fallback ${ALL_PAYLOADS_COMBINED}` },
    });
    render(<KnowledgeGraph initialGraphId="g1" />);
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
    expect(screen.getByText(/A detailed explanation couldn't be generated/)).toBeVisible();
    await expectContained();
  });

  it("stays contained on the failed-build and busy states", async () => {
    installFakeGraphApi({ graph: { status: "failed" } });
    render(<KnowledgeGraph initialGraphId="g1" />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't map this document's structure/)).toBeVisible(),
    );
    await expectContained();
  });
});

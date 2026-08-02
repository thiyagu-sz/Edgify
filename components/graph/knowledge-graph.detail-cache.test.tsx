import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeGraphApi, type FakeGraph } from "@/test/fake-graph-api";
import { KnowledgeGraph } from "./knowledge-graph";

/**
 * "Clicking a concept generates detail once and caches it" (docs/06 Phase 5, W5).
 *
 * The only way to prove this is to COUNT the requests the component makes — a test that merely
 * asserts the panel renders would pass just as well against a component that re-fetches on every
 * render, which is the actual failure mode (and an expensive one: each re-fetch is a model call
 * unless the server's stored detail catches it).
 *
 * Three separate mechanisms have to hold, and each is checked here:
 *   1. the in-memory cache, for a revisit within the session,
 *   2. the in-flight guard, for two renders in the same tick,
 *   3. the server's stored `detailJson`, for a reload — covered in the route/service, and
 *      represented here by the fact that the client asks at most once per concept.
 */

const GRAPH: FakeGraph = {
  title: "Machine learning",
  concepts: [
    { id: "c1", slug: "calc", name: "Calculus", difficulty: "Foundational", layoutX: 24, layoutY: 114 },
    { id: "c2", slug: "opt", name: "Optimisation", difficulty: "Intermediate", layoutX: 24, layoutY: 20 },
    { id: "c3", slug: "gd", name: "Gradient descent", difficulty: "Advanced", layoutX: 194, layoutY: 20 },
  ],
  edges: [
    { prerequisite: "calc", dependent: "opt" },
    { prerequisite: "calc", dependent: "gd" },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function mounted() {
  const api = installFakeGraphApi({ graph: { status: "ready", graph: GRAPH } });
  const user = userEvent.setup();
  render(<KnowledgeGraph initialGraphId="g1" />);
  await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
  return { api, user };
}

/** The node `<g>` elements, in render order. */
function nodes(): Element[] {
  return [...document.querySelectorAll(".node-g")];
}

describe("concept detail is fetched once per concept", () => {
  it("fetches the opening concept exactly once", async () => {
    const { api } = await mounted();
    expect(api.detailCalls).toEqual(["c1"]);
  });

  it("does not re-fetch when the same concept is selected again", async () => {
    const { api, user } = await mounted();
    expect(api.detailCalls).toEqual(["c1"]);

    // Away...
    await user.click(nodes()[1]);
    await waitFor(() => expect(api.detailCalls).toEqual(["c1", "c2"]));

    // ...and back. This is the assertion that matters.
    await user.click(nodes()[0]);
    // The panel title, not `getByText` — the concept name also appears in the SVG node label and
    // in the chips, so a document-wide text query matches several elements.
    await waitFor(() => expect(document.querySelector(".p-title")?.textContent).toBe("Calculus"));
    expect(api.detailCalls, "revisiting a concept re-generated its detail").toEqual(["c1", "c2"]);
  });

  it("fetches each concept once across a full tour of the graph", async () => {
    const { api, user } = await mounted();
    for (const node of nodes()) await user.click(node);
    for (const node of [...nodes()].reverse()) await user.click(node);

    await waitFor(() => expect(api.detailCalls).toHaveLength(3));
    expect([...api.detailCalls].sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("survives a round trip through the other views without re-fetching", async () => {
    const { api, user } = await mounted();
    await user.click(nodes()[1]);
    await waitFor(() => expect(api.detailCalls).toEqual(["c1", "c2"]));

    await user.click(screen.getByRole("tab", { name: "Concepts" }));
    await waitFor(() => expect(document.querySelector(".cc")).toBeTruthy());
    await user.click(screen.getByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(document.querySelector("svg.graph")).toBeTruthy());

    expect(api.detailCalls).toEqual(["c1", "c2"]);
  });

  it("does not fetch twice when the same concept is clicked rapidly", async () => {
    // The in-flight guard: two clicks in the same tick must produce one request.
    const { api, user } = await mounted();
    const target = nodes()[2];
    await Promise.all([user.click(target), user.click(target), user.click(target)]);
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
    expect(api.detailCalls.filter((id) => id === "c3")).toHaveLength(1);
  });

  it("caches the unavailable outcome too, rather than retrying the ladder on every visit", async () => {
    // A concept whose generation failed must not re-walk the ladder every time the user looks at
    // it — that is the expensive failure mode, and the panel shows the summary either way (W5).
    const api = installFakeGraphApi({
      graph: { status: "ready", graph: GRAPH },
      detail: { status: "unavailable", summary: "The stored summary." },
    });
    const user = userEvent.setup();
    render(<KnowledgeGraph initialGraphId="g1" />);
    await waitFor(() =>
      expect(screen.getByText(/A detailed explanation couldn't be generated/)).toBeVisible(),
    );

    await user.click(nodes()[1]);
    await waitFor(() => expect(api.detailCalls).toEqual(["c1", "c2"]));
    await user.click(nodes()[0]);
    await waitFor(() => expect(document.querySelector(".p-title")?.textContent).toBe("Calculus"));

    expect(api.detailCalls).toEqual(["c1", "c2"]);
  });

  it("falls back to the concept's own summary when the detail is unavailable", async () => {
    installFakeGraphApi({
      graph: {
        status: "ready",
        graph: {
          ...GRAPH,
          concepts: GRAPH.concepts.map((c) => ({ ...c, summary: `Summary of ${c.name}` })),
        },
      },
      detail: { status: "unavailable", summary: "Summary of Calculus" },
    });
    render(<KnowledgeGraph initialGraphId="g1" />);
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
    // W5: the summary WAS derived from the user's own document during the structure pass, so it
    // is the only honest content available. Never a demo detail.
    expect(document.querySelector(".panel .def")?.textContent).toContain("Summary of Calculus");
    expect(screen.getByText(/A detailed explanation couldn't be generated/)).toBeVisible();
  });
});

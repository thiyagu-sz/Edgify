import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prerequisiteMap, readiness } from "@/lib/graph/readiness";
import { installFakeGraphApi, type FakeGraph } from "@/test/fake-graph-api";
import { KnowledgeGraph } from "./knowledge-graph";

/**
 * "Marking mastery updates readiness across the graph" (docs/06 Phase 5, W6).
 *
 * The load-bearing word is ACROSS. Marking a concept mastered must change the readiness of every
 * concept downstream of it, not just its own badge — that is the whole point of a dependency
 * graph, and the thing a naive implementation (recolour the clicked node, leave the rest) gets
 * wrong while looking correct on screen.
 *
 * The expected numbers come from `lib/graph/readiness.ts`, which is itself pinned against the
 * prototype's own JavaScript in `readiness.test.ts`. So this file checks the UI applies the
 * algorithm; that file checks the algorithm is the prototype's.
 */

/**
 * A deliberately layered graph, so a change at the bottom has somewhere to propagate to:
 *
 *     gd            (depth 2 from calc, via opt)
 *      ↑
 *     opt           (depth 1 from calc)
 *      ↑
 *     calc          (foundational)
 */
const GRAPH: FakeGraph = {
  title: "Machine learning",
  concepts: [
    { id: "c1", slug: "calc", name: "Calculus", difficulty: "Foundational", estimatedMinutes: 120, layoutX: 24, layoutY: 208 },
    { id: "c2", slug: "opt", name: "Optimisation", difficulty: "Intermediate", estimatedMinutes: 150, layoutX: 24, layoutY: 114 },
    { id: "c3", slug: "gd", name: "Gradient descent", difficulty: "Advanced", estimatedMinutes: 180, layoutX: 24, layoutY: 20 },
  ],
  edges: [
    { prerequisite: "calc", dependent: "opt" },
    { prerequisite: "opt", dependent: "gd" },
  ],
};

const CONCEPTS = GRAPH.concepts.map((c) => ({
  slug: c.slug,
  name: c.name,
  difficulty: c.difficulty ?? "Intermediate",
  summary: "",
  estimatedMinutes: c.estimatedMinutes ?? 0,
}));
const PREREQS = prerequisiteMap(CONCEPTS, GRAPH.edges);

afterEach(() => {
  vi.restoreAllMocks();
});

function nodeFor(slug: string): Element {
  const index = GRAPH.concepts.findIndex((c) => c.slug === slug);
  return document.querySelectorAll(".node-g")[index];
}

function ringPercent(): string {
  return document.querySelector(".ring .pct")?.textContent ?? "";
}

async function mounted(mastery: FakeGraph["mastery"] = []) {
  const api = installFakeGraphApi({
    graph: { status: "ready", graph: { ...GRAPH, mastery } },
  });
  const user = userEvent.setup();
  render(<KnowledgeGraph initialGraphId="g1" />);
  await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
  return { api, user };
}

describe("mastery updates readiness across the graph", () => {
  it("opens on the foundational concept, which is always 100% ready", async () => {
    await mounted();
    expect(document.querySelector(".p-title")?.textContent).toBe("Calculus");
    // Nothing stands between the student and a concept with no prerequisites.
    expect(ringPercent()).toBe("100%");
  });

  it("shows the readiness the algorithm computes, for a concept two layers up", async () => {
    const { user } = await mounted();
    await user.click(nodeFor("gd"));
    await waitFor(() => expect(document.querySelector(".p-title")?.textContent).toBe("Gradient descent"));

    const expected = readiness("gd", PREREQS, new Map());
    // opt at depth 1 (weight 1) and calc at depth 2 (weight 0.5), both locked → 0%.
    expect(expected).toBe(0);
    expect(ringPercent()).toBe(`${expected}%`);
  });

  it("marking a FOUNDATIONAL concept raises readiness two layers above it", async () => {
    const { user } = await mounted();

    // Mark calculus mastered...
    await user.click(screen.getByRole("button", { name: /mark as mastered/i }));
    await waitFor(() => expect(nodeFor("calc").getAttribute("class")).toContain("n-known"));

    // ...then look at the concept two layers up. Its ring must have moved.
    await user.click(nodeFor("gd"));
    await waitFor(() => expect(document.querySelector(".p-title")?.textContent).toBe("Gradient descent"));

    const expected = readiness("gd", PREREQS, new Map([["calc", "known"]]));
    // calc contributes weight 1/2 out of (1 + 1/2) → 33%.
    expect(expected).toBe(33);
    expect(ringPercent(), "readiness did not propagate to the dependent concept").toBe(
      `${expected}%`,
    );
  });

  it("recolours every affected node, not just the one that was clicked", async () => {
    const { user } = await mounted();
    expect(nodeFor("calc").getAttribute("class")).toContain("n-locked");

    await user.click(screen.getByRole("button", { name: /mark as mastered/i }));

    await waitFor(() => expect(nodeFor("calc").getAttribute("class")).toContain("n-known"));
    // The others are untouched — mastery is per concept; readiness is what propagates.
    expect(nodeFor("opt").getAttribute("class")).toContain("n-locked");
    expect(nodeFor("gd").getAttribute("class")).toContain("n-locked");
  });

  it("persists the change, keyed on the concept id", async () => {
    const { api, user } = await mounted();
    await user.click(screen.getByRole("button", { name: /mark as mastered/i }));
    await waitFor(() => expect(api.masteryCalls).toHaveLength(1));
    expect(api.masteryCalls[0]).toEqual({ conceptId: "c1", state: "known" });
  });

  it("toggles back off, and says so", async () => {
    const { api, user } = await mounted();
    await user.click(screen.getByRole("button", { name: /mark as mastered/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Mastered$/ })).toBeVisible());

    await user.click(screen.getByRole("button", { name: /^Mastered$/ }));
    await waitFor(() => expect(api.masteryCalls).toHaveLength(2));
    expect(api.masteryCalls[1]).toEqual({ conceptId: "c1", state: "locked" });
    expect(nodeFor("calc").getAttribute("class")).toContain("n-locked");
  });

  it("renders mastery that arrived with the graph, without a second round trip", async () => {
    // The reason `GET /api/graph/:id` carries mastery: otherwise the first paint is an all-locked
    // graph that then recolours.
    const { api } = await mounted([
      { slug: "calc", state: "known" },
      { slug: "opt", state: "learning" },
    ]);
    expect(nodeFor("calc").getAttribute("class")).toContain("n-known");
    expect(nodeFor("opt").getAttribute("class")).toContain("n-learning");
    expect(api.masteryCalls).toHaveLength(0);
  });

  it("shows the in-progress pip on a learning node (the prototype's `prq-dot`)", async () => {
    await mounted([{ slug: "opt", state: "learning" }]);
    expect(nodeFor("opt").querySelector(".prq-dot")).toBeTruthy();
    expect(nodeFor("calc").querySelector(".prq-dot")).toBeNull();
  });

  it("promotes a locked concept to in-progress when its check question is answered correctly", async () => {
    const { api, user } = await mounted();
    await user.click(screen.getByRole("tab", { name: "Quiz" }));
    await waitFor(() => expect(document.querySelector(".q-opt")).toBeTruthy());

    // The fake's default detail has answer index 0.
    await user.click(document.querySelectorAll(".q-opt")[0] as HTMLButtonElement);

    await waitFor(() => expect(api.masteryCalls).toHaveLength(1));
    expect(api.masteryCalls[0]).toEqual({ conceptId: "c1", state: "learning" });
    expect(nodeFor("calc").getAttribute("class")).toContain("n-learning");
  });

  it("does not demote a mastered concept when its quiz is answered", async () => {
    const { api, user } = await mounted([{ slug: "calc", state: "known" }]);
    await user.click(screen.getByRole("tab", { name: "Quiz" }));
    await waitFor(() => expect(document.querySelector(".q-opt")).toBeTruthy());
    await user.click(document.querySelectorAll(".q-opt")[0] as HTMLButtonElement);

    expect(api.masteryCalls).toHaveLength(0);
    expect(nodeFor("calc").getAttribute("class")).toContain("n-known");
  });

  it("updates the study plan and the concept library from the same state", async () => {
    const { user } = await mounted();
    await user.click(nodeFor("gd"));
    await waitFor(() => expect(document.querySelector(".p-title")?.textContent).toBe("Gradient descent"));

    await user.click(screen.getByRole("tab", { name: "Study plan" }));
    await waitFor(() => expect(document.querySelector(".plan")).toBeTruthy());
    // Two prerequisites outstanding, deepest first: calc (depth 2) then opt (depth 1).
    const steps = [...document.querySelectorAll(".step .sn")].map((el) => el.textContent);
    expect(steps).toEqual(["Calculus", "Optimisation"]);
    expect(document.querySelector(".plan-stats .v")?.textContent).toBe("0/2");

    // The concept library ranks by readiness, so the foundational concept leads.
    await user.click(screen.getByRole("tab", { name: "Concepts" }));
    await waitFor(() => expect(document.querySelector(".cc")).toBeTruthy());
    expect(document.querySelector(".cc .cc-name")?.textContent).toBe("Calculus");
    expect(document.querySelector(".cc .cc-r")?.textContent).toBe("100%");
  });
});

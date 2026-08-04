import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoGraphTransport, demoGraphView } from "@/components/graph/demo-transport";
import { KnowledgeGraph, liveGraphTransport } from "@/components/graph/knowledge-graph";
import { DemoWorkspace } from "./demo-workspace";

/**
 * PROOF (docs/06 Phase 6): **demo content is never written to any user's records.**
 *
 * The claim is not "the demo currently avoids the write routes" — that is a statement about which
 * branches happen to run today, and it decays the moment someone adds a feature. The claim is
 * that the demo has no means to reach the network at all: `demoGraphTransport` closes over frozen
 * data and neither it nor anything it imports contains a `fetch`.
 *
 * So this file counts calls at the one boundary every write must cross. `fetch` is replaced with
 * a spy that FAILS if invoked, the demo is driven through everything a visitor can do, and the
 * count must be zero.
 *
 * THE CONTROL IS THE POINT. A zero-call assertion passes just as happily against a component that
 * renders nothing, a selector that matches nothing, or an interaction that silently no-ops — the
 * exact failure this project has hit before (Phase 4's XSS sentinel could never fire; the PDF
 * "contains" assertions passed over garbled output). So every containment test below is paired
 * with the SAME interactions driven through `liveGraphTransport`, which MUST call `fetch` with
 * the write routes. If a control stops firing, the containment beside it has stopped meaning
 * anything, and the suite says so rather than going quietly green.
 */

const GRAPH = demoGraphView();

/** Records every fetch attempt instead of performing one. Nothing here should ever call it. */
function spyOnFetch() {
  const calls: { url: string; method: string }[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input),
      method: (init?.method ?? "GET").toUpperCase(),
    });
    return new Response(JSON.stringify({ status: "unavailable" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return calls;
}

const writeCalls = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method !== "GET");

/**
 * The full interactive surface of the graph: select concepts, read details, mark mastery.
 *
 * Every step ASSERTS it found its target rather than skipping when it does not. The first draft
 * of this helper looked for the mastery button as `.m-btn.known` — a class that does not exist
 * anywhere in concept-panel.tsx, where the real control is a `btn-primary` reading "Mark as
 * mastered". It silently clicked nothing, so mastery was never exercised, and BOTH the
 * containment test and its control still passed: the control fired on the concept-detail POSTs
 * alone and reported healthy. A control that fires for the wrong reason is worse than none.
 */
async function driveTheGraph(user: ReturnType<typeof userEvent.setup>) {
  const nodes = document.querySelectorAll(".node-g");
  expect(nodes.length).toBeGreaterThan(2); // guards against driving an empty render

  // Visit three concepts, which is what triggers per-concept detail loads.
  for (const index of [1, 2, 0]) {
    await user.click(nodes[index]);
    await waitFor(() => expect(document.querySelector(".panel .def")).toBeTruthy());
  }

  // Mark mastery — the one interaction that writes in the live workspace.
  const markMastered = screen.getByRole("button", { name: /mark as mastered/i });
  await user.click(markMastered);
  // The optimistic local update is what proves the click landed; without it the write path
  // downstream was never reached and the fetch counts below mean nothing.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^mastered$/i })).toBeTruthy(),
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the demo transport cannot reach the network", () => {
  it("has no fetch anywhere in its own source", async () => {
    // Structural, not behavioural: the guarantee is about capability, so read the module.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "components/graph/demo-transport.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon|WebSocket|EventSource/);
  });

  it("drives the whole graph demo without a single request", async () => {
    const calls = spyOnFetch();
    const user = userEvent.setup();
    render(
      <KnowledgeGraph initialGraphId={null} initialGraph={GRAPH} transport={demoGraphTransport} />,
    );
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    await driveTheGraph(user);

    expect(calls).toEqual([]);
  });

  it("CONTROL — the same interactions on the live transport DO write", async () => {
    const calls = spyOnFetch();
    const user = userEvent.setup();
    render(
      <KnowledgeGraph initialGraphId={null} initialGraph={GRAPH} transport={liveGraphTransport} />,
    );
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    await driveTheGraph(user);

    // If any of these reads zero, the containment test above proves nothing — the interactions
    // stopped exercising the code that writes, and both tests are passing vacuously.
    expect(writeCalls(calls).length).toBeGreaterThan(0);
    // Named individually, because "some write happened" would stay green if only one of the two
    // write paths were still being reached — which is exactly how the mastery gap hid before.
    expect(calls.some((c) => c.url.includes("/api/concepts/") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/api/mastery") && c.method === "POST")).toBe(true);
  });

  it("offers no upload control, so there is no route to POST /api/documents", async () => {
    spyOnFetch();
    render(
      <KnowledgeGraph initialGraphId={null} initialGraph={GRAPH} transport={demoGraphTransport} />,
    );
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /upload document/i })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("CONTROL — the live transport DOES offer the upload control", async () => {
    spyOnFetch();
    render(
      <KnowledgeGraph initialGraphId={null} initialGraph={GRAPH} transport={liveGraphTransport} />,
    );
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    expect(screen.queryByRole("button", { name: /upload document/i })).not.toBeNull();
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe("the /demo workspace as a whole", () => {
  it("renders both features and labels itself as a demo, with no requests", async () => {
    const calls = spyOnFetch();
    const user = userEvent.setup();
    render(<DemoWorkspace />);

    // Labelled, always — .claude/rules/ui.md forbids silent substitution.
    const banner = document.querySelector(".notice-banner");
    expect(banner?.textContent).toMatch(/this is a demo/i);
    expect(banner?.textContent).toMatch(/nothing here is saved/i);

    // The graph is the default view.
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    // Switch to Quick Notes and exercise the format chips.
    await user.click(screen.getByRole("tab", { name: /quick notes/i }));
    const chips = document.querySelectorAll(".format-chips .fmt");
    expect(chips.length).toBeGreaterThan(1);
    await user.click(chips[1]);
    await user.click(chips[2]);
    expect(document.querySelector(".qn-output")?.textContent).toBeTruthy();

    // Back to the graph, which must still be there.
    await user.click(screen.getByRole("tab", { name: /knowledge graph/i }));
    await waitFor(() => expect(document.querySelector(".node-g")).toBeTruthy());

    expect(calls).toEqual([]);
  });

  it("the brand returns to the landing page", () => {
    spyOnFetch();
    render(<DemoWorkspace />);
    const brand = screen.getByRole("link", { name: /edgify — home/i });
    expect(brand.getAttribute("href")).toBe("/");
  });

  it("every concept resolves a real explanation, so the zero-call result is not an empty render", async () => {
    // Without this, "no fetch happened" would also be true of a demo that shows nothing.
    for (const concept of GRAPH.concepts) {
      const state = await demoGraphTransport.loadDetail(concept);
      expect(state.kind).toBe("ready");
      if (state.kind !== "ready") continue;
      expect(state.detail.definition.length).toBeGreaterThan(20);
      expect(state.detail.flashcards.length).toBeGreaterThan(0);
      expect(state.detail.quiz).not.toBeNull();
    }
  });
});

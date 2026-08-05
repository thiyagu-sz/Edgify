import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeGraphApi, type FakeGraph } from "@/test/fake-graph-api";
import { KnowledgeGraph } from "./knowledge-graph";

/**
 * The build poll (W4) — and specifically its CADENCE, which is not a UI detail.
 *
 * `GET /api/graph/:id` allows 600 requests per minute per IP. A campus NAT puts a whole class
 * behind one address, so the number of concurrent builders that budget covers is decided entirely
 * by how fast this component polls:
 *
 *     flat 1.5s   → ~40 req/min per builder → ~15 concurrent → a class of 30 gets 429s
 *     1.5s / 3s   → ~23 req/min per builder → ~26 concurrent
 *
 * docs/06 records the backoff as "part of this limit, not optional polish". A test that only
 * asserted "the graph eventually appears" would pass against a flat 1.5s poll and the coupling
 * would be lost the first time someone simplified the loop — so the cadence is measured.
 */

const GRAPH: FakeGraph = {
  title: "Machine learning",
  concepts: [
    { id: "c1", slug: "calc", name: "Calculus", layoutX: 24, layoutY: 20 },
    { id: "c2", slug: "opt", name: "Optimisation", layoutX: 194, layoutY: 20 },
    { id: "c3", slug: "gd", name: "Gradient descent", layoutX: 364, layoutY: 20 },
  ],
  edges: [{ prerequisite: "calc", dependent: "opt" }],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("poll cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("polls at 1.5s for the first 15 seconds, then backs off to 3s", async () => {
    const api = installFakeGraphApi({ graph: { status: "processing" } });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(15_000);
    const fastWindow = api.graphReads;

    await vi.advanceTimersByTimeAsync(30_000);
    const afterBackoff = api.graphReads - fastWindow;

    // ~10 polls in the fast window (15s ÷ 1.5s), plus the immediate first read.
    expect(fastWindow).toBeGreaterThanOrEqual(10);
    expect(fastWindow).toBeLessThanOrEqual(12);

    // ~10 polls in the next 30s (30s ÷ 3s) — half the rate. If the backoff were missing this
    // would be ~20, and the route's 600/min budget would cover half as many students.
    expect(afterBackoff).toBeGreaterThanOrEqual(9);
    expect(afterBackoff).toBeLessThanOrEqual(11);
  });

  it("costs under 40 requests over the full 90-second window", async () => {
    // The arithmetic docs/06 relies on: ~23 req/min sustained rather than ~40.
    const api = installFakeGraphApi({ graph: { status: "processing" } });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.graphReads, "the poll is costing more than one request per 1.5s").toBeLessThan(40);
  });

  it("shows the busy state after 90 seconds rather than spinning forever", async () => {
    installFakeGraphApi({ graph: { status: "processing" } });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();

    await vi.advanceTimersByTimeAsync(65_000);
    expect(screen.getByText(/taking longer than usual/)).toBeVisible();
    expect(screen.getByText(/Server is busy, please try again in a moment/)).toBeVisible();
  });

  it("stops polling once the graph is ready", async () => {
    const api = installFakeGraphApi({
      graph: [{ status: "processing" }, { status: "processing" }, { status: "ready", graph: GRAPH }],
    });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(10_000);
    const settled = api.graphReads;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(document.querySelector("svg.graph")).toBeTruthy();
    expect(api.graphReads, "the poll kept running after the graph resolved").toBe(settled);
  });

  it("keeps polling through a dropped request rather than calling the build failed", async () => {
    const api = installFakeGraphApi({
      graph: [{ status: "network-error" }, { status: "processing" }, { status: "ready", graph: GRAPH }],
    });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(document.querySelector("svg.graph")).toBeTruthy();
    expect(api.graphReads).toBeGreaterThan(1);
  });

  it("stops on a failed build and shows the W4 message", async () => {
    const api = installFakeGraphApi({ graph: { status: "failed" } });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(screen.getByText(/Couldn't map this document's structure/)).toBeVisible();
    const settled = api.graphReads;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.graphReads).toBe(settled);
  });
});

describe("the timeout's retry does not re-spend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /**
   * "Keep waiting" resumes POLLING only, and never re-fires the build.
   *
   * REVISITED 2026-08-05, as this comment previously instructed, when `ZOMBIE-PROCESSING-ROW` was
   * fixed (docs/09 §1.6). The original reason has gone: a build killed by the platform no longer
   * leaves its row `processing` forever, so a re-fire can no longer double-spend on a zombie.
   *
   * The test is KEPT because the behaviour it guards is still correct, on a different argument.
   * Polling is now what SURFACES the outcome — the reaper retires an abandoned build on this very
   * request — so re-firing would add spend-shaped risk to a button whose whole job is to wait. The
   * assertion below is unchanged; only its justification is.
   */
  it("resumes polling without firing another build", async () => {
    const api = installFakeGraphApi({ graph: { status: "processing" } });
    render(<KnowledgeGraph initialGraphId="g1" />);

    await vi.advanceTimersByTimeAsync(95_000);
    expect(screen.getByText(/taking longer than usual/)).toBeVisible();
    const before = api.graphReads;

    // `fireEvent`, not `userEvent`: userEvent schedules its own timers, and under fake timers it
    // deadlocks waiting for a clock only `advanceTimersByTimeAsync` moves.
    fireEvent.click(screen.getByRole("button", { name: /keep waiting/i }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(api.graphReads, "polling did not resume").toBeGreaterThan(before);
    expect(api.buildFires, "the retry re-fired the build, which can double-spend").toBe(0);
  });
});

describe("upload", () => {
  it("fires the build once, then polls — and skips the build entirely on a clone", async () => {
    // The clone path (W4 step 8): the server answers `ready` because another user already built
    // this exact content, so there is nothing to build and nothing to spend.
    const api = installFakeGraphApi({
      graph: { status: "ready", graph: GRAPH },
      upload: { graphId: "g-clone", status: "ready" },
    });
    const user = userEvent.setup();
    const { container } = render(<KnowledgeGraph initialGraphId={null} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["hello world"], "lecture.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(document.querySelector("svg.graph")).toBeTruthy());
    expect(api.buildFires, "a cloned graph triggered a build anyway").toBe(0);
  });

  it("fires the build exactly once on a real upload", async () => {
    const api = installFakeGraphApi({
      // One read, answering `ready`: the build has been fired by then, which is what is measured.
      // A `processing` first read would need the 1.5s poll gap, and this block runs on real timers.
      graph: { status: "ready", graph: GRAPH },
      upload: { graphId: "g-new", status: "processing" },
    });
    const user = userEvent.setup();
    const { container } = render(<KnowledgeGraph initialGraphId={null} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["hello world"], "lecture.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(document.querySelector("svg.graph")).toBeTruthy());
    expect(api.buildFires).toBe(1);
  });

  it("shows the upload failure message and offers a way out", async () => {
    installFakeGraphApi({
      graph: { status: "ready", graph: GRAPH },
      upload: { message: "That file is over the 10 MB limit. Try a smaller file, or paste the text directly." },
    });
    const user = userEvent.setup();
    const { container } = render(<KnowledgeGraph initialGraphId={null} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(["x"], "huge.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(screen.getByText(/over the 10 MB limit/)).toBeVisible());
    // Every catalogue message carries its own next action; the modal must be dismissible.
    expect(screen.getByRole("button", { name: /close/i })).toBeVisible();
  });
});

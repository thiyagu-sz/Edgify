import { describe, expect, it } from "vitest";
import { sanitizeQuiz } from "../ai/schemas";
import { DEMO_GRAPH, demoContentFor } from "./index";

describe("demoContentFor", () => {
  it("returns a markdown string for a markdown notes format", () => {
    const out = demoContentFor({ operation: "quick_notes", format: "key_points" });
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeGreaterThan(0);
  });

  it("returns a valid quiz for a quiz format", () => {
    const out = demoContentFor({ operation: "quick_notes", format: "mcqs" });
    expect(sanitizeQuiz(out)).not.toBeNull();
  });

  it("returns null for an unknown format (→ busy, never a misleading substitution)", () => {
    expect(demoContentFor({ operation: "quick_notes", format: "nope" })).toBeNull();
  });

  /**
   * The ladder must NOT substitute a curated graph for a user's own document. Unlike a notes
   * demo, the graph build persists concepts and edges under the user's `graphId`, so a demo graph
   * would become rows in their workspace claiming to describe the file they uploaded. Tier 6
   * (`failed` + the honest W4 message) is the correct landing.
   */
  it("returns null for a graph request — a demo graph is never written to a user's records", () => {
    expect(demoContentFor({ operation: "graph_structure", format: "" })).toBeNull();
  });

  it("returns null for an unknown operation", () => {
    expect(demoContentFor({ operation: "mystery", format: "x" })).toBeNull();
  });
});

describe("DEMO_GRAPH integrity", () => {
  it("has at least three concepts and no dangling edges", () => {
    expect(DEMO_GRAPH.concepts.length).toBeGreaterThanOrEqual(3);
    const slugs = new Set(DEMO_GRAPH.concepts.map((c) => c.slug));
    for (const edge of DEMO_GRAPH.edges) {
      expect(slugs.has(edge.prerequisite)).toBe(true);
      expect(slugs.has(edge.dependent)).toBe(true);
    }
  });

  it("every concept's quiz answer index is in range", () => {
    for (const c of DEMO_GRAPH.concepts) {
      expect(c.quiz.answer).toBeGreaterThanOrEqual(0);
      expect(c.quiz.answer).toBeLessThan(c.quiz.options.length);
    }
  });
});

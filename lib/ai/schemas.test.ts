import { describe, expect, it } from "vitest";
import { sanitizeGraph, sanitizeQuiz } from "./schemas";

/** docs/04 §3 validation guards — pure, no I/O. */
describe("sanitizeQuiz", () => {
  it("keeps valid questions", () => {
    const quiz = sanitizeQuiz({
      questions: [
        { q: "Q1", options: ["a", "b", "c", "d"], answer: 2, explanation: "e" },
      ],
    });
    expect(quiz?.questions).toHaveLength(1);
  });

  it("drops a question whose answer index is out of range", () => {
    const quiz = sanitizeQuiz({
      questions: [
        { q: "good", options: ["a", "b"], answer: 1, explanation: "" },
        { q: "bad", options: ["a", "b"], answer: 5, explanation: "" },
      ],
    });
    expect(quiz?.questions.map((x) => x.q)).toEqual(["good"]);
  });

  it("returns null when nothing survives (failure, not empty success)", () => {
    expect(
      sanitizeQuiz({ questions: [{ q: "x", options: ["a"], answer: 9 }] }),
    ).toBeNull();
  });

  it("returns null for non-quiz data", () => {
    expect(sanitizeQuiz("not json")).toBeNull();
    expect(sanitizeQuiz({})).toBeNull();
  });
});

describe("sanitizeGraph", () => {
  const base = {
    title: "T",
    concepts: [
      { slug: "a", name: "A" },
      { slug: "b", name: "B" },
      { slug: "c", name: "C" },
    ],
  };

  it("drops edges that reference a missing concept", () => {
    const g = sanitizeGraph({
      ...base,
      edges: [
        { prerequisite: "a", dependent: "b" },
        { prerequisite: "a", dependent: "zzz" }, // dangling
      ],
    });
    expect(g?.edges).toEqual([{ prerequisite: "a", dependent: "b" }]);
  });

  it("breaks a prerequisite cycle so the graph is acyclic", () => {
    const g = sanitizeGraph({
      ...base,
      edges: [
        { prerequisite: "a", dependent: "b" },
        { prerequisite: "b", dependent: "c" },
        { prerequisite: "c", dependent: "a" }, // closes a cycle
      ],
    });
    expect(g).not.toBeNull();
    expect(g!.edges.length).toBeLessThan(3);
    // no cycle remains
    expect(hasCycle(g!.edges)).toBe(false);
  });

  it("treats fewer than three concepts as a failed extraction", () => {
    expect(
      sanitizeGraph({ concepts: [{ slug: "a", name: "A" }], edges: [] }),
    ).toBeNull();
  });

  it("returns null for empty/garbage", () => {
    expect(sanitizeGraph({})).toBeNull();
    expect(sanitizeGraph("")).toBeNull();
  });
});

function hasCycle(edges: { prerequisite: string; dependent: string }[]): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.prerequisite, [...(adj.get(e.prerequisite) ?? []), e.dependent]);
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    state.set(n, 1);
    for (const m of adj.get(n) ?? []) {
      const s = state.get(m);
      if (s === 1) return true;
      if (s === undefined && visit(m)) return true;
    }
    state.set(n, 2);
    return false;
  };
  for (const n of adj.keys()) if (state.get(n) === undefined && visit(n)) return true;
  return false;
}

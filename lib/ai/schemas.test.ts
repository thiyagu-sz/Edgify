import { describe, expect, it } from "vitest";
import { sanitizeConceptDetail, sanitizeGraph, sanitizeQuiz } from "./schemas";

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

  /**
   * The shapes models actually return when they drift. Each must resolve to either a usable quiz
   * or null — never a partially-valid object, because that renders as a broken page and a broken
   * page reads as a broken product (docs/04 §3).
   */
  describe("malformed shapes degrade to null or a usable subset", () => {
    const cases: [string, unknown][] = [
      ["empty questions array", { questions: [] }],
      ["questions not an array", { questions: "five of them" }],
      ["missing questions key", { items: [] }],
      ["null", null],
      ["a JSON string rather than an object", '{"questions":[]}'],
      ["question missing options", { questions: [{ q: "Q", answer: 0, explanation: "" }] }],
      ["question with a single option", { questions: [{ q: "Q", options: ["only"], answer: 0 }] }],
      ["non-integer answer", { questions: [{ q: "Q", options: ["a", "b"], answer: 1.5 }] }],
      ["negative answer", { questions: [{ q: "Q", options: ["a", "b"], answer: -1 }] }],
      ["answer as a string", { questions: [{ q: "Q", options: ["a", "b"], answer: "1" }] }],
      ["empty question text", { questions: [{ q: "", options: ["a", "b"], answer: 0 }] }],
      ["empty option text", { questions: [{ q: "Q", options: ["a", ""], answer: 0 }] }],
      ["options containing null", { questions: [{ q: "Q", options: ["a", null], answer: 0 }] }],
    ];

    for (const [name, raw] of cases) {
      it(name, () => {
        const result = sanitizeQuiz(raw);
        if (result === null) return; // a clean tier failure — the ladder continues
        // Otherwise every surviving question must be fully renderable.
        expect(result.questions.length).toBeGreaterThan(0);
        for (const question of result.questions) {
          expect(question.q.length).toBeGreaterThan(0);
          expect(question.options.length).toBeGreaterThanOrEqual(2);
          expect(Number.isInteger(question.answer)).toBe(true);
          expect(question.answer).toBeGreaterThanOrEqual(0);
          expect(question.answer).toBeLessThan(question.options.length);
          expect(typeof question.explanation).toBe("string");
        }
      });
    }
  });

  it("keeps the good questions when only some are broken", () => {
    const quiz = sanitizeQuiz({
      questions: [
        { q: "keep 1", options: ["a", "b"], answer: 0, explanation: "" },
        { q: "drop", options: ["a", "b"], answer: 7, explanation: "" },
        { q: "keep 2", options: ["a", "b", "c"], answer: 2, explanation: "" },
      ],
    });
    expect(quiz?.questions.map((q) => q.q)).toEqual(["keep 1", "keep 2"]);
  });

  it("defaults a missing explanation rather than rejecting the question", () => {
    const quiz = sanitizeQuiz({ questions: [{ q: "Q", options: ["a", "b"], answer: 0 }] });
    expect(quiz?.questions[0].explanation).toBe("");
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

/**
 * THE SANITISATION SEAM.
 *
 * These validators are the last point at which model output is still "unvalidated", and the
 * first at which it is written anywhere — `generate()` caches the result under a
 * content-addressed key and the caller persists it. So the strings that come OUT of here are the
 * strings a second user with the same document is served from cache, and the strings
 * `cloneGraphByContentHash` copies into their rows. Nothing dirty may leave.
 */
describe("sanitisation at the validation seam", () => {
  const PAYLOAD = "<img src=x onerror=\"document.title='EDGIFY-XSS:seam'\">";
  const hasMarkup = (s: string) => /<[a-z!/]/i.test(s);

  it("strips markup from every quiz string", () => {
    const quiz = sanitizeQuiz({
      questions: [
        {
          q: `What is ${PAYLOAD} backprop?`,
          options: [`${PAYLOAD}A`, "B", "C", "D"],
          answer: 0,
          explanation: `Because ${PAYLOAD}`,
        },
      ],
    });
    const q = quiz!.questions[0];
    expect(hasMarkup(q.q)).toBe(false);
    expect(q.options.some(hasMarkup)).toBe(false);
    expect(hasMarkup(q.explanation)).toBe(false);
    // ...and the legitimate text survives.
    expect(q.q).toContain("backprop");
  });

  it("strips markup from every concept-detail string", () => {
    const detail = sanitizeConceptDetail({
      definition: `A gradient ${PAYLOAD} is a vector.`,
      example: `For instance ${PAYLOAD}`,
      quiz: { q: `Which ${PAYLOAD}?`, options: [`${PAYLOAD}a`, "b"], answer: 0, explanation: PAYLOAD },
      flashcards: [{ front: `Front ${PAYLOAD}`, back: `Back ${PAYLOAD}` }],
    });
    expect(hasMarkup(detail!.definition)).toBe(false);
    expect(hasMarkup(detail!.example)).toBe(false);
    expect(hasMarkup(detail!.quiz!.q)).toBe(false);
    expect(detail!.quiz!.options.some(hasMarkup)).toBe(false);
    expect(hasMarkup(detail!.quiz!.explanation)).toBe(false);
    expect(hasMarkup(detail!.flashcards[0].front)).toBe(false);
    expect(hasMarkup(detail!.flashcards[0].back)).toBe(false);
    expect(detail!.definition).toContain("A gradient");
  });

  it("treats a definition that is ONLY markup as a failed generation, not an empty panel", () => {
    expect(sanitizeConceptDetail({ definition: "<script>x()</script>", example: "" })).toBeNull();
  });

  it("strips markup from concept names, slugs, summaries and the title", () => {
    const graph = sanitizeGraph({
      title: `Topic ${PAYLOAD}`,
      concepts: [
        { slug: "a", name: `Alpha ${PAYLOAD}`, difficulty: "Foundational", summary: `S ${PAYLOAD}` },
        { slug: "b", name: "Beta", difficulty: "Intermediate", summary: "" },
        { slug: "c", name: "Gamma", difficulty: "Advanced", summary: "" },
      ],
      edges: [{ prerequisite: "a", dependent: "b" }],
    });
    expect(hasMarkup(graph!.title)).toBe(false);
    expect(graph!.concepts.some((c) => hasMarkup(c.name) || hasMarkup(c.slug) || hasMarkup(c.summary))).toBe(false);
    expect(graph!.concepts[0].name).toContain("Alpha");
  });

  it("keeps edges matching when a SLUG itself carries a payload", () => {
    // The regression this guards: sanitising slugs after matching edges leaves every edge
    // pointing at the pre-sanitisation spelling, and the graph renders with no edges at all.
    const poisoned = `calc${PAYLOAD}`;
    const graph = sanitizeGraph({
      title: "T",
      concepts: [
        { slug: poisoned, name: "Calculus", difficulty: "Foundational", summary: "" },
        { slug: "opt", name: "Optimisation", difficulty: "Intermediate", summary: "" },
        { slug: "gd", name: "Gradient descent", difficulty: "Advanced", summary: "" },
      ],
      edges: [
        { prerequisite: poisoned, dependent: "opt" },
        { prerequisite: "opt", dependent: "gd" },
      ],
    });
    expect(graph!.edges).toHaveLength(2);
    expect(graph!.edges[0].prerequisite).toBe(graph!.concepts[0].slug);
    expect(hasMarkup(graph!.edges[0].prerequisite)).toBe(false);
  });

  it("deduplicates concepts on slug — (graphId, slug) is UNIQUE", () => {
    const graph = sanitizeGraph({
      title: "T",
      concepts: [
        { slug: "a", name: "First", difficulty: "Foundational", summary: "" },
        { slug: "a", name: "Duplicate", difficulty: "Advanced", summary: "" },
        { slug: "b", name: "Second", difficulty: "Intermediate", summary: "" },
        { slug: "c", name: "Third", difficulty: "Advanced", summary: "" },
      ],
      edges: [],
    });
    expect(graph!.concepts.map((c) => c.slug)).toEqual(["a", "b", "c"]);
    expect(graph!.concepts[0].name).toBe("First");
  });

  it("rejects the graph when sanitisation leaves fewer than three usable concepts", () => {
    expect(
      sanitizeGraph({
        title: "T",
        concepts: [
          { slug: "a", name: "A", difficulty: "Foundational", summary: "" },
          { slug: "<script></script>", name: "B", difficulty: "Advanced", summary: "" },
          { slug: "c", name: "<script></script>", difficulty: "Advanced", summary: "" },
        ],
        edges: [],
      }),
    ).toBeNull();
  });
});

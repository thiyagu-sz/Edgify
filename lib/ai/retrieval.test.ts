import { describe, expect, it } from "vitest";
import { queryTerms, retrieveForConcept, scorePassage, splitPassages } from "./retrieval";

/**
 * Concept-detail grounding (W5). Pure, so the acceptance check costs nothing to run.
 *
 * The property that matters, and the one a sampler cannot provide: **two different concepts in the
 * same document must retrieve DIFFERENT text.** Every other assertion here would also pass for a
 * function that ignored the concept entirely and returned the first 7,000 characters — which is
 * precisely the defect being fixed — so that comparison is the load-bearing one, and the negative
 * control below states the old behaviour explicitly.
 */

const LIMIT = 7000;

const pad = (sentence: string, times: number) => (sentence + " ").repeat(times);

/**
 * Background long enough that head-truncation never escapes it — the real failure's shape.
 *
 * It must exceed the 7,000 limit, and an earlier draft at ~6,400 characters did not: plain
 * truncation already reached the renin cascade, so the negative control failed and said so. The
 * same class of mistake the graph sampler's fixture made; the control is what catches it.
 */
const BACKGROUND =
  pad("The human cell is the basic structural unit of all tissues. Cell membranes regulate transport of ions and water via channels and pumps.", 30) +
  pad("Blood is composed of plasma, erythrocytes, leukocytes and platelets. Haematocrit describes the fraction of red cells by volume.", 30);

/**
 * Each section is far larger than the whole budget, so retrieval must genuinely CHOOSE.
 *
 * An earlier draft used ~2,300-character sections: with a 7,000-character budget every section fit
 * for every concept, both groundings came out identical, and the "own section weighted higher"
 * assertion compared 20 against 20. That was the fixture failing to reproduce the real situation —
 * a 30-page paper is many times the budget — rather than the retrieval failing.
 */
const RAAS_SECTION = pad(
  "The renin-angiotensin-aldosterone system controls arterial pressure over hours to days. Renin cleaves angiotensinogen to angiotensin I, which ACE converts to angiotensin II, a potent vasoconstrictor that stimulates aldosterone release.",
  30,
);
const BARO_SECTION = pad(
  "Baroreceptor reflexes in the carotid sinus and aortic arch buffer short-term pressure change. In sustained hypertension the baroreceptor resets to a higher operating point and no longer opposes the elevated pressure.",
  30,
);
const ENDOTHELIUM_SECTION = pad(
  "Endothelial dysfunction reduces nitric oxide bioavailability and raises endothelin-1, favouring vasoconstriction, oxidative stress and vascular inflammation.",
  30,
);

const PAPER = BACKGROUND + RAAS_SECTION + BARO_SECTION + ENDOTHELIUM_SECTION;

const RAAS = {
  name: "Renin-Angiotensin-Aldosterone System",
  slug: "raas",
  summary: "The renin cascade that raises arterial pressure through angiotensin II and aldosterone.",
};
const BARO = {
  name: "Baroreceptor Reflex",
  slug: "baroreceptor-reflex",
  summary: "Carotid and aortic receptors that buffer short-term pressure change.",
};

/** What the code did before this module existed. */
const headTruncate = (text: string) => text.slice(0, LIMIT);

describe("the acceptance check — a concept is grounded in its OWN passages", () => {
  it("NEGATIVE CONTROL: head-truncation gives both concepts the identical cell-biology text", () => {
    // The defect, stated as a test. Without this the assertions below would pass for a function
    // that ignored the concept completely.
    const forRaas = headTruncate(PAPER);
    const forBaro = headTruncate(PAPER);
    expect(forRaas).toBe(forBaro);
    expect(forRaas.toLowerCase()).toContain("human cell");
    expect(forRaas.toLowerCase()).not.toContain("renin");
    expect(forRaas.toLowerCase()).not.toContain("baroreceptor");
  });

  it("retrieves the renin cascade for the RAAS concept", () => {
    const grounding = retrieveForConcept(PAPER, RAAS, LIMIT).toLowerCase();
    expect(grounding).toContain("renin");
    expect(grounding).toContain("angiotensin");
    expect(grounding).toContain("aldosterone");
  });

  it("retrieves the baroreceptor passages for the baroreceptor concept", () => {
    const grounding = retrieveForConcept(PAPER, BARO, LIMIT).toLowerCase();
    expect(grounding).toContain("baroreceptor");
    expect(grounding).toContain("carotid");
  });

  it("gives the two concepts DIFFERENT text — the property sampling cannot provide", () => {
    const forRaas = retrieveForConcept(PAPER, RAAS, LIMIT);
    const forBaro = retrieveForConcept(PAPER, BARO, LIMIT);
    expect(forRaas).not.toBe(forBaro);
  });

  it("weights each concept's own section above the other's", () => {
    const raasGrounding = retrieveForConcept(PAPER, RAAS, LIMIT).toLowerCase();
    const baroGrounding = retrieveForConcept(PAPER, BARO, LIMIT).toLowerCase();
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    expect(count(raasGrounding, "renin")).toBeGreaterThan(count(baroGrounding, "renin"));
    expect(count(baroGrounding, "baroreceptor")).toBeGreaterThan(count(raasGrounding, "baroreceptor"));
  });

  it("keeps the document opening, so the explanation is not topic-less", () => {
    const grounding = retrieveForConcept(PAPER, RAAS, LIMIT);
    expect(grounding.slice(0, 200).toLowerCase()).toContain("human cell");
  });
});

describe("budget, determinism and ordering", () => {
  it("never exceeds the limit", () => {
    for (const concept of [RAAS, BARO]) {
      expect(retrieveForConcept(PAPER, concept, LIMIT).length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("returns a short document unchanged", () => {
    const short = "A short note about the renin cascade. ".repeat(10);
    expect(short.length).toBeLessThan(LIMIT);
    expect(retrieveForConcept(short, RAAS, LIMIT)).toBe(short);
  });

  it("is deterministic — the cache key depends on it", () => {
    expect(retrieveForConcept(PAPER, RAAS, LIMIT)).toBe(retrieveForConcept(PAPER, RAAS, LIMIT));
  });

  it("reads passages in DOCUMENT order even though they were chosen by relevance", () => {
    // Chosen by score, read in position order — otherwise the explanation is a shuffled argument.
    const grounding = retrieveForConcept(PAPER, RAAS, LIMIT);
    const markers = [...grounding.matchAll(/~(\d+)% into the document/g)].map((m) => Number(m[1]));
    expect(markers.length).toBeGreaterThan(0);
    expect(markers).toEqual([...markers].sort((a, b) => a - b));
  });

  it("labels passages so the model knows text between them is missing", () => {
    expect(retrieveForConcept(PAPER, RAAS, LIMIT)).toMatch(/\[passage \d+ of \d+ — ~\d+%/);
  });
});

describe("fallback when the concept matches nothing", () => {
  it("falls back to representative sampling rather than the opening", () => {
    // A concept whose name never appears verbatim — an abbreviation, a synonym, a model
    // paraphrase. Grounding it in the document's first 7,000 chars would reintroduce the bug.
    const orphan = { name: "Zzzz Qqqq", slug: "zzzz-qqqq", summary: "Nothing in this document." };
    const grounding = retrieveForConcept(PAPER, orphan, LIMIT).toLowerCase();
    expect(grounding).not.toBe(headTruncate(PAPER).toLowerCase());
    // Sampling reaches the far end of the document; head-truncation never does.
    expect(grounding).toContain("endothelial");
  });
});

describe("query construction", () => {
  it("uses name, slug and summary together", () => {
    const terms = queryTerms(RAAS);
    expect(terms).toContain("renin");
    expect(terms).toContain("aldosterone");
    expect(terms).toContain("raas"); // from the slug
    expect(terms).toContain("cascade"); // only present in the summary
  });

  it("splits slug separators rather than treating the slug as one token", () => {
    expect(queryTerms({ name: "X", slug: "baroreceptor-reflex", summary: "" })).toContain("reflex");
  });

  it("drops stopwords and very short tokens", () => {
    const terms = queryTerms({ name: "The System for A B", slug: "x", summary: "with that" });
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("system");
    expect(terms).not.toContain("for");
    expect(terms).not.toContain("a");
  });

  it("tolerates a missing summary", () => {
    expect(() => queryTerms({ name: "RAAS", slug: "raas", summary: null })).not.toThrow();
  });
});

describe("scoring", () => {
  it("saturates term frequency so repetition cannot dominate", () => {
    // A passage that says the word twenty times must not outrank one that explains the mechanism
    // by twenty times as much — the document's own section repeats its subject constantly.
    const repetitive = "renin ".repeat(20);
    const explanatory = "renin cleaves angiotensinogen to angiotensin I and ACE converts it";
    const terms = ["renin", "angiotensin", "ace", "cleaves"];
    expect(scorePassage(explanatory, terms, "renin")).toBeGreaterThan(
      scorePassage(repetitive, terms, "renin"),
    );
  });

  it("rewards a full phrase match above its separate words", () => {
    const terms = ["baroreceptor", "reflex"];
    const withPhrase = scorePassage("the baroreceptor reflex resets", terms, "baroreceptor reflex");
    const withoutPhrase = scorePassage("the baroreceptor and the reflex", terms, "baroreceptor reflex");
    expect(withPhrase).toBeGreaterThan(withoutPhrase);
  });

  it("scores zero when nothing matches", () => {
    expect(scorePassage("unrelated prose entirely", ["renin"], "renin")).toBe(0);
  });
});

describe("passage splitting", () => {
  it("covers the whole document with no gaps or overlaps", () => {
    const passages = splitPassages(PAPER);
    expect(passages[0].start).toBe(0);
    expect(passages[passages.length - 1].end).toBe(PAPER.length);
    for (let i = 1; i < passages.length; i++) {
      expect(passages[i].start).toBe(passages[i - 1].end);
    }
  });

  it("always makes progress, even on text with no sentence boundaries", () => {
    // A pathological document (no full stops) must not loop forever.
    const passages = splitPassages("x".repeat(5000));
    expect(passages.length).toBeGreaterThan(1);
    expect(passages[passages.length - 1].end).toBe(5000);
  });
});

import { describe, expect, it } from "vitest";
import { detectHeadings, sampleForGraph } from "./sampling";

/**
 * The sampler is pure, so the acceptance check for the content-quality fix costs NOTHING to run:
 * no model call, no credits, no network. That matters — this is the regression most likely to
 * come back silently, because head-truncation looks perfectly reasonable in a diff.
 *
 * The load-bearing pair is the mechanism-terms test and its NEGATIVE CONTROL. "The sample contains
 * RAAS" proves nothing on its own — a fixture that mentioned RAAS in its first paragraph would
 * satisfy it under the old head-truncation too. The control asserts head-truncation of the SAME
 * fixture contains none of those terms, so the two together prove the sampler is doing the work.
 */

const LIMIT = 9000;

/**
 * A document shaped like the failure that prompted this: background biology first, the actual
 * subject later. Deliberately reproduces the reported symptom — head-truncation of this text
 * yields a cardiovascular primer with no mechanisms in it.
 */
const pad = (sentence: string, times: number) => (sentence + " ").repeat(times);

/**
 * The background section is deliberately LONGER THAN THE LIMIT (~11,000 chars against a 9,000
 * budget), because that is what makes this fixture reproduce the reported failure: head-truncation
 * must not reach the mechanisms at all. The negative control below asserts exactly that, and it
 * caught an earlier version of this fixture whose background was only ~5,500 chars — short enough
 * that plain truncation already saw RAAS, which would have made the whole suite vacuous.
 */
const BACKGROUND =
  pad("The human cell is the basic structural unit of all tissues. Cell membranes regulate transport of ions and water via channels and pumps.", 28) +
  pad("Blood is composed of plasma, erythrocytes, leukocytes and platelets. Haematocrit describes the fraction of red cells by volume.", 28) +
  pad("The heart consists of four chambers. Valves ensure unidirectional flow through the myocardium during systole and diastole.", 28);

const MECHANISMS =
  pad("The renin-angiotensin-aldosterone system is central to the pathophysiology of hypertension. Renin cleaves angiotensinogen to angiotensin I, converted by ACE to angiotensin II.", 12) +
  pad("Baroreceptor reflexes in the carotid sinus buffer short-term pressure change. In sustained hypertension the baroreceptor resets to a higher operating point.", 12) +
  pad("Total peripheral resistance is the dominant determinant of sustained arterial pressure. Mean arterial pressure equals cardiac output times peripheral resistance.", 12) +
  pad("Renal sodium handling and pressure natriuresis set the long-term pressure set point. Impaired sodium excretion shifts the curve rightward.", 12) +
  pad("Endothelial dysfunction reduces nitric oxide bioavailability and raises endothelin-1, favouring vasoconstriction and vascular inflammation.", 12);

const HYPERTENSION_PAPER = BACKGROUND + MECHANISMS;

/** The same document with numbered section headings, as a structured paper would have. */
const STRUCTURED_PAPER = [
  "Pathophysiology of Hypertension",
  "A review of mechanisms and their clinical relevance.",
  "",
  "1. INTRODUCTION",
  pad("Hypertension is a sustained elevation of arterial pressure with multifactorial causes.", 10),
  "",
  "2. CELLULAR BACKGROUND",
  BACKGROUND,
  "",
  "3. THE RENIN-ANGIOTENSIN-ALDOSTERONE SYSTEM",
  pad("The renin-angiotensin-aldosterone system is central to blood pressure control. Angiotensin II is a potent vasoconstrictor that stimulates aldosterone release.", 12),
  "",
  "4. BARORECEPTOR FUNCTION",
  pad("Baroreceptor reflexes buffer short-term change and reset in sustained hypertension.", 12),
  "",
  "5. PERIPHERAL RESISTANCE",
  pad("Total peripheral resistance dominates sustained pressure through arteriolar remodelling.", 12),
  "",
  "6. RENAL SODIUM HANDLING",
  pad("Pressure natriuresis and sodium excretion set the long-term pressure set point.", 12),
  "",
  "7. ENDOTHELIAL DYSFUNCTION",
  pad("Reduced nitric oxide bioavailability and raised endothelin-1 favour vasoconstriction.", 12),
].join("\n");

const MECHANISM_TERMS = [
  "renin-angiotensin",
  "baroreceptor",
  "peripheral resistance",
  "endothelial",
  "sodium",
];

/** What the code did before this module existed. */
const headTruncate = (text: string) => text.slice(0, LIMIT);

describe("the acceptance check — mechanism terms reach the model", () => {
  it("NEGATIVE CONTROL: head-truncation reaches NONE of them", () => {
    // Without this the test below proves nothing: it would pass on a fixture that happened to
    // mention RAAS in its opening paragraph.
    const head = headTruncate(HYPERTENSION_PAPER).toLowerCase();
    for (const term of MECHANISM_TERMS) {
      expect(head, `head-truncation already contained "${term}" — the fixture is wrong`).not.toContain(term);
    }
    // ...and it is full of the background that produced the reported primer.
    expect(head).toContain("human cell");
  });

  it("sampling reaches every one of them", () => {
    const sampled = sampleForGraph(HYPERTENSION_PAPER, LIMIT).toLowerCase();
    for (const term of MECHANISM_TERMS) {
      expect(sampled, `the sample never reaches "${term}"`).toContain(term);
    }
  });

  it("reaches them in the structured paper too, via section sampling", () => {
    const sampled = sampleForGraph(STRUCTURED_PAPER, LIMIT).toLowerCase();
    for (const term of MECHANISM_TERMS) {
      expect(sampled, `section sampling never reaches "${term}"`).toContain(term);
    }
  });

  it("still carries the opening, so the subject stays anchored", () => {
    // Without the anchor the excerpts read as five unrelated topics rather than one document.
    const sampled = sampleForGraph(STRUCTURED_PAPER, LIMIT);
    expect(sampled).toContain("Pathophysiology of Hypertension");
  });
});

describe("budget and determinism", () => {
  it("never exceeds the limit", () => {
    for (const text of [HYPERTENSION_PAPER, STRUCTURED_PAPER, "x".repeat(120_000)]) {
      expect(sampleForGraph(text, LIMIT).length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("returns short documents completely unchanged", () => {
    // The common case must carry no regression surface at all.
    const short = "A short document about gradient descent. ".repeat(20);
    expect(short.length).toBeLessThan(LIMIT);
    expect(sampleForGraph(short, LIMIT)).toBe(short);
  });

  it("is deterministic — the cache key depends on it", () => {
    // `generate()` keys its cache on the document text; a sampler that varied between runs would
    // miss every cache hit and re-spend on every upload.
    const a = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    const b = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    expect(a).toBe(b);
  });

  it("covers material from the far end of the document, not just the opening", () => {
    const sampled = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    const tail = HYPERTENSION_PAPER.slice(-2000);
    const tailSentence = tail.slice(tail.indexOf("Endothelial"), tail.indexOf("Endothelial") + 40);
    expect(sampled).toContain(tailSentence.trim().slice(0, 30));
  });
});

describe("coherence — excerpts are readable units, not arbitrary cuts", () => {
  it("labels each excerpt with its position so the model knows passages are missing", () => {
    const sampled = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    expect(sampled).toMatch(/\[excerpt \d+ of \d+ — ~\d+% into the document/);
    expect(sampled).toContain("chars omitted before this");
  });

  it("starts every excerpt at a sentence or heading boundary, never mid-word", () => {
    const sampled = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    const bodies = sampled.split(/\n\n\[excerpt[^\]]*\]\n\n/).slice(1);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      // A cut mid-word leaves a lower-case fragment like "ptor reflexes in the carotid".
      expect(body.trimStart()).toMatch(/^[A-Z0-9#]/);
    }
  });

  it("keeps excerpts long enough to contain a relation between two concepts", () => {
    const sampled = sampleForGraph(HYPERTENSION_PAPER, LIMIT);
    const bodies = sampled.split(/\n\n\[excerpt[^\]]*\]\n\n/).slice(1);
    for (const body of bodies) {
      expect(body.length).toBeGreaterThanOrEqual(400);
    }
  });

  it("begins section excerpts AT the heading, so each carries its own title", () => {
    const sampled = sampleForGraph(STRUCTURED_PAPER, LIMIT);
    // At least one excerpt opens with a numbered section heading.
    expect(sampled).toMatch(/\n\n\d+\. [A-Z]/);
  });
});

describe("heading detection is precision-oriented", () => {
  it("finds numbered, markdown and ALL-CAPS headings", () => {
    const headings = detectHeadings(
      ["1. INTRODUCTION", "3.1 Databases Searched", "## Markdown Heading", "PATENTABILITY REPORT", "ordinary prose line that runs on"].join("\n"),
    );
    expect(headings.map((h) => h.text)).toEqual([
      "1. INTRODUCTION",
      "3.1 Databases Searched",
      "## Markdown Heading",
      "PATENTABILITY REPORT",
    ]);
  });

  it("does NOT treat an ordinary short line as a heading", () => {
    /**
     * The heuristic that had to be rejected. Measured on a real PDF: "short line" matched 302 of
     * 491 lines, because extraction breaks at visual wraps rather than paragraphs. A false heading
     * splits a section mid-argument — the exact incoherence this design avoids.
     */
    const wrapped = ["the pressure rises as the", "arteriolar wall thickens and", "the lumen narrows"].join("\n");
    expect(detectHeadings(wrapped)).toEqual([]);
  });

  it("ignores a long line even when it starts with a number", () => {
    const long = `1. ${"a very long sentence that merely begins with a numeral ".repeat(4)}`;
    expect(detectHeadings(long)).toEqual([]);
  });

  it("reports the offset where each heading starts", () => {
    const text = "intro line\n2. METHODS\nbody";
    const [heading] = detectHeadings(text);
    expect(text.slice(heading.offset, heading.offset + 10)).toBe("2. METHODS");
  });

  it("falls back to proportional sampling when there is no structure", () => {
    // Fewer than three headings: the unstructured branch, still reaching the whole document.
    const unstructured = HYPERTENSION_PAPER;
    expect(detectHeadings(unstructured).length).toBeLessThan(3);
    const sampled = sampleForGraph(unstructured, LIMIT).toLowerCase();
    expect(sampled).toContain("endothelial");
  });
});

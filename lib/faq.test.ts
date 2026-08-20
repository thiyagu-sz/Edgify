import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONCEPT_MAP_FAQ, type FaqEntry, PDF_NOTES_FAQ, SITE_FAQ, splitFaq } from "./faq";
import { faqJsonLd } from "./structured-data";

/**
 * The FAQ content and the `FAQPage` markup describing it cannot come apart.
 *
 * WHY THIS FILE EXISTS. Google's structured-data policy requires FAQ markup to correspond to
 * content visible on the page, and marking up an answer the page does not show is in the same
 * enforcement category as a fabricated rating (lib/structured-data.ts). The architecture already
 * makes that hard to get wrong — one array feeds both the renderer and the markup — but "hard to
 * get wrong" is a property that decays. These tests pin it.
 *
 * They also pin the two things about the copy that are load-bearing and easy to erode in an
 * ordinary edit: questions stay questions, and answers stay standalone.
 */

const FAQS: Array<{ name: string; entries: FaqEntry[]; path: string }> = [
  { name: "SITE_FAQ", entries: SITE_FAQ, path: "/" },
  { name: "PDF_NOTES_FAQ", entries: PDF_NOTES_FAQ, path: "/pdf-to-study-notes" },
  { name: "CONCEPT_MAP_FAQ", entries: CONCEPT_MAP_FAQ, path: "/concept-map-for-studying" },
];

describe("splitFaq", () => {
  it("keeps every entry — the lead plus the rest is the original list", () => {
    // If this ever loses one, that entry is marked up as FAQPage and rendered nowhere.
    for (const { name, entries } of FAQS) {
      const { lead, rest } = splitFaq(entries);
      expect([lead, ...rest], `${name} lost or duplicated an entry`).toEqual(entries);
    }
  });

  it("refuses an empty list rather than returning an undefined lead", () => {
    // Without the guard this returns `{ lead: undefined }` and the page renders "undefined".
    expect(() => splitFaq([])).toThrow(/at least one entry/);
  });
});

describe("FAQPage markup describes exactly what the page renders", () => {
  it("marks up every entry, with the answer text verbatim", () => {
    for (const { name, entries, path } of FAQS) {
      const jsonLd = faqJsonLd("https://edgify.online", path, entries);
      const questions = jsonLd.mainEntity as Array<{
        name: string;
        acceptedAnswer: { text: string };
      }>;

      expect(questions.length, `${name} and its markup differ in length`).toBe(entries.length);
      for (const [i, entry] of entries.entries()) {
        expect(questions[i].name).toBe(entry.question);
        // Verbatim, not a summary: the marked-up answer IS the rendered paragraph.
        expect(questions[i].acceptedAnswer.text).toBe(entry.answer);
      }
    }
  });

  it("leaves the `more` link out of the marked-up answer", () => {
    /**
     * `more` renders as a separate link beneath the answer — navigation, not part of the answer.
     * Folding its label into `acceptedAnswer.text` would mark up words that appear on the page in
     * a different role, and an engine quoting the answer would lift link text with no destination.
     */
    const withLink = SITE_FAQ.filter((e) => e.more);
    expect(withLink.length, "premise: some entries carry a `more` link").toBeGreaterThan(0);

    const jsonLd = faqJsonLd("https://edgify.online", "/", SITE_FAQ);
    const texts = (jsonLd.mainEntity as Array<{ acceptedAnswer: { text: string } }>).map(
      (q) => q.acceptedAnswer.text,
    );
    for (const entry of withLink) {
      expect(texts.join("\n")).not.toContain(entry.more!.label);
    }
  });

  it("scopes each page's FAQ to its own URL", () => {
    // Three pages each carrying an FAQ must describe three entities, not redefine one.
    const ids = FAQS.map(({ entries, path }) => faqJsonLd("https://edgify.online", path, entries)["@id"]);
    expect(new Set(ids).size).toBe(FAQS.length);
    expect(ids).toContain("https://edgify.online/#faq");
  });
});

describe("the copy holds the shape the whole exercise depends on", () => {
  it("phrases every question as a question", () => {
    // A heading that is a noun phrase ("Scanned document support") matches no query and is not a
    // valid `Question` name in spirit. The question mark is a cheap proxy for the real property.
    for (const { name, entries } of FAQS) {
      for (const { question } of entries) {
        expect(question.endsWith("?"), `${name}: "${question}" is not phrased as a question`).toBe(true);
      }
    }
  });

  it("keeps every answer self-contained enough to quote", () => {
    /**
     * The GEO requirement, checked in the only way a test can: an answer that opens by referring
     * to something outside itself does not survive extraction. This catches the specific failure
     * — "As mentioned above…", "It does this by…" — not vagueness in general, which needs a human.
     */
    const dangling = /^(it|this|that|they|these|those|he|she|the former|the latter)\b/i;
    const backReference = /\b(as (mentioned|described|noted) above|see above|the section above)\b/i;

    for (const { name, entries } of FAQS) {
      for (const { question, answer } of entries) {
        expect(dangling.test(answer.trim()), `${name}: "${question}" opens with a pronoun whose referent is outside the answer`).toBe(false);
        expect(backReference.test(answer), `${name}: "${question}" refers to content above it`).toBe(false);
        // Two to four sentences of substance. One is usually too thin to be worth citing; a wall
        // of text gets truncated at exactly the wrong place.
        expect(answer.length, `${name}: "${question}" is too short to answer anything`).toBeGreaterThan(80);
      }
    }
  });

  it("states no metric, rating or outcome anywhere", () => {
    /**
     * The rule the whole SEO effort runs under (marketing/seo.md, AGENTS.md, lib/legal.ts): no
     * fabricated user counts, grades, accuracy figures or testimonials. An FAQ is where that
     * drifts first, because the format invites a confident number.
     *
     * The numbers that ARE allowed are the ones the code establishes — a 10 MB cap, six formats —
     * so this looks for the SHAPE of a claim rather than for digits.
     */
    const forbidden = [
      /\b\d+(\.\d+)?\s*%\s*(accurate|of students|faster|better|improvement)/i,
      /\b(thousands|millions|\d[\d,]*\+?)\s+(students|users|universities)/i,
      /\b(guarantee[ds]?|proven to|will improve your (grade|score)|top marks)\b/i,
      /\b(rated|rating|stars|reviews?)\s+\d/i,
    ];
    for (const { name, entries } of FAQS) {
      for (const { question, answer } of entries) {
        for (const pattern of forbidden) {
          expect(pattern.test(answer), `${name}: "${question}" makes an unverifiable claim`).toBe(false);
        }
      }
    }
  });
});

describe("every page that marks up an FAQ also renders it", () => {
  /**
   * The structural guarantee, checked structurally. A page importing `faqJsonLd` is making a
   * claim to Google about visible content; if it does not also render `FaqSection` and
   * `KeyAnswer` from the SAME constant, that claim is false. Reading the source is crude, but it
   * checks the thing that matters — that no page can mark up an FAQ it does not show — and it
   * fails at the moment someone deletes the rendering and leaves the markup behind.
   */
  const PAGES: Array<{ file: string; constant: string }> = [
    { file: "app/(marketing)/page.tsx", constant: "SITE_FAQ" },
    { file: "app/(marketing)/pdf-to-study-notes/page.tsx", constant: "PDF_NOTES_FAQ" },
    { file: "app/(marketing)/concept-map-for-studying/page.tsx", constant: "CONCEPT_MAP_FAQ" },
  ];

  for (const { file, constant } of PAGES) {
    it(`${file} renders the FAQ it marks up`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");

      expect(source, `${file} does not mark up an FAQ`).toContain("faqJsonLd(");
      expect(source, `${file} marks up an FAQ built from a different list`).toMatch(
        new RegExp(`faqJsonLd\\([^)]*${constant}`),
      );
      expect(source, `${file} marks up ${constant} but renders no FAQ section`).toContain("<FaqSection");
      expect(source, `${file} marks up ${constant} but renders no lead answer`).toContain("<KeyAnswer");
      expect(source, `${file} does not split ${constant} into the two rendered halves`).toContain(
        `splitFaq(${constant})`,
      );
    });
  }
});

import { describe, expect, it } from "vitest";
import { corruptPdf, encryptedPdf, scannedPdf, textPdf } from "@/test/fixtures/pdf";
import { PARSE_MESSAGES } from "./failures";
import { extractDocument, isLikelyScanned, isParseFailure, titleFromFilename } from "./index";

/**
 * Document intake end to end (docs/05 W3 steps 3–7), against REAL files wherever a real file can
 * make the point.
 *
 * The scanned case is the one that matters most and the one most likely to be got wrong: it does
 * not throw, it does not look like an error, it looks like a successful parse that happened to
 * find nothing. A system that silently returns an empty result there feels broken (docs/04 §4).
 */

const longText = "Photosynthesis converts light energy into chemical energy. ".repeat(20);

describe("isLikelyScanned — both conditions are required", () => {
  it("flags a multi-page file with almost no text", () => {
    expect(isLikelyScanned("", 4)).toBe(true);
    expect(isLikelyScanned("a stray caption", 12)).toBe(true);
  });

  it("does NOT flag a short single-page note", () => {
    // Different problem, different next action: "add a few paragraphs", not "paste the text".
    expect(isLikelyScanned("Short note.", 1)).toBe(false);
  });

  it("does NOT flag a long multi-page document", () => {
    expect(isLikelyScanned(longText, 30)).toBe(false);
  });

  it("does NOT flag non-PDF sources, which have no page count", () => {
    expect(isLikelyScanned("tiny", null)).toBe(false);
  });
});

describe("extractDocument — the scanned document case", () => {
  it("reports a genuinely scanned PDF honestly", async () => {
    const result = await extractDocument(scannedPdf(4), "lecture-photos.pdf", "application/pdf");

    expect(isParseFailure(result)).toBe(true);
    if (!isParseFailure(result)) return;
    expect(result.kind).toBe("scanned");
    // Asserted against the catalogue constant, not a substring — a reworded message must fail.
    expect(result.message).toBe(PARSE_MESSAGES.scanned);
  });

  it("does not report a scan as merely 'too short'", async () => {
    const result = await extractDocument(scannedPdf(4), "scan.pdf");
    expect(isParseFailure(result) && result.kind).not.toBe("too_short");
  });

  it("returns a FAILURE rather than an empty success — nothing downstream sees a usable doc", async () => {
    const result = await extractDocument(scannedPdf(6), "scan.pdf");
    // The distinction the criterion turns on: no empty-text document object escapes this call,
    // so no caller can go on to build an empty graph from it.
    expect(isParseFailure(result)).toBe(true);
    expect((result as { text?: unknown }).text).toBeUndefined();
  });
});

describe("extractDocument — the ordinary paths", () => {
  it("extracts a real multi-page PDF", async () => {
    const result = await extractDocument(textPdf(3), "biology-notes.pdf", "application/pdf");

    expect(isParseFailure(result)).toBe(false);
    if (isParseFailure(result)) return;
    expect(result.sourceType).toBe("pdf");
    expect(result.pageCount).toBe(3);
    expect(result.charCount).toBe(result.text.length);
    expect(result.title).toBe("biology-notes");
  });

  it("extracts plain text and markdown", async () => {
    const bytes = new TextEncoder().encode(longText);
    for (const [name, expected] of [["notes.txt", "txt"], ["notes.md", "md"]] as const) {
      const result = await extractDocument(bytes, name);
      expect(isParseFailure(result)).toBe(false);
      if (isParseFailure(result)) return;
      expect(result.sourceType).toBe(expected);
      expect(result.pageCount).toBeNull();
    }
  });

  it("maps encrypted and corrupt PDFs to their own messages", async () => {
    const enc = await extractDocument(encryptedPdf(), "protected.pdf");
    expect(isParseFailure(enc) && enc.message).toBe(PARSE_MESSAGES.encrypted);

    const bad = await extractDocument(corruptPdf(), "damaged.pdf");
    expect(isParseFailure(bad) && bad.message).toBe(PARSE_MESSAGES.corrupt);
  });

  it("rejects an unsupported type before doing any parsing work", async () => {
    const result = await extractDocument(new Uint8Array([1, 2, 3]), "deck.pptx");
    expect(isParseFailure(result) && result.kind).toBe("unsupported_type");
  });

  it("rejects text that is too short to work with", async () => {
    const result = await extractDocument(new TextEncoder().encode("Hi."), "note.txt");
    expect(isParseFailure(result) && result.message).toBe(PARSE_MESSAGES.too_short);
  });
});

describe("titleFromFilename", () => {
  it("drops the extension", () => {
    expect(titleFromFilename("Week 3 — Photosynthesis.pdf")).toBe("Week 3 — Photosynthesis");
  });

  it("falls back for a nameless file", () => {
    expect(titleFromFilename(".pdf")).toBe("Document");
  });

  it("caps length so a pathological filename cannot dominate the UI", () => {
    expect(titleFromFilename(`${"a".repeat(5000)}.pdf`)).toHaveLength(200);
  });

  /**
   * Escaping happens at RENDER, not here (`.claude/rules/ui.md`). Neutering the payload at intake
   * would look safer and be worse: it would hide whether the render path is actually safe, and
   * every other model-authored string reaching the UI still needs that path to work.
   */
  it("carries a hostile filename through as inert text, for the render layer to escape", () => {
    const title = titleFromFilename('<img src=x onerror="window.__xss=1">.pdf');
    expect(title).toBe('<img src=x onerror="window.__xss=1">');
  });
});

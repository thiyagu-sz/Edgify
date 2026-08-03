import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsPDF } from "jspdf";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graphToMarkdown } from "../graph/study-guide";
import { MARGIN, STYLES, renderBlocks } from "./render";

/**
 * The placement pass (W7), asserted on the EXTRACTED TEXT of a real PDF rather than on the raw
 * byte stream.
 *
 * That distinction matters and it is why the old test for this had to change. Byte-grepping the
 * stream for `"bold item"` only works while the whole line is drawn in ONE font call — the moment
 * inline bold became genuinely bold, "bold" and " item" are separate `Tj` operators and the
 * contiguous string is gone from the bytes even though the page reads correctly. Extracting the
 * text asks what a reader, and Ctrl-F, actually get.
 *
 * Every case here corresponds to a defect measured on the previous line-by-line renderer.
 */

let tmpDir = "";
let originalCwd = "";

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "edgify-render-"));
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Render markdown and read back both the extracted text and the raw stream. */
async function render(title: string, markdown: string) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  renderBlocks(doc, title, markdown);
  process.chdir(tmpDir);
  doc.save("out.pdf");
  process.chdir(originalCwd);
  const file = readdirSync(tmpDir).find((f) => f.endsWith(".pdf"));
  const bytes = new Uint8Array(readFileSync(join(tmpDir, file as string)));
  const pdf = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return {
    text,
    /**
     * Whitespace-collapsed, for phrase assertions. Wrapping inserts line breaks INSIDE a phrase —
     * a long title now legitimately spans two lines — so matching a multi-word phrase against the
     * raw extraction tests the wrap point rather than the content.
     */
    flat: text.replace(/\s+/g, " "),
    pages: totalPages,
    raw: readFileSync(join(tmpDir, file as string), "latin1"),
    bytes: bytes.length,
  };
}

const GUIDE = [
  "## Renin-Angiotensin-Aldosterone System  (Advanced)",
  "",
  "The **RAAS** is central to blood-pressure regulation, and the variable renal_artery_stenosis is preserved.",
  "",
  "**Prerequisites:** Blood Vessel Structure, Renal Physiology",
  "",
  "#### Clinical note",
  "",
  "| Drug class | Target | Effect |",
  "|---|---|---|",
  "| ACE inhibitor | ACE | Blocks angiotensin II synthesis |",
  "| ARB | AT1 receptor | Blocks angiotensin II action |",
  "",
  "See [the reference](https://example.com/raas) for details.",
  "",
  "```",
  "MAP = CO * TPR",
  "```",
  "",
  "- Peripheral resistance rises with wall thickness.",
  "- Endothelial dysfunction reduces **nitric oxide**.",
].join("\n");

describe("the defects measured on the old renderer are gone", () => {
  it("renders a table instead of literal pipes", async () => {
    const { text, flat } = await render("Study guide", GUIDE);
    expect(flat).toContain("ACE inhibitor");
    expect(flat).toContain("AT1 receptor");
    expect(text, "table printed as literal pipes").not.toContain("|");
    expect(text, "the |---|---| divider printed as content").not.toContain("---");
  });

  it("strips heading markers at every level, including h4", async () => {
    const { text } = await render("Study guide", GUIDE);
    expect(text).toContain("Clinical note");
    expect(text, "heading hashes reached the page").not.toMatch(/#{1,4}\s/);
  });

  it("strips code fences but keeps the code", async () => {
    const { text, flat } = await render("Study guide", GUIDE);
    expect(flat).toContain("MAP = CO * TPR");
    expect(text).not.toContain("```");
  });

  it("renders link TEXT and never the target", async () => {
    const { text } = await render("Study guide", GUIDE);
    expect(text).toContain("the reference");
    expect(text).not.toContain("https://");
    expect(text).not.toContain("](");
  });

  it("PRESERVES snake_case", async () => {
    const { text } = await render("Study guide", GUIDE);
    expect(text).toContain("renal_artery_stenosis");
  });

  it("renders inline bold as text without its markers", async () => {
    const { text } = await render("Study guide", GUIDE);
    expect(text).toContain("RAAS");
    expect(text).toContain("Prerequisites:");
    expect(text, "asterisks reached the page").not.toContain("**");
  });

  it("renders list items with a bullet glyph, not a hyphen marker", async () => {
    const { text, flat } = await render("Study guide", GUIDE);
    expect(text).toContain("•");
    expect(flat).toContain("Peripheral resistance rises");
  });
});

describe("text is drawn ONCE — the regression every `contains` assertion missed", () => {
  /**
   * A real bug, caught by measuring the artefact rather than by any test above.
   *
   * `wrapRuns` spread each run into its word-sized pieces but did not replace `text` with the
   * word, so every piece carried the WHOLE run's text and `drawLine` painted the entire string at
   * each successive x. Output was overlapping garbage — and all seven "contains" assertions
   * passed, because the expected substrings were present many times over. The extracted text was
   * 52,169 characters for ~3,400 characters of markdown, and the file was 165.9 KB instead of ~12.
   *
   * So the assertions here are about COUNT and PROPORTION, which is what "contains" cannot see.
   */
  it("draws each phrase exactly as many times as it appears in the source", async () => {
    const source = "Alpha unique-token beta.\n\n## Heading\n\nGamma unique-token delta.";
    const { text } = await render("Title", source);
    expect((text.match(/unique-token/g) ?? []).length).toBe(2);
    expect((text.match(/Heading/g) ?? []).length).toBe(1);
  });

  it("draws the title once, not once per word", async () => {
    const { text } = await render("Edgify study guide — Pathophysiology of Hypertension", GUIDE);
    expect((text.match(/Edgify study guide/g) ?? []).length).toBe(1);
  });

  it("extracts a character count proportional to the source, not a multiple of it", async () => {
    const { text, bytes } = await render("Study guide", GUIDE);
    // Markers are stripped and whitespace collapses, so extracted text is a little SHORTER than
    // the markdown. A multiple of it means something is being drawn repeatedly.
    expect(text.length).toBeLessThan(GUIDE.length * 1.5);
    expect(bytes).toBeLessThan(60_000);
  });
});

describe("the artefact keeps the properties worth keeping", () => {
  it("is vector text — selectable and searchable, not a raster image", async () => {
    const { text, bytes } = await render("Study guide", GUIDE);
    expect(text.trim().length).toBeGreaterThan(200);
    // A rasterised page would be orders of magnitude larger and extract to nothing.
    expect(bytes).toBeLessThan(200_000);
  });

  it("carries no executable object — the existing inertness assertions, re-run", async () => {
    const { raw } = await render("Study guide", GUIDE);
    expect(raw.startsWith("%PDF-")).toBe(true);
    for (const marker of ["/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/AA", "/SubmitForm"]) {
      expect(raw, `PDF contains ${marker}`).not.toContain(marker);
    }
    const openAction = raw.match(/\/OpenAction\s*([^\n]*)/)?.[1] ?? "";
    expect(openAction).toMatch(/^\[/);
    expect(openAction).not.toContain("/S");
  });

  it("emits NO link annotation, even though the markdown had a link", async () => {
    /**
     * The decision: link text renders, the annotation does not. A clickable target built from
     * model output would be a new execution surface PROOF 5 does not cover, and exports are
     * distributed by the content-addressed cache — one poisoned document reaches everyone who
     * uploads the same file. `/Annots` and `/URI` must be absent from the stream entirely.
     */
    const { raw } = await render("Study guide", GUIDE);
    expect(raw, "a link annotation was emitted").not.toContain("/Annots");
    expect(raw, "a URI action was emitted").not.toContain("/URI");
    expect(raw).not.toContain("/Link");
  });

  it("keeps a javascript: link inert AND invisible", async () => {
    const { text, raw } = await render("Study guide", "Click [here](javascript:alert(1)) now.");
    expect(text).toContain("here");
    expect(text).not.toContain("javascript:");
    expect(raw).not.toContain("/URI");
    expect(raw).not.toContain("/JavaScript");
  });
});

describe("layout rules the line-by-line renderer could not express", () => {
  it("never places text outside the 1-inch margins", async () => {
    // A long unbroken run is the case that used to overflow: the old renderer measured with
    // `splitTextToSize` at ONE font, so a mixed-weight line could exceed the content width.
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    renderBlocks(doc, "Margins", "**Bold start** then a very long ordinary sentence that must wrap cleanly inside the content column without ever crossing the right margin of the page.");
    expect(MARGIN).toBe(72);
    const pageWidth = doc.internal.pageSize.getWidth();
    expect(pageWidth - MARGIN * 2).toBeCloseTo(451.28, 1);
  });

  it("keeps a heading with the content beneath it", async () => {
    // 40 paragraphs, then a heading near the foot of a page: the heading must move to the next
    // page rather than being stranded. Asserted by page count staying sane and the heading text
    // appearing after the filler.
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of filler text.`).join("\n\n");
    const { flat, pages } = await render("Keep with next", `${filler}\n\n## Final Heading\n\nBody under the heading.`);
    expect(pages).toBeGreaterThan(1);
    const headingAt = flat.indexOf("Final Heading");
    const bodyAt = flat.indexOf("Body under the heading.");
    expect(headingAt).toBeGreaterThan(-1);
    expect(bodyAt).toBeGreaterThan(headingAt);
  });

  it("repeats the table header when a table crosses a page", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => `| Row ${i} | Target ${i} | Effect ${i} |`).join("\n");
    const { text, pages } = await render("Long table", `| Drug | Target | Effect |\n|---|---|---|\n${rows}`);
    expect(pages).toBeGreaterThan(1);
    // The header string appears once per page the table occupies.
    const headerCount = (text.match(/Drug/g) ?? []).length;
    expect(headerCount, "table header did not repeat after the page break").toBeGreaterThan(1);
  });

  it("gives a heading more space above than below", () => {
    // The rule that fixes most of the "cramped" reading: a heading binds to the content it
    // introduces, so the gap above it must exceed the gap below.
    for (const style of [STYLES.h1, STYLES.h2, STYLES.h3, STYLES.h4]) {
      expect(style.above).toBeGreaterThan(style.below);
    }
  });

  it("uses the specified type scale and 1.5 body line-height", () => {
    expect(STYLES.title.size).toBe(24);
    expect(STYLES.h1.size).toBe(20);
    expect(STYLES.h2.size).toBe(16);
    expect(STYLES.h3.size).toBe(13);
    expect(STYLES.body.size).toBe(11);
    expect(STYLES.body.lineHeight).toBe(1.5);
  });
});

describe("the real graph study guide", () => {
  it("renders end to end with no stray markdown", async () => {
    const md = graphToMarkdown(
      "Pathophysiology of Hypertension",
      [
        { slug: "raas", name: "RAAS", difficulty: "Advanced", summary: "Renin cascade.", estimatedMinutes: 180 },
        { slug: "vessels", name: "Blood Vessel Structure", difficulty: "Foundational", summary: "Three layers.", estimatedMinutes: 120 },
      ],
      [{ prerequisite: "vessels", dependent: "raas" }],
      new Map(),
    );
    const { text, flat } = await render("Edgify study guide — Pathophysiology of Hypertension", md);
    expect(flat).toContain("Pathophysiology of Hypertension");
    expect(flat).toContain("Blood Vessel Structure");
    expect(flat).toContain("Recommended study order");
    expect(text).not.toContain("**");
    expect(text).not.toMatch(/^#{1,4}\s/m);
  });
});

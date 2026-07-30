// @vitest-environment jsdom
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_PAYLOADS_COMBINED,
  XSS_PAYLOADS,
  assertNoExecutableDom,
} from "@/test/xss-payloads";
import { exportDoc, exportPdf, quizToMarkdown } from "./export";

/**
 * Export is the third surface model output reaches (W7, docs/05) — and the one that leaves the
 * browser. A `.doc` is opened later, in Word, by someone who did not generate it, so a payload
 * that survives here outlives the session it came from.
 *
 * Covered: the DOC blob's HTML, the PDF's text-only construction, and the documented W7 trap
 * (model content containing a literal `</body>`).
 */

let blobs: { blob: Blob; filename: string }[] = [];

beforeEach(() => {
  blobs = [];
  // jsdom implements neither of these. Patch the methods on the real URL object rather than
  // replacing the global: jsPDF resolves URL through its own module scope, so a substituted
  // global is invisible to it and its blob would escape capture.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push({ blob, filename: "" });
      return "blob:fake";
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function docHtmlFor(markdown: string, title = "Edgify — Key Points"): Promise<string> {
  exportDoc(title, markdown);
  expect(blobs).toHaveLength(1);
  return await blobs[0].blob.text();
}

describe("exportDoc — sanitisation", () => {
  for (const { name, payload } of XSS_PAYLOADS) {
    it(`produces an inert document for: ${name}`, async () => {
      const html = await docHtmlFor(payload);
      // Parse the exported body the way Word's HTML importer would, and assert on the tree.
      const host = document.createElement("div");
      host.innerHTML = html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");
      expect(() => assertNoExecutableDom(host)).not.toThrow();
    });
  }

  it("produces an inert document for the whole poisoned corpus at once", async () => {
    const html = await docHtmlFor(ALL_PAYLOADS_COMBINED);
    const host = document.createElement("div");
    host.innerHTML = html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");
    expect(() => assertNoExecutableDom(host)).not.toThrow();
  });

  it("keeps the real notes content", async () => {
    const html = await docHtmlFor("## Backpropagation\n\n- Chain rule, output to input");
    expect(html).toContain("Backpropagation");
    expect(html).toContain("Chain rule, output to input");
  });

  it("escapes the title rather than letting it inject markup", async () => {
    const html = await docHtmlFor("- a point", "<img src=x onerror=\"window.__xss=1\">");
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain("&lt;img");
  });

  it("survives the W7 trap: model content containing a literal </body>", async () => {
    // docs/05 W7 warns that string-splicing around this tag truncates the document.
    const markdown = "Real notes before.\n\n</body></html>\n\nReal notes after.";
    const html = await docHtmlFor(markdown);

    expect(html).toContain("Real notes before.");
    expect(html).toContain("Real notes after.");
    // Exactly one real closing tag: the one we wrote. The model's is escaped, not structural.
    expect(html.match(/<\/body>/g)).toHaveLength(1);
    expect(html.endsWith("</body></html>")).toBe(true);
  });
});

describe("exportPdf — text only, never markup", () => {
  /**
   * Reads the real PDF rather than the calls that built it.
   *
   * Delivery differs by environment: in a browser jsPDF hands a Blob to a download link, but
   * under Node (which is what vitest gives us, jsdom or not) `save()` writes the file with `fs`.
   * The DOCUMENT BYTES are identical either way — same jsPDF instance, same content stream — so
   * asserting on the file is a faithful test of the artifact a user receives. Only the delivery
   * mechanism is untested here, and that is covered by the Playwright download check.
   *
   * We chdir into a temp directory first: jsPDF derives the path from the filename alone and
   * would otherwise drop PDFs into the repository root.
   */
  let tmpDir = "";
  let originalCwd = "";

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "edgify-pdf-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function pdfBytes(title: string, markdown: string): string {
    exportPdf(title, markdown);
    const written = readdirSync(tmpDir).filter((f) => f.endsWith(".pdf"));
    expect(written.length, "exportPdf produced no file").toBeGreaterThan(0);
    return readFileSync(join(tmpDir, written[written.length - 1]), "latin1");
  }

  it("emits a PDF with no executable object at all", () => {
    const raw = pdfBytes("Edgify — Key Points", ALL_PAYLOADS_COMBINED);
    expect(raw.startsWith("%PDF-")).toBe(true);

    // PDF carries its own scripting surface, quite separate from HTML. The export path never
    // creates any of it, and must not start doing so because the source markdown asked.
    expect(raw).not.toContain("/JavaScript");
    expect(raw).not.toContain("/JS");
    expect(raw).not.toContain("/Launch");
    expect(raw).not.toContain("/EmbeddedFile");
    expect(raw).not.toContain("/AA"); // additional-actions dictionary
    expect(raw).not.toContain("/SubmitForm");

    // `/OpenAction` IS present in every jsPDF document — it carries the default view preference
    // (`[3 0 R /FitH null]`, fit-to-width on open), which is a navigation destination, not an
    // action. Assert the benign array form rather than the tag's absence, so a real
    // `/OpenAction << /S /JavaScript >>` would still fail this test.
    const openAction = raw.match(/\/OpenAction\s*([^\n]*)/)?.[1] ?? "";
    expect(openAction).toMatch(/^\[/);
    expect(openAction).not.toContain("/S");
  });

  it("renders headings and bullets as text, stripping markdown syntax", () => {
    const raw = pdfBytes("Edgify — Key Points", "# Heading\n\n- **bold** item");
    expect(raw).toContain("Heading");
    expect(raw).toContain("bold item");
    // The `**` markers are stripped before the text reaches the page.
    expect(raw).not.toContain("**bold**");
  });

  it("does not throw on any payload in the corpus", () => {
    for (const { name, payload } of XSS_PAYLOADS) {
      expect(() => exportPdf("Edgify — Key Points", payload), name).not.toThrow();
    }
  });
});

describe("quizToMarkdown", () => {
  it("renders questions, lettered options, the answer and the explanation", () => {
    const md = quizToMarkdown("MCQs", [
      { q: "What is a weight?", options: ["A conn. strength", "A layer", "A loss", "A step"], answer: 0, explanation: "It scales an input." },
    ]);
    expect(md).toContain("## MCQs");
    expect(md).toContain("**Q1. What is a weight?**");
    expect(md).toContain("- A. A conn. strength  (correct)");
    expect(md).toContain("_Answer: A — It scales an input._");
  });

  it("passes payloads through as inert markdown text for the export path to escape", async () => {
    const md = quizToMarkdown("MCQs", [
      { q: "<script>window.__xss=1</script>", options: ["a", "b"], answer: 0, explanation: "e" },
    ]);
    // quizToMarkdown itself does not escape — it produces markdown. The guarantee is that the
    // surface which turns it into HTML does, so assert that end of the pipe.
    const html = await docHtmlFor(md);
    const host = document.createElement("div");
    host.innerHTML = html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");
    expect(() => assertNoExecutableDom(host)).not.toThrow();
  });
});

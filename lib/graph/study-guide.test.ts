// @vitest-environment jsdom
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConceptDetail } from "../ai/schemas";
import { sanitizeConceptDetail, sanitizeGraph } from "../ai/schemas";
import { exportDoc, exportPdf } from "../export";
import { ALL_PAYLOADS_COMBINED, assertNoExecutableDom } from "@/test/xss-payloads";
import type { GraphConcept, GraphEdge } from "./readiness";
import { graphToMarkdown } from "./study-guide";

/**
 * "Graph export produces a complete study guide" (docs/06 Phase 5, W7).
 *
 * Two claims, checked separately:
 *   1. the markdown is COMPLETE — every concept, its prerequisites, its example, and a
 *      recommended order, foundational first;
 *   2. the artefact is INERT — the `.doc` blob and the PDF carry nothing executable, including
 *      when the concept names and definitions are poisoned, and including the documented W7
 *      `</body>` trap.
 *
 * The export is the surface that leaves the browser: a `.doc` is opened later, in Word, by
 * someone who did not generate it, so a payload that survives here outlives its session.
 */

const CONCEPTS: GraphConcept[] = [
  { slug: "gd", name: "Gradient descent", difficulty: "Advanced", summary: "Steps downhill.", estimatedMinutes: 180 },
  { slug: "calc", name: "Calculus", difficulty: "Foundational", summary: "Rates of change.", estimatedMinutes: 120 },
  { slug: "opt", name: "Optimisation", difficulty: "Intermediate", summary: "Finding minima.", estimatedMinutes: 150 },
];

const EDGES: GraphEdge[] = [
  { prerequisite: "calc", dependent: "opt" },
  { prerequisite: "opt", dependent: "gd" },
];

const DETAIL: ConceptDetail = {
  definition: "The full generated definition of optimisation.",
  example: "Rolling a ball into a bowl.",
  quiz: null,
  flashcards: [],
};

let blobs: Blob[] = [];

beforeEach(() => {
  blobs = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((blob: Blob) => {
      blobs.push(blob);
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
  vi.restoreAllMocks();
});

describe("graphToMarkdown — the guide is complete", () => {
  const md = graphToMarkdown("Machine learning", CONCEPTS, EDGES, new Map([["opt", DETAIL]]));

  it("titles the guide with the graph", () => {
    expect(md).toContain("# Study guide — Machine learning");
  });

  it("includes every concept, with its difficulty", () => {
    expect(md).toContain("## Calculus  (Foundational)");
    expect(md).toContain("## Optimisation  (Intermediate)");
    expect(md).toContain("## Gradient descent  (Advanced)");
  });

  it("orders foundational first, by prerequisite depth", () => {
    const order = ["Calculus", "Optimisation", "Gradient descent"].map((n) => md.indexOf(`## ${n}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("uses the generated definition where one exists", () => {
    expect(md).toContain("The full generated definition of optimisation.");
    expect(md).toContain("*Example:* Rolling a ball into a bowl.");
  });

  it("falls back to the summary for a concept the user never opened", () => {
    // A guide that silently omitted every unopened concept would be worse than one with shorter
    // entries — the prototype's `c.def || c.summary || ""`.
    expect(md).toContain("Rates of change.");
    expect(md).toContain("Steps downhill.");
  });

  it("names prerequisites by name, not by slug", () => {
    expect(md).toContain("**Prerequisites:** Calculus");
    expect(md).toContain("**Prerequisites:** Optimisation");
    expect(md).not.toContain("**Prerequisites:** calc");
  });

  it("ends with a numbered study order covering every concept", () => {
    expect(md).toContain("## Recommended study order");
    expect(md).toContain("1. Calculus");
    expect(md).toContain("2. Optimisation");
    expect(md).toContain("3. Gradient descent");
  });

  it("omits the example line when there is no detail rather than emitting an empty one", () => {
    const bare = graphToMarkdown("T", CONCEPTS, EDGES, new Map());
    expect(bare).not.toContain("*Example:*");
    expect(bare).toContain("## Calculus  (Foundational)");
  });
});

describe("the exported artefacts are inert", () => {
  /** A guide built from model output that carries a payload in every field. */
  function poisonedGuide(): string {
    const structure = sanitizeGraph({
      title: `Topic ${ALL_PAYLOADS_COMBINED}`,
      concepts: [
        { slug: "a", name: `Alpha ${ALL_PAYLOADS_COMBINED}`, difficulty: "Foundational", summary: ALL_PAYLOADS_COMBINED },
        { slug: "b", name: "Beta", difficulty: "Intermediate", summary: ALL_PAYLOADS_COMBINED },
        { slug: "c", name: "Gamma", difficulty: "Advanced", summary: "" },
      ],
      edges: [{ prerequisite: "a", dependent: "b" }],
    })!;
    const detail = sanitizeConceptDetail({
      definition: `Definition ${ALL_PAYLOADS_COMBINED}`,
      example: `Example ${ALL_PAYLOADS_COMBINED}`,
      flashcards: [],
    })!;
    return graphToMarkdown(
      structure.title,
      structure.concepts.map((c) => ({ ...c, estimatedMinutes: 120 })),
      structure.edges,
      new Map([["a", detail]]),
    );
  }

  it("the DOC blob parses to a tree with nothing executable in it", async () => {
    exportDoc("Edgify study guide — Topic", poisonedGuide());
    const html = await blobs[0].text();
    // Parse the exported BODY the way Word's HTML importer would. The wrapper's own <style>
    // block (the Word print CSS we author) is deliberately outside this — it is ours, not the
    // model's, and `assertNoExecutableDom` counts any <style> as a finding.
    const host = document.createElement("div");
    host.innerHTML = html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "");
    expect(() => assertNoExecutableDom(host)).not.toThrow();
  });

  it("the DOC blob is well-formed, with exactly one </body> and it is the last one", async () => {
    /**
     * The W7 trap: the DOC writer builds an HTML string that CONTAINS a literal `</body>`, and any
     * templating or splicing around it must not treat that as the document's real end. Model
     * content carrying its own `</body>` is the attack shape.
     */
    const guide = graphToMarkdown(
      "Topic",
      [
        { slug: "a", name: "Alpha </body></html><script>bad()</script>", difficulty: "Foundational", summary: "Ends here </body></html> and continues.", estimatedMinutes: 120 },
        { slug: "b", name: "Beta", difficulty: "Intermediate", summary: "", estimatedMinutes: 120 },
      ],
      [],
      new Map(),
    );
    exportDoc("Study guide </body>", guide);
    const html = await blobs[0].text();

    const closes = [...html.matchAll(/<\/body>/gi)];
    expect(closes, "the model's </body> was emitted as markup, truncating the document").toHaveLength(1);
    expect(html.trim().endsWith("</body></html>")).toBe(true);
    // The content after the model's literal </body> survived rather than being cut off.
    expect(html).toContain("and continues.");
    expect(html).toContain("Beta");
  });

  it("NEGATIVE CONTROL — an unescaped writer truncates under the same idiom", async () => {
    /**
     * The W7 trap is a STRING-handling failure, not a parser one — worth being precise about,
     * because the obvious control is wrong. An HTML parser ignores a stray `</body>` and keeps
     * going, so parsing proves nothing here; jsdom, Chrome and Word all agree on that.
     *
     * What breaks is any code that treats the tag as the document's end. `split("</body>")[0]` is
     * the everyday idiom for "give me the body" — used by converters, previewers and mail
     * clients — and against a document that carries the model's own `</body>` it silently keeps
     * only the part before it.
     *
     * So: the same guide, written the unescaped way, then read by that idiom. It must lose
     * content. The assertion beside it is that the real exporter's output does not.
     */
    const modelBody = "Ends here </body></html> and continues. Beta";
    const unescaped = `<!DOCTYPE html><html><head></head><body><h1>T</h1>${modelBody}</body></html>`;

    expect([...unescaped.matchAll(/<\/body>/gi)]).toHaveLength(2);
    expect(
      unescaped.split("</body>")[0],
      "the unescaped document did not truncate — this control proves nothing",
    ).not.toContain("Beta");

    // The real exporter, same content: its only literal </body> is the one it wrote, so the same
    // idiom returns the whole document.
    exportDoc("T", modelBody);
    const real = await blobs[0].text();
    expect(real.split("</body>")).toHaveLength(2);
    expect(real.split("</body>")[0]).toContain("and continues.");
    expect(real.split("</body>")[0]).toContain("Beta");
  });

});

/**
 * Reads the real PDF rather than the calls that built it, and from disk: under Node — which is
 * what vitest gives us, jsdom or not — jsPDF's `save()` writes with `fs` instead of handing a Blob
 * to a download link. The document BYTES are identical either way. Same approach, and the same
 * reasoning, as lib/export.test.ts.
 */
describe("the exported PDF study guide", () => {
  let tmpDir = "";
  let originalCwd = "";

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "edgify-guide-"));
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

  it("has a valid header and carries no executable object", () => {
    const structure = sanitizeGraph({
      title: `Topic ${ALL_PAYLOADS_COMBINED}`,
      concepts: [
        { slug: "a", name: `Alpha ${ALL_PAYLOADS_COMBINED}`, difficulty: "Foundational", summary: ALL_PAYLOADS_COMBINED },
        { slug: "b", name: "Beta", difficulty: "Intermediate", summary: "" },
        { slug: "c", name: "Gamma", difficulty: "Advanced", summary: "" },
      ],
      edges: [{ prerequisite: "a", dependent: "b" }],
    })!;
    const raw = pdfBytes(
      "Edgify study guide — Topic",
      graphToMarkdown(
        structure.title,
        structure.concepts.map((c) => ({ ...c, estimatedMinutes: 120 })),
        structure.edges,
        new Map(),
      ),
    );

    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw).not.toContain("/JavaScript");
    expect(raw).not.toContain("/JS");
    expect(raw).not.toContain("/Launch");
    expect(raw).not.toContain("/EmbeddedFile");
    expect(raw).not.toContain("/AA");
    expect(raw).not.toContain("/SubmitForm");

    // `/OpenAction` is present in every jsPDF document as a view preference (a destination array,
    // not an action). Assert the benign form rather than the tag's absence, so a real
    // `/OpenAction << /S /JavaScript >>` would still fail here.
    const openAction = raw.match(/\/OpenAction\s*([^\n]*)/)?.[1] ?? "";
    expect(openAction).toMatch(/^\[/);
    expect(openAction).not.toContain("/S");
  });

  it("still contains the study content", () => {
    const raw = pdfBytes("Edgify study guide — ML", graphToMarkdown("ML", CONCEPTS, EDGES, new Map()));
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw.length).toBeGreaterThan(1000);
  });
});

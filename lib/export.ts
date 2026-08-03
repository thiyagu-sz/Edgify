import { jsPDF } from "jspdf";
import { renderBlocks } from "./pdf/render";
import { escapeAttribute, renderMarkdown } from "./sanitize";

/**
 * Client-side export (W7, docs/05). No server cost, no failure mode.
 *
 * PDF via jsPDF, laid out from a BLOCK MODEL (`lib/pdf`) rather than line by line — see the note
 * on `exportPdf`. DOC via a Word-compatible HTML blob downloaded as `.doc`, rendered through the
 * same sanitiser as the on-screen prose. Neither path executes HTML, and neither emits a link
 * annotation: `[text](url)` renders as its label only.
 */

function slug(s: string): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 44) || "edgify"
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 600);
}

export function exportDoc(title: string, markdown: string): void {
  // Rendered through the SAME chokepoint as the on-screen prose (lib/sanitize). Keeping a second
  // marked+sanitiser pair here meant a second policy, and they drifted: this path once used
  // DOMPurify's defaults and so let <style> through into the exported document after the
  // on-screen path had been tightened. A `.doc` outlives the session and is opened elsewhere, so
  // it needs the stricter policy, not the laxer one. This also neutralises the W7 trap: a literal
  // `</body>` in model content is escaped to text, and the wrapper is built by concatenation
  // without splicing around it (lib/graph/study-guide.test.ts has the control).
  const body = renderMarkdown(markdown);
  const html =
    "<!DOCTYPE html><html><head><meta charset='utf-8'><style>" +
    "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#111;line-height:1.5}" +
    " h1{font-size:19pt;margin:0 0 10pt} h2{font-size:14pt;margin:16pt 0 6pt}" +
    " h3{font-size:12pt;margin:12pt 0 5pt} ul,ol{margin:6pt 0 6pt 18pt}" +
    " li{margin:3pt 0} p{margin:6pt 0}</style></head><body><h1>" +
    escapeAttribute(title) +
    "</h1>" +
    body +
    "</body></html>";
  downloadBlob(new Blob([html], { type: "application/msword" }), slug(title) + ".doc");
}

/**
 * Markdown → PDF, via the block model in `lib/pdf` (W7).
 *
 * REPLACED 2026-08-02. The previous implementation walked `markdown.split("\n")` and called
 * `doc.text()` at a manually-advanced `y`. Measured defects on a realistic study guide: tables
 * printed as literal `|` pipes (with `|---|---|` as body text), `####` headings kept their
 * hashes, code fences printed verbatim, `[text](url)` printed raw, and a global `_` strip
 * corrupted `renal_artery_stenosis` into `renalarterystenosis`.
 *
 * Those are not tuning problems. A renderer that sees one line at a time cannot express
 * "keep this heading with its paragraph", "never split this table row" or "this bold run sits
 * inside that sentence" — they are properties of blocks, and there were no blocks. Parsing is now
 * separate from placement: `lib/pdf/blocks.ts` decides what the content is, `lib/pdf/render.ts`
 * decides where it goes.
 *
 * Still client-side, still free, still VECTOR text — selectable, searchable, tens of KB. The
 * headless-browser and `jsPDF.html()` routes were both rejected: the first stops being free and
 * adds a renderer with far more privilege, the second rasterises and would cost selectability.
 */
export function exportPdf(title: string, markdown: string): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  renderBlocks(doc, title, markdown);
  doc.save(slug(title) + ".pdf");
}

/** Turn a validated quiz into revision markdown for Copy / PDF / DOC (prototype `quizToMarkdown`). */
export function quizToMarkdown(
  label: string,
  questions: {
    q: string;
    options: string[];
    answer: number;
    explanation?: string;
  }[],
): string {
  let md = "## " + label + "\n\n";
  questions.forEach((q, i) => {
    md += "**Q" + (i + 1) + ". " + q.q + "**\n\n";
    (q.options || []).forEach((o, oi) => {
      md += "- " + String.fromCharCode(65 + oi) + ". " + o + (oi === q.answer ? "  (correct)" : "") + "\n";
    });
    md += "\n_Answer: " + String.fromCharCode(65 + q.answer) + " — " + (q.explanation || "") + "_\n\n";
  });
  return md;
}

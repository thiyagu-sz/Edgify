import DOMPurify from "dompurify";
import { jsPDF } from "jspdf";
import { marked } from "marked";

/**
 * Client-side export, ported from docs/reference/trellis-prototype.html (W7, docs/05). No server
 * cost, no failure mode. PDF via jsPDF (walks the markdown line by line as plain text — no HTML
 * is ever executed); DOC via a Word-compatible HTML blob downloaded as `.doc`.
 */

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function slug(s: string): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 44) || "trellis"
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
  // Sanitise the rendered body (the markdown is model output). DOMPurify also neutralises the
  // W7 trap: a literal `</body>` inside model content can't prematurely close the document,
  // because we build the string by concatenation and never splice around `</body>`.
  const body = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
  const html =
    "<!DOCTYPE html><html><head><meta charset='utf-8'><style>" +
    "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#111;line-height:1.5}" +
    " h1{font-size:19pt;margin:0 0 10pt} h2{font-size:14pt;margin:16pt 0 6pt}" +
    " h3{font-size:12pt;margin:12pt 0 5pt} ul,ol{margin:6pt 0 6pt 18pt}" +
    " li{margin:3pt 0} p{margin:6pt 0}</style></head><body><h1>" +
    escapeHtml(title) +
    "</h1>" +
    body +
    "</body></html>";
  downloadBlob(new Blob([html], { type: "application/msword" }), slug(title) + ".doc");
}

export function exportPdf(title: string, markdown: string): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const M = 48,
    PW = doc.internal.pageSize.getWidth(),
    PH = doc.internal.pageSize.getHeight(),
    W = PW - M * 2;
  let y = M;
  function put(text: string, size: number, style: string, indent: number, gap: number) {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    const lines: string[] = doc.splitTextToSize(text, W - indent);
    lines.forEach((l) => {
      if (y > PH - M) {
        doc.addPage();
        y = M;
      }
      doc.text(l, M + indent, y);
      y += size + 3;
    });
    y += gap;
  }
  put(title, 18, "bold", 0, 12);
  markdown.split("\n").forEach((raw) => {
    const t = raw.replace(/\s+$/, "");
    if (!t.trim()) {
      y += 4;
      return;
    }
    const clean = t
      .replace(/\*\*/g, "")
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*\d+\.\s+/, "")
      .replace(/_/g, "");
    if (t.startsWith("### ")) put(t.slice(4).replace(/\*\*/g, ""), 12.5, "bold", 0, 4);
    else if (t.startsWith("## ")) put(t.slice(3).replace(/\*\*/g, ""), 14.5, "bold", 0, 5);
    else if (t.startsWith("# ")) put(t.slice(2).replace(/\*\*/g, ""), 16, "bold", 0, 6);
    else if (/^\s*[-*]\s+/.test(t)) put("•  " + clean, 11, "normal", 16, 2);
    else if (/^\s*\d+\.\s+/.test(t)) put(clean, 11, "normal", 16, 2);
    else put(clean, 11, "normal", 0, 4);
  });
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

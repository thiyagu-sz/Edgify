import { PNG } from "pngjs";
import { jsPDF } from "jspdf";

/**
 * Real PDF fixtures, generated at test time rather than committed as binaries.
 *
 * Generating them keeps the corpus honest: a committed `scanned.pdf` is a file nobody can read the
 * provenance of, and reviewers cannot tell whether it still has the property the test claims. The
 * generators are the specification — `scannedPdf` is image-only *because there is no text call in
 * it*, which is visible right here.
 *
 * jsPDF is already a dependency (the client-side export path) and pngjs is already a devDependency
 * (the visual-diff harness), so this adds nothing to the tree.
 */

/** A multi-page PDF with a real text layer. The ordinary case. */
export function textPdf(pages = 2, paragraph = "Edgify test document. "): Uint8Array<ArrayBuffer> {
  const doc = new jsPDF();
  for (let p = 0; p < pages; p++) {
    if (p > 0) doc.addPage();
    // Wrapped so the text genuinely lands on the page rather than overflowing off it.
    doc.text(doc.splitTextToSize(`Page ${p + 1}. ${paragraph.repeat(12)}`, 180), 10, 20);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

/** A solid-colour PNG — stands in for a page photographed by a phone. */
function flatPng(width = 120, height = 160): string {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 220;
    png.data[i + 1] = 220;
    png.data[i + 2] = 220;
    png.data[i + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

/**
 * A multi-page PDF containing ONLY images — no text layer at all.
 *
 * This is the scanned-lecture-notes case from docs/04 §4, and the reason it matters is that it
 * looks like a successful parse: extraction returns cleanly with almost nothing in it. Note there
 * is deliberately no `doc.text(...)` call anywhere below.
 */
export function scannedPdf(pages = 4): Uint8Array<ArrayBuffer> {
  const doc = new jsPDF();
  const image = flatPng();
  for (let p = 0; p < pages; p++) {
    if (p > 0) doc.addPage();
    doc.addImage(image, "PNG", 15, 20, 120, 160);
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

/** A password-protected PDF. pdf.js raises `PasswordException` (code 1) opening this. */
export function encryptedPdf(): Uint8Array<ArrayBuffer> {
  const doc = new jsPDF({ encryption: { userPassword: "secret" } });
  doc.text("Classified lecture notes.", 10, 20);
  return new Uint8Array(doc.output("arraybuffer"));
}

/** Truncated bytes with a plausible header — pdf.js raises `InvalidPDFException`. */
export function corruptPdf(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode("%PDF-1.4\nthis file was damaged in transit\n");
}

/** A PDF whose bytes exceed `maxBytes`, for the oversized-upload path. */
export function oversizePdf(maxBytes: number): Uint8Array<ArrayBuffer> {
  const doc = new jsPDF();
  const image = flatPng(1400, 1400);
  let bytes = new Uint8Array(0);
  for (let page = 0; page < 400; page++) {
    if (page > 0) doc.addPage();
    doc.addImage(image, "PNG", 5, 5, 200, 200);
    if (page % 20 === 19) {
      bytes = new Uint8Array(doc.output("arraybuffer"));
      if (bytes.byteLength > maxBytes) return bytes;
    }
  }
  return new Uint8Array(doc.output("arraybuffer"));
}

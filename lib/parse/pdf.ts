import { extractText, getDocumentProxy } from "unpdf";
import { log } from "../log";
import { ParseFailure } from "./failures";

/**
 * PDF text extraction, in memory. The file is never stored (docs/03).
 *
 * MEMORY DISCIPLINE IS THE POINT OF THIS MODULE. unpdf holds the parsed document — and every page
 * it touched — until the document is released, and skipping that quietly exhausts container
 * memory after a few dozen uploads (docs/02-tech-stack.md, docs/04 §4). So the release runs in a
 * `finally`, on every path, including the ones that throw.
 *
 * A correction to the wording in those documents, found by probing the library rather than
 * trusting the prose: `PDFDocumentProxy` has **no `destroy()`**. It exposes `numPages` and
 * `cleanup()`; the release that frees the worker is `proxy.loadingTask.destroy()`. Writing the
 * documented `proxy.destroy()` in a `finally` would throw `TypeError: proxy.destroy is not a
 * function` — and because it is in a `finally`, that TypeError would REPLACE whatever real error
 * was propagating, turning "password-protected PDF" into an unrelated crash. Verified against
 * unpdf 1.8 / pdf.js.
 */

/** The subset of `PDFDocumentProxy` this module uses — the seam tests inject a fake through. */
export type PdfDocument = {
  numPages: number;
  loadingTask?: { destroy: () => Promise<void> } | null;
  cleanup?: () => Promise<unknown>;
};

export type PdfDeps = {
  open?: (bytes: Uint8Array) => Promise<PdfDocument>;
  read?: (doc: PdfDocument) => Promise<{ totalPages: number; text: string }>;
};

export type PdfExtract = { text: string; pageCount: number };

/**
 * CONSUMES `bytes`. pdf.js takes ownership of the array it is handed and DETACHES the underlying
 * buffer, so the caller's `Uint8Array` is empty afterwards and parsing the same array twice fails
 * the second time with "Invalid PDF structure" — a corrupt-file message for a perfectly good file.
 *
 * Found by parsing one fixture in a loop (`test/e2e/parse-memory.mjs`), which failed on iteration
 * two. Deliberately NOT worked around with a defensive copy: this module exists to keep peak
 * memory down, and copying would duplicate up to 10 MB on every upload to protect against a reuse
 * that no caller performs. Each upload owns its own buffer and parses it once. If that ever stops
 * being true, copy at the call site rather than taxing every request.
 */

const defaultOpen = (bytes: Uint8Array) =>
  getDocumentProxy(bytes) as unknown as Promise<PdfDocument>;

const defaultRead = async (doc: PdfDocument) => {
  const { totalPages, text } = await extractText(doc as never, { mergePages: true });
  return { totalPages, text };
};

/**
 * Release the parsed document. Never throws.
 *
 * Swallowing here is deliberate and narrow: this runs in a `finally`, so a throw would mask the
 * caller's real error (see the module note). A failed release is a leak worth knowing about, so
 * it is logged rather than ignored.
 */
export async function releaseDocument(doc: PdfDocument | undefined): Promise<void> {
  if (!doc) return;
  try {
    await doc.loadingTask?.destroy();
  } catch (error) {
    log.error("pdf: releasing the document failed", error);
  }
}

export async function extractPdf(
  bytes: Uint8Array,
  deps: PdfDeps = {},
): Promise<PdfExtract | ParseFailure> {
  const open = deps.open ?? defaultOpen;
  const read = deps.read ?? defaultRead;

  let doc: PdfDocument | undefined;
  try {
    doc = await open(bytes);
    const { totalPages, text } = await read(doc);
    return { text: text.trim(), pageCount: totalPages };
  } catch (error) {
    return mapPdfError(error);
  } finally {
    await releaseDocument(doc);
  }
}

/**
 * pdf.js error → catalogue failure. Classified by the exception's `name`, which is what pdf.js
 * actually sets; all three were confirmed by feeding the library real files:
 *   - encrypted PDF  → `PasswordException`     ("No password given", code 1)
 *   - truncated file → `InvalidPDFException`   ("Invalid PDF structure.")
 *   - zero bytes     → `InvalidPDFException`   ("The PDF file is empty…")
 */
function mapPdfError(error: unknown): ParseFailure {
  const name = (error as { name?: unknown })?.name;
  if (name === "PasswordException") return new ParseFailure("encrypted", error);
  if (name === "InvalidPDFException") return new ParseFailure("corrupt", error);
  // Anything else is still a file we could not read; the user's next action is the same.
  return new ParseFailure("corrupt", error);
}

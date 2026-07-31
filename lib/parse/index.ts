import { ParseFailure, isParseFailure } from "./failures";
import { MIN_CHARS, type SourceType, classifySource } from "./limits";
import { extractDocx } from "./docx";
import { extractPdf, type PdfDeps } from "./pdf";

/**
 * Document intake: bytes in, extracted text out, or a typed `ParseFailure` (docs/05 W3 steps 3–7).
 *
 * The original file is NEVER stored (docs/03) — it exists only as the `bytes` argument and is
 * discarded when this returns. Only the text travels onward.
 */

export type ExtractedDocument = {
  text: string;
  charCount: number;
  /** PDFs only; null elsewhere. Needed to tell a scan from a genuinely short note. */
  pageCount: number | null;
  sourceType: SourceType;
  title: string;
};

export type ExtractDeps = { pdf?: PdfDeps };

/** Decode text/markdown as UTF-8, tolerating a BOM. */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "").trim();
}

/**
 * Filename minus extension, as the document title. Untrusted — it reaches the UI, so it is length
 * capped here and ESCAPED at render (`.claude/rules/ui.md`); it is never interpolated into markup
 * or into a prompt's instruction region.
 */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  return (base.length > 0 ? base : "Document").slice(0, 200);
}

/**
 * Distinguish a scanned document from a short one (docs/04 §4).
 *
 * Both conditions are required. Photographed lecture notes are common among students and produce
 * a multi-page PDF with almost no extractable text; a one-page note that happens to be brief is a
 * different problem with a different next action ("add a few paragraphs", not "paste the text").
 * Reporting either as the other is worse than saying nothing.
 */
export function isLikelyScanned(text: string, pageCount: number | null): boolean {
  return text.length < MIN_CHARS && pageCount !== null && pageCount > 1;
}

export async function extractDocument(
  bytes: Uint8Array,
  filename: string,
  mimeType?: string | null,
  deps: ExtractDeps = {},
): Promise<ExtractedDocument | ParseFailure> {
  const sourceType = classifySource(filename, mimeType);
  if (isParseFailure(sourceType)) return sourceType;

  let text: string;
  let pageCount: number | null = null;

  if (sourceType === "pdf") {
    const result = await extractPdf(bytes, deps.pdf);
    if (isParseFailure(result)) return result;
    text = result.text;
    pageCount = result.pageCount;
  } else if (sourceType === "docx") {
    const result = await extractDocx(bytes);
    if (isParseFailure(result)) return result;
    text = result.text;
  } else {
    text = decodeText(bytes);
  }

  // Order matters: the scanned case is the more specific diagnosis and must be tested first,
  // otherwise every scan is reported as "not enough text" and the user is told to do the one
  // thing that will not help.
  if (isLikelyScanned(text, pageCount)) {
    return new ParseFailure("scanned", { pageCount, charCount: text.length });
  }
  if (text.length < MIN_CHARS) {
    return new ParseFailure("too_short", { charCount: text.length });
  }

  return {
    text,
    charCount: text.length,
    pageCount,
    sourceType,
    title: titleFromFilename(filename),
  };
}

export { ParseFailure, isParseFailure } from "./failures";
export {
  MAX_BYTES,
  MIN_CHARS,
  checkContentLength,
  classifySource,
  readCapped,
  type SourceType,
} from "./limits";
export { PARSE_MESSAGES, type ParseFailureKind } from "./failures";
export { readUploadedFile } from "./upload";

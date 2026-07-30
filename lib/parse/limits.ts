import { ParseFailure } from "./failures";

/**
 * Size and type gates, applied BEFORE any file bytes are read (docs/05 W3 step 2, W4 step 1).
 *
 * The ordering is the whole point: a 10 MB cap enforced after buffering the body has already let
 * an attacker spend the memory. `checkContentLength` answers from the header alone, so the route
 * can reject before touching `request.formData()`.
 */

/** 10 MB (docs/04 §4). Binary megabytes — the message says "10 MB" and this is what it means. */
export const MAX_BYTES = 10 * 1024 * 1024;

/** Under this, there is not enough material to generate from (docs/04 §4). */
export const MIN_CHARS = 200;

export type SourceType = "pdf" | "docx" | "txt" | "md";

/**
 * Extension → source type. The extension is authoritative and the MIME type is corroborating:
 * browsers disagree about DOCX (`application/octet-stream` is common) and markdown (often
 * `text/plain` or empty), so rejecting on MIME alone turns valid uploads away.
 */
const BY_EXTENSION: Record<string, SourceType> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  md: "md",
  markdown: "md",
};

/** Types we will accept a MIME claim from, when the extension is missing or unknown. */
const BY_MIME: Record<string, SourceType> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

/**
 * Classify an upload, or fail with the unsupported-type message.
 *
 * Note `.doc` is deliberately absent: mammoth reads DOCX (Open XML) only, and legacy binary `.doc`
 * would parse to garbage rather than fail cleanly. Telling the user we do not read it is honest;
 * silently extracting noise is not.
 */
export function classifySource(
  filename: string,
  mimeType?: string | null,
): SourceType | ParseFailure {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;

  const mime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  const byMime = BY_MIME[mime];
  if (byMime) return byMime;

  return new ParseFailure("unsupported_type", { filename, mimeType });
}

/**
 * Reject an oversized upload from the `Content-Length` header, before the body is read.
 *
 * Returns a failure only when the header PROVES the body is too large. A missing or unparseable
 * header is not a pass — it means this gate cannot answer, and the streaming cap in
 * `readCapped` is what actually enforces the limit. The header is attacker-controlled, so it is
 * an optimisation (reject early, cheaply) layered over a real check, never the real check itself.
 */
export function checkContentLength(header: string | null): ParseFailure | null {
  if (header === null) return null;
  const declared = Number(header);
  if (!Number.isFinite(declared)) return null;
  if (declared > MAX_BYTES) return new ParseFailure("too_large", { declared });
  return null;
}

/**
 * Read a stream into memory, aborting past `MAX_BYTES`.
 *
 * This is the gate that actually holds. A client can send `Content-Length: 1` with a 12 MB body,
 * or no length at all under chunked encoding; without a running total we would buffer all of it
 * and the cap would be decorative.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_BYTES,
): Promise<Uint8Array<ArrayBuffer> | ParseFailure> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return new ParseFailure("too_large", { readBytes: total });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

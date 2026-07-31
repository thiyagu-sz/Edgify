import { ParseFailure, isParseFailure } from "./failures";
import { MAX_BYTES, checkContentLength, readCapped } from "./limits";

/**
 * Pull the uploaded `file` field out of a multipart request, applying BOTH size gates before any
 * bytes are parsed (docs/05 W3 step 2, W4 step 1).
 *
 * Shared by `POST /api/documents/extract` (W3) and `POST /api/documents` (W4). Those two routes
 * differ entirely in what they do with the text — one returns it and stores nothing, the other
 * creates a document and a graph — but their intake is identical, and duplicating it would mean
 * two copies of a size check where drift is a security regression rather than a cosmetic one.
 *
 * Returns the `File` (never its bytes on disk — nothing is stored, docs/03) or a `ParseFailure`
 * carrying a message from the docs/04 §4 catalogue.
 */

/**
 * Slack over the 10 MB file cap for the multipart envelope (boundaries, headers, field names).
 * Without it a legitimate 10 MB file is rejected for the few hundred bytes of wrapper around it.
 * The file's own size is checked exactly, below.
 */
const ENVELOPE_SLACK = 64 * 1024;

export async function readUploadedFile(
  request: Request,
): Promise<File | ParseFailure> {
  // Gate #1: the declared length, answered before the body is touched.
  const declared = checkContentLength(request.headers.get("content-length"));
  if (declared) return declared;

  if (!request.body) return new ParseFailure("unsupported_type", { reason: "no body" });

  // Gate #2: the running total, because Content-Length is client-supplied and may lie.
  const raw = await readCapped(request.body, MAX_BYTES + ENVELOPE_SLACK);
  if (isParseFailure(raw)) return raw;

  let file: File | null = null;
  try {
    // Re-wrap the capped bytes so the platform parses the multipart envelope. Reading
    // `request.formData()` directly would buffer the whole body with no cap at all.
    const form = await new Response(raw, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
    const field = form.get("file");
    if (field instanceof File) file = field;
  } catch (error) {
    return new ParseFailure("corrupt", { cause: error });
  }

  if (!file) return new ParseFailure("unsupported_type", { reason: "no file field" });

  // The file's own size, now known exactly rather than inferred from the envelope.
  if (file.size > MAX_BYTES) {
    return new ParseFailure("too_large", { size: file.size });
  }

  return file;
}

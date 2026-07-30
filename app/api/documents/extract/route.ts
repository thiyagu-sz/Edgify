import { auth } from "@/lib/auth";
import { log } from "@/lib/log";
import {
  MAX_BYTES,
  checkContentLength,
  extractDocument,
  isParseFailure,
  readCapped,
} from "@/lib/parse";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/documents/extract — pull text out of an uploaded file and hand it straight back
 * (W3, docs/05). Quick Notes then proceeds exactly as W2.
 *
 * THE FILE IS NEVER STORED. It exists as bytes for the duration of this handler and is discarded
 * when it returns; nothing is written to any table (docs/03). This route is deliberately
 * side-effect free — no document row, no quota, no model call — so a user can try a file, see
 * what came out, and edit it before spending anything.
 *
 * Returning the extracted text to the textarea rather than hiding it is the point of W3: the user
 * can tell at a glance whether extraction worked, which turns a silent failure into an obvious one.
 *
 * Response contract:
 *   200 `{ text, charCount, title, pageCount, sourceType }` — success
 *   200 `{ message }`                                        — a failure the user can act on
 *   401 `{ message }`                                        — no session
 * Never a stack, a status code, or a vendor name in the body (docs/04 §7).
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Slack over the 10 MB file cap for the multipart envelope (boundaries, headers, field names).
 * Without it a legitimate 10 MB file is rejected for the few hundred bytes of wrapper around it.
 * The file's own size is checked exactly, below.
 */
const ENVELOPE_SLACK = 64 * 1024;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }

  // Size gate #1: the declared length, answered before the body is touched (W3 step 2).
  const declared = checkContentLength(request.headers.get("content-length"));
  if (declared) return json({ message: declared.message });

  if (!request.body) {
    return json({ message: "Edgify reads PDF, DOCX, TXT and Markdown files." });
  }

  // Size gate #2: the running total, because Content-Length is client-supplied and may lie.
  const raw = await readCapped(request.body, MAX_BYTES + ENVELOPE_SLACK);
  if (isParseFailure(raw)) return json({ message: raw.message });

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
    log.error("documents/extract: could not read the upload", error, {
      userId: session.user.id,
    });
    return json({
      message: "That file couldn't be read. It may be damaged — try re-saving or exporting it again.",
    });
  }

  if (!file) {
    return json({ message: "Edgify reads PDF, DOCX, TXT and Markdown files." });
  }
  // The file's own size, now known exactly rather than inferred from the envelope.
  if (file.size > MAX_BYTES) {
    return json({
      message: "That file is over the 10 MB limit. Try a smaller file, or paste the text directly.",
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await extractDocument(bytes, file.name, file.type);

  if (isParseFailure(result)) {
    // The internal cause goes to the log; the user gets the catalogue message only.
    log.error("documents/extract: extraction failed", result.cause, {
      userId: session.user.id,
      kind: result.kind,
      filename: file.name,
    });
    return json({ message: result.message });
  }

  return json({
    text: result.text,
    charCount: result.charCount,
    title: result.title,
    pageCount: result.pageCount,
    sourceType: result.sourceType,
  });
}

export const POST = withRateLimit("documents-extract", handler, {
  limit: 30,
  windowMs: 60_000,
});

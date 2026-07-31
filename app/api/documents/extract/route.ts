import { auth } from "@/lib/auth";
import { log } from "@/lib/log";
import { extractDocument, isParseFailure, readUploadedFile } from "@/lib/parse";
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

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function handler(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ message: "Please sign in again to continue." }, 401);
  }

  // Both size gates and the multipart parse (W3 steps 2–3), shared with POST /api/documents.
  const file = await readUploadedFile(request);
  if (isParseFailure(file)) {
    if (file.kind === "corrupt") {
      log.error("documents/extract: could not read the upload", file.cause, {
        userId: session.user.id,
      });
    }
    return json({ message: file.message });
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

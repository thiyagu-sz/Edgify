import { modelLadder } from "@/lib/ai/models";
import { auth } from "@/lib/auth";
import { contentHash } from "@/lib/cache";
import { createDocument } from "@/lib/db/queries/documents";
import { cloneGraphByContentHash, createGraph } from "@/lib/db/queries/graphs";
import { recordLedger } from "@/lib/db/queries/ledger";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { extractDocument, isParseFailure, readUploadedFile } from "@/lib/parse";
import { withRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/documents — create the document and its graph row, and return the graph id
 * immediately (W4 steps 1–11, docs/05). The build itself is a SEPARATE client-fired request
 * (`POST /api/graph/:id/build`), deliberately not `after()` — see docs/05 W4 and docs/06 Phase 7.
 *
 * THE FILE IS NEVER STORED (docs/03). Only its extracted text is, on the caller's own row.
 *
 * Step 8 is the highest-value line in the system: if any user already has a `ready` graph for
 * this exact content, the concepts and edges are CLONED under this user for zero tokens and the
 * response comes back `ready` on the spot. Ten students, one lecture PDF, one build.
 *
 * ORDER CORRECTION vs the literal W4 text (2026-07-30). W4 reads "step 8 clone and return, DONE"
 * before "step 9 insert document". That order cannot be implemented: `graphs.documentId` is NOT
 * NULL with a foreign key, so a cloned graph has nothing to point at until the caller's own
 * document row exists — and the caller needs that row anyway, both so Quick Notes works on the
 * document (the W4 failure promise) and so concept detail has text to ground against (W5). The
 * document row is therefore inserted FIRST and the clone attempted second. docs/05 has been
 * corrected to match.
 *
 * Response contract:
 *   200 `{ graphId, status }`  — "ready" when cloned, "processing" when a build is needed
 *   200 `{ message }`          — a failure the user can act on (too large, scanned, …)
 *   401 `{ message }`          — no session
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
  const userId = session.user.id;

  // Steps 1–6: size gates, type check, extract, discard the file. Shared with W3's extract route.
  const file = await readUploadedFile(request);
  if (isParseFailure(file)) {
    if (file.kind === "corrupt") {
      log.error("documents: could not read the upload", file.cause, { userId });
    }
    return json({ message: file.message });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const extracted = await extractDocument(bytes, file.name, file.type);
  if (isParseFailure(extracted)) {
    // The internal cause goes to the log; the user gets the catalogue message only.
    log.error("documents: extraction failed", extracted.cause, {
      userId,
      kind: extracted.kind,
    });
    return json({ message: extracted.message });
  }

  // Step 7: the content address. Normalised before hashing, sharing `normalizeText` with the
  // generation cache so both agree on what "the same document" means.
  // Version-scoped (lib/cache.ts): a document uploaded before the sampling fix hashes
  // differently now, so its head-only graph is never cloned to a post-fix uploader.
  const hash = contentHash(extracted.text, env.PROMPT_VERSION);

  // Step 9 (moved ahead of step 8 — see the note above).
  const document = await createDocument(userId, {
    title: extracted.title,
    contentHash: hash,
    charCount: extracted.charCount,
    pageCount: extracted.pageCount,
    sourceType: extracted.sourceType,
    extractedText: extracted.text,
  });

  // Step 8: the classroom case. Zero tokens, no quota, no model call.
  try {
    const clonedGraphId = await cloneGraphByContentHash(userId, hash, document.id);
    if (clonedGraphId) {
      /**
       * A ledger row is still written — every path that COULD have spent tokens records one
       * (.claude/rules/ai.md). `tier: "cache"` is what makes the saving visible: without it the
       * clone is indistinguishable from a user who never uploaded, and the single most valuable
       * mechanism in the system would be invisible on the cost dashboard.
       *
       * Quota is deliberately NOT consumed. A cloned graph costs nothing, so charging for it
       * would break the same invariant a cache hit protects (docs/05 W2, "cache before quota").
       */
      await recordLedger(userId, {
        operation: "graph_structure",
        tier: "cache",
        outcome: "ok",
        tokensIn: 0,
        tokensOut: 0,
      });
      return json({ graphId: clonedGraphId, status: "ready" });
    }
  } catch (error) {
    // A clone failure is not a user-visible failure: fall through and build normally. The worst
    // case is one avoidable generation, which is strictly better than refusing the upload.
    log.error("documents: clone attempt failed, building instead", error, {
      userId,
      documentId: document.id,
    });
  }

  // Steps 10–11: a graph to build, returned immediately so the client can fire the build and poll.
  const graph = await createGraph(userId, {
    documentId: document.id,
    title: extracted.title,
    // `graphs.modelId` is NOT NULL and the row exists before the ladder runs, so this records the
    // model we INTEND to use; `finishGraph` overwrites it with whichever rung actually answered.
    modelId: modelLadder()[0].modelId,
    promptVersion: env.PROMPT_VERSION,
  });

  return json({ graphId: graph.id, status: "processing" });
}

export const POST = withRateLimit("documents", handler, {
  limit: 30,
  windowMs: 60_000,
});

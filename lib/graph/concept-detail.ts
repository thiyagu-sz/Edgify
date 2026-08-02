import { ServiceBusyError, generate } from "../ai/generate";
import type { ConceptDetail } from "../ai/schemas";
import { getConcept, setConceptDetail } from "../db/queries/concepts";
import { getDocument } from "../db/queries/documents";
import { getGraph } from "../db/queries/graphs";
import { log } from "../log";

/**
 * Lazy per-concept explanation (W5, docs/05) — the service behind
 * `POST /api/concepts/:id/detail`. Route handlers stay thin (AGENTS.md), so the ownership walk,
 * the ladder call and the persist all live here.
 *
 * ── ON THE REQUEST PATH, DELIBERATELY ───────────────────────────────────────────────────────
 *
 * The obvious "improvement" here is to return the generated detail immediately and persist it in
 * `after()`. It is not taken, and not because it would not work: `after()` is an OPEN HARD
 * BLOCKER in this project (docs/09 §1.6, docs/06 Phase 7). It depends on Cloud Run keeping CPU
 * allocated after the response is sent — unconfirmed here — and it is entangled with
 * `ZOMBIE-PROCESSING-ROW`, where work killed off the response path leaves no trace. Adopting it
 * in a small, safe-looking corner would be deciding that question by accident, in the place where
 * the consequences are least visible, before the place where they are worst has been fixed.
 *
 * So it stays synchronous. The cost is honest and small: ONE model call inside one request, well
 * inside the 300s deadline — unlike the graph build, which walks the whole ladder and is the
 * reason §1.6 exists. `after()` stays entirely unadopted until §1.6 is resolved and
 * CPU-after-response is confirmed in Phase 7; that is one decision, made once, deliberately.
 */

export type ConceptDetailResult =
  | { status: "ready"; detail: ConceptDetail; cached: boolean }
  /** The ladder was exhausted. The panel falls back to the concept's own summary (W5). */
  | { status: "unavailable"; summary: string }
  /** No such concept, or not this user's. Indistinguishable on purpose. */
  | { status: "not_found" };

export async function getOrCreateConceptDetail(
  userId: string,
  conceptId: string,
): Promise<ConceptDetailResult> {
  // Ownership: `getConcept` resolves through the owning graph, so a guessed uuid reads nothing.
  const concept = await getConcept(userId, conceptId);
  if (!concept) return { status: "not_found" };

  /**
   * W5 step 1 — already generated? Return it and make NO model call. This is what makes "clicking
   * a concept generates detail once" true across sessions and devices, not just within one page:
   * the client's in-memory cache handles a revisit in the same session, this handles a reload.
   *
   * No ledger row is written here. Nothing was spent and no model was called — this is a plain
   * indexed read, the same as `GET /api/graph/:id`, and recording it as a generation would
   * overstate demand on the cost dashboard.
   */
  if (concept.detailJson !== null) {
    return { status: "ready", detail: concept.detailJson as ConceptDetail, cached: true };
  }

  // The document text is the grounding (W5 step 3). Both reads are ownership-scoped again rather
  // than trusted from the concept row.
  const graph = await getGraph(userId, concept.graphId);
  if (!graph) return { status: "not_found" };
  const document = await getDocument(userId, graph.documentId);
  if (!document?.extractedText) {
    log.error("concept detail: document text missing", undefined, { userId, conceptId });
    return { status: "unavailable", summary: concept.summary ?? "" };
  }

  let result;
  try {
    // The ladder owns cache, quota, retries, validation and the ledger (AGENTS.md rule 3). The
    // cache key carries the concept SLUG — without it every concept in one graph would collide on
    // the document text and render the first concept's definition under every name.
    result = await generate({
      userId,
      operation: "concept_detail",
      conceptSlug: concept.slug,
      conceptName: concept.name,
      text: document.extractedText,
    });
  } catch (error) {
    if (!(error instanceof ServiceBusyError)) {
      log.error("concept detail: unexpected failure", error, { userId, conceptId });
    }
    /**
     * Tiers 5 and 6 both land here: `lib/demo/index.ts` does not answer `concept_detail`, so
     * there is no demo detail to substitute (docs/05 W5). The panel falls back to the concept's
     * own summary, which WAS derived from this user's document during the structure pass — the
     * only content available that is genuinely about their material.
     */
    return { status: "unavailable", summary: concept.summary ?? "" };
  }

  const detail = result.data as ConceptDetail;

  /**
   * W5 step 4. `setConceptDetail` is conditional on `detailJson IS NULL`, so if a concurrent
   * request committed first this writes nothing and returns false. In that case we serve THEIR
   * value, not ours: the two are separate generations and the client caches whichever it is
   * handed, so letting the second writer win would mean two users of the same graph — or the same
   * user in two tabs — permanently holding different explanations of one concept.
   */
  const stored = await setConceptDetail(userId, conceptId, detail);
  if (!stored) {
    const current = await getConcept(userId, conceptId);
    if (current?.detailJson) {
      return { status: "ready", detail: current.detailJson as ConceptDetail, cached: true };
    }
    // The row vanished between the two reads (a deleted document cascades). Nothing to serve.
    return { status: "not_found" };
  }

  return { status: "ready", detail, cached: result.tier === "cache" };
}

import { sampleForGraph, sentenceEndAtOrBefore } from "./sampling";

/**
 * Passage retrieval for the lazy concept explanation (W5, docs/05).
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────────────────────
 *
 * `buildConceptDetailPrompt` grounded every explanation in `documentText.slice(0, 7000)` — the
 * same opening 7,000 characters for every concept in the graph, which on a real 10-page PDF is
 * 25.4% of it. Whatever the user clicked, the model read the beginning of the document.
 *
 * The graph sampling fix made this WORSE rather than merely leaving it unfixed. Before it, the two
 * defects were at least consistent: a primer graph explained from primer text. After it they
 * diverge — the graph correctly names "Renin-Angiotensin-Aldosterone System", and clicking that
 * node produced an explanation written from cell membranes and haematocrit. A correct-looking
 * graph with mismatched explanations reads worse than the honest primer it replaced, because the
 * user is told the document teaches RAAS and then shown an account of something else under that
 * heading.
 *
 * ── WHY THIS IS RETRIEVAL AND NOT SAMPLING ───────────────────────────────────────────────────
 *
 * The obvious move is to reuse `sampleForGraph`, and it is the wrong shape. Sampling spreads the
 * budget evenly across the document, so every concept would be grounded in a little of everything:
 * RAAS explained partly from baroreceptor text, partly from blood composition. The graph pass wants
 * breadth because it is describing the whole document; a per-concept explanation wants the passages
 * ABOUT THAT CONCEPT. Same budget, opposite selection criterion.
 *
 * Keyword scoring, not embeddings: no new dependency, no second model call, no vector store. The
 * concept's own `summary` — written by the structure pass and otherwise unused — is the strongest
 * query material available, which is why it is now plumbed through.
 *
 * Pure and deterministic, so the content-addressed cache still works.
 */

/** Matches `CONCEPT_DETAIL_TEXT_LIMIT`; passed in so the two cannot drift. */
const DEFAULT_LIMIT = 7000;

/** Passage granularity — a few sentences, enough to explain something. */
const PASSAGE_CHARS = 700;
/** The document opening, always kept: it names the topic and stops explanations drifting generic. */
const ANCHOR_CHARS = 500;
/** Budget held back for the passage markers. */
const MARKER_RESERVE = 400;
/** Query terms shorter than this carry no signal. */
const MIN_TERM_LENGTH = 3;

/**
 * Words that appear in almost every concept name and would match almost every passage. Kept short
 * deliberately — an aggressive list would strip the domain words that actually discriminate.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "its", "are", "was", "were",
  "which", "their", "them", "then", "than", "how", "what", "why", "when", "over", "under",
  "system", "process", "concept", "using", "used", "between", "within", "about",
]);

export type ConceptQuery = {
  name: string;
  slug: string;
  summary?: string | null;
};

/** Split a query into scoring terms: lower-cased, de-duplicated, stopwords removed. */
export function queryTerms(concept: ConceptQuery): string[] {
  const raw = [concept.name, concept.slug.replace(/[-_]+/g, " "), concept.summary ?? ""].join(" ");
  const terms = raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

type Passage = { start: number; end: number; text: string };

/** Cut the document into sentence-aligned passages of roughly `PASSAGE_CHARS`. */
export function splitPassages(text: string, size = PASSAGE_CHARS): Passage[] {
  const passages: Passage[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const target = Math.min(text.length, cursor + size);
    const end = target >= text.length ? text.length : sentenceEndAtOrBefore(text, target);
    const safeEnd = end > cursor ? end : Math.min(text.length, cursor + size);
    passages.push({ start: cursor, end: safeEnd, text: text.slice(cursor, safeEnd) });
    cursor = safeEnd;
  }
  return passages;
}

/**
 * Score a passage against the query terms.
 *
 * Term frequency SATURATES (`1 + ln(count)`) so a passage cannot win by repeating one word twenty
 * times — which matters here, because a document's own section about a concept repeats its name
 * constantly and would otherwise crowd out the passages that explain the mechanism. A match on the
 * full concept phrase is worth more than the sum of its words.
 */
export function scorePassage(passage: string, terms: string[], phrase: string): number {
  const haystack = passage.toLowerCase();
  let score = 0;

  for (const term of terms) {
    let count = 0;
    let index = haystack.indexOf(term);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(term, index + term.length);
    }
    if (count > 0) score += 1 + Math.log(count);
  }

  if (phrase.length >= MIN_TERM_LENGTH && haystack.includes(phrase)) score += 3;
  return score;
}

function marker(index: number, total: number, percent: number): string {
  return `\n\n[passage ${index} of ${total} — ~${percent}% into the document]\n\n`;
}

/**
 * Select the passages of `text` most relevant to `concept`, up to `limit` characters.
 *
 * Returns the document unchanged when it already fits, so short uploads keep today's behaviour
 * exactly. Falls back to representative sampling when the concept matches nothing — still strictly
 * better than reading the opening, and it keeps a concept whose name does not appear verbatim (an
 * abbreviation, a synonym) from getting an empty grounding.
 */
export function retrieveForConcept(
  text: string,
  concept: ConceptQuery,
  limit: number = DEFAULT_LIMIT,
): string {
  if (text.length <= limit) return text;

  const terms = queryTerms(concept);
  const phrase = concept.name.toLowerCase().trim();
  const passages = splitPassages(text);

  const scored = passages
    .map((passage) => ({ passage, score: scorePassage(passage.text, terms, phrase) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return sampleForGraph(text, limit);

  const anchorEnd = sentenceEndAtOrBefore(text, Math.min(ANCHOR_CHARS, text.length));
  let used = anchorEnd + MARKER_RESERVE;
  const picked: Passage[] = [];

  for (const { passage } of scored) {
    // The anchor already covers the opening; do not pay for it twice.
    if (passage.end <= anchorEnd) continue;
    const cost = passage.end - passage.start;
    if (used + cost > limit) continue;
    picked.push(passage);
    used += cost;
  }

  if (picked.length === 0) return sampleForGraph(text, limit);

  // Re-order by position: the passages were CHOSEN by relevance but must be READ in the order the
  // document presents them, or the explanation reads as a shuffled argument.
  picked.sort((a, b) => a.start - b.start);

  const parts: string[] = [text.slice(0, anchorEnd)];
  picked.forEach((passage, index) => {
    const percent = Math.round((passage.start / text.length) * 100);
    parts.push(marker(index + 1, picked.length, percent));
    parts.push(passage.text);
  });

  const joined = parts.join("");
  return joined.length <= limit ? joined : joined.slice(0, sentenceEndAtOrBefore(joined, limit));
}

/**
 * Representative sampling of a document for graph structure extraction (W4 step 13).
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────────────────────
 *
 * `buildGraphPrompt` used to feed the model `text.slice(0, GRAPH_TEXT_LIMIT)` — the first 9,000
 * characters and nothing else. Measured on a real 10-page PDF: 27,592 characters extracted, 9,000
 * fed, **32.6% of the document, ~3.3 of 10 pages**. The number of pages seen is CONSTANT, so a
 * 30-page paper gets ~11% and a 100-page textbook the same 3.3 pages.
 *
 * For a document that opens with background and reaches its subject later — which is what a
 * pathophysiology paper, a textbook chapter and most lecture notes look like — the model never
 * sees the subject at all. Uploading "Pathophysiology of Hypertension" produced
 * `Human Cell · Blood Composition · Heart Anatomy · Blood Vessel Structure`: a cardiovascular
 * primer, with no RAAS, no baroreceptors, no peripheral resistance.
 *
 * That was NOT a reasoning failure and not a prompt failure. Both were ruled out by experiment
 * before this was written: feeding the same prompt the mechanism section produced exactly the
 * right graph, and rewording the prompt while keeping the head-truncation changed nothing. The
 * model was faithfully summarising the only text it was given.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────────────────────
 *
 * Spends the SAME 9,000-character budget on excerpts drawn from across the whole document. One
 * model call, same input size, zero cost delta — what changes is WHICH 9,000 characters.
 *
 * Pure and deterministic: a function of the text alone, with no I/O and no clock. Determinism is
 * a requirement rather than a nicety, because `generate()` keys its cache on the document text —
 * a sampler that varied between runs would miss every cache hit.
 */

/** Matches `GRAPH_TEXT_LIMIT`; passed in by the caller so the two cannot drift. */
const DEFAULT_LIMIT = 9000;

/** Text before the first heading — title, abstract, introduction. */
const SECTION_ANCHOR_MAX = 1500;
/**
 * The opening slice kept when no headings are detectable.
 *
 * Kept SMALL on purpose. Its only job is to establish what the document is about — title, abstract,
 * opening paragraph — and the opening is precisely the region that produced the wrong graph in the
 * first place. An earlier draft spent 2,500 of the 9,000 budget here, which left five windows for
 * the rest of the document and they misaligned with a five-topic paper: the baroreceptor section
 * fell in a gap and never reached the model. Trading 1,300 characters of redundant background for
 * an extra window is the right side of that bargain.
 */
const PROPORTIONAL_ANCHOR = 1200;
/**
 * Floor and ceiling on how much of each section is taken.
 *
 * The floor is the coherence constraint and it is the reason coverage is capped rather than
 * maximised: a prerequisite relation ("X raises Y") has to fall INSIDE one excerpt to be visible,
 * so excerpts must stay long enough to contain one. Twenty 300-character slices would touch more
 * of the document and yield almost no edges.
 */
const MIN_SECTION_CHARS = 600;
const MAX_SECTION_CHARS = 1800;
/**
 * Window count for the unstructured fallback: as MANY windows as the budget allows while each
 * stays at the coherence floor.
 *
 * This is the opposite of what an earlier draft did, and the correction came from measurement.
 * "Fewer, larger windows" reads like the coherence-preserving choice, but what decides whether a
 * topic is seen at all is the STRIDE between window starts: a block of the document is missed
 * entirely unless a window begins inside it, so coverage requires
 *
 *     stride <= topic block size
 *
 * With a fixed budget, stride shrinks only by adding windows. Six windows over a 20,000-character
 * five-topic paper gave a stride of ~3,500 against ~1,850-character blocks, and the sodium-handling
 * section fell in a gap — twice, at two different window counts, before this was reasoned through
 * rather than tuned. Twelve windows at the 600-character floor give a stride of ~1,660, below the
 * block size, and every topic is reached.
 *
 * The floor is what keeps this from degenerating: 600 characters is three or four sentences, still
 * long enough to contain a relation between two concepts. Slicing thinner would buy stride at the
 * cost of the edges the graph is made of.
 */
const MIN_PROPORTIONAL_WINDOWS = 4;
const MAX_PROPORTIONAL_WINDOWS = 12;
const TARGET_WINDOW_CHARS = MIN_SECTION_CHARS;
/** How far a cut may move to land on a sentence boundary. */
const SNAP_SLACK = 250;
/** Budget held back for the excerpt markers. */
const MARKER_RESERVE = 450;

/** A detected section heading and where it starts. */
export type DetectedHeading = { offset: number; text: string };

const NUMBERED = /^\s*\d+(?:\.\d+)*\.?\s+\S/;
const MARKDOWN_HEADING = /^\s*#{1,6}\s+\S/;
/** Four or more capitals with no lower-case letters — `PATENTABILITY SEARCH REPORT`. */
const ALL_CAPS = /^[^a-z]*[A-Z]{4,}[^a-z]*$/;
const MAX_HEADING_LENGTH = 90;

/**
 * Find section headings.
 *
 * DELIBERATELY PRECISION-ORIENTED. The obvious heuristic — "a short line is a heading" — was
 * measured against a real PDF and matched 302 of 491 lines, because PDF extraction breaks text at
 * visual line wraps rather than at paragraphs. Numbered and ALL-CAPS forms matched 27 lines on
 * the same document and every one was a genuine heading (`1. INTRODUCTION`,
 * `3.1 Databases and Sources Searched`). Five real headings beat fifty false ones: a false
 * heading splits a section mid-argument, which is the exact incoherence this design exists to
 * avoid.
 */
export function detectHeadings(text: string): DetectedHeading[] {
  const headings: DetectedHeading[] = [];
  let offset = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 0 &&
      trimmed.length <= MAX_HEADING_LENGTH &&
      (NUMBERED.test(trimmed) || MARKDOWN_HEADING.test(trimmed) || ALL_CAPS.test(trimmed))
    ) {
      headings.push({ offset, text: trimmed });
    }
    offset += line.length + 1; // + the newline consumed by split
  }

  return headings;
}

/** The index just after the first sentence end at or after `from`, or `from` if there is none. */
function sentenceStartAtOrAfter(text: string, from: number, slack = SNAP_SLACK): number {
  const window = text.slice(from, from + slack);
  const match = /[.!?]\s/.exec(window);
  if (match) return from + match.index + match[0].length;
  const newline = window.indexOf("\n");
  return newline === -1 ? from : from + newline + 1;
}

/** The index just after the last sentence end at or before `to`, or `to` if there is none. */
function sentenceEndAtOrBefore(text: string, to: number, slack = SNAP_SLACK): number {
  const start = Math.max(0, to - slack);
  const window = text.slice(start, to);
  const matches = [...window.matchAll(/[.!?]\s/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    return start + (last.index ?? 0) + last[0].length;
  }
  const newline = window.lastIndexOf("\n");
  return newline === -1 ? to : start + newline + 1;
}

/** Position marker placed before each excerpt. */
function marker(index: number, total: number, percent: number, omitted: number): string {
  const omission = omitted > 0 ? `, ~${omitted.toLocaleString()} chars omitted before this` : "";
  return `\n\n[excerpt ${index} of ${total} — ~${percent}% into the document${omission}]\n\n`;
}

type Excerpt = { start: number; end: number };

/** Assemble excerpts into the final string, with markers, never exceeding `limit`. */
function assemble(text: string, excerpts: Excerpt[], limit: number): string {
  const parts: string[] = [];
  let previousEnd = 0;

  excerpts.forEach((excerpt, index) => {
    const percent = Math.round((excerpt.start / text.length) * 100);
    const omitted = Math.max(0, excerpt.start - previousEnd);
    // The first excerpt is the anchor and needs no marker — it IS the start of the document.
    if (index > 0) parts.push(marker(index + 1, excerpts.length, percent, omitted));
    parts.push(text.slice(excerpt.start, excerpt.end));
    previousEnd = excerpt.end;
  });

  const joined = parts.join("");
  if (joined.length <= limit) return joined;
  // Last-resort guard: trim to the budget at a sentence boundary rather than mid-word.
  return joined.slice(0, sentenceEndAtOrBefore(joined, limit));
}

/** Evenly spread `count` picks across `total` items, always including the first. */
function spread(total: number, count: number): number[] {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  const step = total / count;
  return Array.from({ length: count }, (_, i) => Math.min(total - 1, Math.floor(i * step)));
}

/** Structure-aware sampling: each excerpt begins at a real section boundary. */
function sectionSample(text: string, headings: DetectedHeading[], limit: number): string {
  const anchorEnd = sentenceEndAtOrBefore(
    text,
    Math.min(headings[0].offset, SECTION_ANCHOR_MAX),
  );
  const anchor: Excerpt = { start: 0, end: anchorEnd };

  const sections = headings.map((heading, index) => ({
    start: heading.offset,
    end: index + 1 < headings.length ? headings[index + 1].offset : text.length,
  }));

  const budget = limit - anchorEnd - MARKER_RESERVE;
  const affordable = Math.max(1, Math.floor(budget / MIN_SECTION_CHARS));
  const chosen = spread(sections.length, Math.min(sections.length, affordable));
  const perSection = Math.min(
    MAX_SECTION_CHARS,
    Math.max(MIN_SECTION_CHARS, Math.floor(budget / chosen.length)),
  );

  const excerpts: Excerpt[] = [anchor];
  for (const index of chosen) {
    const section = sections[index];
    // Start AT the heading line, so the excerpt carries its own title — that label is what lets
    // the model treat the fragment as a topic rather than as loose prose.
    const start = Math.max(section.start, anchor.end);
    if (start >= section.end) continue;
    const end = sentenceEndAtOrBefore(text, Math.min(section.end, start + perSection));
    if (end > start) excerpts.push({ start, end });
  }

  return assemble(text, excerpts, limit);
}

/** Fallback for documents with no detectable structure: evenly spaced windows. */
function proportionalSample(text: string, limit: number): string {
  const anchorEnd = sentenceEndAtOrBefore(text, PROPORTIONAL_ANCHOR);
  const budget = limit - anchorEnd - MARKER_RESERVE;
  const windows = Math.min(
    MAX_PROPORTIONAL_WINDOWS,
    Math.max(MIN_PROPORTIONAL_WINDOWS, Math.floor(budget / TARGET_WINDOW_CHARS)),
  );
  const windowSize = Math.max(MIN_SECTION_CHARS, Math.floor(budget / windows));

  const excerpts: Excerpt[] = [{ start: 0, end: anchorEnd }];
  const span = text.length - anchorEnd - windowSize;
  for (let i = 0; i < windows; i++) {
    const raw = anchorEnd + (span > 0 ? Math.floor((span * i) / (windows - 1)) : 0);
    const start = sentenceStartAtOrAfter(text, Math.max(raw, anchorEnd));
    const end = sentenceEndAtOrBefore(text, Math.min(text.length, start + windowSize));
    if (end > start) excerpts.push({ start, end });
    if (start + windowSize >= text.length) break;
  }

  return assemble(text, excerpts, limit);
}

/**
 * Sample `text` down to `limit` characters, drawing from across the whole document.
 *
 * Documents at or under the budget are returned UNCHANGED — the common case keeps today's exact
 * behaviour, so this carries no regression surface for short uploads.
 */
export function sampleForGraph(text: string, limit: number = DEFAULT_LIMIT): string {
  if (text.length <= limit) return text;

  const headings = detectHeadings(text);
  return headings.length >= 3
    ? sectionSample(text, headings, limit)
    : proportionalSample(text, limit);
}

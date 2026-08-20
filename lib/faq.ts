/**
 * The FAQ content, in one place, for the three public pages that carry one.
 *
 * WHY THIS IS A DATA MODULE AND NOT JSX. Two consumers must never disagree:
 *
 *  1. `components/faq-section.tsx`, which renders the questions and answers a person reads.
 *  2. `lib/structured-data.ts`, which emits `FAQPage` JSON-LD describing that same block.
 *
 * Google's structured-data policy is explicit that FAQ markup must match content visible on the
 * page, and marking up an answer the page does not show is the same category of violation as a
 * fabricated rating. Deriving both from this array makes the two identical by construction rather
 * than by review, and `lib/faq.test.ts` fails if a rendered answer and its marked-up answer ever
 * come apart.
 *
 * ── THE RULE FOR EVERY ANSWER HERE ──────────────────────────────────────────────────────────
 * The same rule `lib/legal.ts` runs under: nothing may be asserted unless this repository proves
 * it. Each answer below carries the file that establishes it. No outcome claim, no grade claim,
 * no user count, no accuracy percentage, and no forward-looking commercial promise appears in
 * any of them — an FAQ is the easiest place on a site to drift into all five, because the format
 * invites confident short answers.
 *
 * ── WHY ANSWERS CARRY NO INLINE LINKS ───────────────────────────────────────────────────────
 * `answer` is plain text, and a page that wants to point somewhere uses the separate `more`
 * field, rendered as its own link beneath the paragraph. An inline anchor would put words in the
 * rendered answer that are not in the marked-up one — the exact mismatch this module exists to
 * prevent — and an AI engine quoting the answer would lift link text with no destination.
 *
 * ── WHY THE QUESTIONS ARE PHRASED THE WAY THEY ARE ──────────────────────────────────────────
 * As a student would type them, not as a product team would title them ("Does it work with
 * scanned PDFs?", not "Scanned document support"). That is one phrasing that serves a person
 * skimming, a `FAQPage` entity, and an answer engine matching a query — and it costs nothing.
 */

export type FaqEntry = {
  /** Phrased as a real question, because that is what it is matched against. */
  question: string;
  /**
   * Plain text, self-contained, and true. Written to survive being quoted with no surrounding
   * context, which is both the GEO requirement and a decent test of whether it actually answers.
   */
  answer: string;
  /** An optional link rendered under the answer. Never part of the answer text. */
  more?: { href: string; label: string };
};

/**
 * Split an FAQ into the entry that gets prominence and the rest.
 *
 * THE PATTERN THIS ENCODES, used identically on all three pages: the FIRST entry of each list is
 * that page's core question, and it is rendered high up as a standalone answer block
 * (`components/key-answer.tsx`) rather than being buried seventh in an accordion. The remaining
 * entries render as the FAQ section further down.
 *
 * Both halves are still on the page, so `FAQPage` markup covering the whole list stays truthful —
 * position is not visibility. Splitting here rather than with `[0]` and `.slice(1)` at three call
 * sites means the two halves cannot overlap or lose an entry, and `lib/faq.test.ts` checks that
 * the union is the original list.
 */
export function splitFaq(entries: FaqEntry[]): { lead: FaqEntry; rest: FaqEntry[] } {
  const [lead, ...rest] = entries;
  if (!lead) throw new Error("splitFaq: an FAQ list must have at least one entry");
  return { lead, rest };
}

/**
 * Facts reused across several answers, so a correction lands everywhere at once.
 *
 *  - Accepted types: the literal `accept` list on both file inputs
 *    (`components/notes/quick-notes.tsx`, `components/graph/knowledge-graph.tsx`).
 *  - 10 MB: `MAX_BYTES` in `lib/parse/limits.ts`.
 */
const ACCEPTED_FILES =
  "PDF, DOCX, TXT and Markdown files up to 10 MB. PowerPoint decks, audio and video are not " +
  "supported.";

/**
 * ── LANDING PAGE ────────────────────────────────────────────────────────────────────────────
 *
 * The brand-query FAQ: what someone asks before deciding whether to try it at all. It is also
 * the block most likely to be quoted when an answer engine is asked what Edgify is, which is why
 * the first entry is a definition rather than a pitch.
 */
export const SITE_FAQ: FaqEntry[] = [
  {
    question: "What is Edgify?",
    // Both features and their inputs, exactly as implemented. No adjective that cannot be checked.
    answer:
      "Edgify is a study workspace that works from your own course material. It has two " +
      "features: Quick Notes turns a document or pasted text into short revision notes in a " +
      "choice of study formats, and the Knowledge Graph builds a concept map from an uploaded " +
      "document showing which topics have to be understood before which.",
  },
  {
    question: "What file types can I upload?",
    answer:
      `${ACCEPTED_FILES} Quick Notes also takes text pasted straight into the box, with no file ` +
      "at all. The Knowledge Graph needs a file.",
  },
  {
    question: "Does Edgify cost anything?",
    /**
     * Present tense, stating only what is true today. `app/sign-up/page.tsx` refused a
     * "free, no card needed" line for the same reason — no billing existing is a fact; "free"
     * is a promise about the future. The daily cap is `QUOTA_DAILY_LIMIT` (lib/quota.ts), which
     * is configurable per deployment, so it is described rather than numbered.
     */
    answer:
      "There is no billing in Edgify today — no payment is taken and no card is asked for. Each " +
      "account has a daily limit on how many generations it can run.",
  },
  {
    question: "How is this different from asking a chatbot to summarise my notes?",
    /**
     * The comparison a student actually makes, answered by describing the difference rather than
     * by claiming to be better. Every clause is checkable: prompts are grounded in the submitted
     * text only (lib/ai/prompts.ts), the formats are a fixed list, and the graph extracts
     * prerequisite edges (lib/ai/schemas.ts graphSchema).
     */
    answer:
      "Edgify works only from the document you give it, and hands the result back in a fixed set " +
      "of revision formats rather than as conversation. The Knowledge Graph does something a " +
      "summary cannot: it extracts the concepts in your document and the prerequisite links " +
      "between them, so the order to learn them in falls out of the material itself.",
  },
  {
    question: "Are the generated notes accurate?",
    // Names its own subject rather than opening with "They" — quoted on its own, a pronoun
    // pointing back at the question is an answer about nothing.
    answer:
      "Edgify's notes are written by an AI model working from your document, and they can still " +
      "be wrong, or miss something your document covers. Check anything you are going to rely on " +
      "against your own source material before an exam.",
    more: { href: "/ai-disclaimer", label: "Read the AI disclaimer" },
  },
  {
    question: "What happens to the material I upload?",
    /**
     * Three facts, each from code: the original file is discarded after text extraction
     * (`lib/parse/index.ts` — "The original file is NEVER stored"), every query is userId-scoped
     * (AGENTS.md rule 2, enforced in lib/db/queries/), and there is no delete control
     * (app/(legal)/privacy/page.tsx §11). The last one is the uncomfortable one and is stated
     * anyway.
     */
    answer:
      "The file itself is never stored — Edgify extracts the text and discards the upload. That " +
      "text and anything generated from it are stored against your account, and every query for " +
      "them is filtered by your account, so no other user can read your material. Edgify does " +
      "not yet have a self-service delete button; deletion is by request.",
    more: { href: "/privacy", label: "Read the privacy policy" },
  },
  {
    question: "Can I export what Edgify makes?",
    // `exportPdf` / `exportDoc` in lib/export.ts, used by both features.
    answer:
      "Yes. Revision notes and the knowledge-graph study guide both export to PDF or Word, from " +
      "the browser.",
  },
  {
    question: "Do I need an account?",
    /**
     * Both providers are real: `emailAndPassword` and `socialProviders.google` in lib/auth.ts.
     * The demo genuinely needs no session — it sits outside the `(app)` group deliberately
     * (app/demo/page.tsx).
     */
    answer:
      "To use your own material, yes — sign in with Google, or with an email address and " +
      "password. The demo runs on prepared material and needs no account at all.",
    more: { href: "/demo", label: "Try the demo" },
  },
];

/**
 * ── /pdf-to-study-notes ─────────────────────────────────────────────────────────────────────
 *
 * Constrained by the same rule the page itself documents: SIX markdown formats are described and
 * no quiz claim is made, because the two quiz formats currently fail at the model provider.
 * Restore a quiz answer here at the same time as the page's copy, not before.
 */
export const PDF_NOTES_FAQ: FaqEntry[] = [
  {
    question: "How do I turn a PDF into study notes?",
    answer:
      "Upload the PDF, choose the format you want the notes in, and Edgify writes them from the " +
      "text of that document. Nothing is pulled in from outside the file you gave it, so the " +
      "notes stay inside your syllabus.",
  },
  {
    question: "What kinds of notes can I get back?",
    // The six markdown formats, verbatim from `FORMATS` in lib/ai/prompts.ts.
    answer:
      "Six formats, from the same upload: key points, main concepts, exam points, short notes, " +
      "formulas and terms, and a summary. You can switch format and regenerate as the way you " +
      "are revising changes.",
  },
  {
    question: "Does it work with scanned PDFs?",
    /**
     * A clean no with the reason. `lib/parse/index.ts` has no OCR path and `isLikelyScanned`
     * detects this case explicitly to report it rather than returning empty notes.
     */
    answer:
      "No. Edgify reads the text layer of a PDF, and a scan or a photograph of a page has none " +
      "to read — there is no OCR step. Edgify detects this and tells you rather than returning " +
      "empty notes; pasting the text in directly is the way around it.",
  },
  {
    question: "Can I paste text instead of uploading a file?",
    answer:
      "Yes. Quick Notes takes a pasted block of text as readily as a file, which is the quicker " +
      "route for a few pages copied out of a slide deck or a web page.",
  },
  {
    question: "How large can the document be?",
    answer:
      `${ACCEPTED_FILES} A long document is condensed rather than reproduced: every format is ` +
      "written to be revisable in minutes, so length in equals brevity out.",
  },
  {
    question: "Can I keep the notes after I generate them?",
    answer:
      "Yes. Notes can be copied out, or exported as a PDF or a Word document that you keep " +
      "whether or not you come back to Edgify.",
  },
];

/**
 * ── /concept-map-for-studying ───────────────────────────────────────────────────────────────
 *
 * The vocabulary rule from the page applies here too: students search for "concept map", the
 * product calls it the Knowledge Graph, and both appear so the page is findable without
 * pretending to be a feature it is not.
 */
export const CONCEPT_MAP_FAQ: FaqEntry[] = [
  {
    question: "What is a concept map for studying?",
    /**
     * Definition-style and deliberately generic in the first sentence: this answer is about the
     * technique, not about Edgify, which is what makes it worth quoting. The product appears
     * once, at the end, as an instance of the thing.
     */
    answer:
      "A concept map for studying is a diagram of the ideas in a subject and the links between " +
      "them, used to see how a topic fits together rather than to memorise it as a list. When " +
      "the links record which concepts must be understood first, the map also gives you an " +
      "order to study in. Edgify builds that second kind from a document you upload.",
  },
  {
    question: "How does Edgify build the concept map?",
    answer:
      "You upload one document. Edgify extracts its text, identifies the concepts it covers, and " +
      "works out which of them are prerequisites for which — then draws that as a graph, with " +
      "each concept as a node and each prerequisite as an edge between two nodes.",
  },
  {
    question: "Is a concept map the same as a mind map?",
    /**
     * The distinction is real and it is the reason this feature exists, so it is worth a
     * question of its own. Nothing here disparages mind maps; it says what the two do
     * differently.
     */
    answer:
      "Not quite. A mind map radiates outward from one central topic and its branches record " +
      "associations. The map Edgify builds is a dependency graph: an edge means one concept has " +
      "to be understood before another. That is a stronger claim than an association, and it is " +
      "what lets a study order be read off the diagram.",
  },
  {
    question: "Can I paste text instead of uploading a file?",
    // Stated plainly rather than glossed: the graph path has no paste box.
    answer:
      "Not for the concept map — it is built from an uploaded file. Quick Notes, the other half " +
      "of Edgify, does accept pasted text.",
  },
  {
    question: "What can I see about a single concept?",
    /**
     * Every item listed is rendered by `components/graph/knowledge-graph.tsx` and typed in
     * `lib/ai/schemas.ts` conceptDetailSchema. Per-concept quizzes DO work — this is the one
     * quiz surface the launch may point at.
     */
    answer:
      "Opening a concept gives you a definition, a worked example, its direct prerequisites, " +
      "what it unlocks next, related concepts, a readiness score based on how much of its " +
      "groundwork you have covered, and a short quiz and flashcards for that concept alone.",
  },
  {
    question: "Does it tell me what to study first?",
    answer:
      "Yes. The study plan orders the concepts prerequisite-first — nothing appears before the " +
      "things it depends on — with a time estimate per concept and a count of how many you have " +
      "marked as mastered.",
  },
];

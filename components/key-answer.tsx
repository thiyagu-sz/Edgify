import Link from "next/link";
import type { FaqEntry } from "@/lib/faq";

/**
 * The direct-answer block that sits immediately below the hero on every public page.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────────────────────
 * A hero is written to make someone want to read on. That is a different job from stating, in
 * plain sentences, what this thing is — and the second one is what a search snippet, an AI
 * Overview, and a ChatGPT or Perplexity citation actually lift. Those systems quote a passage
 * that stands on its own; marketing copy quoted out of context reads as a slogan and gets passed
 * over for a competitor's clearer paragraph.
 *
 * So this block carries ONE question phrased the way a person would ask it, and an answer written
 * to survive being extracted with nothing around it: no "as we mentioned above", no pronoun whose
 * referent is the heading, no claim that needs the rest of the page to be true.
 *
 * ── IT IS THE PAGE'S OWN FAQ ENTRY, NOT A SECOND COPY OF IT ─────────────────────────────────
 * The entry comes from `lib/faq.ts` via `splitFaq`, which hands the first question to this block
 * and the remainder to `components/faq-section.tsx`. That matters for correctness rather than
 * tidiness: the `FAQPage` markup covers the whole list, and every answer in it has to be visible
 * on the page. Rendering the lead answer here — prominently, above the fold on most screens —
 * satisfies that for the first entry while keeping exactly one copy of the text in the codebase.
 *
 * Server component, no state, no client JavaScript. The text is in the initial HTML, which is the
 * only version a crawler is guaranteed to see.
 */
export function KeyAnswer({ entry }: { entry: FaqEntry }) {
  return (
    <section className="lx-answer gborder" aria-labelledby="key-answer-heading">
      {/*
        `<h2>`, not `<h3>` or a styled `<div>`. It is the first section under the page's `<h1>`,
        and both a screen reader and an extractor read the answer as belonging to this question
        only because the heading level says it does.
      */}
      <h2 id="key-answer-heading">{entry.question}</h2>
      <p>{entry.answer}</p>
      {entry.more ? (
        <Link className="lx-faq-more" href={entry.more.href}>
          {entry.more.label}
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      ) : null}
    </section>
  );
}

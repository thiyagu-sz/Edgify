import Link from "next/link";
import type { FaqEntry } from "@/lib/faq";

/**
 * The FAQ block shared by the landing page and the two SEO landing pages.
 *
 * A SERVER COMPONENT with no state and no client JavaScript, like every public page it renders
 * on. Content comes from `lib/faq.ts`, which is also what `lib/structured-data.ts` reads to emit
 * the `FAQPage` markup — the two cannot drift.
 *
 * ── WHY EVERY ANSWER IS ALWAYS VISIBLE ──────────────────────────────────────────────────────
 * The obvious way to build this is a set of `<details>` accordions. This does not, and the
 * reason is the point of the block rather than a style preference:
 *
 *  - An FAQ exists here to be extracted — by Google, and by the answer engines this page is
 *    written for. Collapsed content is present in the HTML, so a crawler can read it, but it is
 *    content a person has to act to see, and Google has said for years that it may weight such
 *    content less than what is visible on load. There is nothing to gain by hiding six short
 *    paragraphs.
 *  - `FAQPage` markup must describe content the page actually shows. Always-visible answers make
 *    that trivially true instead of an argument about whether a closed `<details>` counts.
 *  - No accordion means no client component, no `useState`, and no JavaScript shipped to a page
 *    whose whole design goal is to ship none.
 *
 * ── HEADING LEVEL ───────────────────────────────────────────────────────────────────────────
 * Each question is an `<h3>` under the section's own `<h2>`, so the document outline stays
 * ordered — one `<h1>` per page, `<h2>` per section, questions beneath their section. Screen
 * readers and extraction both walk that outline, and a level skipped to get a font size is the
 * most common way it gets broken.
 */
export function FaqSection({
  entries,
  heading,
  eyebrow,
  index,
  id = "faq",
}: {
  entries: FaqEntry[];
  /** The section's `<h2>`. Phrased as a question where the page's voice allows it. */
  heading: string;
  /** The small uppercase label in the section header rule, matching the sections around it. */
  eyebrow: string;
  /** The `(0n)` counter the landing sections use. Passed in because it depends on page order. */
  index: string;
  id?: string;
}) {
  return (
    <section className="lx-section" id={id} aria-labelledby={`${id}-heading`}>
      <div className="lx-shead">
        <div className="row">
          <span>{eyebrow}</span>
          <span>({index})</span>
        </div>
        <div className="line" />
        <h2 className="lx-h2" id={`${id}-heading`}>
          {heading}
        </h2>
      </div>
      <div className="lx-faq">
        {entries.map(({ question, answer, more }) => (
          <div className="lx-faq-item gborder" key={question}>
            <h3>{question}</h3>
            <p>{answer}</p>
            {more ? (
              <Link className="lx-faq-more" href={more.href}>
                {more.label}
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
          </div>
        ))}
      </div>
    </section>
  );
}

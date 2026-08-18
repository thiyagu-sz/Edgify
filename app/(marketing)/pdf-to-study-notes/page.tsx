import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon, BrandMark, CheckIcon } from "@/components/brand-mark";
import { SiteFooter } from "@/components/site-footer";
import { env } from "@/lib/env";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";
import { breadcrumbJsonLd, serialiseJsonLd } from "@/lib/structured-data";

/**
 * `/pdf-to-study-notes` — a public SEO landing page for the "PDF to study notes" intent.
 *
 * A SERVER COMPONENT with no client island, like the landing page it borrows its styling from.
 * Every class here is already defined in the `#landing` block of app/globals.css; this page adds
 * no CSS and no new component, so it inherits the existing responsive breakpoints (900 / 720 /
 * 560px) and the `prefers-reduced-motion` handling for free.
 *
 * ── WHAT THIS PAGE MAY AND MAY NOT SAY ──────────────────────────────────────────────────────
 * Every capability below is checked against the implementation, not against the marketing copy:
 *
 *  - Accepted uploads are PDF, DOCX, TXT and Markdown — the literal `accept` list on the file
 *    input in `components/notes/quick-notes.tsx`. PowerPoint, audio and video are NOT accepted and
 *    are not mentioned.
 *  - Quick Notes takes a pasted block of text as well as a file. (The Knowledge Graph does not —
 *    see the sibling page.)
 *  - SIX formats are described, not eight. `lib/ai/prompts.ts` defines eight, but two of them
 *    (MCQs, Quick Test) are currently rejected by the model provider: strict `response_format`
 *    requires every property to be listed as required, and the quiz schema's `explanation` is
 *    optional. Sending search traffic to a path that fails is worse than saying less, so this page
 *    describes the six markdown formats that work and makes no quiz claim at all. Restore the
 *    quiz copy here when that is fixed.
 *  - Export is PDF and Word — `onPdf` / `onDoc` in the same component.
 *
 * No outcome, grade, accuracy or user-count claim appears anywhere, and none may be added.
 */

const DESCRIPTION =
  "Upload a lecture PDF, DOCX or text file and turn it into short revision notes in six study " +
  "formats — built from your own course material.";

const TITLE = "PDF to Study Notes";
const SOCIAL_TITLE = "PDF to study notes — revision notes from your own course material";

/**
 * `title` is a plain string so the root layout's `%s — Edgify` template applies, giving
 * "PDF to Study Notes — Edgify".
 *
 * The `openGraph` and `twitter` blocks re-spread the shared images because a page-level block
 * REPLACES the root's rather than merging with it — omitting them ships a card with no picture.
 * `lib/seo.ts` documents the footgun and `lib/seo.test.ts` fails if this is forgotten.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/pdf-to-study-notes" },
  openGraph: {
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
    url: "/pdf-to-study-notes",
    type: "website",
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
    images: TWITTER_IMAGES,
  },
};

/** The six markdown formats, verbatim from `lib/ai/prompts.ts`. Quiz formats are excluded — see above. */
const FORMATS = [
  { name: "Key Points", desc: "The 6–10 most important, most testable points." },
  { name: "Main Concepts", desc: "The core concepts, each defined in one line." },
  { name: "Exam Points", desc: "High-yield facts, plus the questions likely to be asked." },
  { name: "Short Notes", desc: "The whole topic condensed to the essentials." },
  { name: "Formulas & Terms", desc: "Key formulas, definitions and terms worth memorising." },
  { name: "Summary", desc: "A tight one- to two-paragraph recap." },
] as const;

export default function PdfToStudyNotesPage() {
  return (
    <div id="landing">
      {/*
        BreadcrumbList only. Organization, WebSite and SoftwareApplication are stated once on `/`
        and are deliberately not repeated here (lib/structured-data.ts). Content is module
        constants with no user or model input, and `<` is escaped by `serialiseJsonLd` — the two
        conditions that make `dangerouslySetInnerHTML` safe.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serialiseJsonLd(breadcrumbJsonLd(env.SITE_URL, TITLE, "/pdf-to-study-notes")),
        }}
      />
      <div className="lx-grid-bg" />
      <div
        className="lx-glow"
        style={{ width: 560, height: 560, background: "rgba(96,165,250,.16)", top: -160, left: "50%", transform: "translateX(-55%)" }}
      />

      <div className="lx-wrap">
        <nav className="lx-nav">
          <Link href="/" className="lx-brand" aria-label="Edgify home">
            <BrandMark />
            edgify
          </Link>
          <div className="lx-navlinks">
            <Link href="/concept-map-for-studying">Concept map</Link>
            <Link href="/demo">Try the demo</Link>
          </div>
          <div className="lx-navr">
            <Link href="/sign-up" className="lx-btn-primary">
              Sign up
              <ArrowIcon />
            </Link>
          </div>
        </nav>

        <header className="lx-hero">
          <div className="lx-pill" style={{ marginBottom: 22 }}>
            <span className="tag">Quick Notes</span> From your own material
          </div>
          <h1 className="lx-h1">
            Turn your PDF into <span className="lx-blue">study notes.</span>
          </h1>
          <p className="lx-sub">
            Upload the lecture PDF you were already going to read, and get it back as short,
            scannable revision notes — grouped, condensed and drawn only from what your document
            actually says.
          </p>
          <div className="lx-hero-cta">
            <Link href="/sign-up" className="lx-btn-primary">
              Sign up
              <ArrowIcon />
            </Link>
            <Link className="lx-btn-glass" href="/demo">
              Try the demo
              <ArrowIcon />
            </Link>
            <a className="lx-btn-glass" href="#how">
              How it works
              <ArrowIcon />
            </a>
          </div>
        </header>

        <section className="lx-section" id="how">
          <div className="lx-shead">
            <div className="row">
              <span>How it works</span>
              <span>(01)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">From a PDF to a study guide in three steps</h2>
          </div>
          <div className="lx-steps">
            <div className="lx-step gborder">
              <div className="n">1</div>
              <h4>Add your material</h4>
              <p>
                Upload a PDF, DOCX, TXT or Markdown file, or paste the text straight into the box.
                Edgify reads the text out of the file for you.
              </p>
            </div>
            <div className="lx-step gborder">
              <div className="n">2</div>
              <h4>Pick a format</h4>
              <p>
                Choose how you want it back — key points for a fast pass, formulas and terms for
                memorising, a summary for a quick recap.
              </p>
            </div>
            <div className="lx-step gborder">
              <div className="n">3</div>
              <h4>Revise and export</h4>
              <p>
                Notes appear as they are written. Copy them, or take a PDF or Word copy with you.
              </p>
            </div>
          </div>
        </section>

        <section className="lx-section">
          <div className="lx-shead">
            <div className="row">
              <span>Formats</span>
              <span>(02)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">Six ways to get your notes back</h2>
          </div>
          <div className="lx-2col">
            <div className="lx-mode qn gborder">
              <span className="badge">STUDY FORMATS</span>
              <h3>Same document, different study guide</h3>
              <p className="lead">
                One upload, six ways to read it back. Switch format and regenerate whenever the way
                you are revising changes.
              </p>
              <ul>
                {FORMATS.map(({ name, desc }) => (
                  <li key={name}>
                    <CheckIcon /> <strong>{name}</strong> — {desc}
                  </li>
                ))}
              </ul>
            </div>
            <div className="lx-mode kg gborder">
              <span className="badge">WHAT GOES IN</span>
              <h3>Your material, not a generic summary</h3>
              <p className="lead">
                Edgify works from the document you give it. Nothing is pulled in from elsewhere, so
                the notes stay tied to your syllabus and your lecturer&apos;s emphasis.
              </p>
              <ul>
                <li>
                  <CheckIcon /> Upload PDF, DOCX, TXT or Markdown
                </li>
                <li>
                  <CheckIcon /> Or paste text directly — no file needed
                </li>
                <li>
                  <CheckIcon /> Export the result to PDF or Word
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="lx-section">
          <div className="lx-shead">
            <div className="row">
              <span>Why your own material</span>
              <span>(03)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">Notes that match what you are actually examined on</h2>
          </div>
          <div className="lx-bento">
            <div className="lx-card col-4 gborder">
              <div className="lx-eyebrow">Scoped to your course</div>
              <h3>Only what your document covers</h3>
              <p>
                A general study guide covers the textbook. Your exam covers your module. Working
                from your own PDF keeps the notes inside the second one.
              </p>
            </div>
            <div className="lx-card col-4 gborder">
              <div className="lx-eyebrow">Nothing padded</div>
              <h3>Short on purpose</h3>
              <p>
                Every format is written to be revisable in minutes rather than complete. The point
                is what you can hold before an exam, not word count.
              </p>
            </div>
            <div className="lx-card col-4 gborder">
              <div className="lx-eyebrow">Yours to keep</div>
              <div className="lx-exp">
                <span>PDF</span>
                <span>DOC</span>
              </div>
              <h3>Export anywhere</h3>
            </div>
          </div>
        </section>

        <section className="lx-section">
          <div className="lx-shead">
            <div className="row">
              <span>Good to know</span>
              <span>(04)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">A few honest details</h2>
          </div>
          <div className="lx-2col">
            <div className="lx-mode qn gborder">
              <h3>What Edgify accepts</h3>
              <p className="lead">
                PDF, DOCX, TXT and Markdown files, or text pasted directly. Scanned pages with no
                text layer, slide decks in PowerPoint format, audio and video are not supported.
              </p>
            </div>
            <div className="lx-mode kg gborder">
              <h3>Notes are AI-generated</h3>
              <p className="lead">
                They are drawn from your document, but they can still get something wrong. Check
                them against your source before you rely on them — see our{" "}
                <Link href="/ai-disclaimer">AI disclaimer</Link>.
              </p>
            </div>
          </div>
        </section>

        <section className="lx-section">
          <div className="lx-cta gborder">
            <div
              className="lx-glow"
              style={{ width: 300, height: 300, background: "rgba(96,165,250,.25)", top: -60, left: "50%", transform: "translateX(-50%)" }}
            />
            <h2>Start with the PDF you already have</h2>
            <p>
              Bring one lecture and see what comes back. If you would rather look first, the demo
              runs on prepared material with nothing to set up.
            </p>
            <div className="lx-hero-cta">
              <Link href="/sign-up" className="lx-btn-primary">
                Sign up
                <ArrowIcon />
              </Link>
              <Link className="lx-btn-glass" href="/demo">
                Try the demo
                <ArrowIcon />
              </Link>
              <Link className="lx-btn-glass" href="/concept-map-for-studying">
                Build a concept map
                <ArrowIcon />
              </Link>
            </div>
          </div>
        </section>

        <SiteFooter brandMark={<BrandMark />} />
      </div>
    </div>
  );
}

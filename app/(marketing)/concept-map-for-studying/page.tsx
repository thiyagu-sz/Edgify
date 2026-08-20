import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon, BrandMark, CheckIcon } from "@/components/brand-mark";
import { FaqSection } from "@/components/faq-section";
import { KeyAnswer } from "@/components/key-answer";
import { SiteFooter } from "@/components/site-footer";
import { env } from "@/lib/env";
import { CONCEPT_MAP_FAQ, splitFaq } from "@/lib/faq";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";
import { breadcrumbJsonLd, faqJsonLd, serialiseJsonLdAll } from "@/lib/structured-data";

/**
 * `/concept-map-for-studying` — a public SEO landing page for the "concept map for studying" intent.
 *
 * A SERVER COMPONENT with no client island. Every class is already defined in the `#landing` block
 * of app/globals.css, so this page adds no CSS and no new component and inherits the existing
 * responsive breakpoints and reduced-motion handling.
 *
 * ── VOCABULARY, DELIBERATELY ────────────────────────────────────────────────────────────────
 * The product calls this the Knowledge Graph. Students searching for it call it a concept map or a
 * mind map. Both are used here — the searched term in the heading and lede, the product term where
 * the page explains what the feature is actually named — so the page is findable without
 * pretending to be a different feature.
 *
 * ── WHAT THIS PAGE MAY AND MAY NOT SAY ──────────────────────────────────────────────────────
 * Checked against the implementation, not the marketing copy:
 *
 *  - A graph is built from an UPLOADED FILE ONLY. `components/graph/knowledge-graph.tsx` offers
 *    "Upload document" and nothing else; there is no paste box on this path, unlike Quick Notes.
 *    That difference is stated on the page rather than glossed over.
 *  - Accepted types are PDF, DOCX, TXT and Markdown — the `accept` list on the file input. No
 *    PowerPoint, audio or video.
 *  - What the graph renders is real: concepts as nodes, prerequisite edges between them, and a
 *    concept panel carrying a definition, a worked example, DIRECT PREREQUISITES, LEARN NEXT,
 *    RELATED, a learning-readiness percentage, a per-concept quiz and flashcards.
 *  - The study plan is real: a prerequisite-first recommended order with a per-concept time
 *    estimate and a covered/total count, plus "mark as mastered".
 *  - Per-concept quizzes DO work (they are generated with the concept detail). This is the one
 *    quiz surface this launch may point at — the Quick Notes MCQ formats currently fail at the
 *    provider, which is why the sibling page makes no quiz claim.
 *
 * No outcome, grade, accuracy or user-count claim appears anywhere, and none may be added.
 */

const DESCRIPTION =
  "Turn a lecture PDF into a concept map that shows how topics connect, which concepts come " +
  "first, and how ready you are to study each one.";

const TITLE = "Concept Map for Studying, Built From Your Notes";
const SOCIAL_TITLE = "Concept map for studying — built from your own lecture notes";

/** See the sibling page: a page-level `openGraph` replaces the root's, images included (lib/seo.ts). */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/concept-map-for-studying" },
  openGraph: {
    title: SOCIAL_TITLE,
    description: DESCRIPTION,
    url: "/concept-map-for-studying",
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

export default function ConceptMapForStudyingPage() {
  /**
   * The page's core question is answered directly under the hero; the rest become the FAQ
   * section. Both halves are rendered, which is what lets the FAQ markup cover all of them.
   */
  const { lead, rest } = splitFaq(CONCEPT_MAP_FAQ);

  return (
    <div id="landing">
      {/* BreadcrumbList only — see lib/structured-data.ts for why nothing else is repeated here. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serialiseJsonLdAll([
            breadcrumbJsonLd(env.SITE_URL, TITLE, "/concept-map-for-studying"),
            // Every marked-up question and answer is rendered on this page: the first as the
            // answer block under the hero, the rest as the FAQ section (lib/faq.ts `splitFaq`).
            faqJsonLd(env.SITE_URL, "/concept-map-for-studying", CONCEPT_MAP_FAQ),
          ]),
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
            <Link href="/pdf-to-study-notes">PDF to study notes</Link>
            <Link href="/demo">Try the demo</Link>
          </div>
          <div className="lx-navr">
            <Link href="/sign-up" className="lx-btn-primary">
              Sign up
              <ArrowIcon />
            </Link>
          </div>
        </nav>

        {/*
          `<main>` names the page's primary content, so a screen reader's "skip to main content"
          and a crawler's extraction both start after the navigation rather than at the top of the
          document. It wraps the hero through to the closing call to action, and excludes the nav
          and the footer — site furniture rather than this page's content.
        */}
        <main>
          <header className="lx-hero">
            <div className="lx-pill" style={{ marginBottom: 22 }}>
              <span className="tag">Knowledge Graph</span> Concepts and prerequisites
            </div>
            <h1 className="lx-h1">
              Concept map <span className="lx-blue">for studying.</span>
            </h1>
            <p className="lx-sub">
              Drawing a mind map by hand is the slow part. Upload your lecture document and Edgify
              builds the map for you — the concepts it contains, and which ones you need to
              understand before the others make sense.
            </p>
            <div className="lx-hero-cta">
              <Link href="/sign-up" className="lx-btn-primary">
                Sign up
                <ArrowIcon />
              </Link>
              <Link className="lx-btn-glass" href="/demo">
                See a worked example
                <ArrowIcon />
              </Link>
              <a className="lx-btn-glass" href="#how">
                How it works
                <ArrowIcon />
              </a>
            </div>
          </header>

          {/* The page's core question, answered so the paragraph survives being quoted alone. */}
          <KeyAnswer entry={lead} />

          <section className="lx-section" id="how">
            <div className="lx-shead">
              <div className="row">
                <span>How it works</span>
                <span>(01)</span>
              </div>
              <div className="line" />
              <h2 className="lx-h2">From one document to a dependency graph</h2>
            </div>
            <div className="lx-steps">
              <div className="lx-step gborder">
                <div className="n">1</div>
                <h3>Upload the document</h3>
                <p>
                  A PDF, DOCX, TXT or Markdown file. The knowledge graph is built from a file, so
                  this step needs an upload rather than pasted text.
                </p>
              </div>
              <div className="lx-step gborder">
                <div className="n">2</div>
                <h3>Edgify reads it</h3>
                <p>
                  It pulls out the concepts the document actually teaches, then works out which ones
                  depend on which — the edges of the map.
                </p>
              </div>
              <div className="lx-step gborder">
                <div className="n">3</div>
                <h3>Explore and plan</h3>
                <p>
                  Click any concept for a grounded explanation, or open the study plan for a
                  prerequisite-first order to work through.
                </p>
              </div>
            </div>
          </section>

          <section className="lx-section">
            <div className="lx-shead">
              <div className="row">
                <span>Relationships</span>
                <span>(02)</span>
              </div>
              <div className="line" />
              <h2 className="lx-h2">What does a prerequisite map show that a topic list does not?</h2>
            </div>
            <div className="lx-2col">
              <div className="lx-mode kg gborder">
                <span className="badge">CONCEPT RELATIONSHIPS</span>
                <h3>Arrows that mean something</h3>
                <p className="lead">
                  A hand-drawn mind map shows that two ideas are related. This one shows which comes
                  first. Selecting a concept highlights the path into it, so you can see what it rests
                  on at a glance.
                </p>
                <ul>
                  <li>
                    <CheckIcon /> Concepts as nodes, prerequisites as directed edges
                  </li>
                  <li>
                    <CheckIcon /> Direct prerequisites and related concepts, listed per concept
                  </li>
                  <li>
                    <CheckIcon /> A concept library, ranked by how ready you are for each one
                  </li>
                </ul>
              </div>
              <div className="lx-mode qn gborder">
                <span className="badge">WHAT TO LEARN FIRST</span>
                <h3>Readiness, and a running order</h3>
                <p className="lead">
                  Each concept carries a learning-readiness score — how much of its groundwork you
                  have already covered — and a &ldquo;learn next&rdquo; pointer. The study plan turns
                  that into a numbered order with a time estimate for each step.
                </p>
                <ul>
                  <li>
                    <CheckIcon /> Readiness per concept, with the prerequisites still open
                  </li>
                  <li>
                    <CheckIcon /> A prerequisite-first recommended order
                  </li>
                  <li>
                    <CheckIcon /> Mark a concept mastered and the readiness updates everywhere
                  </li>
                </ul>
              </div>
            </div>
          </section>

          <section className="lx-section">
            <div className="lx-shead">
              <div className="row">
                <span>Per concept</span>
                <span>(03)</span>
              </div>
              <div className="line" />
              <h2 className="lx-h2">Open a node, get the whole concept</h2>
            </div>
            <div className="lx-bento">
              <div className="lx-card col-4 gborder">
                <div className="lx-eyebrow">Explanation</div>
                <h3>Grounded in your document</h3>
                <p>
                  A definition and a worked example written against the material you uploaded, not a
                  generic encyclopaedia entry.
                </p>
              </div>
              <div className="lx-card col-4 gborder">
                <div className="lx-eyebrow">Self-test</div>
                <h3>A quiz and flashcards</h3>
                <p>
                  Each concept comes with a multiple-choice question and a flashcard set, so you can
                  check a concept the moment you have read it.
                </p>
              </div>
              <div className="lx-card col-4 accent gborder">
                <div className="lx-eyebrow">Learning readiness</div>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 16 }}>
                  <svg width="72" height="72" viewBox="0 0 126 126" style={{ flexShrink: 0 }} aria-hidden="true">
                    <circle cx="63" cy="63" r="54" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="9" />
                    <circle
                      cx="63"
                      cy="63"
                      r="54"
                      fill="none"
                      stroke="#60a5fa"
                      strokeWidth="9"
                      strokeLinecap="round"
                      strokeDasharray="339.29"
                      strokeDashoffset="84.82"
                      transform="rotate(-90 63 63)"
                    />
                  </svg>
                  <div className="lx-ring-num">
                    How much of a concept&apos;s groundwork you have covered, and what is left.
                  </div>
                </div>
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
              <h2 className="lx-h2">What should I know before I upload something?</h2>
            </div>
            <div className="lx-2col">
              <div className="lx-mode kg gborder">
                <h3>It needs a file</h3>
                <p className="lead">
                  The knowledge graph is built from an uploaded document — PDF, DOCX, TXT or
                  Markdown. PowerPoint, audio and video are not supported. If you only have text to
                  paste, <Link href="/pdf-to-study-notes">Quick Notes</Link> takes that instead.
                </p>
              </div>
              <div className="lx-mode qn gborder">
                <h3>The map is AI-generated</h3>
                <p className="lead">
                  The concepts and the links between them are inferred from your document, and they
                  can be wrong. Treat the map as a starting point and check it — see our{" "}
                  <Link href="/ai-disclaimer">AI disclaimer</Link>.
                </p>
              </div>
            </div>
          </section>

          <FaqSection
            entries={rest}
            heading="Questions about concept maps for studying"
            eyebrow="FAQ"
            index="05"
          />

          <section className="lx-section">
            <div className="lx-cta gborder">
              <div
                className="lx-glow"
                style={{ width: 300, height: 300, background: "rgba(96,165,250,.25)", top: -60, left: "50%", transform: "translateX(-50%)" }}
              />
              <h2>See how your topic fits together</h2>
              <p>
                Upload one lecture and read the map it produces. The demo shows a finished graph on
                prepared material if you would rather look before signing up.
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
                <Link className="lx-btn-glass" href="/pdf-to-study-notes">
                  PDF to study notes
                  <ArrowIcon />
                </Link>
              </div>
            </div>
          </section>
        </main>

        <SiteFooter brandMark={<BrandMark />} />
      </div>
    </div>
  );
}

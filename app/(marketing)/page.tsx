import type { Metadata } from "next";
import Link from "next/link";
import { ArrowIcon, BrandMark, CheckIcon } from "@/components/brand-mark";
import { SiteFooter } from "@/components/site-footer";
import { env } from "@/lib/env";
import { OG_IMAGES, TWITTER_IMAGES } from "@/lib/seo";
import { landingJsonLd, serialiseJsonLd } from "@/lib/structured-data";

/**
 * The dark Fluxora landing page, ported from docs/reference/edgify-prototype.html (lines
 * 443-616). Styling lives in the `#landing` block of app/globals.css.
 *
 * This is a SERVER COMPONENT, and deliberately so. The prototype drives navigation with
 * `.js-launch` click handlers because it is a single file with no router; here those become
 * `<Link>`s and the in-page nav becomes ordinary fragment anchors, so the whole page needs no
 * client JavaScript at all. Nothing on it holds state.
 *
 * ONE ADDITION to the prototype: a third "Try the demo" call to action in the hero, plus a
 * matching nav and footer link. docs/06 Phase 6 requires a demo entry point and the prototype
 * has none — it predates the /demo route. It reuses the existing `.lx-btn-glass` styling and
 * removes nothing, so every element the prototype specifies is still present and unchanged.
 */

const DESCRIPTION =
  "Turn your notes, slides and PDFs into short, high-yield exam revision — and a dependency " +
  "graph that shows exactly what to learn first.";

/**
 * `title` is set through `absolute` so the root layout's `%s — Edgify` template does not turn
 * this into "Edgify — cram fast… — Edgify".
 *
 * The `openGraph` block is repeated rather than inherited because the root's version is the
 * site-wide default; stating it here keeps the landing page's share card correct if the root copy
 * ever changes for another reason. This is the URL that gets posted to Product Hunt.
 */
export const metadata: Metadata = {
  title: { absolute: "Edgify — cram fast, or understand deeply" },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    title: "Edgify — cram fast, or understand deeply",
    description: DESCRIPTION,
    url: "/",
    type: "website",
    // REQUIRED, not redundant. A page-level `openGraph` replaces the root's rather than merging
    // with it, so omitting this ships a card with no image (lib/seo.ts).
    images: OG_IMAGES,
  },
  twitter: {
    card: "summary_large_image",
    title: "Edgify — cram fast, or understand deeply",
    description: DESCRIPTION,
    images: TWITTER_IMAGES,
  },
};

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 15V4M12 15l-4-4M12 15l4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function LandingPage() {
  return (
    <div id="landing">
      {/*
        Schema.org JSON-LD. Content is entirely module constants (lib/structured-data.ts) with no
        user or model input, and `<` is escaped there so the tag cannot be closed early — the two
        conditions that make `dangerouslySetInnerHTML` safe here.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialiseJsonLd(landingJsonLd(env.SITE_URL)) }}
      />
      <div className="lx-grid-bg" />
      <div
        className="lx-glow"
        style={{ width: 560, height: 560, background: "rgba(96,165,250,.16)", top: -160, left: "50%", transform: "translateX(-55%)" }}
      />
      <div className="lx-glow" style={{ width: 420, height: 420, background: "rgba(52,211,153,.06)", top: 640, right: -120 }} />

      <div className="lx-wrap">
        <nav className="lx-nav">
          <div className="lx-brand">
            <BrandMark />
            edgify
          </div>
          <div className="lx-navlinks">
            <a href="#lx-features">Features</a>
            <a href="#lx-modes">How it works</a>
            <a href="#lx-start">Get started</a>
            <Link href="/demo">Try the demo</Link>
          </div>
          <div className="lx-navr">
            <span className="lx-pill">
              <span className="dot" /> Live
            </span>
            <Link href="/notes" className="lx-btn-primary">
              Launch app
              <ArrowIcon />
            </Link>
          </div>
        </nav>

        <header className="lx-hero">
          <div className="lx-pill" style={{ marginBottom: 22 }}>
            <span className="tag">New</span> An academic study workspace
          </div>
          <h1 className="lx-h1">
            Cram fast, or <span className="lx-blue">understand deeply.</span> One workspace.
          </h1>
          <p className="lx-sub">
            Edgify turns your notes, slides and PDFs into short, high-yield revision for the night before an exam — and a
            dependency graph that shows exactly what to learn first.
          </p>
          {/*
            The primary CTA points at SIGN-UP rather than the workspace.
            "Launch workspace" reads as an instruction to someone who already has an account; a
            first-time visitor has no workspace to launch, and following it only produced a
            redirect to sign-in with no explanation of why. The account routes are the existing
            Better Auth pages — no second authentication path is introduced.

            THIS PAGE STAYS STATICALLY PRERENDERED, deliberately. Choosing the label from the
            session would mean reading cookies here, which opts the whole marketing page out of
            static rendering and adds a session database read to every anonymous visit — a real
            cost on a scale-to-zero service, for a word. Signed-in visitors are not stranded: the
            nav's "Launch app" still goes to /notes, and the (app) layout already routes them
            correctly either way.
          */}
          <div className="lx-hero-cta">
            <Link href="/sign-up" className="lx-btn-primary">
              Sign up
              <ArrowIcon />
            </Link>
            <Link className="lx-btn-glass" href="/sign-in">
              Sign in
              <ArrowIcon />
            </Link>
            <a className="lx-btn-glass" href="#lx-modes">
              See how it works
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2S2 6.477 2 12s4.477 10 10 10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  opacity=".5"
                />
                <path d="M10 9l5 3-5 3z" fill="currentColor" />
              </svg>
            </a>
            <Link className="lx-btn-glass" href="/demo">
              Try the demo
              <ArrowIcon />
            </Link>
          </div>
        </header>

        <div className="lx-bento" id="lx-features">
          <div className="lx-card col-8 row-2 gborder" style={{ animationDelay: ".3s" }}>
            <div className="lx-eyebrow">Dependency graph</div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 0" }}>
              <svg viewBox="0 0 300 150" width="100%" style={{ maxWidth: 340 }} aria-hidden="true">
                <line x1="45" y1="120" x2="95" y2="78" stroke="rgba(255,255,255,.2)" strokeWidth="1.5" />
                <line x1="150" y1="120" x2="95" y2="78" stroke="rgba(255,255,255,.2)" strokeWidth="1.5" />
                <line x1="95" y1="78" x2="70" y2="34" stroke="rgba(255,255,255,.2)" strokeWidth="1.5" />
                <line x1="150" y1="120" x2="215" y2="78" stroke="rgba(96,165,250,.5)" strokeWidth="1.5" />
                <line x1="70" y1="34" x2="215" y2="78" stroke="rgba(96,165,250,.5)" strokeWidth="1.5" />
                <circle cx="45" cy="120" r="9" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.3)" />
                <circle cx="150" cy="120" r="9" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.3)" />
                <circle cx="95" cy="78" r="9" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.3)" />
                <circle cx="70" cy="34" r="9" fill="rgba(255,255,255,.14)" stroke="rgba(255,255,255,.3)" />
                <circle cx="215" cy="78" r="12" fill="#60a5fa" />
              </svg>
            </div>
            <h3>See exactly what to learn first</h3>
            <p>
              Upload a document and Edgify maps its concepts and prerequisites into a graph, then scores how ready you are
              for each one.
            </p>
          </div>

          <div className="lx-card col-4 gborder" style={{ animationDelay: ".4s" }}>
            <div className="lx-eyebrow">Quick notes</div>
            <div style={{ marginTop: 12 }}>
              <div className="lx-check">
                <CheckIcon /> Only the testable points
              </div>
              <div className="lx-check">
                <CheckIcon /> Short and scannable
              </div>
              <div className="lx-check">
                <CheckIcon /> Ready in seconds
              </div>
            </div>
            <h3>Cram the essentials</h3>
          </div>

          <div className="lx-card col-4 accent gborder" style={{ animationDelay: ".5s" }}>
            <div className="lx-eyebrow">Learning readiness</div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 16 }}>
              <svg width="88" height="88" viewBox="0 0 126 126" style={{ flexShrink: 0 }}>
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
                  strokeDashoffset="61.07"
                  transform="rotate(-90 63 63)"
                />
                <text x="63" y="63" textAnchor="middle" dominantBaseline="central" fontSize="30" fontWeight="700" fill="#fff" fontFamily="Inter">
                  82%
                </text>
              </svg>
              <div className="lx-ring-num">Prerequisites covered — with the exact gaps left to close.</div>
            </div>
          </div>

          <div className="lx-card col-4 gborder" style={{ animationDelay: ".55s" }}>
            <div className="lx-eyebrow">Revision formats</div>
            <div className="lx-mini-pills">
              <span className="lx-mini-pill">Key points</span>
              <span className="lx-mini-pill">Exam points</span>
              <span className="lx-mini-pill">Main concepts</span>
              <span className="lx-mini-pill">Summary</span>
              <span className="lx-mini-pill">Formulas</span>
              <span className="lx-mini-pill">Short notes</span>
            </div>
            {/* EIGHT. `lib/ai/prompts.ts` defines exactly eight formats; "nine" was a draft
                miscount, already corrected in docs/06 and in lib/structured-data.ts. */}
            <h3>Eight ways to revise</h3>
          </div>

          <div className="lx-card col-4 gborder" style={{ animationDelay: ".6s" }}>
            <div className="lx-eyebrow">Grounded, not guessed</div>
            <div className="lx-doc-lines">
              <div className="ln" style={{ width: "100%" }} />
              <div className="ln" style={{ width: "82%" }} />
              <div className="ln" style={{ width: "90%" }} />
            </div>
            <div className="lx-tag-blue">
              <span className="dot" /> Generated from your material
            </div>
          </div>

          <div className="lx-card col-4 gborder" style={{ animationDelay: ".65s" }}>
            <div className="lx-eyebrow">Take it with you</div>
            <div className="lx-exp">
              <span>
                <DownloadIcon /> PDF
              </span>
              <span>
                <DownloadIcon /> DOC
              </span>
            </div>
            <h3>Export anywhere</h3>
          </div>
        </div>

        <section className="lx-section" id="lx-modes">
          <div className="lx-shead">
            <div className="row">
              <span>How it works</span>
              <span>(01)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">Two modes, one workspace</h2>
          </div>
          <div className="lx-2col">
            <div className="lx-mode qn gborder">
              <span className="badge">QUICK NOTES</span>
              <h3>Revise fast</h3>
              <p className="lead">
                Built for the night before the exam. Paste or upload your material, pick a format, and get short,
                high-yield notes with only what&apos;s likely to be tested.
              </p>
              <ul>
                <li>
                  {/*
                    Names the six MARKDOWN formats and no longer advertises MCQs or the graded
                    quick test. Both are implemented, but the provider currently rejects them —
                    strict `response_format` requires every property to be listed as required and
                    the quiz schema's `explanation` is optional — so the landing page stopped
                    promising a path that fails. Restore the quiz copy when that is fixed.
                  */}
                  <CheckIcon /> Key points, main concepts, exam points, short notes, formulas and
                  summaries
                </li>
                <li>
                  <CheckIcon /> Upload PDF, DOCX, TXT or Markdown
                </li>
                <li>
                  <CheckIcon /> Export to PDF or Word in a click
                </li>
              </ul>
            </div>
            <div className="lx-mode kg gborder">
              <span className="badge">KNOWLEDGE GRAPH</span>
              <h3>Understand deeply</h3>
              <p className="lead">
                For real mastery. Edgify reads your document, finds its concepts and the order they build in, and
                generates deep, source-grounded explanations on demand.
              </p>
              <ul>
                <li>
                  <CheckIcon /> A prerequisite graph built from your own material
                </li>
                <li>
                  <CheckIcon /> Learning readiness, study plans and a concept library
                </li>
                <li>
                  <CheckIcon /> Per-concept explanations, quizzes and flashcards
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="lx-section">
          <div className="lx-shead">
            <div className="row">
              <span>Get going</span>
              <span>(02)</span>
            </div>
            <div className="line" />
            <h2 className="lx-h2">From file to focused study in three steps</h2>
          </div>
          <div className="lx-steps">
            <div className="lx-step gborder">
              <div className="n">1</div>
              <h4>Bring your material</h4>
              <p>Upload a lecture PDF, slides or notes — or just paste the text straight in.</p>
            </div>
            <div className="lx-step gborder">
              <div className="n">2</div>
              <h4>Pick your mode</h4>
              <p>Quick notes for fast revision, or the knowledge graph for deep understanding.</p>
            </div>
            <div className="lx-step gborder">
              <div className="n">3</div>
              <h4>Study &amp; export</h4>
              <p>Revise, test yourself, track readiness, and take a PDF or Word copy with you.</p>
            </div>
          </div>
        </section>

        <section className="lx-section" id="lx-start">
          <div className="lx-cta gborder">
            <div
              className="lx-glow"
              style={{ width: 300, height: 300, background: "rgba(96,165,250,.25)", top: -60, left: "50%", transform: "translateX(-50%)" }}
            />
            <h2>Start studying smarter</h2>
            <p>Two ways to learn, grounded in your own material. Jump straight into the workspace — no setup.</p>
            <div className="lx-hero-cta">
              {/* Same reasoning as the hero: the closing CTA asks for an account. */}
              <Link href="/sign-up" className="lx-btn-primary">
                Sign up
                <ArrowIcon />
              </Link>
              <Link className="lx-btn-glass" href="/sign-in">
                Sign in
                <ArrowIcon />
              </Link>
              <Link className="lx-btn-glass" href="/demo">
                Try the demo
                <ArrowIcon />
              </Link>
            </div>
          </div>
        </section>

        {/* The mark is passed in so this file keeps the single copy of that SVG. */}
        <SiteFooter brandMark={<BrandMark />} />
      </div>
    </div>
  );
}

# 10 — SEO and GEO: measurement, and what is prepared but not submitted

Companion to `marketing/seo.md`, which is the strategy. This file is the record: what was
measured, with what tool, on what date — and what is staged awaiting approval.

Two rules govern everything below, and they are the same two that govern `lib/legal.ts`:

- **Every number here came out of a tool.** Nothing is estimated, rounded up, or remembered.
- **Nothing has been submitted anywhere.** Search Console, Bing, and every other external service
  are prepared to the point of one click and stopped there (`marketing/seo.md` rule 5).

---

## 1. Where the work lives

| Concern | File |
| --- | --- |
| Site-wide metadata, `metadataBase`, title template, OG/Twitter defaults | `app/layout.tsx` |
| Per-page metadata and canonicals | each `page.tsx` |
| Shared social-card images (and the merge footgun they exist for) | `lib/seo.ts` |
| Crawl rules, including the AI-crawler decision | `app/robots.ts` |
| Indexable URL set | `app/sitemap.ts` |
| Schema.org JSON-LD | `lib/structured-data.ts` |
| FAQ content — one source for the rendered block and its markup | `lib/faq.ts` |
| Direct-answer and FAQ rendering | `components/key-answer.tsx`, `components/faq-section.tsx` |

Pinned by `app/seo.test.ts`, `app/metadata.test.ts`, `lib/structured-data.test.ts`,
`lib/faq.test.ts` and `lib/seo.test.ts`.

---

## 2. Public surface

Eight indexable URLs. The set is asserted literally in `app/seo.test.ts`, so it cannot drift
from `app/sitemap.ts` or from `app/robots.ts` without a test failing.

| Route | Indexable | Why |
| --- | --- | --- |
| `/` | yes | Landing page. Brand query. |
| `/demo` | yes | Real, substantial, static content behind no sign-up wall. |
| `/pdf-to-study-notes` | yes | "PDF to study notes" intent. |
| `/concept-map-for-studying` | yes | "Concept map for studying" intent. |
| `/privacy`, `/terms`, `/cookies`, `/ai-disclaimer` | yes | A cautious user goes looking for these. |
| `/notes`, `/graph` | **no** | Authenticated. A crawler sees only the sign-in redirect. |
| `/admin/usage` | **no** | Internal. |
| `/sign-in`, `/sign-up` | **no** | Thin, and they would compete with `/` for the brand query. |
| `/api/*` | **no** | No route returns indexable HTML. |

Each private route is covered twice — disallowed in `robots.txt` *and* `noindex` in its own
metadata — because `Disallow` alone stops the crawl without stopping the indexing.

---

## 3. AI crawlers — the decision, and why it is written down

**Edgify allows every published AI crawler, on the same terms as any other crawler: the public
pages, and nothing private.** The reasoning is in the comment block at the top of `app/robots.ts`
and is not repeated here; the short version is that the only content these bots can reach is
marketing copy written to be repeated, and a student's uploaded coursework is behind
authentication where no crawler of any kind can reach it.

Tokens were verified against each operator's own documentation on **2026-08-19** rather than
recalled — these names change, and a misspelled one is a rule that silently matches nothing:

| Operator | Tokens | Source |
| --- | --- | --- |
| OpenAI | `OAI-SearchBot`, `GPTBot`, `ChatGPT-User` | developers.openai.com/api/docs/bots |
| Anthropic | `Claude-SearchBot`, `ClaudeBot`, `Claude-User` | support.claude.com article 8896518 |
| Perplexity | `PerplexityBot`, `Perplexity-User` | docs.perplexity.ai/guides/bots |
| Google | `Google-Extended` | developers.google.com/search/docs/crawling-indexing/google-common-crawlers |
| Others | `Applebot-Extended`, `CCBot`, `Meta-ExternalAgent`, `Amazonbot` | operator documentation |

One fact worth keeping visible because it is routinely got wrong: Google states that
`Google-Extended` **"does not impact a site's inclusion in Google Search nor is it used as a
ranking signal"**. It governs Gemini training and grounding only. Blocking it would not have
protected search visibility, and allowing it does not endanger it.

**The trap this configuration avoids.** robots.txt group matching is winner-take-all: a crawler
that finds a group naming its own token obeys that group and ignores `User-agent: *` entirely.
A named group written without the `Disallow` lines does not inherit them — it opens `/api/` and
the authenticated routes to precisely that bot, while the top of the file still looks correct.
Both groups therefore spread the same constant, and `app/seo.test.ts` fails if any group is ever
added without the full list.

---

## 4. Performance — measured, 2026-08-19

**Tool:** Lighthouse 12.8.2, mobile emulation, simulated throttling (150 ms RTT, 1,638 Kbps,
4× CPU slowdown — Lighthouse's own defaults), against `next start` on a local production build.

**Read these as lab numbers, not field numbers.** They ran against localhost on one machine, so
they carry none of Cloud Run's cold-start latency and none of a real network's variance. They are
useful for comparing before against after, and for finding defects. They are not a prediction of
what a student on a train will see. Field data needs CrUX or Search Console, which requires the
site to have traffic first — see §6.

### Before → after this change

| Route | Perf | Accessibility | SEO | Best practices | LCP | CLS | TBT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | 84 → **84** | 98 → **100** | 100 → **100** | 96 → **96** | 3.94 s → 3.95 s | **0 → 0** | 217 ms → 210 ms |
| `/pdf-to-study-notes` | 83 → **84** | 98 → **100** | 100 → **100** | 96 → **96** | 3.90 s → 3.95 s | **0 → 0** | 265 ms → 225 ms |
| `/concept-map-for-studying` | 83 → **84** | 98 → **100** | 100 → **100** | 96 → **96** | 3.96 s → 3.95 s | **0 → 0** | 240 ms → 217 ms |
| `/demo` | 71 | 91 | 100 | 96 | 5.21 s | 0 | — |

Two things this table is saying:

- **Accessibility went 98 → 100 on all three public pages**, from a real defect that Lighthouse
  named: the three-step sections used `<h4>` directly under the section's `<h2>`, skipping a
  level, so `heading-order` failed on every public page. They are now `<h3>`. The rendered size is
  unchanged (`app/globals.css` moved the selector with them), so the prototype's visual
  specification is intact — only the outline a screen reader and an extractor walk was corrected.
- **Adding the answer block and an eight-question FAQ to each page cost nothing measurable.**
  CLS stayed at 0, LCP moved within run-to-run noise, and TBT went slightly down. Both blocks are
  server-rendered with no client component, which is why.

### The LCP finding, and a hypothesis that measurement killed

LCP sits at ~3.95 s under Lighthouse's simulated Slow 4G, which is above the 2.5 s "good"
threshold. Lighthouse attributes 88% of it to render delay.

The obvious suspect was the hero's `fadeSlideIn` animation: `.lx-hero > *` starts at
`opacity: 0` with per-child delays, and LCP does not count an element until it is visible.
**That hypothesis is wrong, and it was tested rather than assumed.** Measuring real LCP in
Chromium at 4× CPU throttle, three runs each, with and without `prefers-reduced-motion` — which
the CSS already honours by disabling the animation entirely:

| | LCP runs (ms) | Median |
| --- | --- | --- |
| Animation on | 620, 504, 472 | **504 ms** |
| Animation off (reduced motion) | 404, 612, 472 | **472 ms** |

A 32 ms difference, inside the noise of the runs themselves. The animation is not the cause, and
removing it — which would have meant overriding the visual specification in `.claude/rules/ui.md`
— would have bought nothing.

What the number actually reflects is Lighthouse's network simulation applied to the JavaScript
payload. Which leads to the one real lever, below.

### The demo prefetch — tried, measured, and deliberately NOT kept

This one is recorded in full because the result contradicted the reasoning, and the next person
to look at the payload will have the same idea.

**The observation.** Lighthouse recorded a 216 KiB transfer on `/` for a chunk that `/`'s HTML
never references. That chunk holds **jsPDF, marked and DOMPurify** — the workspace's export and
markdown-rendering libraries, 648 KB raw. It arrives because `<Link href="/demo">` **prefetches
the demo route**, and the demo bundles the full workspace. The marketing pages were pulling the
heaviest dependencies in the app for a route most visitors never open.

**The fix, applied and then reverted.** `prefetch={false}` on all ten `/demo` links. In Next 16.3
that value means *"prefetching will never happen both on entering the viewport and on hover"* —
checked against the current `next/link` documentation, because it is stronger than the
hover-still-works behaviour that is commonly assumed.

**Measured, Slow-4G + 4× CPU, three runs each, median:**

| | Landing chunks at idle | Heavy chunk before any click | Demo click → rendered |
| --- | --- | --- | --- |
| Prefetch on | 2,076 KB | yes | **717 ms** |
| Prefetch off | **1,331 KB** | **no** | **2,414 ms** |

**And what it bought in Lighthouse:**

| Route | JS transferred | Performance | LCP |
| --- | --- | --- | --- |
| `/` | 670 → 418 KiB | 84 → **85** | 4.0 s → 3.9 s |
| `/pdf-to-study-notes` | 670 → 418 KiB | 84 → **85** | 3.9 s → 3.9 s |
| `/concept-map-for-studying` | 670 → 418 KiB | 84 → **84** | 4.0 s → 3.9 s |

**A 38% cut in JavaScript moved the performance score by about one point, and made the most
valuable click on the site 1.7 seconds slower.** So it was reverted.

**Why the intuition was wrong.** Prefetching happens *after* load, on idle. It never blocked FCP
or LCP — it only inflated the total-bytes figure that Lighthouse reports and that a person reading
a report reacts to. Removing it improved a number that was not costing users anything and charged
a real 1.7 s to the one interaction these pages exist to produce.

**The general lesson, which is the reason this section is long:** a byte total is not a user
experience. Both halves of a trade have to be measured, and the half that is harder to measure —
the click that happens after the page is already loaded — is the half that mattered here.

**Where the payload actually is, if it is ever worth attacking:** the 418 KiB that remains is the
Next.js framework, React, Sentry and PostHog, on pages that render no client component of their
own. Sentry's client bundle is the largest single item and is the honest first target. The demo
prefetch is not.

### Already satisfied, and why nothing was changed

| Phase 3 item | State |
| --- | --- |
| `next/image` for meaningful images | No `<img>` on any public page — every graphic is inline SVG. |
| `next/font` | Both faces self-hosted through `next/font/google` (`app/layout.tsx`). |
| Minimal client JS on public pages | All three are server components with no client island. |
| Explicit dimensions / no layout shift | **CLS is 0 on every public page**, measured. |
| Lazy-load below the fold | Nothing below the fold is heavy — it is text and SVG. |

---

## 5. Structured data

| Page | Blocks |
| --- | --- |
| `/` | `Organization`, `WebSite`, `SoftwareApplication` (one `@graph`), plus `FAQPage` |
| `/pdf-to-study-notes` | `BreadcrumbList`, `FAQPage` |
| `/concept-map-for-studying` | `BreadcrumbList`, `FAQPage` |

Verified in the **built** HTML (`.next/server/app/*.html`), not in the source: every block parses
as JSON, and **every marked-up answer string appears in the rendered page**. That last check is
the one that matters — FAQ markup describing content a page does not show is a policy violation,
not a shortcut.

Still deliberately absent, each documented at its refusal site in `lib/structured-data.ts`:
`aggregateRating`, `review`, `offers`/`price`, and `SearchAction`. Edgify has no reviews, no
billing and no site search, and markup is a claim made directly to Google.

`FAQPage` **was** previously refused, on the grounds that Google restricted FAQ rich results in
August 2023. That reasoning was correct for the goal it was written against — earning a rich
result — and is the wrong test for extraction by an answer engine, which is what the markup now
serves. The reversal and its reasoning are recorded in the function's own comment.

---

## 6. Prepared, awaiting approval — **nothing here has been submitted**

### Google Search Console

1. Add the property at <https://search.google.com/search-console> as a **Domain** property for
   `edgify.online` (covers every subdomain and both protocols; a URL-prefix property would not).
2. Verify by **DNS TXT record** at the registrar. Not the HTML-file or meta-tag methods: both put
   a verification token in the repository, and a domain property cannot use them anyway.
3. Submit `https://edgify.online/sitemap.xml` under **Sitemaps**.
4. Do not use the Indexing API. It is documented for job-posting and livestream pages only.

**Blocked on:** DNS access, and your go-ahead.

### Bing Webmaster Tools

1. Add the site at <https://www.bing.com/webmasters>.
2. **Import from Google Search Console** once step 1 above exists — it carries the verification
   and the sitemap across, and avoids a second DNS record.
3. Bing feeds Copilot and some other answer engines, so this is not only a Bing decision.

**Blocked on:** Search Console existing first, and your go-ahead.

### Analytics — already in place, nothing to add

PostHog, wired in `lib/analytics.ts`, no-op unless `NEXT_PUBLIC_POSTHOG_KEY` is set at build time.
It is privacy-respecting by construction and by test: `lib/analytics-privacy.test.ts` reads the
source of every `track()` call site and fails if an event could carry uploaded text, model output,
a filename or a concept name. No metric anywhere is inflated or synthesised.

---

## 7. Query tracking

The point of this table is to make improvement measurable against something written down *before*
the data existed. It has no volume figures because no keyword tool was used — inventing them
would be worse than leaving them out. Priority is relevance to what Edgify actually does.

Fill in `Status` from Search Console once §6 is approved and has collected data. Expect weeks to
months, not days.

| Intent | Target query | Page that targets it | Status |
| --- | --- | --- | --- |
| Product | edgify | `/` | Not yet measured |
| Informational | pdf to study notes | `/pdf-to-study-notes` | Not yet measured |
| Informational | turn lecture notes into revision notes | `/pdf-to-study-notes` | Not yet measured |
| Informational | how to make revision notes from a pdf | `/pdf-to-study-notes` (FAQ) | Not yet measured |
| Informational | concept map for studying | `/concept-map-for-studying` | Not yet measured |
| Informational | what is a concept map for studying | `/concept-map-for-studying` (answer block) | Not yet measured |
| Comparison | concept map vs mind map | `/concept-map-for-studying` (FAQ) | Not yet measured |
| Comparison | ai study tool vs chatgpt for notes | `/` (FAQ) | Not yet measured |
| Product | ai note summariser for students | `/` | Not yet measured |
| Trial | edgify demo / try study notes generator | `/demo` | Not yet measured |

### GEO — what to watch instead of rankings

Answer engines do not publish an equivalent of Search Console, so the honest measurement is
manual and periodic. Roughly monthly, ask ChatGPT, Perplexity and Google AI Overviews a handful
of the queries above and record whether Edgify appears and whether the description is accurate.

The description being **wrong** matters more than it being absent. That is the failure this whole
approach is built to avoid — which is why every answer in `lib/faq.ts` carries the file that
proves it, and why `lib/faq.test.ts` rejects an answer that opens with a pronoun pointing at
something outside itself.

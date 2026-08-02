# 06 — Implementation plan

Seven phases. Each is independently verifiable and ends in a working, committable state.

**Work one phase at a time.** Pasting all documents into one prompt and asking for the whole
application produces a large amount of code that compiles and does not work. A phase at a
time, with the acceptance criteria checked explicitly, produces something that runs.

Suggested prompt per phase:

```
Read docs/AGENTS.md, docs/01-architecture.md and docs/02-tech-stack.md.
Implement Phase N from docs/06-implementation-plan.md.
Stop when every acceptance criterion passes. Do not start Phase N+1.
```

---

## Phase 1 — Foundation (3–5 days)

Prove the riskiest integrations before building anything on top of them.

**Scope**
- `create-next-app` with TypeScript, App Router, Tailwind
- `lib/env.ts` — Zod-validated environment; app refuses to boot if anything is missing
- Neon project; `lib/db/client.ts` with **connection retry** for cold starts
- Drizzle schema per `03-data-model.md`; first migration
- Better Auth with Google OAuth; generate its tables via CLI
- Protected route group; sign-in and sign-out
- Dockerfile with `output: "standalone"`; runs locally

**Acceptance criteria**
- [ ] `npm run build` succeeds; the Docker image runs locally
- [ ] Sign in with Google, refresh, session persists
- [ ] Sign out clears the session
- [ ] Removing a required env var stops the app at boot with a clear message
- [ ] Database query works after Neon has idled 10+ minutes (cold start retry proven)
- [ ] `npm run typecheck` and `npm run lint` pass

> Prototype the Better Auth flow **first**, before anything depends on it. It is the least
> proven piece of the stack. If it fights you for more than a day, switching to Supabase Auth
> is a reasonable decision, not a failure.

---

## Phase 2 — Guardrails and isolation (2–3 days)

Unglamorous, early, and the reason nothing catches fire later.

**Scope**
- **GCP budget alert and hard billing cap** — before any paid API call exists
- **Neon spending limit**
- `lib/db/queries/` — every function takes `userId` first and filters on it
- Cross-user isolation tests
- `lib/quota.ts` — daily counter, upsert, read remaining
- `lib/log.ts` and Sentry wiring
- Rate limiting on unauthenticated routes — **CLOSED 2026-07-29.** Was incomplete: `withRateLimit`
  existed but was applied to `/api/health` **only**, so `/api/notes/generate` and `/api/usage` were
  reachable unwrapped. On the generate route that was the expensive one — the handler resolved the
  session (a DB read) before rejecting, so an attacker with no credentials could drive database
  work per request, and the route is the entry point to model-tier spend. Both are now wrapped
  (`notes-generate`, 60/min/IP; `usage`, 120/min/IP — generous because a shared campus NAT puts a
  whole class behind one address, and authenticated users are already bounded by the daily quota)
- **`checkRateLimit` cost two sequential round trips; now one.** It ran the counter upsert *and*
  an elapsed-window cleanup `DELETE`, both awaited in sequence, when only the upsert answers the
  question the request is asking. Fixed **opportunistically**: the upsert's `RETURNING count`
  reports when a *new* window row was created (`count === 1`), which is exactly when a prior
  window became elapsed, so cleanup now runs once per window per key rather than once per request.
  Two supporting changes fell out of it — the cleanup sits *outside* `withDbRetry` (a retry there
  would re-run the upsert and double-count the request), and a cleanup failure is caught and
  logged rather than failing the request.
- **`withRateLimit` fails open.** If the limiter's own query fails, the request proceeds and the
  failure is logged. Throwing would surface Next's raw 500 on routes that otherwise map every
  failure to a calm message (docs/04 §7), and would turn a brief database hiccup into a total
  outage. Nothing is exposed: every route behind the wrapper needs the database for its own
  session and quota reads, so it cannot do expensive work either.

**Acceptance criteria**
- [ ] **A test billing alert actually fires — NEVER RUN. The oldest open safety gap in the
      project.** Deferred during Phase 2 and never picked up; confirmed 2026-07-29 by tracing
      back through the work. The cap function exists (`infra/billing-cap/`) and the runbook is
      written (docs/08), but no GCP project has been created and the drill has not been executed
      once — which is why `PROJECT_ID` and the budget display name were free to be renamed to
      `edgify-*`: they name resources that do not exist yet.

      Not blocking Phase 5. But Phase 3 onward spends real money, and the entire billing-cap
      apparatus exists so that a 3am retry loop cannot drain the account. Reaching Phase 7 with
      the cap **built but never once fired** is the largest unverified risk in the build:
      "the billing cap works" is currently an assumption, not a tested fact — the only major
      claim here that has not been checked against reality the way everything else has. Needs a
      clear half hour. Also gated at launch by docs/09.
- [ ] Isolation test: user A's document is invisible to user B through **every** query function
- [ ] Quota increments, enforces at the limit, and resets at day boundary
- [ ] An unauthenticated route rejects a burst of requests
- [x] **`/api/notes/generate` and `/api/usage` reject a burst of unauthenticated requests** — met
      2026-07-29. Both wrapped; `app/api/rate-limit-coverage.test.ts` asserts the rejection happens
      **before the session lookup** (`getSession` never called), which is the property that
      matters — asserting only "returns 429" would pass even with the DB read still in front of it
- [x] **`checkRateLimit` issues one round trip per request, not two** — met 2026-07-29. Asserted as
      a statement count via `test/count-queries.ts`, not wall-clock time, so it holds identically
      against a localhost container and a remote Neon instance
- [ ] Sentry receives a deliberately thrown test error

> Billing caps before the code that can spend money. The failure mode this prevents is a
> retry loop at 3am against a paid API.

---

## Phase 3 — The AI layer (4–6 days)

The heart of the system. Build it once, properly.

**Scope**
- `lib/ai/models.ts` — model IDs from env, with fallback lists
- `lib/ai/prompts.ts` — versioned templates ported from the prototype
- `lib/ai/schemas.ts` — Zod schemas for every structured output
- `lib/ai/generate.ts` — **the full degradation ladder** from `04-resilience.md`
- `lib/cache.ts` — content-addressed dedupe. Inserts into `generation_cache` use `ON CONFLICT
  DO NOTHING`: two users uploading the same document race on the same cache key — the exact
  classroom scenario the cache exists for — and without it one of them errors on the duplicate
  key (`.claude/rules/database.md`)
- `lib/demo/` — curated graph and sample notes lifted from the prototype
- `usage_ledger` writes on every call

**Acceptance criteria**
- [ ] Identical input twice → second is a cache hit, zero tokens, no quota consumed
- [ ] Forcing a 429 (bad free model id) falls through to the paid model, invisibly
- [ ] Forcing both to fail returns demo content with the banner
- [ ] Forcing demo to be unavailable returns the busy message, not an exception
- [ ] Malformed JSON triggers exactly one repair attempt, then falls through
- [ ] Every path writes a ledger row with the correct `tier` and `outcome`
- [ ] Retries are jittered — verified by inspecting timing in logs

> Test the ladder by breaking things on purpose. Point the free model at a nonexistent id.
> Use an invalid key. Return garbage from a stubbed model. Every one of these must produce a
> calm user-facing state.

---

## Phase 4 — Quick Notes (4–5 days)

**Scope**
- Port the prototype's Quick Notes UI to React, preserving the design exactly
- Tailwind theme built from the prototype's `:root` custom properties
- `POST /api/notes/generate` with streaming
- All nine formats, quiz formats using `generateObject`
- Interactive quiz with live scoring
- Copy / PDF / DOC export, ported from the prototype
- Quota display in the UI

**Acceptance criteria**
- [x] Side-by-side with `edgify-prototype.html`, the UI is visually indistinguishable
- [~] Tokens stream progressively; first token within ~2 seconds — streaming yes, ~2s **not met**
- [x] All ~~nine~~ **eight** formats produce sensible output
- [x] Quiz scores correctly and shows explanations
- [~] PDF and DOC exports open correctly in a reader and in Word — PDF yes, Word **unverified**
- [x] Approaching quota shows the counter; reaching it shows the friendly state
- [x] Demo banner appears when the ladder falls through

#### Phase 4 results (2026-07-28)

**Visual fidelity — met.** `test/e2e/visual-diff.mjs` drives the prototype and the app to the
same seven states with the same fixtures and pixel-diffs the Quick Notes region at 1440×900 and
1280×800. Worst state **0.197%** differing pixels; most at 0.02–0.09%; prose and loading states
are pixel-identical apart from the constant floor. Three deliberate deviations, printed by every
run: the disabled "Upload file" link (Phase 5, and the ~170px floor in every state); the
error-state heading, where the prototype uses one generic title for every failure and the app
uses the specific docs/04 §7 catalogue title; and textarea scroll offset after "Load sample",
normalised before capture. Getting here required one real fix — Tailwind's preflight sets
`line-height: inherit` on buttons where the prototype leaves it `normal`, making every format
chip 4.25px taller and pushing everything below down 8.5px (found by measuring element geometry,
`test/e2e/measure-geometry.mjs`, not by guessing).

**Formats — eight, not nine.** The prototype defines eight (`FORMATS`, proto:848-865) and so does
`lib/ai/prompts.ts`. The "nine" above was wrong; no ninth was invented. All eight verified against
the live model, checked for shape rather than wording (`test/e2e/all-formats.mjs`): 8/8.

**First token — NOT met.** Measured against a production build, n=10, cache-busted
(`test/e2e/first-token-latency.mjs`): **median 2958ms, min 2014ms, p95 12735ms.** Attribution:
~811ms is our three sequential Neon round trips before the model is called (session, cache,
quota — 270ms each), ~2147ms is provider time-to-first-token plus app overhead. So the free model
alone roughly consumes the whole budget; even with a free database the median would sit near
2.1s. The per-query RTT here is network distance (local server → `us-east-2` Neon), which would be
single-digit ms co-located — but production has not been measured, so that explains the number
rather than excusing it. **This is a measurement, deliberately not a CI gate**; the structural
property that makes ~2s *achievable* — the route flushing its first byte before the generation
completes — is gated deterministically in `app/api/notes/generate/route.test.ts`. Note this
contradicts the "~1.2s streaming first token" recorded in `lib/env.ts` on 2026-07-27; that figure
should be treated as stale.

Progressive streaming itself is confirmed in a real browser: 100 DOM updates across 85 distinct
lengths for one generation, first paint measured client-side.

**Database round trips on the hot path** (`test/e2e/db-hotpath-latency.mjs`, per-call medians).
Every query costs ~250–275ms here and the work itself is trivial — that is network distance to
`us-east-2`, not database time.

| Call | Median | On the first-token path? |
|---|---|---|
| session lookup (SELECT) | 277ms | yes |
| cache lookup (UPDATE…RETURNING — it bumps hit stats) | 276ms | yes |
| quota consume (INSERT…ON CONFLICT) | 275ms | yes, on a miss |
| ledger write (INSERT) | 275ms | no, on completion |

Changed: the cache write and the ledger write at the end of a generation were sequential and are
independent — neither reads the other's result. Issued together they cost **552ms → 270ms, saving
~281ms per completed generation**. Two parallel statements cost about the same as one, because the
cost is round-trip latency rather than server work. This also means a failing cache write no
longer prevents the ledger row from being written.

Not changed, and deliberately so:

- **cache ∥ quota-consume** would consume the allowance before the cache result is known, so a
  cache HIT would cost the user a generation — the invariant in `.claude/rules/ai.md`. Guarded by
  `lib/ai/ordering.test.ts`, which fails with "a cache hit charged the user a generation" if
  anyone tries it. Verified live: two identical requests left the counter at 29/30.
- **cache ∥ quota-*read*** is safe but measures strictly *worse* — the miss path still needs the
  consume write afterwards, so it adds a round trip instead of removing one.
- **session ∥ cache** is the one genuine first-token win (~283ms; the cache key is
  content-addressed and does not depend on `userId`). Its precondition — rate limiting the route —
  was met on 2026-07-29, but **it has still not been implemented, and the arithmetic says it is not
  worth it.** The cache lookup is an `UPDATE…RETURNING`, so overlapping it with the session lookup
  means issuing a database *write* before the caller is authenticated; that is only acceptable
  behind a limiter, which is why the ordering was a hard dependency.

  What it does *not* buy, because the arithmetic is counter-intuitive: the wrapper itself now adds
  one round trip (~275ms) to the same path, against the ~283ms parallelising removes. **Best case
  is a wash.** The pre-fix wrapper would have made it net *worse* by roughly 267ms, which is why
  the cleanup fix had to come first.

  So the sequencing held — **fix the cleanup → wrap the routes → only then consider parallelising**
  — and the conclusion at the end of it is: don't. The routes were rate limited because leaving
  them unwrapped was a security gap, not because it unlocked a speedup; the speedup does not
  survive its own precondition.

So the first-token path still costs ~829ms in three sequential round trips, and no safe
reordering meaningfully changes that. It is a **deployment** concern rather than a code one:
co-locate the app with the database and all three fall to single-digit milliseconds, which is
worth more than every reordering discussed here combined.

**Exports.** PDF verified by inspecting the generated artifact (correct `%PDF-` header, text
present, no `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/AA` or scripted `/OpenAction`);
the W7 `</body>` trap is covered. **The `.doc` opening correctly in Word is unverified** — Word is
not available in this environment. The blob is Word-compatible HTML and is asserted inert, but
someone should open one before launch.

---

## Phase 5 — Documents and the graph (5–7 days)

**Scope**
- `lib/parse/` — unpdf and mammoth, with `finally` cleanup and size caps
- Scanned-document detection
- `POST /api/documents/extract` and `POST /api/documents`
- Graph structure extraction, validation, cycle-breaking, layout computation
- `POST /api/graph/:id/build` — the build runs as its own client-fired request, ownership-checked
  and idempotent on `status = "processing"`. **Not `after()`**, which depends on Cloud Run
  CPU-after-response — unverified here, and if it is wrong every upload silently ends in `failed`.
  Logged as a Phase 7 optimisation instead (docs/05 W4)
- `GET /api/graph/:id` with polling
- **Graph failures never serve demo content.** Ladder tiers 5 and 6 both collapse to
  `status = "failed"` + the W4 message. A graph demo would be persisted rows under the user's own
  `graphId` describing a document they never uploaded — `lib/demo/index.ts` therefore does not
  answer `graph_structure` at all, so the ladder cannot reach one by accident. `DEMO_GRAPH` is
  reserved for Phase 6's `/demo` (docs/03 §graphs)
- Port the graph UI: SVG, panel, concept library, study plan, progress modal
- Lazy concept detail — persisted on the REQUEST PATH, not via `after()` (see slice 3 results)
- Mastery tracking
- **Dedupe on `contentHash`** — clone an existing graph instead of regenerating
- **BLOCKER — the build can outlive its own request.** Found 2026-07-30 by the first live
  end-to-end run; two coupled defects, launch-blocking, gated in docs/09 §1.6 and go/no-go item 8.
  **`LADDER-EXCEEDS-TIMEOUT`**: at ~65s median single-call latency, a build that repairs once and
  falls through to the fallback rung reaches ~195–260s and one reaching the paid rung exceeds the
  300s Cloud Run request timeout — the *ordinary* case under free-tier rate limiting, not a tail.
  **`ZOMBIE-PROCESSING-ROW`**: a mid-flight kill writes nothing, so the row stays `processing`
  forever — the poll never resolves (never-fail becomes never-resolve), and the build route's
  idempotency check refuses only *finished* graphs, so a retry on the zombie is permitted and
  re-spends, with no reaper. Fixes: a wall-clock budget (~200s) checked **between rungs**, a
  heartbeat/timeout that transitions abandoned builds to `failed`, and a build-route guard that
  refuses or reclaims a stale `processing` row. **All three required; none substitutes for
  another.** Not built in the Phase 5 slices — flagged, measured and gated

**Acceptance criteria**
- [~] A 30-page PDF produces a graph within ~90 seconds — **median 73.7s, but max 93.0s over n=5,
      and every run was a best case.** Measured, not gated. See "End-to-end timing" below
- [x] The same PDF uploaded by a second user returns instantly, zero tokens — 8.0s vs 54–93s,
      ledger `tier: "cache"`, quota unchanged; verified live, not only in the test harness
- [ ] A scanned PDF produces the honest scanned-document message
- [ ] An 11 MB file is rejected before the body is read
- [ ] An encrypted PDF fails with a clear message, not a crash
- [x] **Clicking a concept generates detail once and caches it** — met 2026-08-01. Asserted by
      COUNTING requests (`knowledge-graph.detail-cache.test.tsx`), not by "the panel renders":
      three guards, in-memory cache, in-flight set, and the server's stored `detailJson`
- [x] **The panel scrolls independently; the page behind does not move** — met 2026-08-01, and
      VERIFIED IN CHROMIUM 2026-08-02: wheeling the panel to its end leaves `window.scrollY` at 0
      (panel `scrollTop 1249`), and the control with `overscroll-behavior: auto` scrolls the page
      to 78. The four declarations are also compared against the prototype's own rule, with five
      mutation controls
- [x] **Marking mastery updates readiness across the graph** — met 2026-08-01. The load-bearing
      word is *across*: marking a foundational concept moves the ring of a concept two layers
      above it (0% → 33%), which a recolour-the-clicked-node implementation would fail
- [x] **Graph export produces a complete study guide** — met 2026-08-01. Completeness and inertness
      checked separately; the W7 `</body>` trap has a control showing the unescaped form
      truncating under `split("</body>")[0]`

#### Phase 5 slice 2 results (2026-07-30) — query layer, AI widening, three routes

The UI (graph, concept panel, export) and the `/api/concepts` and `/api/mastery` routes are the
next slice; the query layer and `generate.ts` support for both landed here.

**The join-through isolation case.** `concepts` and `edges` carry no `userId` — the owner lives on
`graphs` — so their isolation is one `EXISTS` subquery that looks optional to a refactorer. Proven
by mutation: deleting the predicate from `listConcepts` turned **three** tests red, each showing
user B reading A's rows (`["a","b","c"]`), including the bidirectional clone case; restoring it
returned 24/24. That drill is now also **permanent infrastructure** rather than a one-off — a
final describe block runs the unscoped form of each query inline and asserts it *does* leak, so
the "B sees nothing" assertions beside it can never pass vacuously. If those controls ever go
green-by-accident, the seeding has changed and the whole suite has stopped proving anything.

**`cloneGraphByContentHash` is the one cross-user read in the codebase**, and it is listed as such
(`CONTENT_ADDRESSED_ALLOWLIST`) rather than hidden in the writer allowlist. Sound for the
`generation_cache` reason (docs/03): reachable only by supplying a document that hashes
identically, nothing enumerable, every row written under the caller. Tested bidirectionally —
clone invisible to source, source invisible to caller, fresh concept ids so mastery cannot leak.

**Proof 7 — the classroom case.** A second user uploading an identical file gets `status: "ready"`
on upload: zero model calls, own rows under own `userId`, quota unchanged, one ledger row with
`tier: "cache"`. Negative control: the same harness with different text takes the build path and
*does* charge. Drilled — making the clone path consume quota produced exactly the assertion that
matters: *"the clone consumed a generation from the daily allowance: expected 29 to be 30"*.

**Proof 8 — graph failure.** Sub-3-concept output walks the ladder in **exactly 6 model calls**
(3 rungs × 1 attempt + 1 repair; a malformed result repairs once then moves on, it is not
retried within a rung), reaches tier 6 because no demo graph exists, and lands on
`status = "failed"` with the W4 message. The `documents` row and its `extractedText` survive
intact — which is what makes "Quick Notes still works on it" true rather than a hope. A re-fire
after failure is a no-op and spends nothing.

**Concept-detail cache key.** Removing the slug collapsed **all nine concepts of a realistic graph
onto one key** (`expected 1 to be 9`). Without it the first concept clicked populates the entry
and every other concept renders that first concept's definition under its own name — silent, and
worse the better the cache performs.

**`generation_cache` under real concurrency.** The pre-existing sequential test could not prove
the `ON CONFLICT` rule: by the time the second insert runs the first has committed, so Postgres
never arbitrates two live inserts. Replaced with a two-connection barrier (both `BEGIN`, both
`INSERT`, then `COMMIT`) that produces the genuine interleaving, plus a control asserting the
same barrier raises `23505` without the clause. Drilled — removing `.onConflictDoNothing()` from
`setCached` made **9 of 10 concurrent writers error** on the duplicate key: the classroom
scenario failing exactly as `.claude/rules/database.md` predicts.

**Decisions recorded rather than papered over:**

- **No `building` status.** docs/03's four statuses are exhaustive and `demo` is reserved. The
  conditional `UPDATE ... WHERE status = 'processing'` inside `finishGraph` runs FIRST in the
  transaction and takes the row lock, so **corruption is fully closed**: two simultaneous builds
  can never write duplicate concepts, duplicate edges, or a `ready` graph with a partial node set.
  What remains is a bounded, accepted **spend** window — *at most one wasted model call*, only when
  two builds for the same graph are genuinely simultaneous (both past the route's pre-check before
  either commits), bounded by the daily quota, and the client fires the build once.
- **No demo tier for `concept_detail`**, matching the graph decision. docs/05 W5 corrected.
- **W4 step order corrected**: the document row must be inserted before the clone, because
  `graphs.documentId` is `NOT NULL`. docs/05 corrected.
- **`GET /api/graph/:id` is limited to 600/min per IP.** One client polling at 1.5s costs
  ~40 req/min, so 600 covers ~15 concurrent builders behind one address — and a campus NAT puts a
  whole class behind one address. A class of 30 would need ~1200/min. **The next slice's polling
  backoff (1.5s for ~15s, then 3s) is what makes 600 hold; it is part of this limit, not polish.**
  Shipping the graph UI with a flat 1.5s poll would make this route the feature's own bottleneck.
- **A ported prototype quirk, pinned not fixed**: `startX = max(8, …)` prefers an 8px left margin
  over true centring, so a shrunk row that fills the viewport overhangs the 760 viewBox by up to
  8px. Rule 6 says the prototype is the specification; the test records the behaviour and why.

#### Phase 5 slice 3 results (2026-08-01) — the graph UI

**PROOF 5 — model strings cannot execute, and the proof can fail.** The graph is the worst place
in the product for this, because its content is SHARED: `generation_cache` is content-addressed on
the document text, so the next student to upload the same PDF is served the byte-identical stored
detail, and `cloneGraphByContentHash` copies concept names and summaries into their rows. Stored
XSS with a distribution mechanism attached.

Three rendering contexts, each with a negative control that renders the prototype's own unescaped
template and **must fire** — 12 firing controls in total, then containment across nine real
surfaces (node labels, attributes, markdown body, quiz, explanation, flashcards, library, plan,
chips, plus the unavailable and failed states).

**The sentinel had to be replaced first, and that is the significant finding.** `window.__xss`
**could never fire in this repo's component tests**, so every `expect(window.__xss).toBeUndefined()`
in the Phase 4 suite passed identically against a completely unsanitised renderer. Measured, not
assumed: jsdom compiles an injected handler (`typeof img.onerror === "function"`, source intact)
and invoking it runs the payload, but the `window` it writes to is jsdom's realm global rather than
the object vitest exposes to the test. `runScripts: "dangerously"` changes nothing. `document.title`
does cross, so the corpus writes there and `assertNoExecutableDom` is no longer carrying the whole
suite alone. The Phase 4 assertions were repaired rather than left green.

Two smaller findings fell out of building the controls, both of which had been quietly weakening
them: `<details open>` queues its `toggle` event as a TASK, so a payload rendered in one test
detonated inside a *later* one, on a detached node, presenting as an unrelated failure with no
offending element anywhere (`flushDeferredHandlers` now drains between tests); and the driver's
"click everything" step was consuming the application's own controls, including the quiz clicks
the tests make themselves.

**Sanitisation moved to the validation seam** (`lib/ai/schemas`), upstream of the cache, the
database, the clone and the UI, rather than at render. A render-time gate leaves the stored and
cloned payload dirty and makes every present and future consumer individually responsible; there
is now no dirty copy to distribute. Two consequences worth recording:

- **DOMPurify was replaced by `sanitize-html`.** DOMPurify needs a DOM, which is why the old
  implementation had a fail-closed branch — correct, but it made server-side sanitisation
  impossible and made safety depend on a browser global being present in a container.
  `sanitize-ssr.test.ts` now asserts byte-identical output with no `document` at all, rather than
  asserting a degraded fallback.
- **Storage keeps entities encoded; display decodes them.** Measured: `learning rate < 0.01` is
  stored as `learning rate &lt; 0.01`, which React would render literally — visible corruption of
  the user's own material, worst in the maths-heavy documents this product is for. Decoding at
  REST is not safe (a model emitting `&lt;img …&gt;` round-trips into live markup in the database),
  so `plainText()` decodes at the React boundary, where React re-escapes on output.

**Readiness is pinned against the prototype's own JavaScript**, extracted from the reference HTML
and executed as an oracle (`test/prototype-oracle.ts`), across the curated graph and 40 randomised
mastery assignments. This is not ceremony: the worked example in the test was first written as
**25 from hand arithmetic, and the oracle said 27**. Hand-written expectations would have shipped
the 25. Mutation drills: uniform weights instead of `1/depth` → 48 tests red; direct prerequisites
only (the doc's old wording, implemented literally) → 57 red, including closure diffs.

**docs/05 W6 corrected.** It described the algorithm as weighting "each prerequisite by `1 / depth`",
which reads as direct prerequisites only and produces different numbers on any graph deeper than
one layer. The reference walks the full transitive closure at shortest depth. On the curated graph
`cnn` scores 27 with the closure and 0 with the paraphrase — the size of the difference the wording
hid. The corrected section carries the worked example.

**The poll backoff is now measured, not just documented.** 1.5s for 15s then 3s, asserted as a
request count under fake timers (~11 in the fast window, ~10 in the next 30s). A test that only
checked "the graph eventually appears" would pass against a flat 1.5s poll, and the coupling to the
600/min limit on `GET /api/graph/:id` — which decides whether a class of 30 behind one campus NAT
gets 429s on their own progress modal — would be lost the first time someone simplified the loop.

**Two accepted spend windows, recorded together** because they are the same shape and should be
reasoned about as a pair:

| Window | Bound | Why it is accepted |
|---|---|---|
| **Graph build** (`finishGraph`) | At most one wasted model call, when two builds for the same graph are genuinely simultaneous | Corruption is fully closed by the conditional `UPDATE … WHERE status = 'processing'`, which takes the row lock first. Closing the spend window too needs a `building` claim status, which docs/03 does not define |
| **Concept detail** (`setConceptDetail`) | At most one wasted model call, when a user double-clicks a concept fast enough that both requests pass the stored-detail check before either commits | Same mechanism: `UPDATE … WHERE detailJson IS NULL` takes the row lock, so first commit wins and the loser serves the winner's value rather than overwriting it. Closing it needs request coalescing — more machinery than one duplicate call justifies |

Both are bounded by the per-user daily quota. The detail case matters slightly more than it looks:
the two results are separate generations and the client caches whichever it is handed, so a
last-write-wins update would leave two tabs — or two users of one graph — permanently holding
different explanations of the same concept.

**`after()` was NOT adopted, anywhere, including where it would have been easy.** Persisting the
concept detail off the response path is the obvious tidy-up and it was deliberately not taken:
§1.6 is an open hard blocker specifically about `after()`'s deadline and zombie exposure, and
adopting it in a small safe-looking corner would decide that question by accident, in the place
where the consequences are least visible, before the place where they are worst is fixed. Concept
detail is one model call inside one request — well inside the 300s deadline, unlike the build.

**The client's timeout retry deliberately does not re-spend.** With `ZOMBIE-PROCESSING-ROW`
unfixed, a build killed by the platform leaves its row `processing` forever and the build route's
idempotency check refuses only *finished* graphs — so a retry button that re-fires the build is
permitted and spends again. "Keep waiting" resumes polling only, and a test guards that decision
with a pointer to revisit it when §1.6 is fixed.

**One deliberate deviation from the prototype**, recorded rather than silently taken: the
prototype's `@media (max-width: 720px)` rule hides the label `<span>` inside every `.btn-primary` /
`.btn-secondary` to collapse icon+label toolbar buttons to icons. Applied globally it also empties
the one button in the app whose span is its entire content and has no icon behind it — "Try again"
in the Quick Notes error state — leaving an empty box at the moment the user is trying to recover.
Scoped to `.gbar-right`. The visible design is identical either way.

#### Phase 5 verification against real Postgres and a real browser (2026-08-02)

The integration and browser proofs had been **written but unrun across three slices** — no
container runtime and no server in the authoring environment. Both suites were run properly here.
`npm test` completed end to end for the first time: **646 tests, 45 files, all three projects.**

**One real defect, found by the repo's own coverage guard.** `getLatestGraph` — added in slice 3
so `/graph` knows which graph to open on — had **no cross-user isolation case**, and the guard in
`isolation.integration.test.ts` (which auto-discovers every exported query function) failed the
build:

```
AssertionError: Query functions with no isolation coverage — add a case in
isolation.integration.test.ts:
graphs.getLatestGraph: expected [ 'graphs.getLatestGraph' ] to deeply equal []
```

The function was in fact scoped (`eq(graphs.userId, userId)`), so this was a missing *proof*
rather than a live leak — but it is exactly the gap that guard exists to catch, and it could not
have been caught in the authoring environment. Worth being precise about the shape it would have
had: `/graph` takes no id from the path, so an unscoped version would open user B's workspace on
user A's most recent upload — the whole graph, its concepts and its edges — **with no id ever
guessed and no attacker involved**. That is worse than the usual IDOR shape; it would just happen.
Two cases added: each user gets their own most recent graph, and a user with no graphs gets
nothing rather than someone else's.

**The two `setConceptDetail` concurrency drills pass against real Postgres.** Sequential
first-commit-wins, and three genuinely concurrent writers producing exactly one winner — the
sequential case alone cannot prove the rule, because by the time the second statement runs the
first has committed and Postgres never arbitrates two live writes.

**`test/e2e/graph-proofs.mjs` — 8/8, including both negative controls.**

| Check | Result |
|---|---|
| Panel is a bounded, scrollable region (premise) | panel scrollable, page scrollable |
| Computed `overscroll-behavior` | `contain` |
| Computed `position` | `sticky` |
| Scrolling the panel to its end does not move the page | page `scrollY 0`, panel `scrollTop 1249` |
| **Control:** without `overscroll-behavior: contain` | **page scrolled to 78** |
| No payload executed in a real browser | 10 payloads, every surface |
| No executable markup survived the real parser | — |
| **Control:** the same payloads unescaped, unassisted | **fired: `EDGIFY-XSS:img`** |

The XSS control is the one jsdom could not give: Chromium fires `img onerror` and `svg onload`
itself, with no dispatching, so the containment result is measured against a live vector rather
than a driven one.

**Two bugs in the proof harness itself, which meant it had never actually executed.** Both were
in the script, not the app: `getByRole("tab", { name: "Graph" })` matched the top bar's
"Knowledge graph" link as well as the view switcher (Playwright strict mode rejects the
ambiguity — fixed with `exact: true`), and an SVG `<g>`'s own `<text>` child intercepts pointer
events so the node click never satisfied actionability (fixed with `force: true`). A written-but-
unrun proof is worth roughly nothing, and this is the second time in Phase 5 that running
something for the first time was where the value was.

#### End-to-end timing, live (2026-07-30)

First full exercise of the ingestion path against the real stack: production build, real Neon,
real OpenRouter, driven by curl with a seeded session. Five distinct genuine 30-page text PDFs
(~97–104 KB, ~69k extracted chars), each rotated so the first 9,000 characters differ — otherwise
runs 2+ would hit the contentHash clone and the generation cache and measure nothing.

| Run | Upload | Build | **Total** | Model (ledger) | Concepts/edges |
|---|---|---|---|---|---|
| 0 | 6.0s | 48.0s | 54.0s | 42.0s | 6 / 6 |
| 1 | 4.0s | 88.9s | **93.0s** | 83.3s | 8 / 9 |
| 2 | 3.4s | 70.2s | 73.7s | 65.3s | 7 / 6 |
| 3 | 3.5s | 20.8s | **24.4s** | 17.7s | 6 / 5 |
| 4 | 2.9s | 79.7s | 82.8s | 74.0s | 6 / 5 |

**Median total 73.7s** (upload 3.5s, build 70.2s). Min 24.4s, max 93.0s. A measurement, deliberately
not a CI gate — same treatment as the Phase 4 first-token figure.

**Three things the number hides, and they matter more than the number.**

1. **Every one of these is a BEST CASE.** All five ledger rows read `tier: "free"`, `outcome: "ok"`
   — first rung, first attempt, no retry, no repair, no fallback. The spread (24.4s → 93.0s, 3.8x)
   is pure free-model variance on a *single* call.
2. **"30-page" is not what is being measured.** `GRAPH_TEXT_LIMIT` caps the prompt at 9,000
   characters, so of ~69,600 extracted characters the model saw ~13% — roughly the first 4 pages
   (`tokens_in` ≈ 2,600 confirms it). Build time is therefore essentially **independent of document
   length**; a 100-page PDF would cost the same model time and only slightly more parsing. The
   criterion passes, but a reader could reasonably assume the graph covers all 30 pages. **It does
   not.** Whether that is the right product behaviour is a real question, and a separate one from
   this timing.
3. **Parsing is not the bottleneck.** Upload+extract+hash+insert for 30 pages is ~3.5s, about 5% of
   the total. The model call is ~90–95%.

**Does it fit the 300s Cloud Run request timeout? Not with comfortable margin — this is a finding,
not a number to record.**

On the observed best case, yes: max 93.0s against 300s is 3.2x headroom. But the ladder's whole
purpose is the case where the first rung *doesn't* answer, and none of these five runs exercised
it. At the observed median single-call latency of ~65s:

| Ladder path | Model calls | Est. wall clock |
|---|---|---|
| First attempt succeeds (all 5 runs above) | 1 | ~65s |
| Free rung repairs once, then succeeds | 2 | ~130s |
| Free rung fails + repairs, fallback rung succeeds | 3–4 | ~195–260s |
| Reaches the paid rung | 5+ | **>300s — killed** |

So a build that merely repairs once and falls through to the fallback rung lands at ~260s, inside
300s with almost no margin; anything reaching the paid rung exceeds it. That is not an exotic
tail — free-tier rate limiting under load is the ordinary case the ladder exists for.

**And being killed by the platform is worse than failing.** Nothing writes `status = "failed"` on
a mid-flight kill, so the row stays `processing` forever: `GET /api/graph/:id` reports `processing`
indefinitely, the client polls to its 90s timeout and shows the busy message over a graph that
never resolves, and because the build route's idempotency pre-check only refuses non-`processing`
graphs, a retry is *allowed* and spends again. There is no reaper.

**These two defects are recorded as blocker-class, not as tuning notes**: `LADDER-EXCEEDS-TIMEOUT`
and `ZOMBIE-PROCESSING-ROW`, in the Phase 5 scope above, the Phase 7 scope below, docs/09 §1.6, the
docs/09 §3.1 failure-injection table, and go/no-go item 8. They are **flagged rather than built** —
out of this slice's scope — and all three fixes (wall-clock budget between rungs, heartbeat to
`failed`, stale-`processing` guard) are required; none substitutes for another.

The `after()` coupling is the part most likely to be got wrong later, so it is stated in both
places: **`after()` has identical deadline exposure and does not address this.** It moves the
build off the response path without lengthening the deadline — it only changes who kills it, and
makes the kill less visible. Confirming CPU-after-response is necessary but **not sufficient**;
the budget is the real fix and is required regardless of `after()`.

**A real bug found by this run** — `realRunModel` did not pass `maxRetries: 0` while
`realRunStream` always had. The buffered seam therefore ran the AI SDK's default **2 internal
retries beneath every ladder attempt**, so ~14 ladder calls could become ~42 provider requests:
free-tier quota burned on invisible retries, our jittered backoff bypassed, and worst-case latency
tripled against exactly the timeout analysed above. `graph_structure` and `concept_detail` both use
this seam, so Phase 5 was the most exposed. Fixed, and guarded by `lib/ai/retry-discipline.test.ts`
so neither seam can regress.

---

## Phase 6 — Landing page and demo (2–3 days)

**Scope**
- Port the dark Fluxora landing page exactly, scoped so its dark tokens cannot leak into the
  light workspace — scope the dark tokens to `#landing` (`.claude/rules/ui.md`)
- Replace `app/(marketing)/page.tsx`, the Phase 1 placeholder that currently owns `/`, with the
  real landing page
- "Launch workspace" and "Try the demo" entry points
- `/demo` route, fully interactive, no session required
- Responsive behaviour down to mobile

**Acceptance criteria**
- [ ] Landing page matches the prototype
- [ ] Dark landing tokens do not affect workspace styling
- [ ] `/demo` works fully signed out — graph, quizzes, flashcards, export
- [ ] Demo content is never written to any user's records
- [ ] Logo returns to the landing page from the app

---

## Phase 7 — Deploy and verify (2–3 days)

**Scope**
- Cloud Run deployment per `07-deployment.md`
- Secrets in Secret Manager, not environment plaintext
- GitHub Actions: typecheck, lint, test, build, deploy
- Migrations as an explicit deploy step
- Sentry release tracking
- Internal usage dashboard from `usage_ledger`
- Load test at 25 concurrent (2.5x target)
- **BLOCKER — bound the graph build's wall clock (`LADDER-EXCEEDS-TIMEOUT`,
  `ZOMBIE-PROCESSING-ROW`).** Carried from Phase 5, gated in docs/09 §1.6 and go/no-go item 8.
  A wall-clock budget (~200s) checked **between ladder rungs**, a heartbeat that transitions
  abandoned builds to `failed`, and a build-route guard that refuses or reclaims a stale
  `processing` row instead of re-spending on it. **This is the real fix, and it is required
  regardless of `after()`.**
- **Confirm Cloud Run keeps CPU allocated after the response is sent.** Phase 5 deliberately made
  the graph build a separate client-fired request (`POST /api/graph/:id/build`) rather than using
  Next's `after()`, because `after()` silently depends on this setting and a wrong guess ends every
  upload in `failed` with no application-level symptom. Once confirmed, folding the build back into
  `POST /api/documents` via `after()` removes a round trip and a client responsibility — an
  optimisation to adopt *after* verification, keeping the build route as the fallback. Do not
  reverse the order (docs/05 W4).

  **`after()` does NOT address the timeout blocker above, and must not be adopted before it is
  fixed.** `after()` has **identical deadline exposure**: moving the build off the response path
  does not lengthen the deadline, it only changes *who* kills it — and it makes the kill *less*
  visible, since there is no longer a hanging request to notice. So confirming CPU-after-response
  is **necessary but not sufficient**; adopting `after()` without the budget converts a visible
  timeout into a silent one, and `ZOMBIE-PROCESSING-ROW` gets strictly worse.

  The two are **orthogonal**: sequence them independently. The budget is required whether or not
  `after()` is ever adopted; `after()` is a round-trip optimisation that may only be taken once
  the budget exists *and* CPU-after-response is confirmed

**Acceptance criteria**
- [ ] Deployed and reachable over HTTPS
- [ ] Cold start under ~5 seconds end to end
- [ ] 25 concurrent simulated users: zero 5xx responses
- [ ] Ten real users for a week without intervention
- [ ] Cost dashboard shows per-user spend
- [ ] Deliberately exhausting the free tier degrades to paid, then demo, cleanly in production

---

## Timeline

| Phase | Days |
|---|---|
| 1 Foundation | 3–5 |
| 2 Guardrails | 2–3 |
| 3 AI layer | 4–6 |
| 4 Quick Notes | 4–5 |
| 5 Documents and graph | 5–7 |
| 6 Landing and demo | 2–3 |
| 7 Deploy | 2–3 |
| **Total** | **22–32 working days** |

Roughly 5–7 weeks part-time. Phases 1–3 are the foundation and should not be rushed; 4–6 go
faster than they look because the prototype has already settled the design decisions.

---

## Common failure patterns to avoid

| Pattern | Why it goes wrong |
|---|---|
| Generating the whole app in one prompt | Produces code that compiles and does not work, with no way to tell which part is broken |
| Building features before guardrails | The expensive lesson arrives after the credits are gone |
| Skipping the isolation test | The one bug class that turns a project into an incident |
| Redesigning the UI while porting | The prototype's design is settled; re-litigating it costs days |
| Adding a queue, Redis, or storage "for later" | Complexity that fails without ever having paid for itself |
| Trusting model output | It will be malformed. Validate every time |
| Testing only the happy path | The whole product promise is what happens when things fail |

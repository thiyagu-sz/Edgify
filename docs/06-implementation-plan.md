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
- Rate limiting on unauthenticated routes — **INCOMPLETE, found 2026-07-28 during Phase 4.**
  `withRateLimit` exists and works, but is applied to `/api/health` **only**. `/api/notes/generate`
  and `/api/usage` are unwrapped, so an unauthenticated caller reaches both. On the generate route
  that is the expensive one: the handler resolves the session (a DB read) before rejecting, so an
  attacker with no credentials can drive database work per request, and the route is the entry
  point to model-tier spend. Wrap both with the same `withRateLimit(routeName, handler)`
- **`checkRateLimit` costs two sequential round trips; make it one before it goes on the authed
  routes.** It runs the counter upsert *and* an elapsed-window cleanup `DELETE`
  (`lib/rate-limit.ts`), both awaited in sequence. Only the upsert answers the question the
  request is asking. The `DELETE` is pure housekeeping — the code's own comment notes an elapsed
  window is never read again — so it is a full round trip (~275ms against a remote database)
  charged to every request for work no request needs. On `/api/health` that is invisible; in
  front of generation it doubles the wrapper's cost on the first-token path. Move it off the
  critical path:
  - **Opportunistically** — the upsert's `RETURNING count` already tells you when a *new* window
    row was created (`count === 1`), which is exactly when a prior window has just become
    elapsed. Cleaning only then reduces the `DELETE` from once per request to once per window per
    key, needs no new machinery, and keeps it inside the same handler
  - **Backgrounded** — fire and forget. If chosen, attach a `.catch()` at the point of creation:
    an unobserved rejected promise becomes an `unhandledRejection`, which this branch already hit
    once for real (docs/09 §3.1) and which is a process-stability risk on Cloud Run
  - **Batched** — a periodic sweep across all keys, if a scheduler exists by then

  Whichever is chosen, the wrapper must add **one** round trip, not two.

**Acceptance criteria**
- [ ] A test billing alert actually fires
- [ ] Isolation test: user A's document is invisible to user B through **every** query function
- [ ] Quota increments, enforces at the limit, and resets at day boundary
- [ ] An unauthenticated route rejects a burst of requests
- [ ] **`/api/notes/generate` and `/api/usage` reject a burst of unauthenticated requests** — not
      met; see the scope note above
- [ ] **`checkRateLimit` issues one round trip per request, not two** — assert the query count,
      not the wall-clock time, so the check does not depend on network distance
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
- [x] Side-by-side with `trellis-prototype.html`, the UI is visually indistinguishable
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
  content-addressed and does not depend on `userId`). **Blocked on rate limiting — do not
  implement it before then.** The cache lookup is an `UPDATE…RETURNING`, so overlapping it with
  the session lookup means issuing a database *write* before the caller is authenticated, and
  `/api/notes/generate` is currently unwrapped (see the Phase 2 scope note). That converts an
  unauthenticated request from one read into a read plus a write — a DoS amplification, not a
  latency optimisation. The ordering is a hard dependency: **rate limit the route first, then
  parallelise.**

  Note what this does *not* buy, because the arithmetic is counter-intuitive. `checkRateLimit`
  costs **two** sequential round trips today — the counter upsert and an elapsed-window cleanup
  `DELETE` — so adding the wrapper as it stands puts ~550ms back onto the path that parallelising
  removes ~283ms from: **net worse by roughly 267ms** at ~275ms per round trip. Moving the
  cleanup off the critical path is therefore a prerequisite, not a nicety, and is logged as a
  Phase 2 scope item. Even then the best case is about a wash (~275ms added against ~283ms
  removed).

  So: rate limit the route because it is a security gap, not because it unlocks a speedup. The
  speedup does not survive its own precondition, and the sequencing is **fix the cleanup → wrap
  the routes → only then parallelise**.

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
- `GET /api/graph/:id` with polling
- Port the graph UI: SVG, panel, concept library, study plan, progress modal
- Lazy concept detail
- Mastery tracking
- **Dedupe on `contentHash`** — clone an existing graph instead of regenerating

**Acceptance criteria**
- [ ] A 30-page PDF produces a graph within ~90 seconds
- [ ] The same PDF uploaded by a second user returns instantly, zero tokens
- [ ] A scanned PDF produces the honest scanned-document message
- [ ] An 11 MB file is rejected before the body is read
- [ ] An encrypted PDF fails with a clear message, not a crash
- [ ] Clicking a concept generates detail once and caches it
- [ ] The panel scrolls independently; the page behind does not move
- [ ] Marking mastery updates readiness across the graph
- [ ] Graph export produces a complete study guide

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

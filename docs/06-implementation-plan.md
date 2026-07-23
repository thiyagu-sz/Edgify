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
- Rate limiting on unauthenticated routes

**Acceptance criteria**
- [ ] A test billing alert actually fires
- [ ] Isolation test: user A's document is invisible to user B through **every** query function
- [ ] Quota increments, enforces at the limit, and resets at day boundary
- [ ] An unauthenticated route rejects a burst of requests
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
- `lib/cache.ts` — content-addressed dedupe
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
- [ ] Side-by-side with `trellis-prototype.html`, the UI is visually indistinguishable
- [ ] Tokens stream progressively; first token within ~2 seconds
- [ ] All nine formats produce sensible output
- [ ] Quiz scores correctly and shows explanations
- [ ] PDF and DOC exports open correctly in a reader and in Word
- [ ] Approaching quota shows the counter; reaching it shows the friendly state
- [ ] Demo banner appears when the ladder falls through

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
  light workspace
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

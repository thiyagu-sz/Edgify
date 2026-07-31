# AGENTS.md — Rules for coding agents working in this repository

Place this file at the repository root. Read it before writing any code.

---

## Project

Edgify: an academic study workspace. Two features — **Quick Notes** (short, high-yield exam
revision from pasted or uploaded material) and **Knowledge Graph** (concept dependency graph
built from an uploaded document, with per-concept explanations).

Full specification lives in `docs/`. Read `docs/01-architecture.md` and
`docs/02-tech-stack.md` before your first change.

---

## Non-negotiable rules

**1. Never call the model API from the browser.**
The OpenRouter key lives in server-side environment variables only. Any code that puts
`OPENROUTER_API_KEY` in a client component, a `NEXT_PUBLIC_` variable, or a browser fetch is
wrong and must be rejected. This is the single most important rule in the repository.

Before every commit, scan the staged diff for secret **values** (not variable names — matching
identifiers like `GOOGLE_CLIENT_SECRET` only produces false positives):

```bash
git diff --cached | grep -iE "sk-or-v1-[A-Za-z0-9_-]{20,}|postgres(ql)?://[^\"]*@|client_secret\s*[:=]\s*[\"'][^\"']+|SENTRY_DSN=https"
```

If it prints anything, stop and inspect — a real credential may be about to be committed.

Two fixes to this command, both made 2026-07-29 and both verified against sample strings rather
than assumed:

- **The OpenRouter pattern requires a key body**, not just the `sk-or-v1` prefix. Matching the
  bare prefix fires on every piece of documentation that shows the key format — `docs/07` has
  carried such a line since Phase 1 — so it hit on every commit touching those files, and would
  have hit again on the Phase 7 whole-tree scan. An alert that is always noise is one people
  learn to wave through, which is worse than not having it. Requiring 20+ key characters loses
  nothing: a real key is far longer, and a fragment too short to match is not a usable credential.
- **`postgres://` alone missed real credentials.** Neon issues `postgresql://` URLs, `.env.local`
  uses that form and `lib/env.ts` explicitly accepts both — and `postgres://` is not a substring
  of `postgresql://`, so this check had been blind to the exact URL shape this project uses. Now
  `postgres(ql)?://`.

**Known baseline — three files, and only these three:**

- `.env.example` — its placeholder `postgresql://user:password@…` line.
- `test/secret-scan.test.ts` — credential-shaped fixtures, which must match or the test proves
  nothing. Written as `EXAMPLE_*` bodies on RFC 2606 `.invalid` hosts so a hit is dismissible at
  a glance, and deliberately not obfuscated, so a real key pasted there is still caught.
- **This file**, whenever the command above is edited: the pattern matches its own text, because
  `client_secret\s*[:=]\s*[\"'][^\"']+` is itself a `client_secret` assignment. Harmless, and not
  worth contorting the regex to avoid.

Neither is suppressed. Telling a placeholder from a real credential by regex means trusting the
literal string `user`, which is a bypass waiting to happen. Treat hits from these two files as
the baseline and **anything else as real** until inspected.

**This command is covered by `test/secret-scan.test.ts`**, which reads the pattern out of *this
file* — so the doc stays the source of truth — and asserts both directions: every credential
shape is caught, and every documentation placeholder is ignored. It also fails if the pattern
cannot be extracted or is empty, because an empty regex matches every line and would report a
confident all-clear while checking nothing. Change the command and `npm test` tells you what you
broke. The `postgresql://` gap above was found that way, not by reading it.

**2. Every database query filters by `userId`.**
There is no row-level security in this stack. Tenant isolation is enforced in application
code. All database access goes through `lib/db/queries/`. Every exported function takes
`userId` as its first parameter and applies it in the `WHERE` clause. Never write a raw query
in a route handler or a server component.

**3. Every model call goes through `lib/ai/generate.ts`.**
That module owns the degradation ladder (see `docs/04-resilience.md`). Do not call
`streamText` or the OpenRouter provider directly from anywhere else. If you need a new
generation type, add it to that module.

**4. The user never sees a raw error.**
No stack traces, no HTTP status codes, no vendor names, no `error.message` rendered to the
UI. Map every failure to one of the user-facing states defined in `docs/04-resilience.md`.

**5. Validate every model output with Zod before use.**
Models return malformed JSON. `JSON.parse` without a schema check is a bug. Parse, validate,
and on failure follow the repair-then-fallback path in `docs/04-resilience.md`.

**6. The prototype is the visual specification.**
`docs/reference/edgify-prototype.html` defines the design. Port its markup and CSS custom
properties faithfully into React components and the Tailwind theme. Do not redesign.

---

## Conventions

- **TypeScript strict mode.** No `any`. No `@ts-ignore` without a comment explaining why.
- **Server Components by default.** Add `"use client"` only when you need state, effects, or
  browser APIs.
- **Route handlers stay thin.** Parse and validate input, call a service in `lib/`, shape the
  response. No business logic in `app/api/`.
- **Zod schemas live next to what they validate** and are exported for reuse.
- **No `console.log` in committed code.** Use the logger in `lib/log.ts`.
- **Environment variables are validated at boot** in `lib/env.ts` using Zod. The app should
  refuse to start with a missing or malformed variable rather than fail at request time.

## Directory layout

```
app/
  (marketing)/page.tsx        Landing page — dark Fluxora theme
  (app)/                      Authenticated workspace — light theme
    notes/page.tsx
    graph/page.tsx
  api/
    auth/[...all]/route.ts    Better Auth handler
    notes/generate/route.ts   Streaming generation
    documents/route.ts        Upload + parse
    graph/[id]/route.ts       Graph read + status
lib/
  ai/
    generate.ts               Degradation ladder. All model calls go here
    prompts.ts                Versioned prompt templates
    schemas.ts                Zod schemas for model output
    models.ts                 Model routing config
  db/
    schema.ts                 Drizzle schema
    queries/                  All database access, userId-scoped
  demo/                       Static fallback content (see 04-resilience)
  graph/
    layout.ts                 Layer-based layout, ported from the prototype. Pure, no I/O
  parse/                      PDF/DOCX text extraction
  quota.ts                    Per-user limits
  cache.ts                    Content-addressed dedupe
  env.ts                      Validated environment
  log.ts
components/                   Ported from the prototype
docs/
```

---

## Before you write code

- **Check the current API.** The AI SDK, Better Auth, and Next.js all move quickly. Where a
  document shows a code pattern, treat it as intent rather than exact syntax, and verify the
  signature against the library's current documentation. Do not invent API surface.
- **Prefer the smallest change that satisfies the acceptance criteria.** These documents
  describe a deliberately small system. Adding a queue, a cache layer, a state management
  library, or a service abstraction that the spec does not ask for is a regression.
- **If a requirement is ambiguous, ask rather than guess.** A wrong assumption baked into
  Phase 2 is expensive by Phase 6.

## Before you say a phase is done

Run all of these:

```bash
npm run typecheck     # tsc --noEmit
npm run lint
npm run test
npm run build
```

Then check the phase's acceptance criteria in `docs/06-implementation-plan.md` explicitly,
one line at a time. "It compiles" is not "it works".

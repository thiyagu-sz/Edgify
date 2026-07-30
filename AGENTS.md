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
git diff --cached | grep -iE "sk-or-v1|postgres://[^\"]*@|client_secret\s*[:=]\s*[\"'][^\"']+|SENTRY_DSN=https"
```

If it prints anything, stop and inspect — a real credential may be about to be committed.

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

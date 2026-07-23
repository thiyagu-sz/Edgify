# AGENTS.md — Rules and conventions for coding agents

Trellis is an academic study workspace with two features: **Quick Notes** (fast exam revision)
and **Knowledge Graph** (deep understanding from an uploaded document). Target ~10 concurrent
users; $0/month infrastructure in a normal month; the only paid service is OpenRouter credits.

The full specification lives in `docs/`. Read `docs/01-architecture.md` and
`docs/02-tech-stack.md` before starting, the data model and isolation rules in
`docs/03-data-model.md`, the never-fail spec in `docs/04-resilience.md`, and the phase you are
on in `docs/06-implementation-plan.md`.

> Provenance note: the project's original `AGENTS.md` arrived empty (0 bytes), so this file was
> reconstructed from the `docs/` specification. If a canonical `AGENTS.md` exists, it takes
> precedence over this reconstruction.

## The six non-negotiable rules

1. **The model API key is server-only.** All OpenRouter/model calls run on the server; the key
   must never reach the browser and is never prefixed `NEXT_PUBLIC_`. (`docs/01`, `docs/07`)
2. **Every query function takes `userId` first and filters on it.** There is no row-level
   security — tenant isolation is application code. All database access lives in
   `lib/db/queries/*`; single-row lookups filter on **both** the id and the `userId`.
   (`docs/03`)
3. **All model calls go through `lib/ai/generate.ts`.** The degradation ladder, retries,
   fallback and demo path live in that one module; no route or component calls a model provider
   directly. (`docs/01`, `docs/04`)
4. **The user never sees a raw failure.** On any error — rate limit, exhausted credits,
   malformed output — show cached content, demo content, or *"Server is busy, please try again
   in a moment."* Never a stack trace, an HTTP status code, or a vendor name. (`docs/04`,
   `docs/README`)
5. **Validate every model output with Zod.** Structured output is validated (schemas in
   `lib/ai/schemas.ts`); on failure, repair once, then fall back. Never trust raw model JSON.
   (`docs/01`, `docs/02`)
6. **The prototype is the visual specification.** `docs/reference-trellis-prototype.html`
   defines the design exactly. Port it faithfully — do not redesign it, do not "improve" it, do
   not substitute a component library. Sanitise model output before `dangerouslySetInnerHTML`;
   escape model-generated strings in SVG text and HTML attributes. (`docs/README`,
   `.claude/rules/ui.md`)

## Working method

- Implement **one phase at a time** from `docs/06-implementation-plan.md`.
- Stop at the end of a phase and report which acceptance criteria pass.
- Never start the next phase unless asked.
- Do not generate the whole app in one prompt — it compiles and does not work.

## Technical constraints

- Node 22 LTS · Next.js ^16 (App Router, streaming) · React ^19 · TypeScript `strict: true`,
  no exceptions.
- Database: Neon Postgres via Drizzle, using the pooled `pg` driver against the **pooled**
  connection string. `lib/db/client.ts` must retry connection errors (Neon cold start).
- Auth: Better Auth with **Google OAuth only**. No passwords, no email flows.
- Models: OpenRouter via the Vercel AI SDK. Model IDs come from env with fallback lists.
- Validate all environment variables in `lib/env.ts` (Zod) at boot; the app refuses to start on
  a missing or malformed value.
- Run migrations as an explicit step, never on application boot.

## Commands

- Dev: `npm run dev`
- Build: `npm run build`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`

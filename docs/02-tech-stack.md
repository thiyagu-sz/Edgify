# 02 — Technology stack

Every entry states what it is, why it was chosen, and what would make us change it. Pin
versions at install time; the ranges below reflect what was current in July 2026.

---

## Runtime and framework

| Package | Version | Purpose |
|---|---|---|
| Node.js | 22 LTS | Required by Next 16 (Node 20+) and by `@openrouter/ai-sdk-provider`, which requires Node 22+ and is ESM-only |
| `next` | ^16.2 | App Router, streaming, React Server Components. Next 16 is Active LTS |
| `react` / `react-dom` | ^19.2 | Required by Next 16 |
| `typescript` | ^5.x | `strict: true`, no exceptions |

**Why Next.js rather than a separate API:** one deployment, one language, native streaming,
and the prototype is already HTML/CSS/JS that ports cleanly into React. A separate backend
would be two things to deploy for no benefit at this size.

---

## Hosting — Google Cloud Run

Containerised Next.js (`output: "standalone"`), scaling to zero when idle.

Chosen because it is genuinely pay-per-use with a permanent free allowance of roughly 2M
requests, 180K vCPU-seconds and 360K GiB-seconds per month — far beyond ten users — and
because its request timeout is generous enough to run document ingestion inline, which is
what lets us skip a job queue entirely.

It also handles high per-instance concurrency, which suits this workload: model calls are
almost entirely I/O wait, so one small instance absorbs all concurrent users comfortably.

*Alternatives considered:* Vercel Hobby is free but prohibits commercial use and hard-stops
when a cap is hit. Cloudflare Workers has a $5/month floor once past the free tier and its
V8-isolate runtime complicates Node library use. Neither is wrong; Cloud Run fits the
pay-per-use requirement best.

*Change when:* cold starts become a real complaint and you are willing to pay for a warm
minimum instance.

---

## Database — Neon Postgres

| Package | Purpose |
|---|---|
| `drizzle-orm` | Typed SQL, light runtime, migration-friendly |
| `drizzle-kit` | Migration generation |
| `pg` *or* `@neondatabase/serverless` | Driver — see note below |

Neon is serverless Postgres that suspends after about five minutes of inactivity and bills
per compute-hour with no monthly minimum. The free allowance (100 compute-hours, 0.5 GB)
covers this workload with room to spare, and exceeding it costs cents rather than taking the
app offline.

**Driver note:** on Cloud Run the container is long-lived, so a standard pooled `pg`
connection against Neon's **pooled** connection string is appropriate and reuses connections
well. Use the serverless HTTP driver only if you later move to a per-request runtime.

**Important:** because Neon suspends when idle, the first query after a quiet period can fail
or hang while compute resumes. `lib/db/client.ts` must retry connection errors two or three
times with short backoff. Do not skip this — it presents as random failures in production
and is very confusing to debug after the fact.

*Why not Supabase:* it does not scale to zero, so you pay for idle compute, and its free tier
hard-stops. Its real advantage — row-level security — is discussed in `04-resilience.md`
and `03-data-model.md`, and is the main thing this stack gives up.

---

## Authentication — Better Auth

| Package | Purpose |
|---|---|
| `better-auth` | Auth library; users live in your own Postgres |

Better Auth now maintains Auth.js, which is in security-patch-only mode — so NextAuth is the
wrong default for a new project. Better Auth is MIT-licensed, scaffolds its schema via CLI,
has a Drizzle adapter, and costs nothing at any scale because it is a library rather than a
service.

**Use Google OAuth only.** No passwords means no reset flow, no verification emails, no
credential storage, and no transactional email provider. It removes an entire category of
work and of security mistakes. Add email sign-in later only if users ask for it.

*Honest caveat:* Better Auth is young and some teams have reported rough edges. Prototype the
login flow first, in Phase 1, before the rest of the app depends on it.

---

## Models — OpenRouter

| Package | Version | Purpose |
|---|---|---|
| `ai` | ^7.x | Vercel AI SDK core — `streamText`, `generateObject` |
| `@openrouter/ai-sdk-provider` | ^2.x | Official OpenRouter provider. Requires Node 22+, ESM-only |
| `@ai-sdk/react` | ^7.x | Client streaming hooks |
| `zod` | ^4.x | Model output validation |

The AI SDK gives streaming, structured output and provider abstraction for free, and its
`generateObject` with a Zod schema is materially more reliable than parsing JSON out of a
text completion by hand.

> **Zod version:** `zod` installs as **`^4.x`** (Phase 1, confirmed). The earlier `^3.x` range
> here was stale; v4 is the current major and what the code is written against. Do not "correct"
> it back to v3.

**Model routing** (`lib/ai/models.ts`) — keep every model ID in an environment variable with
a fallback list. Free model IDs on OpenRouter rotate out with little notice, and a retirement
should be a config change rather than an outage.

| Task | Tier | Reason |
|---|---|---|
| Key points, short notes, summary | Free / budget | High volume, low difficulty |
| MCQs, quick test | Free / budget | Structured output; validate strictly |
| Formulas and terms | Budget / mid | Precision matters |
| Graph structure extraction | Mid | Low volume, defines the whole graph |
| Concept explanation | Mid | Quality is the point |

*Rate limits to design around:* free (`:free`) models are capped at 20 requests per minute
and 1,000 per day once $10 of credits has ever been purchased. Ten users at a 30/day quota
generate at most ~300 requests/day, comfortably inside that. Paid models via credits have no
OpenRouter platform limit. Failed requests, including 429s, count against the free daily
quota — so retries must be limited and jittered.

---

## Document parsing

| Package | Purpose |
|---|---|
| `unpdf` | PDF text extraction |
| `mammoth` | DOCX text extraction |

`unpdf` ships a serverless build of Mozilla's PDF.js with zero native dependencies and works
across Node, edge and serverless runtimes. **Do not use `pdf-parse`** — it depends on
`canvas`, which needs native bindings that fail to build in serverless and container
environments and produces confusing deploy-time errors.

**Memory discipline:** `unpdf` holds the parsed document in memory until released. Always
destroy the document object when extraction finishes, in a `finally` block. Skipping this is
how a container quietly runs out of memory after a few dozen uploads.

*No OCR in v1.* Scanned documents are detected (extraction returns almost nothing) and the
user is told honestly. See `04-resilience.md`.

---

## UI

| Package | Purpose |
|---|---|
| `tailwindcss` | Styling. Port the prototype's `:root` custom properties into the theme |
| `marked` | Markdown rendering, exactly as the prototype does |
| `jspdf` | Client-side PDF export, exactly as the prototype does |
| `lucide-react` | Icons — only where the prototype does not already use inline SVG |

Keep the prototype's inline SVG for the brand mark, the graph, and the readiness rings. They
are already correct and pixel-matched to the design.

---

## Observability

| Package | Purpose |
|---|---|
| `@sentry/nextjs` | Errors, client and server |

Cost and usage tracking are handled by the `usage_ledger` table plus a simple internal page —
no third-party analytics vendor in v1.

---

## Deliberately excluded

Each of these was considered. Adding one without a measured reason is a regression.

| Not using | Why | Add when |
|---|---|---|
| Redis / Upstash | Postgres counters are sufficient at this volume, and the free Redis tiers are tight | Rate limiting needs sub-millisecond latency |
| Job queue (Inngest, Trigger.dev) | Cloud Run's timeout covers ingestion inline | Ingestion exceeds the timeout, or >25 concurrent users |
| Object storage (R2, S3) | Files are discarded after text extraction, so they never need storing | You want to keep originals for reprocessing |
| A separate parser service | In-process parsing with hard caps is adequate | Parsing crashes affect app availability |
| Vector database | No semantic search in v1 | You add cross-document search — then use `pgvector` in Neon, not a new vendor |
| State management library | Server Components plus `useState` cover it | Genuinely shared client state appears |
| Component library (MUI, Chakra) | The prototype's design is the spec; a library fights it | Never, for this project |

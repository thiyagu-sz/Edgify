# 01 — Architecture

## Design principle

Edgify is a small system with one unusual property: **every meaningful user action triggers a
slow, metered, third-party call that can fail.** Almost every architectural decision follows
from that, not from traffic volume. At ten concurrent users, throughput is a non-issue;
failure handling and cost control are the entire job.

So the system is deliberately small — one Next.js application, one Postgres database, one
model provider — with the complexity concentrated in a single module (`lib/ai/generate.ts`)
that handles the thing that actually goes wrong.

---

## Component map

```
                         Browser (React, Next.js)
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  Cloud Run — Next.js container │
                    │  scales to zero when idle      │
                    └───────────────────────────────┘
                         │           │           │
             ┌───────────┘           │           └────────────┐
             ▼                       ▼                        ▼
    ┌────────────────┐    ┌────────────────────┐   ┌──────────────────┐
    │ Neon Postgres  │    │  lib/ai/generate   │   │  lib/parse       │
    │ scales to zero │    │  degradation ladder│   │  in-memory PDF   │
    │                │    │         │          │   │  and DOCX        │
    │ users, docs,   │    │         ▼          │   └──────────────────┘
    │ graphs, notes, │    │   OpenRouter API   │
    │ quota, cache   │    │   :free → paid     │
    └────────────────┘    └────────────────────┘
                                    │
                                    ▼ (all paths exhausted)
                          ┌────────────────────┐
                          │  lib/demo          │
                          │  static content    │
                          └────────────────────┘
```

Four dependencies, one of which (Better Auth) is a library rather than a service. There is no
object storage, no queue, no Redis, and no separate parser service. Each of those was
considered and rejected in `docs/02-tech-stack.md`.

---

## The two request paths

These have genuinely different physics and must not share a code path.

### Path A — Interactive generation (Quick Notes, concept explanation)

Latency-sensitive, 5–30 seconds, user is watching the screen.

```
1. POST /api/notes/generate
2. Auth check           → 401 if absent
3. Quota check          → quota-exceeded state if over daily limit
4. Cache lookup         → sha256(text + format + model + promptVersion)
                          HIT: return stored result immediately, 0 tokens
5. MISS: open a streaming response
6. lib/ai/generate → OpenRouter, tokens relayed to the browser as they arrive
7. On completion: persist result, write cache entry, write usage ledger row
```

Streaming is not cosmetic. It puts the first token on screen in about a second, so a
25-second generation feels responsive, and it lets the UI show progress instead of a spinner
that might be broken.

### Path B — Document ingestion and graph construction

Slow (30–120 seconds), multi-step, must survive partial failure.

```
1. POST /api/documents  (multipart, 10 MB cap enforced before reading)
2. Validate type and size
3. Extract text in memory (unpdf / mammoth). File is discarded, never stored
4. Reject if extracted text is under ~200 characters → likely a scan, tell the user honestly
5. Hash the text. If an identical document already has a graph → clone it, return, stop
6. Insert document + text rows, status = "processing"
7. Extract structure via lib/ai/generate → concepts + prerequisite edges
8. Validate with Zod. Repair once on failure, then fall back
9. Insert concepts and edges, status = "ready"
10. Return graph id; the client polls GET /api/graph/:id until ready
```

Concept explanations are generated **lazily** on first click, through Path A, and cached
per concept. Building all of them up front would multiply the cost of every upload by nine
for content most users never open.

**Why no job queue:** Cloud Run's request timeout is configurable well beyond this workload
(default 5 minutes, far more available), so the whole ingestion runs inside one request with
the client polling for status. A queue becomes worthwhile past roughly 25 concurrent users or
if ingestion regularly exceeds the timeout. Adding one before that is complexity without
payoff.

---

## Guard layer

Three checks sit in front of every model call, in this order. They are cheap and they run
every time.

| Guard | Enforced by | Failure behaviour |
|---|---|---|
| **Authentication** | Better Auth session | Redirect to sign-in |
| **Per-user daily quota** | `lib/quota.ts`, Postgres counter | Friendly "daily limit reached" state, offer demo mode |
| **Input size cap** | Route handler, before parsing | Clear message naming the actual limit |

The quota check happens *before* the cache lookup deliberately — a cached hit costs nothing,
so cache hits do not consume quota. Order the code accordingly: auth → cache → quota → model.

---

## Data flow for deduplication

The highest-value mechanism in the system, and the reason a class of students sharing one
lecture PDF does not cost fifty generations.

```
cacheKey = sha256(normalisedText + ":" + format + ":" + modelId + ":" + promptVersion)
```

Normalisation matters: collapse whitespace, trim, lowercase nothing else. Two students
uploading the same PDF produce byte-identical extracted text and therefore the same key.

Including `modelId` and `promptVersion` means improving a prompt invalidates old entries
naturally rather than silently serving stale output from a worse prompt.

Cache entries live in Postgres, not Redis. At this scale a `SELECT` on an indexed hash column
is fast enough, and it removes a dependency.

---

## Failure boundaries

Where each class of failure is caught and contained:

| Failure | Caught in | Contained how |
|---|---|---|
| Model rate limit, overload, timeout | `lib/ai/generate.ts` | Degradation ladder — retry, fall back, demo |
| Malformed model output | `lib/ai/schemas.ts` | Zod validation → repair → fallback |
| PDF parse crash or OOM | `lib/parse/` | Size caps before parsing; try/catch; honest message |
| Database unavailable (Neon cold start) | `lib/db/client.ts` | Connection retry with short backoff |
| Quota exceeded | `lib/quota.ts` | Friendly state, demo mode offered |
| Anything unanticipated | `app/error.tsx` + route handlers | Generic busy message, logged to Sentry |

Full specification in `docs/04-resilience.md`.

---

## What runs where

| Concern | Location | Reason |
|---|---|---|
| Rendering, routing | Cloud Run container | Standard Next.js standalone build |
| Model calls | Server only | The key must never reach the browser |
| PDF/DOCX parsing | Server, in memory | Consistency, and the file is discarded anyway |
| Graph SVG rendering | Client | Interactive; the prototype already does this |
| Markdown rendering | Client | `marked`, as in the prototype |
| PDF/DOC export | Client | `jsPDF` and a Word-HTML blob, as in the prototype. Zero server cost |

Export staying client-side is deliberate — the prototype's implementation already works, and
moving it server-side would add cost and latency for no benefit.

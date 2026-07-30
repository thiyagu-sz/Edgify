# 03 — Data model

Postgres via Drizzle. Better Auth manages its own tables (`user`, `session`, `account`,
`verification`) — generate those with its CLI and do not hand-edit them.

Everything below is application schema.

---

## Tables

### `documents`
Uploaded source material. The original file is **never stored** — only its extracted text.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `userId` | text, fk → user.id, **not null** | Every query filters on this |
| `title` | text | Filename, or first heading found |
| `contentHash` | text, not null | `sha256` of normalised extracted text |
| `charCount` | integer | |
| `pageCount` | integer, nullable | PDFs only |
| `sourceType` | text | `pdf` / `docx` / `txt` / `md` / `paste` |
| `extractedText` | text | The whole point of the row |
| `createdAt` | timestamptz, default now | |

Indexes: `(userId, createdAt desc)`, `(contentHash)`

### `graphs`
One knowledge graph per document.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `documentId` | uuid, fk, not null | |
| `userId` | text, fk, not null | Denormalised on purpose — avoids a join on every read |
| `title` | text | Short topic name from the model |
| `status` | text | `processing` / `ready` / `failed` / **`demo` — see below** |
| `failureReason` | text, nullable | Internal only, never shown to the user |
| `promptVersion` | text, not null | |
| `modelId` | text, not null | |
| `createdAt` | timestamptz | |

Indexes: `(userId, createdAt desc)`, `(documentId)`

> **`status = "demo"` is reserved for the Phase 6 `/demo` route, and is never written by the
> authenticated build path.** Decided 2026-07-29.
>
> The degradation ladder's tier 5 does *not* apply to graph structure. A Quick Notes demo is a
> banner above a transient panel; a graph demo would be **rows** — concepts and edges persisted
> under the user's own `graphId`, describing a document they never uploaded. Once those rows
> exist, a banner does not undo them, and "passing off generic sample content as an analysis of
> the user's own document" is the one genuinely bad outcome `04-resilience.md` §2 names.
>
> So on the authenticated path both tier 5 and tier 6 collapse to `status = "failed"`, which
> surfaces the honest W4 message. `lib/demo/index.ts` enforces this by not answering
> `graph_structure` at all, so the ladder cannot reach a demo graph even by accident. `DEMO_GRAPH`
> stays exported for `/demo`, where nothing is persisted and there is no user document to
> misrepresent.

### `concepts`
Nodes of the graph. `detailJson` is null until the user first clicks the concept.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `graphId` | uuid, fk, not null | |
| `slug` | text, not null | Stable id within the graph |
| `name` | text, not null | |
| `difficulty` | text | `Foundational` / `Intermediate` / `Advanced` |
| `summary` | text | One line, generated with the structure |
| `detailJson` | jsonb, nullable | Definition, example, quiz, flashcards — lazily filled |
| `detailGeneratedAt` | timestamptz, nullable | |
| `estimatedMinutes` | integer | Derived from difficulty |
| `layoutX`, `layoutY`, `layoutW` | integer | Computed server-side once, stored |

Unique: `(graphId, slug)`

### `edges`
Prerequisite relationships. `prerequisiteId` must be learned before `dependentId`.

| Column | Type |
|---|---|
| `graphId` | uuid, fk, not null |
| `prerequisiteId` | uuid, fk → concepts.id |
| `dependentId` | uuid, fk → concepts.id |

Primary key: `(graphId, prerequisiteId, dependentId)`

### `notes`
Generated Quick Notes output.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `userId` | text, fk, not null | |
| `documentId` | uuid, fk, nullable | Null when the user pasted text directly |
| `format` | text, not null | `key_points`, `mcqs`, … |
| `contentMd` | text | Markdown, or serialised quiz JSON |
| `modelId`, `promptVersion` | text | |
| `createdAt` | timestamptz | |

### `mastery`
Per-user concept progress.

| Column | Type |
|---|---|
| `userId` | text, fk, not null |
| `conceptId` | uuid, fk, not null |
| `state` | text — `locked` / `learning` / `known` |
| `updatedAt` | timestamptz |

Primary key: `(userId, conceptId)`

### `generation_cache`
The deduplication table. **This is what keeps the system affordable.**

| Column | Type | Notes |
|---|---|---|
| `cacheKey` | text, pk | `sha256(normalisedText:format:modelId:promptVersion)` |
| `resultJson` | jsonb, not null | The full generated payload |
| `hitCount` | integer, default 0 | Useful signal; cheap to maintain |
| `createdAt`, `lastAccessedAt` | timestamptz | |

Deliberately **not** scoped to a user. Two students uploading the same lecture PDF must share
the entry — that sharing is the entire mechanism. See the privacy note below.

### `usage_counters`
Quota enforcement. One row per user per day.

| Column | Type |
|---|---|
| `userId` | text, not null |
| `day` | date, not null |
| `generations` | integer, default 0 |
| `tokensIn`, `tokensOut` | integer, default 0 |

Primary key: `(userId, day)`

### `usage_ledger`
Append-only record of every model call. Not an analytics afterthought — it is how quotas,
cost visibility and abuse detection all work.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid, pk | |
| `userId` | text, not null | |
| `operation` | text | `quick_notes` / `graph_structure` / `concept_detail` |
| `modelId` | text | |
| `tier` | text | `free` / `paid` / `cache` / `demo` |
| `tokensIn`, `tokensOut` | integer | |
| `costMicros` | integer | Cost in millionths of a dollar; integers avoid float drift |
| `latencyMs` | integer | |
| `outcome` | text | `ok` / `retried` / `fallback` / `demo` / `failed` |
| `createdAt` | timestamptz | |

Index: `(userId, createdAt desc)`, `(createdAt desc)`

---

## Tenant isolation — read this before writing any query

There is no row-level security in this stack. Postgres will happily return another user's
rows if you ask it to. **Isolation is entirely your application code's responsibility.**

Rules, enforced by convention and tests:

1. All database access lives in `lib/db/queries/*.ts`. No exceptions.
2. Every exported function takes `userId` as its **first** parameter.
3. Every `SELECT`, `UPDATE` and `DELETE` includes `eq(table.userId, userId)`.
4. Functions returning a single row by id take both the id and the userId, and filter on both.

```ts
// correct
export async function getDocument(userId: string, documentId: string) {
  return db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.userId, userId)),
  });
}

// wrong — a guessed uuid reads someone else's coursework
export async function getDocument(documentId: string) {
  return db.query.documents.findFirst({ where: eq(documents.id, documentId) });
}
```

**Write the isolation test in Phase 2, not later.** Create two users, create a row owned by
A, assert every query function returns nothing for B. It is fifteen minutes and it catches
the one class of bug that turns a small project into an incident.

If you later want defence in depth, Neon is standard Postgres and supports RLS. Enabling it
is a worthwhile hardening step once the app is stable.

---

## Privacy note on the shared cache

`generation_cache` is shared across users by design, and that deserves a moment's thought.

What is shared is *derived output keyed by a hash of the input*. A user can only ever receive
a cached entry by supplying a document that hashes identically — meaning they already have
the same document. No user can enumerate or browse the cache, and no key reveals anything
about the content.

Two practical rules: never expose cache keys in an API response, and never build a "recently
generated" feature over this table. If Edgify ever handles genuinely confidential documents
rather than coursework, revisit this and scope the cache per user.

---

## Migrations

```bash
npx drizzle-kit generate    # after editing schema.ts
npx drizzle-kit migrate     # apply
```

Commit generated SQL. Never edit an applied migration — add a new one. Run migrations as an
explicit step in deployment, not on application boot: two containers starting simultaneously
and both migrating is a bad afternoon.

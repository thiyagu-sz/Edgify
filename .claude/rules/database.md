---
paths:
  - "lib/db/**/*.ts"
  - "app/api/**/*.ts"
---

# Database rules

Full schema: `docs/03-data-model.md`.

## There is no row-level security

Postgres will return another user's rows if you ask it to. Tenant isolation is
enforced **entirely** by application code. This is the highest-severity bug class
in the project.

## The four rules

1. All database access lives in `lib/db/queries/`. No exceptions — no raw queries
   in route handlers, server components, or service modules
2. Every exported function takes `userId` as its **first** parameter
3. Every `SELECT`, `UPDATE` and `DELETE` includes `eq(table.userId, userId)`
4. Single-row lookups by id filter on **both** the id and the userId

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

Health checks and other non-user queries belong in `lib/db/client.ts`, not in
`queries/`, so that `queries/` stays unambiguously userId-first.

## Connection handling

Neon suspends after about five minutes idle, so the first query after a quiet
period can fail while compute resumes. All queries go through `withDbRetry()`.
Never call the pool directly.

## Cache inserts must tolerate races

`generation_cache` writes use `ON CONFLICT DO NOTHING`. Two users uploading the
same document simultaneously will produce the same cache key, and without this one
of them errors on a duplicate key. This is the exact classroom scenario the cache
exists for.

## Migrations

- `npx drizzle-kit generate` after editing `schema.ts`, then `npx drizzle-kit migrate`
- Commit generated SQL
- Never edit an applied migration — add a new one
- Migrations run as an explicit deploy step, never on application boot

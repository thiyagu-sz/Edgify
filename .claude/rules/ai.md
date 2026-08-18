---
paths:
  - "lib/ai/**/*.ts"
  - "lib/cache.ts"
  - "lib/quota.ts"
  - "app/api/notes/**/*.ts"
  - "app/api/concepts/**/*.ts"
  - "app/api/documents/**/*.ts"
---

# Model call rules

Full specification: `docs/04-resilience.md`. These rules are the summary that must
always hold.

## The key never reaches the browser

- `OPENROUTER_API_KEY` is read server-side only
- Never `NEXT_PUBLIC_`, never in a client component, never in a browser fetch
- The browser must make zero requests to `openrouter.ai` — every model call is
  proxied through our own `/api/*` routes

## One entry point

All model calls go through `lib/ai/generate.ts`. Do not call `streamText`,
`generateObject`, or the OpenRouter provider directly from a route handler, a
component, or any other module. New generation types are added to that module.

That module owns the degradation ladder, caching, ledger writes, and error
mapping. Bypassing it silently bypasses all four.

## The degradation ladder

Every request walks down until something succeeds:

```
0  cache hit           → return stored result, zero tokens, no quota consumed
1  free-tier model     → normal result
2  retry tier 1        → max 2 attempts, jittered
3  paid model          → normal result, user sees no difference
4  retry tier 3        → once
5  demo content        → real content + visible banner
6  ServiceBusyError    → "Server is busy, please try again in a moment."
```

Tiers 0–4 are invisible to the user. Tier 5 is always labelled. Tier 6 is the
only failure state, and it is calm.

## Retry discipline

- Maximum 2 retries per model tier
- **Always jittered.** Fixed delays make concurrent requests retry in lockstep and
  exhaust the rate limit again
- Honour `retry-after` when present
- Retryable: 429, 5xx, network timeout, malformed output (once)
- **Not retryable:** 402 (no credits), 401 (bad key), 400 (bad request) — skip
  straight to the demo tier
- Failed requests count against the free daily quota, so eager retrying costs more
  than it recovers

## Streaming: commit on evidence, diagnose zero output

- A streaming source is committed only once a **non-zero-length token** is in hand.
  `admitFirstToken` (`lib/ai/generate.ts`) is the only way to consume a stream's head;
  it withholds that token and `commitStream` re-emits it. Never relay on stream open.
- Every `RunStream` implementation MUST provide `diagnoseZeroOutput()`. It is a
  required member of `RunStreamResult`, not an optional one — omitting it is a
  compile error.
- A clean zero-length close is **ambiguous** and must be diagnosed, never assumed:
  `transport-fault` → do not retry this source, advance; `no-output` → bounded retry.
  On a 401 the SDK closes the stream cleanly and reports only via `onError`, so the
  naive reading retries a key that can never work.
- The reconstructed fault leaves the adapter as a typed verdict. Do not encode it into
  `textStream`, and do not expose the adapter's captured error.

Full specification: `docs/04-resilience.md` §1.1.

## Validate every model output

- Prefer `generateObject` with a Zod schema over parsing text
- If parsing text: strip code fences, extract the outermost object, then Zod-parse
- On validation failure: one repair attempt, then continue down the ladder
- Never let unvalidated output reach the database or the UI

Guard these specific cases — they occur in practice:
- Edges referencing a concept slug that does not exist → drop the edge
- Cyclic prerequisites → break the weakest edge, log it
- Quiz `answer` index outside the options array → discard that question
- Fewer than three concepts → failed extraction, not a small graph
- Empty or whitespace-only content → failure, not success

## Never surface a raw error

No stack traces, HTTP status codes, provider names, token counts, or
`error.message` in any user-facing string. Map every failure to the message
catalogue in `docs/04-resilience.md` §7.

## Ordering matters

Auth → cache → quota → model.

The cache lookup comes **before** the quota check. A cached result costs nothing,
so it must not consume the user's daily allowance.

## Model IDs live in the environment

Every model ID comes from an env var with a fallback list. Free-tier model IDs
rotate out with little notice; a retirement must be a config change, not a code
change and not an outage.

## Every call writes a ledger row

`usage_ledger` records operation, model, tier, tokens, latency, cost and outcome —
including cache hits, demo fallbacks and failures. This is how quotas, cost
visibility and abuse detection all work. A code path that skips the ledger write is
incomplete.

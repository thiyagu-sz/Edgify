# 04 — Resilience: the never-fail specification

**Requirement:** the user must never see a failure. Every error becomes either useful content
or a calm, honest message.

This document is the contract. If an implementation can produce a user-visible stack trace,
HTTP status code, vendor name, or raw `error.message`, it is wrong.

---

## 1. The degradation ladder

Every generation request walks down this ladder until something succeeds. Implement it once,
in `lib/ai/generate.ts`, and call it from everywhere.

| Tier | Attempt | Cost | User sees |
|---|---|---|---|
| **0** | Cache hit on `sha256(text:format:model:promptVersion)` | Free | Instant result. No indication anything special happened |
| **1** | Free-tier model (`:free`) | Free | Normal streamed result |
| **2** | Retry tier 1, max 2 attempts, jittered backoff | Free | Nothing — still streaming |
| **3** | Paid model via credits | Cents | Normal result. No indication of the switch |
| **4** | Retry tier 3 once | Cents | Nothing |
| **5** | **Demo content** for this format/topic | Free | Result plus an honest banner |
| **6** | Busy state | Free | *"Server is busy, please try again in a moment."* + retry button |

Tiers 0–4 are invisible. The user should not know or care which model answered. Only tiers 5
and 6 change what they see, and both are calm rather than alarming.

### Reference implementation shape

Treat this as intent, not exact syntax — verify AI SDK signatures against current docs.

```ts
export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const key = cacheKey(input);

  const cached = await cache.get(key);                       // tier 0
  if (cached) return { ...cached, tier: "cache" };

  for (const model of [FREE_MODEL, PAID_MODEL]) {            // tiers 1–4
    const attempts = model === FREE_MODEL ? 3 : 2;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = await callModel(model, input);
        const valid = validate(input.schema, result);         // see §3
        if (!valid.ok) throw new MalformedOutputError();
        await cache.set(key, valid.data);
        await ledger.record({ ...input, model, outcome: "ok" });
        return { ...valid.data, tier: model === FREE_MODEL ? "free" : "paid" };
      } catch (err) {
        if (!isRetryable(err)) break;        // 402, 401, bad request: stop, next model
        await sleep(backoff(i) + Math.random() * 1000);   // jitter is mandatory
      }
    }
  }

  const demo = demoContentFor(input);                        // tier 5
  if (demo) {
    await ledger.record({ ...input, outcome: "demo" });
    return { ...demo, tier: "demo" };
  }

  await ledger.record({ ...input, outcome: "failed" });      // tier 6
  throw new ServiceBusyError();
}
```

**Jitter is not optional.** When several requests share one API key and all retry after the
same fixed delay, they retry simultaneously and exhaust the bucket again. Always add a random
component. And keep retries few: failed requests, including 429s, count against the free
daily quota, so aggressive retrying drains the allowance faster than successful work does.

### Which errors are retryable

| Condition | Retryable | Then |
|---|---|---|
| 429 rate limited | Yes | Backoff with jitter; honour `retry-after` if present |
| 5xx / overloaded | Yes | Backoff with jitter |
| Network timeout | Yes | One retry, then next tier |
| Malformed output | Yes, once | Repair prompt (§3), then next tier |
| 402 no credits | **No** | Skip straight to demo tier |
| 401 bad key | **No** | Demo tier + alert the operator — this is a config bug |
| 400 bad request | **No** | Demo tier + log loudly — this is our bug |

---

## 1.1 Streaming commitment: the first-token admission barrier

The table above assumes the failure is visible where the request was issued. On the streaming
path that assumption does not hold, and the ladder above is not sufficient on its own.

**The discovered fact.** On a 401 the provider SDK does not throw from `textStream`. The stream
yields zero chunks and closes *cleanly*; `totalUsage` rejects with a generic error carrying no
status; and the `APICallError` with the status on it reaches the `onError` callback and nowhere
else. So the naive reading of the transport — "the stream ended without content, that is an empty
result, empty results are retryable" — inverts the retry policy exactly where retrying can never
succeed. A successfully-closed, zero-length stream is the signature of a **non-retryable
configuration fault**, not of a transient empty generation.

Two rules follow, and they are load-bearing only in combination.

**Rule 1 — commit on positive evidence, never on stream open.** A streaming source is not
committed because the stream opened. The control layer draws from the transport until it holds a
token of **non-zero length**, and withholds that token. Only then is the source committed. The
withheld token is re-emitted at the head of the same generation, so the client's progressive
experience is identical to immediate relay — nothing is buffered beyond the first token.

`admitFirstToken` in `lib/ai/generate.ts` is the only way to consume the head of a stream.

**Rule 2 — a zero-output close must be diagnosed, not assumed.** Every streaming adapter must
answer `diagnoseZeroOutput()`, a **required** member of `RunStreamResult` in `lib/ai/models.ts`.
It is called at, and only at, the instant a stream terminates having admitted no token:

| Tokens admitted | Verdict | Diagnosis | Action |
|---|---|---|---|
| 0 | `transport-fault` | Terminal fault recovered from the async channel | Re-raise so `classify` reads the status; **do not retry this source**; alert; advance |
| 0 | `no-output` | Transient empty generation | Retryable tier failure, within this source's attempt bound |
| ≥ 1 | — | Source has demonstrated production | Commit; re-emit the withheld token; stream on |

**Why the two rules need each other.** Rule 1 creates the decision state — "no output yet" versus
"positive production evidence" — that Rule 2 keys on; without the barrier, relay has already begun
and there is no pre-commit moment in which any diagnosis could be acted upon. Rule 2 makes Rule 1's
own exit condition usable; without the diagnosis, "terminated having produced nothing" is exactly
the state a terminal fault forges, so the barrier would hand a guaranteed-futile attempt back for
retry. Removing either one is a real regression, and both directions are pinned by mutation tests
in `lib/ai/admission-barrier.test.ts`.

**The capability is required, not optional.** An adapter that cannot discriminate is not a weaker
streaming source, it is an unsafe one: it silently restores the behaviour in which a bad key burns
the entire ladder budget with no operator alert. Omitting `diagnoseZeroOutput` is a compile error.

**The data channel carries data only.** The reconstructed fault is never encoded into
`textStream`; it leaves the adapter as a typed verdict. The adapter's captured error never escapes
its closure.

---

## 2. Demo mode

Demo mode is the reason this system does not have a hard failure state. It exists for three
situations: the ladder reaching tier 5, the user exhausting their daily quota, and a visitor
who wants to try Edgify before signing in.

**The content already exists.** The prototype ships a curated machine-learning knowledge
graph (calculus and linear algebra through to CNNs, RNNs and attention) with full
definitions, examples, quizzes and flashcards for every concept, plus a sample source text.
Lift that data verbatim into `lib/demo/`:

```
lib/demo/
  graph.ts       The curated ML graph — concepts, edges, layout, details
  notes.ts       One pre-written sample output per Quick Notes format
  index.ts       demoContentFor(input) → content | null
```

Generate the sample notes once, by hand or by running each format against the sample text,
then commit them as static data. They cost nothing at runtime and never fail.

### Rules for demo mode

- **Always labelled.** A quiet banner, never a silent substitution. Passing off generic
  sample content as an analysis of the user's own document is the one genuinely bad outcome
  available here.
- **Fully interactive.** Clicking concepts, flipping flashcards, taking quizzes, exporting —
  all work. It is a real experience, not a screenshot.
- **Reachable deliberately.** A "Try the demo" entry point on the landing page. Someone
  evaluating Edgify should not have to sign in first.
- **Never written to the user's data.** Demo content is not persisted as their document,
  their graph, or their notes.
- **Recorded in the ledger** with `outcome: "demo"`. A rising demo rate is your earliest
  signal that something upstream is broken.

### Banner copy

> **Showing sample content.** Live generation is temporarily unavailable, so this is a
> prepared example. Your document is safe — try again in a few minutes.

For the quota case, different and friendlier:

> **You've used today's generations.** Here's a worked example in the meantime. Your limit
> resets at midnight.

---

## 3. Model output validation

Models return malformed JSON. Assume it, every time.

```
1. Prefer generateObject with a Zod schema over parsing text yourself
2. If parsing text: strip code fences, extract the outermost {...}, then Zod-parse
3. On validation failure: ONE repair attempt — send the output back with the
   validation error and ask for corrected JSON only
4. Still failing: treat as a tier failure and continue down the ladder
```

Never let unvalidated model output reach the database or the UI. A graph with a dangling edge
or a quiz with a missing option renders as a broken page, and that reads as a broken product.

Guard for these specific cases, because they occur in practice:

- Edges referencing a concept slug that does not exist → drop the edge, keep the graph
- Cyclic prerequisites → break the cycle at the weakest edge, log it
- A quiz `answer` index outside the options array → discard that question
- Fewer than three concepts extracted → treat as a failed extraction, not a small graph
- Empty or whitespace-only content → failure, not success

---

## 4. Upload and parsing failures

| Case | Detection | User message |
|---|---|---|
| File too large | Size check **before** reading the body | "That file is over the 10 MB limit. Try a smaller file, or paste the text directly." |
| Unsupported type | Extension and MIME check | "Edgify reads PDF, DOCX, TXT and Markdown files." |
| Encrypted PDF | Parse throws | "That PDF is password-protected. Remove the protection, or paste the text." |
| **Scanned document** | Extraction yields under ~200 chars from a multi-page file | "This looks like a scanned document — Edgify can't read the text yet. Paste the text directly and everything else will work." |
| Corrupt file | Parse throws | "That file couldn't be read. It may be damaged — try re-saving or exporting it again." |
| Text too short | Under ~200 chars | "There isn't enough text here to work with. Add a few paragraphs." |

The scanned-document case matters more than it looks — photographed lecture notes are common
among students, and a system that silently returns an empty result there feels broken. Detect
it and say so plainly.

Always release the parsed PDF document in a `finally` block — `proxy.loadingTask.destroy()`, not
the `proxy.destroy()` this document used to specify, which does not exist and whose `TypeError`
would mask the real error from inside the `finally`.

Measured 2026-07-29 (`test/e2e/parse-memory.mjs`, 200 sequential parses): skipping the release
does **not** exhaust container memory as previously claimed — heap growth was 1.3 KB/parse with it
and 2.4 KB/parse without, and rss plateaued. The rule stands because eager release is free and
does not depend on a collection arriving under memory pressure, but it is enforced by a test
(`lib/parse/pdf.test.ts`), not by waiting for a symptom that will not appear. See
`02-tech-stack.md` for the full finding.

---

## 5. Quota and limits

Quota is a product surface, not just a guard. Show it before it bites.

| State | Threshold | Behaviour |
|---|---|---|
| Normal | < 80% | Nothing shown |
| Approaching | 80% | Quiet counter: "6 generations left today" |
| Exhausted | 100% | Friendly state, demo mode offered, reset time shown |

Never phrase a quota as an error. "You've used today's generations" is a fact about a
budget; "Error: quota exceeded" is a failure. Same information, completely different feeling.

---

## 6. Database and infrastructure failures

**Neon cold starts.** The database suspends when idle, so the first query after a quiet
period can fail or hang while compute resumes. Retry connection errors two or three times
with short backoff in `lib/db/client.ts`. Without this you get intermittent failures that are
very hard to diagnose later.

**Cloud Run cold starts.** First request after idle takes a couple of seconds. Render the
shell and a skeleton immediately rather than blocking on data — a cold start during page load
is far less noticeable than one mid-interaction.

**Total database unavailability.** Serve the landing page and demo mode, which need no
database at all. The app degrades to a brochure with a working demo rather than an error
page.

---

## 7. User-facing message catalogue

Use these strings. Consistency is part of feeling reliable.

| Situation | Message |
|---|---|
| Generation exhausted all tiers | "Server is busy, please try again in a moment." |
| Demo fallback | "Showing sample content. Live generation is temporarily unavailable." |
| Quota reached | "You've used today's generations. Your limit resets at midnight." |
| Upload too large | "That file is over the 10 MB limit. Try a smaller file, or paste the text directly." |
| Scanned PDF | "This looks like a scanned document — Edgify can't read the text yet. Paste the text directly and everything else will work." |
| Graph build failed | "Couldn't map this document's structure. Quick Notes still works on it." |
| Session expired | "Please sign in again to continue." |
| Anything unexpected | "Something went wrong on our side. Please try again in a moment." |

**Never show:** stack traces, HTTP status codes, model or provider names, token counts,
`error.message`, "OpenRouter", "Neon", "429", "rate limit", "quota exceeded" as raw text.

Every message should do three things: say what happened in plain language, say whether the
user's data is safe, and offer a next action. The busy message has a retry button; the
scanned-PDF message points at paste; the quota message points at demo mode.

---

## 8. What gets logged instead

The user sees calm; you see everything. To Sentry and the ledger:

- Full error with stack, the tier reached, model attempted, and attempt count
- Request id, user id, operation type
- Latency per attempt, tokens in and out
- Cache hit or miss

**Alert on:** demo-tier rate above 5% of requests over an hour, any 401 or 400 from the model
API, failed database connections after retries, and daily spend crossing a threshold.

A rising demo rate is the single most useful alert in the system. It means users are still
being served, but something upstream is wrong — exactly the situation you want to know about
before anyone complains.

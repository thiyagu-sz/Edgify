# 05 — Workflows

Step-by-step for every user action. Each step names where it lives, so implementation is
mechanical rather than interpretive.

---

## W1 — Sign in

```
Landing page (dark) → "Launch workspace"
  ├─ Session exists  → /notes
  └─ No session      → /sign-in → Google OAuth → callback
                       → Better Auth creates user + session
                       → redirect /notes
```

The landing page and demo mode must work **without** a session. Someone should be able to
evaluate Edgify before creating an account.

---

## W2 — Quick Notes from pasted text

The most common path in the product. Optimise it.

```
Client                                Server
──────                                ──────
Paste text, pick format
Click "Generate"
  │
  └─ POST /api/notes/generate
     { text, format }
                                      1. Session check           → 401
                                      2. Zod validate body       → 400
                                      3. Length check (200 chars
                                         min, ~40k max)          → clear message
                                      4. cacheKey = sha256(...)
                                      5. Cache lookup
                                         HIT → return, no quota spent, done
                                      6. Quota check             → quota state
                                      7. Open stream
                                      8. lib/ai/generate (ladder)
                                      9. Stream tokens to client
                                     10. On finish: persist note,
                                         write cache, write ledger,
                                         increment counter
  │
  ├─ Tokens render progressively into the prose panel
  ├─ On completion: enable Copy / PDF / DOC / Regenerate
  └─ On demo tier: render content + demo banner
```

Note the ordering: **cache before quota.** A cached result costs nothing, so it must not
consume the user's daily allowance. Getting this backwards makes repeat views feel punitive.

For quiz formats (`mcqs`, `quick_test`), the model returns structured JSON rather than
markdown. Use `generateObject` with the Zod schema, do not stream, and render the interactive
quiz once validated. A half-streamed quiz is not useful.

---

## W3 — Quick Notes from an uploaded file

Same as W2 after extraction.

```
Select file
  │
  └─ POST /api/documents/extract  (multipart)
                                      1. Session check
                                      2. Size check BEFORE reading body (10 MB)
                                      3. Type check (pdf/docx/txt/md)
                                      4. Extract text in memory
                                         - unpdf for PDF, destroy in finally
                                         - mammoth for DOCX
                                         - direct read for txt/md
                                      5. If text < 200 chars and pages > 1
                                         → scanned-document message
                                      6. Discard the file. Never store it
                                      7. Return { text, charCount, title }
  │
  ├─ Fill the textarea with extracted text (user can see and edit it)
  └─ Continue exactly as W2
```

Showing the extracted text rather than hiding it is deliberate: the user can tell immediately
whether extraction worked, which turns a silent failure into an obvious one.

---

## W4 — Build a knowledge graph

The longest operation in the product. It runs inline on Cloud Run with the client polling.

```
Upload document in Graph mode
  │
  └─ POST /api/documents
                                      1–6. As W3 (validate, extract, discard file)
                                      7. contentHash = sha256(normalised text
                                         + PROMPT_VERSION) — see docs/03
                                      8. Insert document + text
                                      9. Existing READY graph with this hash?
                                         YES → clone concepts + edges for this
                                               user, return graphId + "ready", DONE
                                               (zero tokens — the classroom case)
                                     10. Insert graph, status = "processing"
                                     11. Return { graphId } immediately
  │
  ├─ Show the modal with staged progress (as in the prototype)
  ├─ Fire POST /api/graph/:id/build   (do NOT await — this is the build)
  └─ Poll GET /api/graph/:id every 1.5s

                                     POST /api/graph/:id/build:
                                     12. Session + ownership check; idempotent —
                                         only proceeds while status = "processing"
                                     13. lib/ai/generate → structure extraction
                                         (6–9 concepts + prerequisite edges).
                                         The prompt carries ~9,000 chars SAMPLED
                                         from across the document, not its first
                                         9,000 (lib/ai/sampling.ts) — same budget,
                                         same single call, zero cost delta
                                     14. Zod validate; repair once; drop dangling
                                         edges; break cycles
                                     15. Compute layer-based layout, store x/y/w
                                     16. Insert concepts + edges
                                     17. status = "ready"
                                     On failure at 13–14:
                                         status = "failed", reason logged
  │
  ├─ Poll sees "ready"  → render graph, select first foundational concept
  ├─ Poll sees "failed" → "Couldn't map this document's structure.
  │                        Quick Notes still works on it." + link
  └─ Poll times out (90s) → busy message + retry
```

**Why the build is a second, client-fired request.** Decided 2026-07-29. The obvious reading of
steps 11–12 is "return the id, then keep working in the same request", which on Next means
`after()`. That depends on Cloud Run keeping CPU allocated *after* the response is sent — a
deployment setting this project has not yet configured or verified (Phase 7). If it is wrong, the
build is throttled or killed mid-flight and every upload silently ends in `failed`, with the cause
invisible from the application logs.

So the build is its own request: explicit, ownership-checked, and idempotent on
`status = "processing"` so a double-fire or a retry cannot start two builds or corrupt a finished
one. `after()` remains the tidier shape and is logged as a Phase 7 optimisation — adopt it only
once CPU-after-response is confirmed, and keep this route as the fallback.

**Both ladder tiers 5 and 6 land on `failed` here.** Unlike Quick Notes, there is no demo-graph
substitution: see the note under `graphs` in `03-data-model.md`. The user gets the honest message
over a document they still own, and Quick Notes still works on it.

**The document row is inserted BEFORE the clone check.** Corrected 2026-07-30; this document
previously ordered them the other way ("clone and return, DONE" at step 8, "insert document" at
step 9), and that order cannot be implemented. `graphs.documentId` is `NOT NULL` with a foreign
key (docs/03), so a cloned graph has nothing to point at until the caller's own document row
exists. The caller needs that row regardless: it is what makes "Quick Notes still works on it"
true after a graph failure, and what gives W5's concept detail text to ground against.

The clone is also gated on the source graph being `status = "ready"`. A `processing` source has
no concepts yet and a `failed` one never will, so cloning either would hand the user an empty
graph marked ready — worse than simply building.

Neither changes the economics: the clone still costs zero tokens, consumes no quota, and makes no
model call. It writes one `usage_ledger` row with `tier: "cache"`, which is what keeps the saving
visible on the cost dashboard rather than looking like a user who never uploaded.

Step 9 is the single highest-value line in the system. Ten students in one class upload one
lecture PDF; nine of them get an instant graph for zero tokens.

---

## W5 — View a concept

Explanations are generated lazily and cached forever.

```
Click a node in the graph
  │
  ├─ concept.detailJson exists?
  │    YES → render immediately
  │    NO  → render header + summary + loading state
  │          POST /api/concepts/:id/detail
  │                                  1. Session + ownership check
  │                                  2. Quota check
  │                                  3. lib/ai/generate → definition,
  │                                     example, quiz, flashcards, grounded in
  │                                     the passages RETRIEVED for this concept
  │                                     (lib/ai/retrieval.ts) — not the document's
  │                                     first 7,000 chars, which grounded every
  │                                     concept in the same opening text
  │                                  4. Validate, persist detailJson
  │                                  5. Return
  │          → render, no further cost on revisit
  └─ On ladder exhaustion: render the concept's own summary
     + "A detailed explanation couldn't be generated."
```

**There is no demo tier for concept detail.** Corrected 2026-07-30; this document previously said
"on demo tier: render sample detail + banner". Two reasons, and the first is the same one that
denies graphs a demo (docs/03 §graphs):

1. **It persists.** `concepts.detailJson` is a column on the user's own row (step 4), so a demo
   detail is a written record rather than a transient panel. A banner does not undo a row.
2. **There is nothing honest to serve.** The demo library holds details for the curated
   machine-learning concepts only. A user who clicked a node called "Photosynthesis" would get
   the calculus explanation under that heading — a misleading substitution whatever the banner
   says, and picking "the nearest" curated concept is worse, because it looks like it worked.

So the ladder ends at tier 6 and the panel falls back to the concept's `summary`, which *was*
derived from the user's own document during the structure pass. That is what the prototype does
on failure, and it is the only content available that is genuinely about their material.
`lib/demo/index.ts` enforces this by not answering `concept_detail`, so the ladder cannot reach a
demo detail by accident.

The panel scrolls independently — `position: sticky`, `max-height: calc(100vh - 108px)`,
`overflow-y: auto`, `overscroll-behavior: contain`. This is already solved in the prototype;
port it exactly rather than re-deriving it.

---

## W6 — Mark mastery, study plan, concept library

Pure client and database work. No model calls, so these must never fail or show a busy state.

```
Mark as mastered → POST /api/mastery { conceptId, state }
                   upsert (userId, conceptId)
                   → recompute readiness client-side, re-render

Study plan       → derived entirely from stored concepts, edges and mastery
Concept library  → same data, different view
```

Readiness scoring is the prototype's algorithm. **Corrected 2026-08-01** — this section
previously read "walk the prerequisite closure, weight each prerequisite by `1 / depth`", which
is a lossy paraphrase: read literally it suggests only DIRECT prerequisites are scored, and that
produces different numbers on any graph deeper than one layer. The reference algorithm
(`closure` / `readiness`, proto:1049–1052) is:

1. Breadth-first from the target's direct prerequisites at depth 1, following prerequisites of
   prerequisites, recording each ancestor at its **shortest** depth from the target. This is the
   full **transitive closure**, not the direct parents — a grandparent counts, at half weight.
2. Weight every ancestor in that closure by `1 / depth`, so nearer prerequisites matter more.
3. Score `known` as 1, `learning` as 0.5, `locked` as 0, and return
   `round(100 × Σ(weight × score) / Σ weight)`.
4. A concept with an empty closure scores 100 — nothing stands between the student and it.

Worked example on the prototype's own curated graph, in its initial state (`calc` and `linalg`
known, `opt` in progress, everything else locked). The closure of `cnn` is **six** concepts, not
its two direct prerequisites:

| Ancestor | Depth | Weight | Mastery | Contribution |
|---|---|---|---|---|
| `nn` | 1 | 1 | locked | 0 |
| `bp` | 1 | 1 | locked | 0 |
| `linalg` | 2 | 0.5 | known | 0.5 |
| `gd` | 2 | 0.5 | locked | 0 |
| `opt` | 3 | 0.333 | learning | 0.167 |
| `calc` | 3 | 0.333 | known | 0.333 |

`round(100 × 1.0 / 3.667)` = **27**. Scoring only the direct prerequisites gives 0 on the same
data — the size of the difference the old wording hid.

Keep it client-side — it is instant and needs no round trip. `lib/graph/readiness.ts` is the
implementation, and `readiness.test.ts` pins it against the prototype's own JavaScript, extracted
from `docs/reference/edgify-prototype.html` and executed as an oracle, so the formula cannot
drift from the reference again without a test failing. (The 27 above was first written as 25 from
hand arithmetic; the oracle caught it. That is the argument for the oracle in one line.)

---

## W7 — Export

Entirely client-side, exactly as the prototype does it. No server cost, no failure mode.

```
PDF → jsPDF, walking the markdown line by line
DOC → Word-compatible HTML blob, downloaded as .doc
```

Port the prototype's implementation directly. One known trap: the DOC export builds an HTML
string containing a literal `</body>` tag. Any templating or string-splicing around it must
not treat that as the document's real end.

---

## W8 — Demo mode

```
Landing "Try the demo"     → /demo, no session required
Quota exhausted            → demo offered inline
Generation ladder tier 5   → demo returned in place of the result

All demo paths:
  - serve static content from lib/demo/
  - fully interactive: click, flip, quiz, export
  - clearly banner-labelled
  - never persisted to the user's records
  - recorded in the ledger as outcome: "demo"
```

---

## API summary

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/notes/generate` | Streaming Quick Notes |
| `POST` | `/api/documents/extract` | Extract text, return it, store nothing |
| `POST` | `/api/documents` | Create document + graph row, return graphId |
| `POST` | `/api/graph/:id/build` | Run the structure extraction; idempotent on `processing` |
| `GET` | `/api/graph/:id` | Graph with concepts and edges; status for polling |
| `POST` | `/api/concepts/:id/detail` | Lazy concept explanation |
| `POST` | `/api/mastery` | Upsert mastery state |
| `GET` | `/api/usage` | Remaining quota for the UI |
| `*` | `/api/auth/[...all]` | Better Auth |

Every route: session check → Zod validation → service call in `lib/` → shaped response.
No business logic in route handlers.

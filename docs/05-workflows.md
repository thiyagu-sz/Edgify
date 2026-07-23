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
evaluate Trellis before creating an account.

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
                                      7. contentHash = sha256(normalised text)
                                      8. Existing graph with this hash?
                                         YES → clone concepts + edges for this
                                               user, return graphId, DONE
                                               (zero tokens — the classroom case)
                                      9. Insert document + text
                                     10. Insert graph, status = "processing"
                                     11. Return { graphId } immediately
  │
  ├─ Show the modal with staged progress (as in the prototype)
  └─ Poll GET /api/graph/:id every 1.5s

                                     Meanwhile, same request continues:
                                     12. lib/ai/generate → structure extraction
                                         (6–9 concepts + prerequisite edges)
                                     13. Zod validate; repair once; drop dangling
                                         edges; break cycles
                                     14. Compute layer-based layout, store x/y/w
                                     15. Insert concepts + edges
                                     16. status = "ready"
                                     On failure at 12–13:
                                         status = "failed", reason logged
  │
  ├─ Poll sees "ready"  → render graph, select first foundational concept
  ├─ Poll sees "failed" → "Couldn't map this document's structure.
  │                        Quick Notes still works on it." + link
  └─ Poll times out (90s) → busy message + retry
```

Step 8 is the single highest-value line in the system. Ten students in one class upload one
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
  │                                     example, quiz, flashcards
  │                                     (document text as grounding)
  │                                  4. Validate, persist detailJson
  │                                  5. Return
  │          → render, no further cost on revisit
  └─ On demo tier: render sample detail + banner
```

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

Readiness scoring is the prototype's algorithm: for a target concept, walk the prerequisite
closure, weight each prerequisite by `1 / depth`, and score `known` as 1, `learning` as 0.5,
`locked` as 0. Keep it client-side — it is instant and needs no round trip.

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
| `POST` | `/api/documents` | Create document + start graph build |
| `GET` | `/api/graph/:id` | Graph with concepts and edges; status for polling |
| `POST` | `/api/concepts/:id/detail` | Lazy concept explanation |
| `POST` | `/api/mastery` | Upsert mastery state |
| `GET` | `/api/usage` | Remaining quota for the UI |
| `*` | `/api/auth/[...all]` | Better Auth |

Every route: session check → Zod validation → service call in `lib/` → shaped response.
No business logic in route handlers.

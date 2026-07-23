# Trellis — Implementation Documentation

Complete build specification for Trellis, an academic study workspace with two features:
**Quick Notes** (fast, high-yield exam revision) and **Knowledge Graph** (deep understanding
from an uploaded document).

**Target:** ~10 concurrent users · **Infrastructure cost:** $0/month in a normal month
**Paid services:** OpenRouter credits only

---

## How to use these documents

Put this whole folder at `docs/` in your repository, and put `AGENTS.md` at the repository
**root** (not inside `docs/`). Coding agents read the root file automatically.

Then work through `06-implementation-plan.md` one phase at a time. Do not paste all documents
into a single prompt and ask for the whole app — you will get a large amount of code that
compiles and does not work. Instead:

```
Read docs/AGENTS.md and docs/06-implementation-plan.md.
Implement Phase 1 only. Stop when the phase's acceptance criteria pass.
```

Then review, commit, and move to Phase 2. Each phase is designed to be independently
verifiable, which is what makes this approach reliable.

---

## Document index

| File | Contents | Read when |
|---|---|---|
| `AGENTS.md` | Rules and conventions for coding agents | Always — put at repo root |
| `01-architecture.md` | System design, request paths, component boundaries | Before starting |
| `02-tech-stack.md` | Exact packages, versions, and why each was chosen | Before starting |
| `03-data-model.md` | Database schema, Drizzle definitions, indexes | Phase 1 |
| `04-resilience.md` | **The never-fail specification.** Degradation ladder, demo mode, error messages | Phase 3 onward — read early |
| `05-workflows.md` | Step-by-step request flows for every user action | Phases 4–5 |
| `06-implementation-plan.md` | Seven phases with acceptance criteria | Throughout |
| `07-deployment.md` | Cloud Run, Neon, environment, CI/CD | Phase 7 |
| `09-pre-production-checklist.md` | **Go/no-go gate.** Security and reliability verification | Before launch — read it during Phase 1 |
| `08-operations.md` | Post-production: monitoring, cost caps, runbooks | After launch |

---

## Before you launch

`09-pre-production-checklist.md` is a go/no-go gate with seven hard blockers. Read it early —
several items (sanitising rendered model output, the cross-user isolation test, `ON CONFLICT`
on the cache insert) are much cheaper to build in during Phases 2–5 than to retrofit the week
before launch.

---

## The three rules that matter most

Everything else in these documents supports these.

**1. The user never sees a failure.**
When anything goes wrong — rate limits, exhausted credits, a model returning nonsense — the
user sees either cached content, demo content, or the message *"Server is busy, please try
again in a moment."* Never a stack trace, never an HTTP status code, never a vendor name.
This is specified in full in `04-resilience.md`.

**2. The prototype is the visual specification.**
`trellis-prototype.html` defines the design exactly: the dark Fluxora landing page, the light
workspace, the two-feature switcher, the graph rendering, the panel behaviour. Port it
faithfully. Do not redesign it, do not "improve" it, do not substitute a component library's
default styling.

**3. Cost control is a feature, not an optimisation.**
Per-user quotas, the deduplication cache, and hard billing caps are built in Phase 3 —
*before* the generation features they protect. This ordering is deliberate.

---

## What this system is not

Stated plainly so nobody builds the wrong thing:

- Not multi-tenant SaaS with organisations, roles, or billing
- Not real-time collaborative
- Not a mobile app
- Not internationalised
- No admin dashboard beyond a simple usage view

Each of these is reachable later. None belongs in the first build.

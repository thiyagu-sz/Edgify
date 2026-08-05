# 07 — Deployment

Target: Google Cloud Run, scale to zero, pay per use.

---

## Environment variables

Validate all of these in `lib/env.ts` with Zod at boot. The app should refuse to start on a
missing or malformed value rather than fail mysteriously at request time.

**Required — the app refuses to boot without these.** No defaults; `instrumentation.ts` calls
`assertEnv()` and exits 1.

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://…-pooler…?sslmode=verify-full` | Neon **pooled** connection string. Pin `sslmode` explicitly (docs/02) |
| `BETTER_AUTH_SECRET` | random 32+ bytes | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://edgify-xxx.run.app` | Must match the deployed origin exactly |
| `GOOGLE_CLIENT_ID` | | Google Cloud console |
| `GOOGLE_CLIENT_SECRET` | | |
| `OPENROUTER_API_KEY` | `sk-or-v1-<your-key-here>` | **Server only. Never `NEXT_PUBLIC_`** |

**Optional — every one has a default in `lib/env.ts`.** Setting them is a deliberate override, and
*not* setting them is a supported configuration.

| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_FREE_MODEL` | `google/gemma-4-26b-a4b-it:free` | Free-tier route |
| `OPENROUTER_FREE_FALLBACKS` | `inclusionai/ling-3.0-flash:free` | Comma-separated. Free ids rotate — keep alternatives on a different provider |
| `OPENROUTER_PAID_MODEL` | `openai/gpt-4o-mini` | Overflow tier |
| `PROMPT_VERSION` | `v2` | Bump to invalidate the cache. Also folded into `contentHash` (docs/03) |
| `QUOTA_DAILY_LIMIT` | `30` | Per user per day |
| `QUOTA_TIMEZONE` | `UTC` | IANA name. The day boundary quota resets on |
| `RATE_LIMIT_MAX` | `30` | Default per-route ceiling; routes override (docs/06 Phase 2) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `GRAPH_BUILD_BUDGET_MS` | `200000` | Wall-clock budget for one graph build. **Coupled to `--timeout` below** (docs/09 §1.6) |
| `ADMIN_EMAILS` | *(empty — nobody)* | Comma-separated emails allowed to open `/admin/usage`. **Fails closed:** unset authorises nobody, including in dev. A session is authentication; this is authorisation, and that page shows every user's spend and identity rather than the caller's own |
| `SENTRY_DSN` | *(unset)* | Empty string is treated as unset, so dev still boots |
| `NEXT_PUBLIC_SENTRY_DSN` | *(unset)* | A DSN is a public ingestion key, not a secret — this prefix is deliberate and safe |
| `NODE_ENV` | `development` | Set `production` in the image |

> **CORRECTED 2026-08-05, and the correction is the point.** This table had drifted from
> `lib/env.ts` in both directions, and it is the document someone follows while populating Secret
> Manager on deploy day — so every error here lands at the worst possible moment.
>
> It listed three variables that **do not exist anywhere in the code** — `OPENROUTER_QUALITY_MODEL`,
> `DAILY_GENERATION_LIMIT` and `MAX_UPLOAD_BYTES` (0 hits each) — and omitted five that do.
>
> **`DAILY_GENERATION_LIMIT` is the dangerous one, because it fails silently.** The real name is
> `QUOTA_DAILY_LIMIT`, which has a default of 30. Set the documented name in Secret Manager and
> nothing rejects it: the variable is simply ignored and the app runs on the default. The operator
> sees a quota they believe they configured, and there is no error anywhere to contradict them. A
> *missing required* variable is loud — the app exits 1 naming it — but a **misspelled optional one
> is silent by construction**, which is why the split into required/optional above matters more
> than it looks.
>
> Pinned by `test/deploy-env-docs.test.ts`, which derives the truth from `lib/env.ts` at runtime
> rather than from a list here. A hand-written list would be a third copy that goes stale the same
> way this one did — the identical failure `test/dockerfile-env.test.ts` was written for in Phase 1.

Nothing model-related is ever exposed to the client. If a variable needs a `NEXT_PUBLIC_`
prefix, question whether it should exist at all — `NEXT_PUBLIC_SENTRY_DSN` is the one deliberate
exception, and it is a public ingestion key rather than a credential.

---

## Dockerfile

Multi-stage, standalone output. Set `output: "standalone"` in `next.config.ts` first.

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 8080
ENV PORT=8080 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
```

Cloud Run injects `PORT`; bind to `0.0.0.0`, not `localhost`, or health checks fail with an
unhelpful message.

---

## Cloud Run service

```bash
gcloud run deploy edgify \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --concurrency 40 \
  --cpu 1 --memory 1Gi \
  --timeout 300 \
  --set-secrets DATABASE_URL=edgify-db-url:latest,\
OPENROUTER_API_KEY=edgify-openrouter:latest,\
BETTER_AUTH_SECRET=edgify-auth-secret:latest
```

Reasoning for each setting:

| Flag | Value | Why |
|---|---|---|
| `--min-instances` | `0` | Scale to zero. This is the whole point — accept the cold start |
| `--max-instances` | `5` | A ceiling is a cost guard. Ten users never need more |
| `--concurrency` | `40` | Model calls are I/O-bound; one instance absorbs many users |
| `--memory` | `1Gi` | PDF parsing is the memory peak. Below this, large files OOM |
| `--timeout` | `300` | Covers inline graph builds, which is why there is no queue. **Coupled to `GRAPH_BUILD_BUDGET_MS`** — see below |
| `--region` | near your users | `asia-south1` (Mumbai) for India |

> **`--timeout` and `GRAPH_BUILD_BUDGET_MS` are one decision in two places. Change one, change the
> other.** (docs/09 §1.6, closed 2026-08-05.)
>
> The graph build is the longest operation in the product and the degradation ladder's own
> arithmetic can exceed this timeout: at the measured ~65s median call latency, a build that
> repairs once and falls through reaches ~260s, and one reaching the paid rung exceeds 300s. That
> is the ordinary case under free-tier rate limiting, not a tail.
>
> The app bounds itself at `GRAPH_BUILD_BUDGET_MS` (200s) so it abandons cleanly to
> `status = "failed"` *before* the platform kills the request. **The 100s gap is not slack — it is
> what pays for writing the failure and returning a response.** Being killed by the platform is
> strictly worse than failing: nothing writes `failed`, the row stays `processing` forever, and the
> build route would permit a retry that re-spends.
>
> So: raise `--timeout` and you may raise the budget. **Lower `--timeout` below ~260s without
> lowering the budget and you reintroduce the blocker**, silently, with no local test able to see
> it — the budget would no longer be the binding constraint.

Use **Secret Manager**, not `--set-env-vars`, for anything sensitive. Plaintext secrets in
the service config are visible to anyone with console read access.

---

## Neon setup

1. Create the project in the region closest to Cloud Run.
2. Confirm **scale to zero** is enabled, with a 5-minute suspend.
3. Set a **spending limit**.
4. Use the **pooled** connection string in `DATABASE_URL`.
5. Keep a separate branch for development — branching is free and instant.

Re-check that scale-to-zero is still enabled after any settings change. Certain
configurations silently disable it, and the compute meter then runs around the clock. Compare
your first month's usage against expectation.

---

## Google OAuth

1. GCP console → APIs and Services → Credentials → OAuth client ID → Web application
2. Authorised redirect URI: `https://<your-domain>/api/auth/callback/google`
3. Add `http://localhost:3000/api/auth/callback/google` for local development
4. Configure the consent screen — for external users this needs a privacy policy URL

---

## Migrations

Run as an explicit deploy step, never on application boot. Two containers starting at once
and both migrating is a bad afternoon.

```yaml
- name: Run migrations
  run: npx drizzle-kit migrate
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

---

## CI/CD (GitHub Actions)

**Written 2026-08-05. The workflows are real files now, not a sketch in this document** —
`.github/workflows/ci.yml` and `.github/workflows/deploy.yml`. Read those; this section explains
the shape rather than duplicating them, because a second copy of a pipeline goes stale exactly the
way the environment table above did.

Two workflows, deliberately not one:

| | `ci.yml` | `deploy.yml` |
|---|---|---|
| Triggers | every branch except `main`, and every PR | push to `main`, or manual dispatch |
| Needs cloud credentials | **no** | yes (WIF) |
| Can reach production | **no** | yes |

Splitting them is a security property, not tidiness: the workflow that runs on every branch and
every fork PR holds no secrets and has no path to production, so an untrusted contribution cannot
reach either. Everything privileged lives in the workflow only `main` can trigger.

Inside `deploy.yml` the ordering is the design:

1. **`verify` runs the same four commands AGENTS.md requires**, and `deploy` declares
   `needs: verify`. The gate is duplicated rather than shared with `ci.yml` on purpose — a deploy
   that trusts a verification it did not run itself ships whatever the last green run happened to
   be.
2. **Migrations run as an explicit step, before the new revision exists.** Never on application
   boot. A failure here stops the deploy and leaves the current revision serving (docs/09 §3.5).
3. **`concurrency` does not cancel in progress.** Cancelling a run mid-migration is how you get a
   half-migrated database; queue the next one instead.
4. **`environment: production`** so a required reviewer can gate deploys from repository settings.
   The line alone enforces nothing — configure it once under Settings → Environments.

Prefer Workload Identity Federation over a downloaded service-account key. A JSON key in
GitHub secrets is a long-lived credential that cannot be rotated easily.

`ci.yml` also greps the **built client bundle** for a key value. That is a different check from the
pre-commit scan in AGENTS.md rule 1: the pre-commit one reads a staged diff, this one reads the
artefact that actually reaches a browser.

---

## Billing caps — do this before the first deploy

Non-negotiable. Pay-per-use has no ceiling by default.

1. **GCP budget alert** at $5, $10, $25 of monthly spend.
2. **GCP budget action** that disables billing at a hard cap. This can take the app offline —
   that is the intended behaviour, and preferable to an unbounded bill.
3. **Neon spending limit** in the project settings.
4. **OpenRouter**: simply do not top up beyond what you are prepared to lose.
5. **`--max-instances 5`** on Cloud Run caps runaway compute.

---

## Deployment checklist

- [ ] All environment variables set in Secret Manager
- [ ] `OPENROUTER_API_KEY` confirmed absent from any client bundle (`grep` the build output)
- [ ] Migrations applied
- [ ] Google OAuth redirect URI matches the deployed domain exactly
- [ ] `BETTER_AUTH_URL` matches the deployed origin
- [ ] Budget alerts and hard cap active
- [ ] Neon spending limit set, scale-to-zero confirmed on
- [ ] Sentry receiving events from production
- [ ] Cold start measured end to end
- [ ] Degradation ladder verified in production, not just locally

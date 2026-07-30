# 07 — Deployment

Target: Google Cloud Run, scale to zero, pay per use.

---

## Environment variables

Validate all of these in `lib/env.ts` with Zod at boot. The app should refuse to start on a
missing or malformed value rather than fail mysteriously at request time.

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://…-pooler…` | Neon **pooled** connection string |
| `BETTER_AUTH_SECRET` | random 32+ bytes | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | `https://edgify-xxx.run.app` | Must match the deployed origin |
| `GOOGLE_CLIENT_ID` | | Google Cloud console |
| `GOOGLE_CLIENT_SECRET` | | |
| `OPENROUTER_API_KEY` | `sk-or-v1-…` | **Server only. Never `NEXT_PUBLIC_`** |
| `OPENROUTER_FREE_MODEL` | e.g. `openrouter/free` | Free-tier route |
| `OPENROUTER_FREE_FALLBACKS` | comma-separated ids | Free model ids rotate — keep alternatives |
| `OPENROUTER_PAID_MODEL` | a budget paid model | Overflow tier |
| `OPENROUTER_QUALITY_MODEL` | a mid-tier model | Graph structure and concept detail |
| `DAILY_GENERATION_LIMIT` | `30` | Per user per day |
| `MAX_UPLOAD_BYTES` | `10485760` | 10 MB |
| `PROMPT_VERSION` | `v1` | Bump to invalidate the cache |
| `SENTRY_DSN` | | |
| `NODE_ENV` | `production` | |

Nothing model-related is ever exposed to the client. If a variable needs a `NEXT_PUBLIC_`
prefix, question whether it should exist at all.

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
| `--timeout` | `300` | Covers inline graph builds, which is why there is no queue |
| `--region` | near your users | `asia-south1` (Mumbai) for India |

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

```yaml
name: deploy
on:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
      - run: npm run build

  deploy:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_SA }}
      - run: npx drizzle-kit migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
      - uses: google-github-actions/deploy-cloudrun@v2
        with:
          service: edgify
          source: .
          region: asia-south1
```

Prefer Workload Identity Federation over a downloaded service-account key. A JSON key in
GitHub secrets is a long-lived credential that cannot be rotated easily.

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

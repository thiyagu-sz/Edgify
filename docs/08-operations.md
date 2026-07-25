# 08 — Operations (after production)

Running Trellis once it is live. Deliberately lightweight — at ten users, most "monitoring"
is looking at two numbers once a week.

---

## The weekly ritual (10 minutes)

| Check | Where | Healthy |
|---|---|---|
| Demo-tier rate | `usage_ledger`, `outcome = 'demo'` | Under 2% of generations |
| Cache hit rate | `tier = 'cache'` | Rising over time; 30%+ once a class shares documents |
| Daily spend | OpenRouter dashboard | Inside expectation |
| Cloud Run and Neon spend | GCP and Neon billing | Near zero |
| Sentry | Issues since last week | Nothing recurring |
| **Database backup** | Manual export | **Done this week** |

```sql
-- one query for most of the above
SELECT date_trunc('day', created_at) AS day,
       tier, outcome, count(*), sum(cost_micros)/1e6 AS usd
FROM usage_ledger
WHERE created_at > now() - interval '7 days'
GROUP BY 1,2,3 ORDER BY 1 DESC;
```

**The backup is the one that matters.** Neon's free tier has no automatic backups. Ten
minutes a week:

```bash
pg_dump "$DATABASE_URL" -Fc -f "trellis-$(date +%F).dump"
```

Keep the last four somewhere that is not the same cloud account.

---

## Alerts worth having

Three. Resist adding more — alerts you ignore are worse than no alerts.

| Alert | Threshold | Means |
|---|---|---|
| **Demo rate spike** | >5% of generations in an hour | Something upstream is broken. Users are still served, which is why nobody has complained yet. **The most valuable alert in the system** |
| **Auth failure from model API** | Any 401 or 400 | Key revoked, expired, or a model id retired |
| **Budget threshold** | 50% of monthly cap | Usage is running ahead of expectation |

---

## Guardrail setup and fire drills (Phase 2)

The guardrails that keep spend and blast radius bounded. Set these up before any code that can
spend money (docs/06 Phase 2, docs/09 §1.4).

### Hard billing cap (GCP)

Protects Google-side spend (Cloud Run and anything billed to the project). OpenRouter and Neon
are billed separately and capped on their own.

```
Cloud Billing Budget ──threshold exceeded──▶ Pub/Sub topic ──▶ Cloud Function (capBilling)
                                                                     │
                                                    detaches billing account → billing off
```

Source: [`infra/billing-cap/`](../infra/billing-cap/). Identifiers used below:

```bash
PROJECT_ID=trellis-prod; BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX
TOPIC=billing-alerts;     REGION=us-central1
```

**One-time setup**

1. Topic the budget publishes to:
   ```bash
   gcloud pubsub topics create "$TOPIC" --project "$PROJECT_ID"
   ```
2. Budget with a hard amount and the topic attached (Console → Billing → Budgets & alerts →
   *Manage notifications* → Connect a Pub/Sub topic), or:
   ```bash
   gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
     --display-name="trellis-hard-cap" --budget-amount=50USD \
     --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
     --all-updates-rule-pubsub-topic="projects/$PROJECT_ID/topics/$TOPIC"
   ```
3. Deploy the function, starting in dry-run so the first drill proves wiring without touching
   billing:
   ```bash
   gcloud functions deploy cap-billing --gen2 --runtime=nodejs22 --region="$REGION" \
     --source=infra/billing-cap --entry-point=capBilling --trigger-topic="$TOPIC" \
     --set-env-vars=GCP_PROJECT="$PROJECT_ID",CAP_DRY_RUN=true
   ```
4. Let the function change billing:
   ```bash
   SA=$(gcloud functions describe cap-billing --gen2 --region="$REGION" \
        --format='value(serviceConfig.serviceAccountEmail)')
   gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
     --member="serviceAccount:$SA" --role="roles/billing.admin"
   ```

**Fire drill — prove the cap fires, not just that it exists.** Pre-deploy GCP spend is ~$0, and
a budget only alerts when `cost ≥ threshold × budget`, so we publish a **synthetic**
budget-exceeded message (Google's own recommended test).

*Drill A — wiring, dry run:*
```bash
gcloud pubsub topics publish "$TOPIC" --project "$PROJECT_ID" \
  --message "$(cat infra/billing-cap/sample-budget-message.json)"
gcloud functions logs read cap-billing --gen2 --region="$REGION" --limit=20
# Expect: "budget_notification" then "DRY RUN: would disable billing …"
```

*Drill B — the real cap, in a maintenance window:*
```bash
gcloud functions deploy cap-billing --gen2 --region="$REGION" \
  --source=infra/billing-cap --entry-point=capBilling --trigger-topic="$TOPIC" \
  --update-env-vars=CAP_DRY_RUN=false
gcloud pubsub topics publish "$TOPIC" --project "$PROJECT_ID" \
  --message "$(cat infra/billing-cap/sample-budget-message.json)"
gcloud beta billing projects describe "$PROJECT_ID"    # billingEnabled: false  ← action fired
# ── RESTORE ──
gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
gcloud beta billing projects describe "$PROJECT_ID"    # billingEnabled: true
```
Evidence to keep: the published message, the function log line, and the
`billingEnabled: false → true` transition.

> **Phase 7 follow-up:** once Cloud Run has real spend, lower the budget amount below actual
> spend once to confirm the **email** notification also fires, then restore it.

### Neon spending limit

Neon Console → Project → **Settings → Billing / Usage limits** → set a monthly spend limit.
Neon enforces it by suspending compute, so the app degrades to landing + demo (docs/04 §6)
rather than accruing runaway cost. Recorded as configured (screenshot in the ops log); no
"exceed it" drill is run because that would require spending the limit — a conscious decision
under the checklist's grading model.

### Owned elsewhere

- **Cloud Run `--max-instances`** — a finite ceiling, set as a deploy flag in Phase 7.
- **OpenRouter balance** — kept only as large as you are willing to lose; set with the key in
  Phase 3.
- **Per-user daily quota** — enforced in [`lib/quota.ts`](../lib/quota.ts); boundary and
  concurrency guarantees are covered by its tests.

---

## Runbooks

### "Server is busy" reported by a user

1. Check Sentry for the last hour.
2. Query the ledger: `SELECT tier, outcome, count(*) … WHERE created_at > now() - interval '1 hour' GROUP BY 1,2`.
3. Diagnose by pattern:
   - Mostly `demo` → both model tiers failing. Check OpenRouter status and credit balance.
   - Mostly `failed` → demo content is not being returned. **This is a bug in the ladder**, since tier 5 should always catch.
   - Normal mix → likely an isolated timeout. Ask the user to retry.

### Free model id retired

Symptom: 400 from the model API, demo rate jumps.

1. Check OpenRouter's model catalogue for current free ids.
2. Update `OPENROUTER_FREE_MODEL` and `OPENROUTER_FREE_FALLBACKS`.
3. Redeploy. No code change — this is why the ids are environment variables.

This will happen. Free model rosters rotate with little notice; it is a config task, not an
incident.

### Credits exhausted

Symptom: 402 from the model API; every request falls to free-tier-only, then demo.

1. Top up OpenRouter.
2. Review the ledger for what consumed them — one user, one operation, or genuine growth?
3. If one user: lower `DAILY_GENERATION_LIMIT` or look for a retry loop.
4. If one operation: check whether the cache is working for it.

### Unexpected bill

1. GCP billing → break down by service.
2. Neon: check whether **scale-to-zero silently disabled itself**. This is the usual cause.
3. Cloud Run: check instance-hours. Did `min-instances` get set above 0?
4. If the cause is not immediately obvious, use the hard billing cap and investigate calmly.

### Suspected data leak between users

Treat seriously and immediately, because this stack has no row-level security.

1. Run the isolation test suite.
2. Audit `lib/db/queries/` for any function missing a `userId` filter.
3. Search the codebase for database calls outside `lib/db/queries/`.
4. Fix, add a regression test, and consider enabling Postgres RLS as defence in depth.

---

## Cost tuning, in order of impact

1. **Cache hit rate.** The highest-leverage number in the system. If it is low, check that
   text normalisation is consistent — inconsistent whitespace handling produces different
   hashes for identical documents and silently defeats deduplication.
2. **Free-tier share.** What proportion runs on `:free`? If low, the free model may be
   failing silently and everything is quietly falling to paid.
3. **Model routing.** Are cheap formats using the cheap model? Verify against
   `lib/ai/models.ts` rather than assuming.
4. **Prompt length.** Input tokens are most of the cost. Are you sending more document than
   the task needs?
5. **Quota.** Lower `DAILY_GENERATION_LIMIT` if a small number of users dominate.

---

## Changing prompts safely

1. Edit `lib/ai/prompts.ts`.
2. **Bump `PROMPT_VERSION`.** This invalidates cache entries so old and new outputs never mix.
3. Test against a fixed set of five documents you keep for this purpose.
4. Compare outputs manually before deploying. There is no automated quality metric here, and
   pretending otherwise is worse than admitting it.

Never change a prompt without bumping the version. Serving cached output from an old prompt
alongside new output makes quality regressions invisible.

---

## Growth triggers

| Signal | Response |
|---|---|
| Concurrent users pass ~25 | Add a job queue (Inngest free tier) for ingestion |
| Ingestion exceeds the Cloud Run timeout | Same |
| Cold starts draw complaints | Always-on Neon, roughly $9/month |
| Free daily cap hit routinely | Nothing — credits already absorb it |
| Storage of originals needed | Add Cloudflare R2, 10 GB free |
| Cross-document search wanted | `pgvector` in Neon. Not a new vendor |
| Institutional customer appears | Revisit RLS, retention policy, and a DPA |

Most of these cost nothing. The architecture was chosen so that the first several growth
steps are configuration changes rather than invoices.

---

## What "healthy" looks like after a month

- Demo-tier rate under 2%
- Cache hit rate above 30%
- Model spend under $5/month
- Infrastructure spend $0
- No Sentry issue recurring more than twice
- Four database backups on disk
- Ten users who have not needed to contact you

If all of those hold, the system is doing its job and you should be building features rather
than watching dashboards.

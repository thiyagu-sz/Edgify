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

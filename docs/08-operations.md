# 08 — Operations (after production)

Running Edgify once it is live. Deliberately lightweight — at ten users, most "monitoring"
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
pg_dump "$DATABASE_URL" -Fc -f "edgify-$(date +%F).dump"
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

Source: [`infra/billing-cap/`](../infra/billing-cap/). Identifiers below are the **live** ones as of
2026-08-04. Earlier revisions of this file used `PROJECT_ID=edgify-prod`; **no such project has
ever existed** — that name came from the Trellis→Edgify rename and was never applied to the
infrastructure, which is why the budget is still called `trellis-hard-cap`. See the drill record.

```bash
PROJECT_ID=innovationmate; BILLING_ACCOUNT=01CC5B-2F930F-3694A8
TOPIC=billing-alerts;      REGION=us-central1
SA=cap-billing@$PROJECT_ID.iam.gserviceaccount.com
```

**One-time setup** — run from the repo root; in Cloud Shell,
`gh repo clone thiyagu-sz/Edgify -- --branch phase-5` first. **The branch matters:** `infra/` is
not on `main`, and a default clone fails at deploy with `Provided directory does not exist`.

0. Enable the APIs and create the Pub/Sub service identity Eventarc needs:
   ```bash
   gcloud services enable cloudbilling.googleapis.com billingbudgets.googleapis.com \
     pubsub.googleapis.com cloudfunctions.googleapis.com run.googleapis.com \
     cloudbuild.googleapis.com artifactregistry.googleapis.com eventarc.googleapis.com \
     logging.googleapis.com --project="$PROJECT_ID"
   gcloud beta services identity create --service=pubsub.googleapis.com --project="$PROJECT_ID"
   ```
1. Topic the budget publishes to:
   ```bash
   gcloud pubsub topics create "$TOPIC" --project "$PROJECT_ID"
   ```
2. Budget with a hard amount and the topic attached (Console → Billing → Budgets & alerts →
   *Manage notifications* → Connect a Pub/Sub topic), or — note the GA flag is
   `--notifications-rule-pubsub-topic` (`--all-updates-rule-pubsub-topic` exists only on the
   alpha/beta tracks):
   ```bash
   gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
     --display-name="edgify-hard-cap" --budget-amount=50USD \
     --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
     --notifications-rule-pubsub-topic="projects/$PROJECT_ID/topics/$TOPIC"
   ```
3. Grant the Pub/Sub service agent token creation (Eventarc → gen2 push auth; the deploy
   prompts for this if it is missing):
   ```bash
   PUBSUB_SA="service-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')@gcp-sa-pubsub.iam.gserviceaccount.com"
   gcloud projects add-iam-policy-binding "$PROJECT_ID" \
     --member="serviceAccount:$PUBSUB_SA" --role="roles/iam.serviceAccountTokenCreator"
   ```
4. Give the function a dedicated identity and the four roles it needs — **all project-scoped**.
   ```bash
   gcloud iam service-accounts create cap-billing --project="$PROJECT_ID"
   for R in roles/billing.projectManager roles/browser \
            roles/run.invoker roles/eventarc.eventReceiver; do
     gcloud projects add-iam-policy-binding "$PROJECT_ID" \
       --member="serviceAccount:$SA" --role="$R" --condition=None --quiet
   done
   ```
   - `billing.projectManager` — carries `deleteBillingAssignment`, the detach at `index.js:57`.
     Verify with `gcloud iam roles describe`: it holds **exactly two** permissions, both writes,
     and **no read of any kind**.
   - `browser` — `resourcemanager.projects.get`, which `isBillingEnabled()` needs at
     `index.js:45`. Omit it and the function dies on the pre-flight read, three lines short of
     the detach, with a `PERMISSION_DENIED` that looks identical to missing write access.
   - `run.invoker` + `eventarc.eventReceiver` — `--service-account` in step 5 **also repoints the
     Eventarc trigger identity**, not just the runtime. Without these the trigger cannot deliver
     and the cap goes deaf: worse than a broken cap, because it stops logging entirely.

   IAM takes 1–3 minutes to propagate. A `PERMISSION_DENIED` in the first minutes is expected;
   with `--retry` on it clears itself, which is visible in the logs as a backoff ladder.

   **Earlier revisions of this step said `gcloud billing accounts add-iam-policy-binding
   "$BILLING_ACCOUNT" --role=roles/billing.admin` against whatever SA the function happened to
   run as — do not do that.** That grants read+write over *every* project on the billing account,
   and the SA it lands on is the default compute account, which is inherited by every Cloud Run
   service, function and VM in the project — so in Phase 7 the Edgify web service itself would run
   with the power to detach billing. The four roles above are strictly narrower and sufficient:
   verified by Drill B on 2026-08-04.
5. Deploy onto that identity, starting in dry-run so the first drill proves wiring without
   touching billing, and with `--retry` so a transient failure at the moment the real cap is
   needed is not a permanent silent miss. (The source registers via `functions.cloudEvent` — a
   bare gen1-style `exports.x` leaves the CloudEvent payload empty on gen2, which reads as
   "within budget" every time.)
   ```bash
   gcloud functions deploy cap-billing --gen2 --runtime=nodejs22 --region="$REGION" \
     --source=infra/billing-cap --entry-point=capBilling --trigger-topic="$TOPIC" \
     --service-account="$SA" \
     --set-env-vars=GCP_PROJECT="$PROJECT_ID",CAP_DRY_RUN=true \
     --retry --project="$PROJECT_ID"
   ```
   Confirm both identities landed — runtime *and* trigger — plus the retry policy:
   ```bash
   gcloud functions describe cap-billing --gen2 --region="$REGION" --project="$PROJECT_ID" \
     --format="value(serviceConfig.serviceAccountEmail, eventTrigger.serviceAccountEmail,
                     serviceConfig.environmentVariables.CAP_DRY_RUN, eventTrigger.retryPolicy)"
   ```

**Fire drill — prove the cap fires, not just that it exists.** Pre-deploy GCP spend is ~$0, and
a budget only alerts when `cost ≥ threshold × budget`, so we publish a **synthetic**
budget-exceeded message (Google's own recommended test).

*Drill A — wiring, dry run.* **Check the deployed value of `CAP_DRY_RUN` before publishing, every
time** — the message says `cost=500 / budget=50`, so against an armed function this *is* Drill B,
unannounced and outside a maintenance window:
```bash
gcloud functions describe cap-billing --gen2 --region="$REGION" --project="$PROJECT_ID" \
  --format="value(serviceConfig.environmentVariables.CAP_DRY_RUN)"   # MUST print: true

gcloud pubsub topics publish "$TOPIC" --project "$PROJECT_ID" \
  --message "$(cat infra/billing-cap/sample-budget-message.json)"
gcloud functions logs read cap-billing --gen2 --region="$REGION" --limit=20
# Expect: "budget_notification … dryRun=true" then "DRY RUN: would disable billing …"
# `dryRun=false` in that line means you are not in a dry run. Stop.
```
Passing Drill A proves the wiring and the billing **read**. It says nothing about whether the cap
can actually detach — see the drill record below.

*Drill B — the real cap, in a maintenance window.* **Run as two separate pastes.** Arming and
firing in one block means a stray paste detaches billing; splitting them makes the fire step a
deliberate act, taken only after the arm step has been read back.

*B1 — confirm the blast radius, record the baseline, arm:*
```bash
# Detaching billing takes down EVERYTHING in the project, not just the cap.
gcloud run services list --project="$PROJECT_ID"     # cap-billing is the function itself
gcloud functions list --project="$PROJECT_ID"
gcloud firestore databases list --project="$PROJECT_ID"
gcloud beta billing projects describe "$PROJECT_ID"  # baseline: billingEnabled: true

gcloud functions deploy cap-billing --gen2 --region="$REGION" \
  --source=infra/billing-cap --entry-point=capBilling --trigger-topic="$TOPIC" \
  --service-account="$SA" --update-env-vars=CAP_DRY_RUN=false \
  --retry --project="$PROJECT_ID"

gcloud functions describe cap-billing --gen2 --region="$REGION" --project="$PROJECT_ID" \
  --format="value(serviceConfig.environmentVariables.CAP_DRY_RUN,eventTrigger.retryPolicy)"
# MUST print:  false  RETRY_POLICY_RETRY   — anything else, stop; the deploy did not take
```

*B2 — fire and restore, as one paste. Do not pause between them:*
```bash
gcloud pubsub topics publish "$TOPIC" --project "$PROJECT_ID" \
  --message "$(cat infra/billing-cap/sample-budget-message.json)"
sleep 30
gcloud beta billing projects describe "$PROJECT_ID"  # billingEnabled: false  ← action fired
# ── RESTORE ──
gcloud beta billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
gcloud beta billing projects describe "$PROJECT_ID"  # billingEnabled: true
# logs last: Cloud Logging retains them, so do not stay detached to read output
gcloud functions logs read cap-billing --gen2 --region="$REGION" --project="$PROJECT_ID" --limit=8
```

**Once billing is off, redeploying is impossible** — Cloud Build needs billing. The only way back
is `projects link`, which is why restore is a link and not a redeploy, and why the operator must
already hold `roles/billing.admin` on the account before starting.

**Then watch the logs for three minutes.** A *second* `BILLING DISABLED` after the relink means the
message nacked and redelivered, and the cap has detached billing again — relink again. Expected
behaviour is a clean ack (`disableBilling()` returns and the handler resolves long before the
detach reaches the Cloud Run scheduler), but `--retry` makes this the one hazard the drill itself
introduces, so confirm it rather than assume it.

Evidence to keep: the published message id, the execution id, both log lines, and the
`billingEnabled: true → false → true` transition.

> **Drill result — 2026-08-04 (project `innovationmate`, billing account `01CC5B-2F930F-3694A8`).**
> **Drill A verified** (execution `e3xf2c7rii25`): synthetic `cost=500 / budget=50` produced
> `budget_notification … dryRun=true` then `DRY RUN: would disable billing for
> projects/innovationmate (cost 500 > budget 50).` **Drill B verified** (execution `e4dtpj8t4wjr`,
> message `20881984335134252`, revision `cap-billing-00008-weh`): `budget_notification …
> dryRun=false` at 03:50:05.568 then `BILLING DISABLED for projects/innovationmate.` at
> 03:50:08.097 — 2.5s end to end — with `gcloud beta billing projects describe` showing
> `billingAccountName: ''` / `billingEnabled: false`, restored to `true` by `projects link`.
> Exactly one `BILLING DISABLED` line: the message acked on first delivery, so retry did not
> re-detach after the relink. **AC1 satisfied.**
>
> **The 2026-07-26 entry this replaces claimed Drill B had been completed. It had not, and could
> not have been.** On 2026-08-04 the function's service account held no billing permission
> whatsoever — the whole billing-account policy contained a single binding, to the operator's own
> user account — so `updateProjectBillingInfo` could only ever have returned `PERMISSION_DENIED`.
> Nothing removes IAM bindings spontaneously; **step 5 below was simply never run.** The
> `billingEnabled: false → true` transition that was recorded as evidence was almost certainly
> the operator's own `unlink`/`link`, which tests the operator's permissions, not the function's.
> The tell was in the record itself: Drill A carried an execution id and quoted log lines, Drill B
> carried the words "completed by the operator" and nothing else. **Evidence that cannot be
> pasted is not evidence.**
>
> **Why Drill A cannot substitute for Drill B — this is structural, not an oversight.** The
> dry-run guard at `infra/billing-cap/index.js:50` returns *before* `disableBilling()` at line 57.
> Drill A therefore exercises decode, threshold compare, and the billing **read**, then stops one
> line short of the only call that needs write permission — and passes identically whether or not
> step 5 was ever run. A cap whose write path has never executed is untested no matter how green
> the dry run looks. **Only Drill B touches line 57.** Treat a passing Drill A as proof of wiring
> and nothing more.
>
> Gotchas folded into the setup above. From 2026-07-26: the budget flag is
> `--notifications-rule-pubsub-topic`; the Pub/Sub service agent needs
> `roles/iam.serviceAccountTokenCreator`; the handler must be registered via `functions.cloudEvent`
> or the payload arrives empty. From 2026-08-04: **`roles/billing.projectManager` holds exactly
> two permissions** (`createBillingAssignment`, `deleteBillingAssignment`) and no read at all, so
> `isBillingEnabled()` at line 45 fails without `roles/browser`; `--service-account` also
> repoints the **Eventarc trigger** identity, which then needs `run.invoker` and
> `eventarc.eventReceiver` or delivery stops silently; and `infra/` lives on branch `phase-5`, not
> `main`, so a default clone deploys nothing. Useful accident worth keeping: the sample message
> says `edgify-hard-cap` while the live budget is still `trellis-hard-cap`, so the log line tells
> drill traffic from real notifications at a glance.
>
> **Blast radius.** Detaching billing is project-scoped and takes down *everything* in the
> project. `innovationmate` held nothing but the cap itself when this drill ran (`run services
> list`, `functions list`, `firestore databases list` → 0 items), which is why it was safe to
> fire. Re-confirm that before ever repeating it, and note that an armed cap on a shared project
> will take unrelated workloads down with Edgify.

> **Phase 7 follow-up:** once Cloud Run has real spend, lower the budget amount below actual
> spend once to confirm the **email** notification also fires, then restore it.

### Neon spending limit

**Status: N/A on the Free Plan (recorded 2026-07-25).** The current project is on Neon's Free
Plan, which has no billing attached and exposes no *Billing / Usage limits* page — the dashboard
only offers **Plans**. There is nothing to cap: the free tier enforces fixed allowances (compute
hours, storage) by throttling/suspending compute, not by charging, so runaway *spend* is not
possible. The app degrading to landing + demo on suspend (docs/04 §6) is the same behaviour a
spend limit would produce. This is a conscious decision under the checklist's grading model.

**Revisit when the project moves to a paid Neon plan:** set a monthly spend limit via Neon
Console → Project → **Settings → Billing / Usage limits**, and record it (screenshot in the ops
log).

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

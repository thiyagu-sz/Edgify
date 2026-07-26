/**
 * Hard billing cap — the auto-disable half of docs/09 §1.4.
 *
 * Deployed as a 2nd-gen, Pub/Sub-triggered Cloud Function subscribed to the budget topic. When
 * a budget notification reports spend over the budget amount, it DETACHES the billing account
 * from the project, which stops all further billable usage. This is the failure mode that
 * "billing caps before the code that can spend money" (docs/06 Phase 2) exists to prevent: a
 * retry loop at 3am against a paid API.
 *
 * CAP_DRY_RUN=true logs the intended action without detaching billing — used to prove the
 * Pub/Sub → function wiring before the real drill.
 *
 * The function's service account needs `roles/billing.admin` on the billing account to change
 * a project's billing link.
 *
 * Registered with the Functions Framework as a CloudEvent function (not a bare `exports.x`).
 * On gen2, that is what guarantees the handler receives the CloudEvent — with the Pub/Sub
 * message at `cloudEvent.data.message.data` — rather than an HTTP request or a gen1-style
 * (data, context) pair, either of which leaves the payload empty.
 */
const functions = require("@google-cloud/functions-framework");
const { CloudBillingClient } = require("@google-cloud/billing");

const billing = new CloudBillingClient();
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const PROJECT_NAME = `projects/${PROJECT_ID}`;
const DRY_RUN = process.env.CAP_DRY_RUN === "true";

functions.cloudEvent("capBilling", async (cloudEvent) => {
  const payload = decodePayload(cloudEvent);
  const costAmount = Number(payload.costAmount ?? 0);
  const budgetAmount = Number(payload.budgetAmount ?? 0);

  // Plain-text line so it is visible in `gcloud functions logs read` (JSON logs land in
  // jsonPayload, which that command renders blank).
  console.log(
    `budget_notification name=${payload.budgetDisplayName} cost=${costAmount} budget=${budgetAmount} dryRun=${DRY_RUN}`,
  );

  if (!(costAmount > budgetAmount)) {
    console.log("Spend is within budget — no action.");
    return;
  }

  if (!(await isBillingEnabled())) {
    console.log("Billing is already disabled — nothing to do.");
    return;
  }

  if (DRY_RUN) {
    console.warn(
      `DRY RUN: would disable billing for ${PROJECT_NAME} (cost ${costAmount} > budget ${budgetAmount}).`,
    );
    return;
  }

  await disableBilling();
});

/**
 * Decode the Pub/Sub JSON payload from the CloudEvent. The base64 body normally lives at
 * `data.message.data`; tolerate `data.data` as a fallback for other delivery shapes.
 */
function decodePayload(cloudEvent) {
  const base64 =
    cloudEvent?.data?.message?.data ?? cloudEvent?.data?.data ?? null;
  if (!base64) return {};
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function isBillingEnabled() {
  const [info] = await billing.getProjectBillingInfo({ name: PROJECT_NAME });
  return Boolean(info.billingEnabled);
}

async function disableBilling() {
  // Setting billingAccountName to "" detaches the account, which disables billing.
  const [info] = await billing.updateProjectBillingInfo({
    name: PROJECT_NAME,
    projectBillingInfo: { billingAccountName: "" },
  });
  console.warn(`BILLING DISABLED for ${PROJECT_NAME}.`);
  return info;
}

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
 */
const { CloudBillingClient } = require("@google-cloud/billing");

const billing = new CloudBillingClient();
const PROJECT_ID = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const PROJECT_NAME = `projects/${PROJECT_ID}`;
const DRY_RUN = process.env.CAP_DRY_RUN === "true";

exports.capBilling = async (cloudEvent) => {
  const message = cloudEvent?.data?.message;
  const payload = message?.data
    ? JSON.parse(Buffer.from(message.data, "base64").toString("utf8"))
    : {};

  const costAmount = Number(payload.costAmount ?? 0);
  const budgetAmount = Number(payload.budgetAmount ?? 0);

  console.log(
    JSON.stringify({
      event: "budget_notification",
      budgetDisplayName: payload.budgetDisplayName,
      costAmount,
      budgetAmount,
      dryRun: DRY_RUN,
    }),
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
};

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

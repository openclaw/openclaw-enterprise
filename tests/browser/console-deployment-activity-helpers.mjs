import assert from "node:assert/strict";

// agents/deployment-evidence.mts shows the newest readable deployment's recorded status in
// "Deployment details". These helpers check when that disclosure opens, including a slow first read:
// - a routine completion starts folded;
// - a failure's card leads the page and folds them (finding 2094);
// - the page's first record that lands after the bounded reveal (FIRST_ACTIVITY_WAIT_MS) fills
//   the folded panel without opening it, so the version tabs below do not move; the Agent
//   summary above shows its outcome (finding 2163);
// - any other first record, and every later change, opens them.

export const deploymentActivity = (page) => page.locator(".deployment-status");

const deploymentDetails = (page) => page.locator(".deployment-status > details");

export const deploymentDetailsOpen = (page) =>
  deploymentDetails(page).evaluate((node) => node.open);

// The browser's read of one deployment's record.
export const deploymentRecordUrl = (fixture, namespaceId, agentId, revisionId) =>
  `${fixture.origin}/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`;

// Opens the folded details, as a reader does, for the record's evidence.
export async function openDeploymentActivity(page) {
  if (!(await deploymentDetailsOpen(page))) {
    await deploymentDetails(page).locator(":scope > summary").click();
  }
  return deploymentActivity(page);
}

// A failure's card leads the Agent page and folds the details (finding 2094); a reader opens
// them for the record's evidence.
export async function openFailureDetails(page) {
  await page.getByRole("region", { name: "Deployment needs attention" }).waitFor();
  return openDeploymentActivity(page);
}

// Waits until Deployment activity shows `label` and returns the panel: a recorded status
// ("Recorded status: In progress"), or for "Unavailable" the error of a read that failed.
// - `folded: false`: the details are open, as every change after the first record leaves them.
// - `folded: true`: they are folded (a routine completion, or a failure under its card).
// - unset, for the page's first record: they may be folded, because that record can land after
//   the page showed; the summary must then show the same outcome, and the details are opened
//   for the record's evidence.
export async function expectDeploymentOutcome(page, label, { folded } = {}) {
  const activity = deploymentActivity(page);
  await (
    label === "Unavailable"
      ? activity.getByRole("alert", { includeHidden: true })
      : activity
          .locator(".deployment-outcome")
          .getByText(`Recorded status: ${label}`, { exact: true })
  ).waitFor({ state: "attached" });
  const open = await deploymentDetailsOpen(page);
  if (folded !== undefined) {
    assert.equal(open, !folded, `Deployment details ${folded ? "stay folded" : "open"}`);
    return activity;
  }
  if (!open) {
    await page
      .getByRole("region", { name: "Agent state at a glance" })
      .getByText(new RegExp(` · ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
      .waitFor();
    await openDeploymentActivity(page);
  }
  return activity;
}

// Waits until the viewed version's own deployment record shows `label`.
export async function expectVersionRecord(page, label) {
  const record = page.locator(".version-deployment-record");
  await record.getByText(`Recorded outcome: ${label}`, { exact: true }).waitFor();
  return record;
}

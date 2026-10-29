import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  AGENT_READ,
  apiRequests,
  authorizationDenials,
  denyRevisionRead,
  detailUrl,
  expireSessions,
  grantInstallationAdministration,
  grantMember,
  hasFocus,
  holdRequests,
  login,
  loginThroughForm,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  persistedDeploymentError,
  recordLayoutShifts,
  shortId,
  stopAgentButton,
  takeLayoutShifts,
  trackSettledFetches,
  waitForChosenVersion,
  waitForEnabled,
  waitForIdleFetches,
} from "./console-agents-browser-helpers.mjs";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
  expectVersionRecord,
  openFailureDetails,
  showDeploymentTab,
} from "./console-deployment-activity-helpers.mjs";
import { agentDeleteRequests, agentStopRequests } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  ACCESS_TAB_UNAVAILABLE,
  AGENT_CREATE_RESTRICTED,
  AGENT_DELETE_DENIED,
  AGENT_STOP_AND_DELETE_DENIED,
  AGENT_STOP_DENIED,
  askForGrant,
  BACKENDS_DENIED,
  BOUND_SECRET_METADATA,
  BOUND_SECRET_READ_REFUSED,
  BOUND_SECRET_UNLISTED,
  DIAGNOSTICS_RUNTIME_UNAVAILABLE,
  diagnosticsRecordedFailure,
  MALFORMED_REQUEST,
  NO_PERSISTED_STARTUP_FAILURE,
  RESOURCE_CONFLICT,
  requestedVersionUnavailable,
  stopRefused,
  NEW_VERSIONS_READ,
  PLUGINS_READ_ONLY,
  STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION,
  VERSION_UNAVAILABLE,
  VERSION_READ_DENIED_HEADING,
} from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";

function deploymentBody(
  namespaceId,
  agentId,
  deploymentId,
  status,
  error = null,
  cleanup = undefined,
) {
  return JSON.stringify({
    data: {
      deploymentId,
      namespaceId,
      agentId,
      status,
      error,
      warnings: [],
      progress: null,
      ...(cleanup === undefined ? {} : { cleanup }),
    },
    meta: { requestId: "req_test_agent_state" },
  });
}

const authenticationFailure = persistedDeploymentError("RUNTIME_AUTHENTICATION_FAILED");

test("Refresh deployment also refreshes the viewed version's deployment record", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Record refresh", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Record Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let status = "running";
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(
        namespace.id,
        agent.id,
        revision.id,
        status,
        status === "failed" ? authenticationFailure : null,
      ),
    }),
  );
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  const activity = await expectDeploymentOutcome(page, "In progress");
  const record = await expectVersionRecord(page, "In progress");
  await record.getByText(NO_PERSISTED_STARTUP_FAILURE, { exact: true }).waitFor();
  // A new failure must become visible even if the reader folded the pending progress: its card
  // leads the page, and the details stay folded under it.
  await activity.getByText("Deployment details", { exact: true }).press("Enter");
  await activity.getByText("Recorded status: In progress").waitFor({ state: "hidden" });

  status = "failed";
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByText("v1 did not deploy successfully (RUNTIME_AUTHENTICATION_FAILED).", { exact: false })
    .waitFor();
  await openFailureDetails(page);
  await expectDeploymentOutcome(page, "Failed", { folded: false });
  await expectVersionRecord(page, "Failed");
  // The card above leads with this version's error, so the record points at it rather than
  // repeating it (finding 2368).
  await record
    .getByText("The error and its next step are at the top of this page.", { exact: true })
    .waitFor();
  assert.equal(await record.getByText(authenticationFailure.message, { exact: false }).count(), 0);
  assert.equal(await record.getByText(NO_PERSISTED_STARTUP_FAILURE, { exact: true }).count(), 0);
});

test("Deployment activity follows pending work until it records a result", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Activity follow", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Follow Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let status = "running";
  let statusReads = 0;
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) => {
    statusReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(
        namespace.id,
        agent.id,
        revision.id,
        status,
        status === "failed" ? authenticationFailure : null,
      ),
    });
  });
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  await expectDeploymentOutcome(page, "In progress");
  await expectVersionRecord(page, "In progress");

  // Pending work is reread on its own; the reader does not have to press Refresh deployment.
  status = "failed";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await openFailureDetails(page);
  await expectDeploymentOutcome(page, "Failed", { folded: false });
  await expectVersionRecord(page, "Failed");
  await page
    .getByRole("region", { name: "Agent state at a glance" })
    .getByText("v1 · Failed", { exact: true })
    .waitFor();

  // A recorded result ends the follow-up reads.
  const readsAtResult = statusReads;
  await page.clock.runFor(DEPLOYMENT_POLL_MS * 3);
  assert.equal(statusReads, readsAtResult);
});

test("Deployment activity names retire cleanup as revision cleanup and follows it", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Cleanup follow", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Cleanup Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let cleanup = { status: "queued", nextAttemptAt: "2026-09-30T12:00:00.000Z" };
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(
        namespace.id,
        agent.id,
        revision.id,
        "failed",
        authenticationFailure,
        cleanup,
      ),
    }),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  // The failure's card says nothing of the cleanup, so the details it would fold stay open and
  // show it without the reader opening them, even when the record lands after the page showed.
  await page.getByRole("region", { name: "Deployment needs attention" }).waitFor();
  const activity = await expectDeploymentOutcome(page, "Failed", { folded: false });

  // The same retire cleanup also covers repository credential resources, so the
  // status names the version's cleanup rather than bootstrap resources.
  const status = activity.locator(".deployment-cleanup");
  assert.equal(await status.isVisible(), true);
  assert.equal(await status.getAttribute("role"), "status");
  assert.equal(
    await status.innerText(),
    "Revision cleanup pending. This version's resources have not been confirmed removed.",
  );
  // A failed attempt queues the cleanup for a retry; the API keeps reporting it running, with
  // the time of the next attempt, so the status line says it started (finding 2466).
  cleanup = { status: "running", nextAttemptAt: "2026-09-30T12:01:00.000Z" };
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await status
    .getByText(
      "Revision cleanup started. This version's resources have not been confirmed removed; the controller will retry.",
    )
    .waitFor();
  cleanup = { status: "succeeded", nextAttemptAt: null };
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await status.getByText("Revision cleanup completed for this version.").waitFor();
  await expectDeploymentOutcome(page, "Failed", { folded: false });
});

// A pending deployment is reread every few seconds and its summary usually stays the same.
// Rewriting the summary cards and status line with the same text repainted them on every
// poll (finding 1424); only the changed attempt details in Deployment activity may change.
test("Deployment polls leave an unchanged summary and status line untouched", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Quiet polls", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Quiet Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let attempt = 1;
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: revision.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "running",
          error: null,
          warnings: [],
          progress: {
            lastAttempt: {
              at: `2026-09-30T12:00:0${attempt}.000Z`,
              code: "REVISION_INCOMPLETE",
              message: `Waiting for the runtime to become ready (attempt ${attempt}).`,
            },
            nextAttemptAt: null,
          },
        },
        meta: { requestId: "req_test_quiet_polls" },
      }),
    }),
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  await waitForChosenVersion(page, 1);
  const activity = await expectDeploymentOutcome(page, "In progress");
  await activity.getByText("Waiting for the runtime to become ready (attempt 1).").waitFor();
  await page
    .getByRole("region", { name: "Agent state at a glance" })
    .getByText("v1 · In progress", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    globalThis.summaryRewrites = [];
    const observer = new globalThis.MutationObserver((records) => {
      for (const record of records) {
        globalThis.summaryRewrites.push(record.target.textContent);
      }
    });
    for (const selector of [".agent-current-summary", ".agent-status-line"]) {
      observer.observe(globalThis.document.querySelector(selector), {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  });

  // The poll renders the new attempt and the summary in the same pass.
  attempt = 2;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await activity.getByText("Waiting for the runtime to become ready (attempt 2).").waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.summaryRewrites), []);
});

test("Deployment activity keeps following after Back restores the cached Agent view", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Activity restore", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Restore Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let status = "running";
  let statusReads = 0;
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) => {
    statusReads += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(namespace.id, agent.id, revision.id, status),
    });
  });
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await trackSettledFetches(page);
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url.pathname + url.search);
  await waitForChosenVersion(page, 1);
  const activity = await expectDeploymentOutcome(page, "In progress");
  const panel = await activity.elementHandle();
  // The Console caches the Agent view for Back only if its reads finished before it was left.
  await waitForIdleFetches(page);

  // While the Agent view is cached, its poll timer fires without a current view.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces" }).waitFor();
  await page.clock.runFor(DEPLOYMENT_POLL_MS * 2);
  await page.goBack();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(
    await panel.evaluate((node) => node.isConnected),
    true,
    "Back reuses the cached Agent view",
  );
  await expectDeploymentOutcome(page, "In progress", { folded: false });

  // The restored view resumes following without a manual Refresh deployment.
  status = "succeeded";
  const readsBeforeResult = statusReads;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await expectDeploymentOutcome(page, "Completed", { folded: false });
  assert.ok(statusReads > readsBeforeResult);
});

test("Diagnostics explain UNAVAILABLE checks and point at the recorded failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Diagnostics explain", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Diagnostics Agent", nativeValues("v1"));
  // Diagnostics are offered for the current version: an Embedded version is selected before its
  // gateway is ready, so a failed record can belong to it (finding 2403).
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const deploymentPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`;
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}${deploymentPath}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(namespace.id, agent.id, revision.id, "failed", authenticationFailure),
    }),
  );
  await page.route(`${fixture.origin}${deploymentPath}/diagnostics`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          revisionId: revision.id,
          observedAt: "2026-09-30T09:06:47.000Z",
          checks: ["configuration", "authentication", "connectivity"].map((check) => ({
            component: "gateway",
            check,
            state: "unknown",
            checkedAt: "2026-09-30T09:06:46.000Z",
            code: "UNAVAILABLE",
          })),
        },
        meta: { requestId: "req_test_diagnostics_unavailable" },
      }),
    }),
  );
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  await showDeploymentTab(page);
  const observations = page.locator(".version-diagnostics");
  await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
  await observations.getByText("gateway / authentication").waitFor();
  await observations.getByText(DIAGNOSTICS_RUNTIME_UNAVAILABLE).waitFor();
  await observations
    .getByText(diagnosticsRecordedFailure("RUNTIME_AUTHENTICATION_FAILED"))
    .waitFor();
  // The failed record does not make the selected version a "Failed version": it is current.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  assert.equal(
    await page.locator(".version-selection-notice").textContent(),
    "Current version · read-only admitted snapshot.",
  );
});

// A fast answer painted "Waiting for diagnostic results…" for a frame and moved focus to it and
// back (finding 1714). The waiting line, the disabled button and the focus move now wait 250 ms.
test("A fast diagnostics answer neither shows the waiting line nor moves focus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Diagnostics fast", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Fast Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const deploymentPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`;
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}${deploymentPath}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(namespace.id, agent.id, revision.id, "succeeded"),
    }),
  );
  const answer = (observedAt) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        revisionId: revision.id,
        observedAt,
        checks: [
          {
            component: "slack",
            check: "authentication",
            state: "succeeded",
            checkedAt: observedAt,
          },
        ],
      },
      meta: { requestId: "req_test_diagnostics_fast" },
    }),
  });
  const holdRun = (observedAt) =>
    holdRequests(t, page, `${fixture.origin}${deploymentPath}/diagnostics`, {
      method: "POST",
      once: true,
      fulfill: answer(observedAt),
    });
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-30T12:00:01Z"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  await showDeploymentTab(page);
  const observations = page.locator(".version-diagnostics");
  const run = observations.getByRole("button", { name: "Run diagnostics for this version" });
  const waiting = observations.getByText("Waiting for diagnostic results…");
  await run.waitFor();
  // Every waiting line added and every element focused inside the panel, painted or not.
  await page.evaluate(() => {
    const panel = globalThis.document.querySelector(".version-diagnostics");
    globalThis.diagnosticsSeen = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.textContent.includes("Waiting for diagnostic results")) {
            globalThis.diagnosticsSeen.push("waiting line");
          } else if (node.textContent.startsWith("Observed ")) {
            globalThis.diagnosticsSeen.push("result");
          }
        }
      }
    }).observe(panel, { childList: true, subtree: true });
    panel.addEventListener("focusin", (event) =>
      globalThis.diagnosticsSeen.push(`focus ${event.target.localName}`),
    );
  });
  const seen = () => page.evaluate(() => globalThis.diagnosticsSeen.splice(0));
  const description = () =>
    run.evaluate(
      (node) =>
        globalThis.document.getElementById(node.getAttribute("aria-describedby"))?.textContent,
    );

  await run.focus();
  assert.deepEqual(await seen(), ["focus button"]);
  // The last run repeats the result shown: it is added anew, so it is announced again.
  for (const [observedAt, slow] of [
    ["2026-09-30T12:00:02.000Z", false],
    ["2026-09-30T12:00:04.000Z", false],
    ["2026-09-30T12:00:06.000Z", true],
    ["2026-09-30T12:00:06.000Z", false],
  ]) {
    const held = await holdRun(observedAt);
    await page.keyboard.press("Enter");
    try {
      await held.requested;
      await page.clock.runFor(249);
      assert.equal(await waiting.count(), 0);
      assert.equal(await run.isEnabled(), true);
      assert.equal(await hasFocus(run), true);
      if (slow) {
        // Past the delay the run behaves as before: the line shows and takes focus from the
        // disabled button.
        await page.clock.runFor(1);
        await waiting.waitFor();
        assert.equal(await hasFocus(waiting), true);
        assert.equal(await run.isDisabled(), true);
        // Focus events land at once, mutation records a microtask later.
        assert.deepEqual((await seen()).sort(), ["focus p", "waiting line"]);
      }
    } finally {
      held.release();
    }
    const shown = await page.evaluate((value) => new Date(value).toLocaleString(), observedAt);
    const observed = observations.getByText(`Observed ${shown}`);
    await observed.waitFor();
    assert.equal(await hasFocus(run), true);
    assert.equal(await description(), await observed.textContent());
    assert.deepEqual((await seen()).sort(), slow ? ["focus button", "result"] : ["result"]);
  }

  // A reader who leaves the button before the line shows stays where they went, even on the page
  // itself after clicking text outside the panel (maintainer review).
  const onPage = () =>
    page.evaluate(() => globalThis.document.activeElement === globalThis.document.body);
  const held = await holdRun("2026-09-30T12:00:08.000Z");
  await run.focus();
  await page.keyboard.press("Enter");
  try {
    await held.requested;
    await page
      .getByRole("region", { name: "Agent state at a glance" })
      .getByText("Selected for service", { exact: true })
      .click();
    assert.equal(await onPage(), true);
    await page.clock.runFor(250);
    await waiting.waitFor();
    assert.equal(await onPage(), true);
  } finally {
    held.release();
  }
  const shown = await page.evaluate(
    (value) => new Date(value).toLocaleString(),
    "2026-09-30T12:00:08.000Z",
  );
  await observations.getByText(`Observed ${shown}`).waitFor();
  assert.equal(await onPage(), true);
});

test("Diagnostics explain a missing Slack channel and keep the recorded failure in view", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Diagnostics scope", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("v1"));
  // Diagnostics are offered for the current version: an Embedded version is selected before its
  // gateway is ready, so a failed record can belong to it (finding 2403).
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const deploymentPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`;
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}${deploymentPath}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(namespace.id, agent.id, revision.id, "failed", authenticationFailure),
    }),
  );
  // The shape the Kubernetes gateway returns when the version has no Slack channel.
  await page.route(`${fixture.origin}${deploymentPath}/diagnostics`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          revisionId: revision.id,
          observedAt: "2026-09-30T09:06:47.000Z",
          checks: [
            {
              component: "gateway",
              check: "configuration",
              state: "failed",
              checkedAt: "2026-09-30T09:06:46.000Z",
              code: "NOT_CONFIGURED",
            },
            {
              component: "gateway",
              check: "authentication",
              state: "unknown",
              checkedAt: "2026-09-30T09:06:46.000Z",
            },
            {
              component: "gateway",
              check: "connectivity",
              state: "unknown",
              checkedAt: "2026-09-30T09:06:46.000Z",
            },
          ],
        },
        meta: { requestId: "req_test_diagnostics_no_slack" },
      }),
    }),
  );
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  await showDeploymentTab(page);
  const observations = page.locator(".version-diagnostics");
  await observations.getByText(/gateway checks cover only the Slack channel/).waitFor();
  await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
  await observations.getByText("gateway / authentication").waitFor();
  // A version without Slack has nothing to check: the rows say so in words, not as a failed code.
  await observations
    .getByText(/^Slack is not set up for this version, so there is nothing to check\./)
    .waitFor();
  const results = await observations.locator(".credential-status-list dd").allTextContents();
  assert.deepEqual(
    results.map((text) => text.split(" · ")[0]),
    ["not set up", "not checked", "not checked"],
  );
  assert.equal(await observations.getByText(/NOT_CONFIGURED/).count(), 0);
  await observations
    .getByText(diagnosticsRecordedFailure("RUNTIME_AUTHENTICATION_FAILED"))
    .waitFor();
  assert.equal(await observations.getByText(DIAGNOSTICS_RUNTIME_UNAVAILABLE).count(), 0);
});

test("Agent detail returns to the Agents list once background deletion finishes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete finish", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Finish Candidate", nativeValues("go"));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  let gone = false;
  await page.route(`${fixture.origin}${agentPath}`, async (route, request) => {
    if (gone && request.method() === "GET") {
      await route.fulfill(apiErrorResponse(404, "NOT_FOUND", "Agent not found."));
      return;
    }
    await route.continue();
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Finish Candidate" }).waitFor();

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Finish Candidate?" });
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  // The background cleanup finishes; no reader action follows.
  gone = true;
  await page.waitForURL((current) => current.pathname === "/console/agents", { timeout: 10_000 });
  await page.getByRole("heading", { name: "Agents" }).waitFor();
});

test("Agent detail hides sharing instead of showing an error to non-administrators", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing denied", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Shared Agent", nativeValues("x"));
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/**`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Access denied." },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000403" },
      }),
    }),
  );
  // A link to the Access tab, where sharing is (UX spec 3.8).
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Shared Agent" }).waitFor();
  const panel = page.locator(".agent-access");
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByText(/Sharing policy requires Installation administration/).count(),
    0,
  );
  // The refused read hides the tab too, and Configuration opens in its place.
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  const configuration = page.getByRole("tab", { name: "Configuration", selected: true });
  await configuration.waitFor();
  assert.equal(await page.getByRole("tab", { name: "Access" }).count(), 0);
  // The arrow keys skip the hidden Access tab: End and wrapping stop at Deployment.
  const focused = () => page.evaluate(() => globalThis.document.activeElement?.textContent);
  await configuration.focus();
  await page.keyboard.press("End");
  assert.equal(await focused(), "Deployment");
  await page.keyboard.press("ArrowRight");
  assert.equal(await focused(), "Configuration");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focused(), "Deployment");
});

// The API audits each refused read as an authorization denial, one nobody attempted. A member's
// page loads therefore send no Installation-administration probe, and her Agent detail reads no
// sharing policy; an administrator's session still asks both (finding D45).
test("Only an administrator's session probes Installation administration and reads sharing policy", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Audited access", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Audited Agent", nativeValues("x"));
  const reader = await fixture.createNamespaceMember("audited-reader", namespace.id, AGENT_READ);
  // A link to the Access tab, where sharing policy is read.
  const access = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  const adminReads = (requests) =>
    requests
      .filter(({ path }) => path === "/observability" || path.includes("/iam/"))
      .map(({ method, path }) => `${method} ${path}`);
  const adminDenials = () =>
    authorizationDenials(fixture.auditSink, /^openclaw\.(observability|iam)\./);

  const { page: member } = await newPage(t, fixture);
  await trackSettledFetches(member);
  const memberRequests = apiRequests(member, fixture.origin);
  await login(member, fixture, access, reader.credentials);
  await member.getByRole("heading", { name: "Audited Agent" }).waitFor();
  await member.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  assert.equal(await member.getByRole("tab", { name: "Access" }).count(), 0);
  // The Namespace permission answer's refusal is not kept across reloads, so a reload and another
  // page ask it again; none of them probes.
  await member.reload();
  await member.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  await member.goto(`${fixture.origin}/console/namespaces`);
  await member.getByRole("list", { name: "Namespaces" }).getByText("Audited access").waitFor();
  await waitForIdleFetches(member);
  assert.equal(await member.getByRole("link", { name: "Observability", exact: true }).count(), 0);
  assert.deepEqual(adminReads(memberRequests), []);
  assert.deepEqual(adminDenials(), []);

  const { page: admin } = await newPage(t, fixture);
  const adminRequests = apiRequests(admin, fixture.origin);
  await login(admin, fixture, access);
  await admin
    .getByRole("region", { name: "Share Agent", exact: true })
    .getByText("Current policy loaded.", { exact: true })
    .waitFor();
  assert.equal(
    await admin.getByRole("link", { name: "Observability", exact: true }).getAttribute("href"),
    url,
  );
  assert.deepEqual([...new Set(adminReads(adminRequests))].sort(), [
    `GET /namespaces/${namespace.id}/iam/access-bindings`,
    `GET /namespaces/${namespace.id}/iam/roles`,
    "GET /observability",
  ]);
  assert.deepEqual(adminDenials(), []);
});

// Finding 2619. A member's Agent detail shows a bound Secret she may not read from the
// Namespace's Secret list, which leaves it out and audits nothing, instead of reading the Secret,
// which the API audits as a denial nobody attempted. An administrator still reads it, without
// the list read (finding 2623).
test("A member's Agent detail reads no bound Secret her Secret list leaves out", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Secrets", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Bound model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Bound Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  // Agent and Configuration read, no Secret read.
  const reader = await fixture.createNamespaceMember("bound-reader", namespace.id, AGENT_READ);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  const secretPath = `/namespaces/${namespace.id}/secrets/${secret.id}`;
  const secretReads = (requests) => requests.filter(({ path }) => path === secretPath);
  const listReads = (requests) =>
    requests.filter(({ path }) => path === `/namespaces/${namespace.id}/secrets`);
  const secretDenials = () => authorizationDenials(fixture.auditSink, /^openclaw\.secrets\./);

  const { page: member } = await newPage(t, fixture);
  await trackSettledFetches(member);
  const memberRequests = apiRequests(member, fixture.origin);
  await login(member, fixture, url, reader.credentials);
  const unlisted = member.getByText(BOUND_SECRET_UNLISTED, { exact: true });
  await unlisted.waitFor();
  // The ID stays in the title for the administrator who grants read on it.
  assert.equal(await unlisted.getAttribute("title"), secret.id);
  await waitForIdleFetches(member);
  assert.deepEqual(secretReads(memberRequests), []);
  assert.deepEqual(secretDenials(), []);

  const { page: admin } = await newPage(t, fixture);
  const adminRequests = apiRequests(admin, fixture.origin);
  await trackSettledFetches(admin);
  await login(admin, fixture, url);
  await admin.getByRole("link", { name: "Bound model key", exact: true }).waitFor();
  await waitForIdleFetches(admin);
  assert.equal(secretReads(adminRequests).length, 1);
  assert.deepEqual(listReads(adminRequests), []);
  assert.deepEqual(secretDenials(), []);
});

// Finding D757. A bound Secret's links open the console's Secrets page with that Secret's metadata
// and consumers, not the API path's raw JSON. A member whose Secret list leaves the Secret out
// gets no link, which would only open a refusal the API audits; the Credentials field says why
// its name is unavailable, as the Configuration tab does.
test("Credentials links a readable bound Secret to the Secrets page and explains an unreadable one", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret links", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Linked model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Linked Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const reader = await fixture.createNamespaceMember("link-reader", namespace.id, AGENT_READ);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  const secretPage = `/console/secrets?namespace=${namespace.id}&secret=${secret.id}`;
  const metadataLink = (page) =>
    page.getByRole("link", {
      name: "View harness authentication Secret metadata (opens in new tab)",
    });

  const { page: member } = await newPage(t, fixture);
  await trackSettledFetches(member);
  await login(member, fixture, url, reader.credentials);
  const hint = member.locator("#harness-auth-secret-status");
  await hint.getByText(BOUND_SECRET_UNLISTED, { exact: true }).waitFor();
  await waitForIdleFetches(member);
  assert.equal(await metadataLink(member).count(), 0);
  assert.equal(await member.getByText(BOUND_SECRET_METADATA, { exact: true }).count(), 0);
  assert.deepEqual(authorizationDenials(fixture.auditSink, /^openclaw\.secrets\./), []);
  // With Secret read, the same member's disabled field names the bound metadata and links it.
  grantMember(fixture, "link-reader", [["read", "secret"]]);
  await member.reload();
  await hint.getByText(BOUND_SECRET_METADATA, { exact: true }).waitFor();
  await metadataLink(member).waitFor();

  // A member who may update the Agent and operate the Secret, but not read it, can edit the
  // field. Its hint still says why the bound Secret has no name, before how to choose another.
  const editor = await fixture.createNamespaceMember("link-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
    ["operate", "secret"],
  ]);
  const { page: editing } = await newPage(t, fixture);
  await trackSettledFetches(editing);
  await login(editing, fixture, url, editor.credentials);
  await waitForEnabled(editing.getByLabel("API key Secret", { exact: true }));
  await waitForIdleFetches(editing);
  const editorHint = await editing.locator("#harness-auth-secret-status").textContent();
  assert.ok(editorHint.startsWith(`${BOUND_SECRET_UNLISTED} `), editorHint);
  assert.equal(await metadataLink(editing).count(), 0);

  const { page: admin } = await newPage(t, fixture);
  await login(admin, fixture, url);
  await waitForEnabled(admin.getByLabel("API key Secret", { exact: true }));
  const link = metadataLink(admin);
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), secretPage);
  assert.equal(await link.getAttribute("target"), "_blank");
  // The Configuration tab's summary names the Secret with a link to the same page.
  await admin.getByRole("tab", { name: "Configuration", exact: true }).click();
  const named = admin.getByRole("link", { name: "Linked model key", exact: true });
  await named.waitFor();
  assert.equal(await named.getAttribute("href"), secretPage);
  // The Secrets page opens that Secret's metadata and consumers, Agent included.
  const [opened] = await Promise.all([admin.waitForEvent("popup"), named.click()]);
  const dialog = opened.getByRole("dialog", { name: "Linked model key" });
  await dialog.getByText(secret.id, { exact: true }).waitFor();
  await dialog.getByRole("link", { name: "Linked Agent", exact: true }).waitFor();
  assert.equal(await opened.locator("pre").count(), 0);
  // The link opens the Secret once: the header's Refresh reloads the list without opening it
  // again, because the page dropped the parameter from its URL.
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const oldRow = await opened
    .getByRole("button", { name: "Linked model key", exact: true })
    .elementHandle();
  await opened.getByRole("button", { name: "Refresh", exact: true }).click();
  await opened.waitForFunction((row) => !row.isConnected, oldRow);
  await opened.getByRole("button", { name: "Linked model key", exact: true }).waitFor();
  // The Secrets page opens a linked Secret in the same task that draws the list.
  assert.equal(await opened.getByRole("dialog").count(), 0);
  assert.equal(new URL(opened.url()).search, `?namespace=${namespace.id}`);

  // Finding 2645. The link keeps its Secret until the Secrets page shows it: through sign-in when
  // it opens signed out, through a failed first load's Retry, and through a session that expires
  // during the load. Each time the dialog opens and the parameter leaves the URL.
  const expectLinkedDialog = async (page) => {
    const linked = page.getByRole("dialog", { name: "Linked model key" });
    await linked.getByText(secret.id, { exact: true }).waitFor();
    assert.equal(new URL(page.url()).search, `?namespace=${namespace.id}`);
    await linked.getByRole("button", { name: "Close", exact: true }).click();
  };
  const { page: signedOut } = await newPage(t, fixture);
  await loginThroughForm(signedOut, fixture, secretPage, reader.credentials);
  await expectLinkedDialog(signedOut);

  const secretList = `${fixture.origin}/namespaces/${namespace.id}/secrets`;
  await member.route(
    secretList,
    (route) => route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again.")),
    { times: 1 },
  );
  await member.goto(`${fixture.origin}${secretPage}`);
  await member.getByRole("button", { name: "Retry", exact: true }).click();
  await expectLinkedDialog(member);

  const expiring = await holdRequests(t, member, secretList, { once: true });
  await member.goto(`${fixture.origin}${secretPage}`);
  await expiring.requested;
  expireSessions(fixture);
  expiring.release();
  await member.getByText("Your session has expired").waitFor();
  await member.getByLabel("Email", { exact: true }).fill(reader.credentials.email);
  await member.getByLabel("Password").fill(reader.credentials.password);
  await member.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectLinkedDialog(member);
});

// Finding 2619. Backends need Installation administration. A member's Backends page shows the
// refusal without reading Backends, which the API audits as a denial nobody attempted, on each
// page load; an administrator still reads them.
test("Only an administrator's Backends page reads Backends", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Backends access", { ready: true });
  const reader = await fixture.createNamespaceMember("backends-reader", namespace.id, AGENT_READ);
  const backendsPage = `/console/backends?namespace=${namespace.id}`;
  const backendsReads = (requests) => requests.filter(({ path }) => path === "/backends");
  const backendsDenials = () => authorizationDenials(fixture.auditSink, /^openclaw\.backends\./);

  const { page: member } = await newPage(t, fixture);
  await trackSettledFetches(member);
  const memberRequests = apiRequests(member, fixture.origin);
  await login(member, fixture, backendsPage, reader.credentials);
  const denial = member.locator(".state-panel");
  await denial.getByText(BACKENDS_DENIED, { exact: true }).waitFor();
  // The header's Refresh asks the permission answer again; it still reads no Backends.
  const oldPanel = await denial.elementHandle();
  await member.getByRole("button", { name: "Refresh", exact: true }).click();
  await member.waitForFunction((panel) => !panel.isConnected, oldPanel);
  await member.locator(".state-panel").getByText(BACKENDS_DENIED, { exact: true }).waitFor();
  await waitForIdleFetches(member);
  assert.equal(await member.getByRole("combobox", { name: "Namespace", exact: true }).count(), 0);
  assert.deepEqual(backendsReads(memberRequests), []);
  assert.deepEqual(backendsDenials(), []);

  const { page: admin } = await newPage(t, fixture);
  await trackSettledFetches(admin);
  const adminRequests = apiRequests(admin, fixture.origin);
  const adminRead = admin.waitForResponse(
    (response) => new URL(response.url()).pathname === "/backends" && response.status() === 200,
  );
  await login(admin, fixture, backendsPage);
  await adminRead;
  await waitForIdleFetches(admin);
  assert.equal(backendsReads(adminRequests).length, 1);
  assert.equal(await admin.getByText(BACKENDS_DENIED, { exact: true }).count(), 0);
  assert.deepEqual(backendsDenials(), []);
});

// Findings 2620 and 2621. A Restriction that denies an administrator Agent create in a Namespace
// says nothing about Installation administration. In that Namespace, the only one, so no other
// Namespace's answer can settle it, the administrator still reads Backends and gets the
// Observability link, Settings' Installation Driver configuration and an Agent's Access tab, on
// the first page load and after a reload.
test("A Restriction on Agent create leaves an administrator's Installation pages", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create restricted", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Restricted Agent", nativeValues("x"));
  restrict(fixture.policy, "create", "agent", { namespaceId: namespace.id });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const backendsRead = () =>
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/backends" && response.status() === 200,
    );
  const observability = page.getByRole("link", { name: "Observability", exact: true });

  let read = backendsRead();
  await login(page, fixture, `/console/backends?namespace=${namespace.id}`);
  await read;
  await waitForIdleFetches(page);
  assert.equal(await page.getByText(BACKENDS_DENIED, { exact: true }).count(), 0);
  assert.equal(await observability.getAttribute("href"), url);
  read = backendsRead();
  await page.reload();
  await read;
  await waitForIdleFetches(page);
  assert.equal(await page.getByText(BACKENDS_DENIED, { exact: true }).count(), 0);
  assert.equal(await observability.getAttribute("href"), url);

  await page.goto(`${fixture.origin}/console/settings?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Installation Driver configuration" }).waitFor();
  await page.goto(String(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration")));
  await page.getByRole("heading", { name: "Restricted Agent" }).waitFor();
  await page.getByRole("tab", { name: "Access", exact: true }).waitFor();
  // The Agents list and Create Agent name the Restriction and who lifts it, not an administrator
  // to ask: she is one (finding D759).
  await page.goto(`${fixture.origin}/console/agents?namespace=${namespace.id}`);
  const create = page.getByRole("button", {
    name: "Create Agent",
    exact: true,
    description: AGENT_CREATE_RESTRICTED,
  });
  await create.waitFor();
  assert.equal(await create.isDisabled(), true);
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
  await page.getByRole("status").getByText(AGENT_CREATE_RESTRICTED, { exact: true }).waitFor();
  assert.deepEqual(
    authorizationDenials(fixture.auditSink, /^openclaw\.(observability|backends|iam)\./),
    [],
  );
});

// Finding 2622. Refresh on the Backends refusal, and a reload, check Installation administration
// again, so an account made administrator while signed in reads Backends. A member's refusal
// reads no Backends and sends no probe (finding 2619). An account with no readable Namespace has
// no permission answer to ask, so its one probe is refused and kept for the tab; Refresh probes
// once more.
test("Refresh and reload on the Backends refusal check Installation administration again", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Administered later", { ready: true });
  const memberGrants = [
    ["read", "namespace"],
    ["create", "agent"],
  ];
  const personas = [
    { label: "refreshed-member", grants: memberGrants, recheck: "refresh", probes: 0 },
    { label: "reloaded-member", grants: memberGrants, recheck: "reload", probes: 0 },
    { label: "refreshed-outsider", grants: [], recheck: "refresh", probes: 1 },
  ];
  for (const { label, grants, recheck, probes } of personas) {
    const account =
      grants.length > 0
        ? await fixture.createNamespaceMember(label, namespace.id, grants)
        : await fixture.createAccountWithPolicy(label, () => {});
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const requests = apiRequests(page, fixture.origin);
    const reads = (path) => requests.filter((request) => request.path === path).length;
    const path =
      grants.length > 0 ? `/console/backends?namespace=${namespace.id}` : "/console/backends";
    await login(page, fixture, path, account.credentials);
    await page.locator(".state-panel").getByText(BACKENDS_DENIED, { exact: true }).waitFor();
    await waitForIdleFetches(page);
    assert.equal(reads("/backends"), 0, label);
    assert.equal(reads("/observability"), probes, label);

    grantInstallationAdministration(fixture, account.principal);
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/backends" && response.status() === 200,
    );
    if (recheck === "refresh") {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else {
      await page.reload();
    }
    await read;
    await waitForIdleFetches(page);
    assert.equal(await page.getByText(BACKENDS_DENIED, { exact: true }).count(), 0, label);
  }
  // Only the outsider's first probe was refused; no Backends read was.
  assert.deepEqual(
    authorizationDenials(fixture.auditSink, /^openclaw\.(observability|backends)\./).map(
      (event) => event.action,
    ),
    ["openclaw.observability.read"],
  );
});

// Finding 2627. An administrator whose administration is revoked while signed in reads Backends
// once more, and the API audits that one refusal. The refusal settles the console's answer, so the
// Observability link goes away, and the next reload or Refresh asks the permission answer, which
// audits nothing, instead of reading Backends again. Each recheck runs right after a refusal: a
// reload depends on the tab's stored answer, a Refresh on the in-memory one. A grant in between
// reaches the console at Refresh, as before.
test("A Backends refusal after administration is revoked is read and audited once", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked later", { ready: true });
  const account = await fixture.createNamespaceMember("revoked-administrator", namespace.id, [
    ["read", "namespace"],
  ]);
  let revoke = grantInstallationAdministration(fixture, account.principal);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const reads = (path) => requests.filter((request) => request.path === path).length;
  const permissionsPath = `/namespaces/${namespace.id}/permissions`;
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  const refresh = () => page.getByRole("button", { name: "Refresh", exact: true }).click();
  const backendsAnswer = (status) =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/backends" && response.status() === status,
    );

  let read = backendsAnswer(200);
  await login(page, fixture, `/console/backends?namespace=${namespace.id}`, account.credentials);
  await read;
  for (const [index, recheck] of ["reload", "refresh"].entries()) {
    if (index > 0) {
      revoke = grantInstallationAdministration(fixture, account.principal);
      read = backendsAnswer(200);
      await refresh();
      await read;
    }
    await waitForIdleFetches(page);
    assert.equal(await observability.getAttribute("href"), url, recheck);

    revoke();
    // The first Refresh after the revoke cannot know it: it reads Backends, which the API refuses.
    read = backendsAnswer(403);
    await refresh();
    await read;
    await page.locator(".state-panel").getByText(BACKENDS_DENIED, { exact: true }).waitFor();
    await waitForIdleFetches(page);
    assert.equal(await observability.count(), 0, recheck);
    const refused = reads("/backends");

    const asked = reads(permissionsPath);
    // The settled refusal asks the permission answer; a stale one would read Backends.
    const answered = page.waitForResponse((response) =>
      [permissionsPath, "/backends"].includes(new URL(response.url()).pathname),
    );
    if (recheck === "refresh") {
      await refresh();
    } else {
      await page.reload();
    }
    await answered;
    await page.locator(".state-panel").getByText(BACKENDS_DENIED, { exact: true }).waitFor();
    await waitForIdleFetches(page);
    assert.ok(reads(permissionsPath) > asked, `${recheck} asks the permission answer`);
    assert.equal(reads("/backends"), refused, recheck);
    assert.equal(await observability.count(), 0, recheck);
  }
  // One audited refusal per revocation.
  assert.deepEqual(
    authorizationDenials(fixture.auditSink, /^openclaw\.(observability|backends)\./).map(
      (event) => event.action,
    ),
    ["openclaw.backends.list", "openclaw.backends.list"],
  );
});

// Settings shows the Installation Driver configuration heading while its schemas read is still in
// flight. An administrator's Settings page has settled once the schemas are listed; a revoke
// before then reaches that read and the API refuses and audits it (finding 2654).
async function waitForDriverSchemas(page) {
  await page.getByText(/^Inspect startup settings accepted by the selected Drivers\./).waitFor();
}

// Finding D760. An administrator revoked while signed in keeps the tab's settled answer, so the
// first page she opens afterwards sends reads only Installation administration may make: sharing
// policy, a bound Secret by ID, the Installation's Driver schemas. The API audits each refusal.
// The first one is read and audited once and settles "not an administrator" for the tab; the
// reads still waiting are refused unsent. The page takes the member path: the Access tab gives way
// to Configuration and says why, the bound Secret's name is unavailable, Settings leaves out the
// Driver schemas, and the Observability link goes away. The other pages read none of them again.
// Each round starts on another page, opened right after the revoke, so it recalls the stale
// answer. Then she may read the bound Secret herself. Last, a Restriction on Secret read refuses
// one such read to an administrator: the permission answer, which audits nothing, still says she
// administers, so nothing settles.
test("Installation-administration reads after a revoke are refused and audited once", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked mid-session", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Revoked model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Revoked Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  // Agent and Configuration read, no Secret read: a member once administration goes.
  const account = await fixture.createNamespaceMember("revoked-walker", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const reads = (path) => requests.filter((request) => request.path === path).length;
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  const driverSchemas = page.getByRole("heading", { name: "Installation Driver configuration" });
  const unlisted = page.getByText(BOUND_SECRET_UNLISTED, { exact: true });
  const adminDenials = () =>
    authorizationDenials(
      fixture.auditSink,
      /^openclaw\.(observability|backends|iam|secrets|installation)\./,
    );
  const settingsUrl = `${fixture.origin}/console/settings?namespace=${namespace.id}`;
  const agentUrl = String(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const pages = {
    access: async () => {
      await page.goto(String(detailUrl(fixture, namespace.id, agent.id, "draft", "access")));
      await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
      await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
      await unlisted.waitFor();
      await waitForIdleFetches(page);
      assert.equal(await page.getByRole("tab", { name: "Access" }).count(), 0);
    },
    agent: async () => {
      await page.goto(agentUrl);
      await unlisted.waitFor();
      await waitForIdleFetches(page);
    },
    settings: async () => {
      await page.goto(settingsUrl);
      await page.getByRole("heading", { name: "Signed-in account" }).waitFor();
      await waitForIdleFetches(page);
      assert.equal(await driverSchemas.count(), 0);
      assert.equal(await page.getByRole("alert").count(), 0);
    },
    backends: async () => {
      const refused = reads("/backends");
      await page.goto(`${fixture.origin}/console/backends?namespace=${namespace.id}`);
      await page.locator(".state-panel").getByText(BACKENDS_DENIED, { exact: true }).waitFor();
      await waitForIdleFetches(page);
      assert.equal(reads("/backends"), refused);
    },
  };

  let revoke = grantInstallationAdministration(fixture, account.principal);
  await login(page, fixture, settingsUrl, account.credentials);
  for (const [round, first] of ["access", "agent", "settings"].entries()) {
    if (round > 0) {
      // Administration again: a page load asks the permission answer, then the probe.
      revoke = grantInstallationAdministration(fixture, account.principal);
      await page.goto(settingsUrl);
    }
    await waitForDriverSchemas(page);
    assert.equal(await observability.getAttribute("href"), url, first);
    revoke();
    await pages[first]();
    assert.equal(await observability.count(), 0, first);
    assert.equal(adminDenials().length, round + 1, first);
    for (const other of ["access", "agent", "settings", "backends"]) {
      await pages[other]();
    }
    assert.equal(adminDenials().length, round + 1, first);
  }

  // One who may read the bound Secret herself reads it as before: her own grant allows it, so it
  // proves nothing about administration. The sharing reads on the same page still go one at a
  // time, and the first refusal settles her answer.
  grantMember(fixture, "revoked-walker", [["read", "secret"]]);
  const named = page.getByRole("link", { name: "Revoked model key", exact: true });
  revoke = grantInstallationAdministration(fixture, account.principal);
  await page.goto(settingsUrl);
  await waitForDriverSchemas(page);
  revoke();
  await page.goto(agentUrl);
  await named.waitFor();
  await waitForIdleFetches(page);
  assert.equal(adminDenials().length, 3);
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await observability.count(), 0);
  assert.equal(adminDenials().length, 4);
  // Opened on the Access tab, her Secret read waits behind the sharing reads and is refused
  // unsent when the first one settles her answer. It then takes the member path, which lists
  // the Secret, so she still sees its name.
  revoke = grantInstallationAdministration(fixture, account.principal);
  await page.goto(settingsUrl);
  await waitForDriverSchemas(page);
  revoke();
  await page.goto(String(detailUrl(fixture, namespace.id, agent.id, "draft", "access")));
  await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
  await named.waitFor();
  await waitForIdleFetches(page);
  assert.equal(await observability.count(), 0);
  assert.equal(adminDenials().length, 5);

  grantInstallationAdministration(fixture, account.principal);
  await page.goto(agentUrl);
  await named.waitFor();
  assert.equal(await observability.getAttribute("href"), url);
  restrict(fixture.policy, "read", "secret", { namespaceId: namespace.id });
  await page.reload();
  await page.getByText(BOUND_SECRET_READ_REFUSED, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await observability.getAttribute("href"), url);
  assert.equal(await page.getByRole("tab", { name: "Access", exact: true }).count(), 1);
  assert.deepEqual(
    adminDenials()
      .slice(5)
      .map((event) => event.action),
    ["openclaw.secrets.read"],
  );
});

// Finding 2636. A page kept for Back replays its reads to check it is unchanged. The reads only
// Installation administration may make keep that gate on replay. First the Access tab is opened
// as an administrator: after a revoke, the first Back to it sends one of them, the API refuses and
// audits it, and that refusal settles "not an administrator" for the tab. The other replays, and
// every later Back, are refused unsent. Then the Access tab is opened after a revoke: its
// first administration read is audited and the rest are refused unsent, and Back sends none of
// them again.
test("Back to a kept Agent page after a revoke sends no more audited administration reads", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked before Back", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Kept model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Kept Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const account = await fixture.createNamespaceMember("revoked-reader", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  const adminDenials = () =>
    authorizationDenials(
      fixture.auditSink,
      /^openclaw\.(observability|backends|iam|secrets|installation)\./,
    );
  const accessUrl = String(detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  const settingsUrl = `/console/settings?namespace=${namespace.id}`;
  // In-app navigation keeps the Agent page for Back.
  const leaveForAgents = async () => {
    await page.locator("nav").getByRole("link", { name: "Agents", exact: true }).first().click();
    await page.waitForURL(/\/console\/agents\?/);
    await waitForIdleFetches(page);
  };
  const backThreeTimes = async (denials) => {
    for (let step = 0; step < 3; step += 1) {
      await page.goBack();
      await page.waitForURL(new RegExp(`/console/agents/${agent.id}\\?`));
      await waitForIdleFetches(page);
      assert.equal(await observability.count(), 0, `Back ${step}`);
      assert.equal(adminDenials().length, denials, `Back ${step}`);
      await page.goForward();
      await page.waitForURL(/\/console\/agents\?/);
      await waitForIdleFetches(page);
    }
  };

  let revoke = grantInstallationAdministration(fixture, account.principal);
  await login(page, fixture, accessUrl.replace(fixture.origin, ""), account.credentials);
  await page.getByRole("tab", { name: "Access", selected: true }).waitFor();
  await waitForIdleFetches(page);
  await leaveForAgents();
  assert.equal(adminDenials().length, 0);
  revoke();
  await backThreeTimes(1);

  // Administration again: a page load asks the permission answer, then the probe.
  revoke = grantInstallationAdministration(fixture, account.principal);
  await page.goto(`${fixture.origin}${settingsUrl}`);
  await waitForDriverSchemas(page);
  revoke();
  await page.goto(accessUrl);
  await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(adminDenials().length, 2);
  await leaveForAgents();
  await backThreeTimes(2);
});

// Finding 2637. A Restriction refuses an administrator's bound Secret read, and the permission
// answer that would confirm her administration fails (here a 503). A failed answer is unknown, not
// a refusal: she keeps the Observability link and the Access tab, and the next page load asks again.
test("A failed permission answer after a Restriction refusal keeps an administrator's answer", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Permission outage", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Restricted model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Restricted Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  await login(page, fixture, `/console/settings?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Installation Driver configuration" }).waitFor();
  assert.equal(await observability.getAttribute("href"), url);

  restrict(fixture.policy, "read", "secret", { namespaceId: namespace.id });
  const permissionsPath = `/namespaces/${namespace.id}/permissions`;
  const isPermissions = (address) => new URL(address).pathname === permissionsPath;
  await page.route(isPermissions, (route) =>
    route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again.")),
  );
  // The page load asks the permission answer first; the Restriction refusal asks it again.
  const failedAnswers = [];
  page.on("response", (response) => {
    if (isPermissions(response.url()) && response.status() === 503) {
      failedAnswers.push(response.url());
    }
  });
  const refusal = page.waitForResponse(
    (response) => /\/secrets\//.test(new URL(response.url()).pathname) && response.status() === 403,
  );
  await page.goto(String(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration")));
  await refusal;
  await page.getByText(BOUND_SECRET_READ_REFUSED, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.ok(failedAnswers.length >= 1, "the permission answer failed");
  assert.equal(await observability.getAttribute("href"), url);
  assert.equal(await page.getByRole("tab", { name: "Access", exact: true }).count(), 1);
  assert.deepEqual(
    authorizationDenials(
      fixture.auditSink,
      /^openclaw\.(observability|backends|iam|secrets|installation)\./,
    ).map((event) => event.action),
    ["openclaw.secrets.read"],
  );
});

// Finding 2643. The reads that wait behind the first administration read belong to its page.
// A revoked administrator opens the Access tab; its first read reaches the API, which refuses and
// audits it, and she leaves before the answer reaches the page. Leaving aborts that read, so
// nothing settles, and the reads waiting behind it are dropped with their page instead of being
// sent from the next one: one audited refusal, as when she stays. Signing out at the same point
// sends nothing either.
test("Reads waiting behind a pending administration read end with their page", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    observabilityUrl: "https://metrics.example.test/d/operations",
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Left mid-check", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Mid-check key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Mid-check Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const account = await fixture.createNamespaceMember("mid-check", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  // Sharing policy and a bound Secret by ID: the reads only an administrator's page sends.
  const administrationPath = (path) => /\/iam\/|\/secrets\/sec_/.test(path);
  const adminDenials = () =>
    authorizationDenials(fixture.auditSink, /^openclaw\.(observability|backends|iam|secrets)\./);
  const accessUrl = String(detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  const sidebarLink = (name) => page.locator("nav").getByRole("link", { name, exact: true });

  const revoke = grantInstallationAdministration(fixture, account.principal);
  await login(page, fixture, `/console/settings?namespace=${namespace.id}`, account.credentials);
  await page.getByRole("heading", { name: "Installation Driver configuration" }).waitFor();
  await waitForIdleFetches(page);
  revoke();

  for (const [round, leave] of [
    async () => {
      await sidebarLink("Agents").first().click();
      await page.getByRole("link", { name: "Mid-check Agent", exact: true }).first().waitFor();
    },
    async () => {
      await page.locator(".account-toggle").click();
      await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
      await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    },
  ].entries()) {
    // The tab still takes her for an administrator, so the Access tab sends its reads.
    const first = await holdRequests(
      t,
      page,
      (address) => administrationPath(new URL(address).pathname),
      { once: true, afterServer: true },
    );
    await page.goto(accessUrl);
    assert.equal((await first.requested).status(), 403);
    assert.equal(adminDenials().length, round + 1);
    const sent = requests.length;
    await leave();
    first.release();
    await waitForIdleFetches(page);
    assert.deepEqual(
      requests.slice(sent).filter(({ path }) => administrationPath(path)),
      [],
      `round ${round}`,
    );
    assert.equal(adminDenials().length, round + 1);
  }
});

// Finding D790. The Access tab's panel is built once per page. An administrator who opened it,
// lost administration with the page open and came back to the tab found the panel read before:
// "Current policy loaded." and an enabled Remove binding, while nothing said the policy reads were
// now refused. A return reads the policy again, one list at a time, so the refusal is audited once
// and takes the member path a reload takes: the tab gives way to Configuration and says why.
test("A return to the Access tab after a revoke shows the member notice, audited once", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["access-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked sharing", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Revoked sharing Agent", nativeValues("x"));
  const account = await fixture.createNamespaceMember("revoked-sharer", namespace.id, AGENT_READ);
  // A direct grant gives the panel a Remove binding to show.
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const role = await fixture.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "operate", resourceKind: "agent" }] },
  });
  const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: account.principal.id,
      roleId: role.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  assert.equal(binding.status, 201);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const policyReads = (from) => requests.slice(from).filter(({ path }) => path.includes("/iam/"));
  const iamDenials = () => authorizationDenials(fixture.auditSink, /^openclaw\.iam\./);
  const revoke = grantInstallationAdministration(fixture, account.principal);
  await login(
    page,
    fixture,
    String(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration")),
    account.credentials,
  );
  const accessTab = page.getByRole("tab", { name: "Access", exact: true });
  const configurationTab = page.getByRole("tab", { name: "Configuration", exact: true });
  const loaded = page.getByText("Current policy loaded.", { exact: true });
  const remove = page.getByRole("button", { name: "Remove binding", exact: true });
  await accessTab.click();
  await loaded.waitFor();
  await waitForEnabled(remove.first());
  await configurationTab.click();
  await waitForIdleFetches(page);
  // An administrator's return reads the policy again and shows it as before.
  let sent = requests.length;
  await accessTab.click();
  await waitForEnabled(remove.first());
  await waitForIdleFetches(page);
  assert.equal(await loaded.isVisible(), true);
  assert.equal(policyReads(sent).length, 2);
  // A share's outcome stays through the next return: the recheck rereads the policy but keeps
  // what the panel said.
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  const shared = panel.getByText("Agent access is shared.", { exact: false });
  await panel
    .getByLabel("Existing person’s Principal ID")
    .fill(fixture.provisionedAccounts[0].principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await shared.waitFor();
  await configurationTab.click();
  await waitForIdleFetches(page);
  sent = requests.length;
  await accessTab.click();
  await waitForEnabled(remove.first());
  await waitForIdleFetches(page);
  assert.equal(policyReads(sent).length, 2);
  assert.equal(await shared.isVisible(), true);
  assert.equal(await loaded.count(), 0);
  await configurationTab.click();
  await waitForIdleFetches(page);
  assert.deepEqual(iamDenials(), []);

  revoke();
  sent = requests.length;
  await accessTab.click();
  await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await accessTab.count(), 0);
  assert.equal(await loaded.count(), 0);
  assert.equal(await remove.count(), 0);
  assert.equal(policyReads(sent).length, 1);
  assert.equal(iamDenials().length, 1);

  // Finding D792. Credentials then read the IAM policy for the model credential's grant, as an
  // administrator's Credentials tab does: two more refusals, audited, with nothing shown. The
  // refusal above settled that this reader no longer administers the Installation, so the tab
  // sends no read that needs it.
  sent = requests.length;
  const credentialsTab = page.getByRole("tab", { name: "Credentials", exact: true });
  await credentialsTab.click();
  await page.getByRole("tab", { name: "Credentials", selected: true }).waitFor();
  await page.locator("#harness-auth-method").waitFor();
  await waitForIdleFetches(page);
  assert.equal(policyReads(sent).length, 0);
  assert.equal(iamDenials().length, 1);

  // Access that returns is used again: Refresh asks again, and the Access tab is back.
  grantInstallationAdministration(fixture, account.principal);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await accessTab.click();
  await loaded.waitFor();
  await waitForEnabled(remove.first());
  assert.equal(iamDenials().length, 1);
});

// Finding D795. Once the Access tab's recheck settled that a revoked administrator no longer
// administers the Installation, her open page kept the administrator's controls until Refresh:
// Deploy new version, Stop and Delete stayed enabled, and Plugins sent a capabilities read the
// API refused and audited. The page now reads her permission answer again, which audits
// nothing, and shows the member's controls as Refresh would, without a reload. Plugins opened
// while that answer is in flight waits for it instead of reading.
test("A revoke the Access tab settles takes away administrator controls without Refresh", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked controls", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Revoked controls Agent",
    nativeValues("x"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const account = await fixture.createNamespaceMember("revoked-controls", namespace.id, AGENT_READ);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const revoke = grantInstallationAdministration(fixture, account.principal);
  await login(
    page,
    fixture,
    String(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration")),
    account.credentials,
  );
  const accessTab = page.getByRole("tab", { name: "Access", exact: true });
  const deploy = page.getByRole("button", { name: "Deploy new version", exact: true });
  const remove = page.getByRole("button", { name: "Delete Agent", exact: true });
  const stop = stopAgentButton(page);
  await waitForEnabled(deploy);
  await waitForEnabled(stop);
  await waitForEnabled(remove);
  await accessTab.click();
  await page.getByText("Current policy loaded.", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await waitForIdleFetches(page);

  revoke();
  const audited = authorizationDenials(fixture.auditSink).length;
  const sent = requests.length;
  const reread = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    { once: true },
  );
  await accessTab.click();
  await page.getByText(ACCESS_TAB_UNAVAILABLE, { exact: true }).waitFor();
  await reread.requested;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("tab", { name: "Plugins", selected: true }).waitFor();
  reread.release();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  // She holds Agent read only: no deploy, operate or delete.
  await stop.waitFor({ state: "hidden" });
  await remove.waitFor({ state: "hidden" });
  assert.equal(await deploy.isDisabled(), true);
  await waitForIdleFetches(page);
  assert.equal(
    requests.slice(sent).filter(({ path }) => path.endsWith("/plugins/capabilities")).length,
    0,
  );
  // The Access tab's refused policy read is the only audited refusal.
  assert.deepEqual(
    authorizationDenials(fixture.auditSink)
      .slice(audited)
      .map(({ action }) => action),
    ["openclaw.iam.roles.list"],
  );
});

// Finding D792. A refusal after the page confirmed administration settles nothing until the
// permission answer, which audits nothing, says so: a Restriction can refuse one read to an
// administrator. Opened on the Access tab, the sharing reads confirm her administration; the
// Configuration tab's bound Secret read, sent after them, is refused. She is still an
// administrator, so she keeps the Observability link and the Access tab, and that refusal is the
// only audited one.
test("A Restriction refusal after confirmed administration keeps an administrator's answer", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Confirmed then restricted", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Confirmed model key", "hidden-model");
  const agent = await fixture.createAgent(namespace.id, "Confirmed Agent", nativeValues("x"), {
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  restrict(fixture.policy, "read", "secret", { namespaceId: namespace.id });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  await login(page, fixture, String(detailUrl(fixture, namespace.id, agent.id, "draft", "access")));
  await page.getByText("Current policy loaded.", { exact: true }).waitFor();
  await waitForIdleFetches(page);
  const refusal = page.waitForResponse(
    (response) => /\/secrets\//.test(new URL(response.url()).pathname) && response.status() === 403,
  );
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await refusal;
  await page.getByText(BOUND_SECRET_READ_REFUSED, { exact: true }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await observability.getAttribute("href"), url);
  assert.equal(await page.getByRole("tab", { name: "Access", exact: true }).count(), 1);
  assert.deepEqual(
    authorizationDenials(
      fixture.auditSink,
      /^openclaw\.(observability|backends|iam|secrets|installation)\./,
    ).map((event) => event.action),
    ["openclaw.secrets.read"],
  );
});

// Only a Backends refusal settles Installation administration as false (finding 2627). A read that
// fails for another reason, here an unavailable dependency, says nothing about it: the
// administrator keeps the Observability link.
test("A Backends failure other than a refusal keeps an administrator's answer", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Backends outage", { ready: true });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const observability = page.getByRole("link", { name: "Observability", exact: true });
  const isBackends = (address) => new URL(address).pathname === "/backends";
  await page.route(isBackends, (route) =>
    route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again.")),
  );

  const read = page.waitForResponse(
    (response) => isBackends(response.url()) && response.status() === 503,
  );
  await login(page, fixture, `/console/backends?namespace=${namespace.id}`);
  await read;
  await waitForIdleFetches(page);
  assert.equal(await page.getByText(BACKENDS_DENIED, { exact: true }).count(), 0);
  assert.equal(await observability.getAttribute("href"), url);
});

const FORBIDDEN = {
  status: 403,
  contentType: "application/json",
  body: JSON.stringify({
    error: { code: "FORBIDDEN", message: "Access denied." },
    meta: { requestId: "req_00000000-0000-4000-8000-000000000403" },
  }),
};

// The session probe could not tell (/observability failed): only a known denial leaves the
// Access tab out, so an administrator keeps it. The tab is about the whole Agent, so the viewed
// version's evidence steps aside while it is open.
test("An unknown Installation access answer keeps the Access tab", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Access unknown", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unknown Agent", nativeValues("v1"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await page.route(`${fixture.origin}/observability`, (route) =>
    route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Unavailable.")),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  await waitForChosenVersion(page, 1);
  await showDeploymentTab(page);
  const evidence = page.locator(".version-evidence");
  await evidence.waitFor();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page
    .getByRole("region", { name: "Share Agent", exact: true })
    .getByText("Current policy loaded.", { exact: true })
    .waitFor();
  assert.equal(await evidence.isHidden(), true);
});

// A refused policy read with focus on the Access tab hides the tab, moves focus to
// Configuration's and replaces the Access entry in history, so Back does not return to it.
test("A refused sharing read moves focus off the hidden Access tab", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing refused", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Refused Agent", nativeValues("x"));
  const { page } = await newPage(t, fixture);
  const read = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/roles`,
    { method: "GET", once: true, fulfill: FORBIDDEN },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Refused Agent" }).waitFor();
  const entries = await page.evaluate(() => globalThis.history.length);
  const access = page.getByRole("tab", { name: "Access", exact: true });
  await access.focus();
  await access.press("Enter");
  await read.requested;
  assert.equal(await page.evaluate(() => globalThis.document.activeElement?.textContent), "Access");
  read.release();
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  const configuration = page.getByRole("tab", { name: "Configuration", selected: true });
  await configuration.waitFor();
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Configuration",
  );
  assert.equal(await page.evaluate(() => globalThis.history.length), entries + 1);
});

// The read is refused after the reader left the tab: Back to it opens Configuration in its
// place, never the hidden panel.
test("Back to a refused Access tab opens Configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing left", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Left Agent", nativeValues("x"));
  const { page } = await newPage(t, fixture);
  const read = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/roles`,
    { method: "GET", once: true, fulfill: FORBIDDEN },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Left Agent" }).waitFor();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await read.requested;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "plugins");
  read.release();
  await page.getByRole("tab", { name: "Access" }).waitFor({ state: "detached" });
  await page.goBack();
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  assert.equal(await page.locator(".agent-access").count(), 0);
});

function routeDeploymentStatus(page, fixture, namespace, agent, revision, status, error = null) {
  return page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: deploymentBody(namespace.id, agent.id, revision.id, status, error),
    }),
  );
}

test("Agent detail says when the current or requested version cannot be read", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Hidden versions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Hidden Agent", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(page, fixture, namespace, agent, first.revision, "succeeded");

  const url = detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Hidden Agent" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  // A readable completed deployment starts folded; its evidence is reachable by keyboard.
  await summary.getByText(`v${first.revision.revision} · Completed`).waitFor();
  await summary.getByText("Not verified", { exact: true }).waitFor();
  const activity = await expectDeploymentOutcome(page, "Completed", { folded: true });
  await activity.getByText("Deployment details", { exact: true }).press("Enter");
  await expectDeploymentOutcome(page, "Completed", { folded: false });

  // Revision read is granted per version: v2 is current, but this reader cannot read it.
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  denyRevisionRead(fixture, namespace, second.revision);
  const requests = apiRequests(page, fixture.origin);
  const versionReads = () =>
    requests.filter(({ path }) => path.endsWith(`/revisions/${second.revision.id}`)).length;
  const versionDenials = () =>
    authorizationDenials(fixture.auditSink, "openclaw.agent_revisions.read").length;
  await page.goto(
    detailUrl(fixture, namespace.id, agent.id, second.revision.id, "configuration").href,
  );
  // The page named that version by its raw ID in four places and read it once per tab, an
  // audited refusal. The newest page of versions lists every version this reader can read and
  // leaves v2 out, so, as on the Agents list, the page names it in words and does not read it.
  // Beside v1's completed deployment it is newer (finding D791).
  const NEWER_UNREADABLE = "A newer version you cannot read";
  await summary.getByText("Newer version hidden", { exact: true }).waitFor();
  await summary.getByText(NEWER_UNREADABLE, { exact: true }).waitFor();
  assert.equal(await summary.getByText("v1 · Completed").count(), 0);
  await page
    .locator(".agent-status-line")
    .getByText(/^The current version is one you cannot read; v1 is an older version\./)
    .waitFor();
  await page
    .getByText(
      `${NEWER_UNREADABLE} remains selected for service. Browsing does not deploy or roll back.`,
      { exact: true },
    )
    .waitFor();
  // Members have no chat or native admin surface, so the hint names only paths that work.
  await page
    .locator(".agent-status-line")
    .getByText(
      new RegExp(
        `${RegExp.escape(NEW_VERSIONS_READ)} If this Agent is set up for a channel such as Slack, you can message it there when that channel allows you\\.$`,
      ),
    )
    .waitFor();
  await page.getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true }).waitFor();
  assert.equal(await page.getByText("Configuration unavailable").count(), 0);
  // The settled denial panel shows once the page decided whether to read the version.
  assert.equal(await page.locator("main").getByText(/rev_/).count(), 0);
  assert.equal(versionReads(), 0);
  assert.equal(versionDenials(), 0);

  // After a deploy the console opens the requested version; its outcome stays hidden too.
  const requested = await fixture.deployAgent(namespace.id, agent.id);
  denyRevisionRead(fixture, namespace, requested);
  const requestedUrl = detailUrl(fixture, namespace.id, agent.id, requested.id, "configuration");
  await page.goto(requestedUrl.href);
  await page.getByRole("heading", { name: "Hidden Agent" }).waitFor();
  // The page cannot tell a version it may not read from one that does not exist, so it says
  // either may be true, and does not ask for read "after each deployment" (finding D750).
  const statusLine = page.locator(".agent-status-line");
  await statusLine.getByText(requestedVersionUnavailable(shortId(requested.id))).waitFor();
  await page.getByRole("heading", { name: "Version not found or not shared" }).waitFor();
  await page.getByText(VERSION_UNAVAILABLE, { exact: true }).waitFor();
});

// After a stop request the Stop row names the current version. One the reader cannot read is
// named in the page's words there too, not by its raw ID (finding D791).
test("A requested stop names an unreadable current version in words", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Stopped hidden", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Stopped hidden Agent", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  denyRevisionRead(fixture, namespace, second.revision);
  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  assert.equal(stopped.data.activeRevisionId, second.revision.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(page, fixture, namespace, agent, first.revision, "succeeded");

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByText("Requested runtime state", { exact: true }).waitFor();
  await stopRegion.getByText("A newer version you cannot read", { exact: true }).waitFor();
  assert.equal(await stopRegion.getByText(/rev_/).count(), 0);
});

test("Agent detail says an Agent's versions are hidden, not missing, when none is readable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unreadable versions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Hidden history", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  denyRevisionRead(fixture, namespace, first.revision);
  const { page } = await newPage(t, fixture);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Hidden history" }).waitFor();
  await page
    .getByText(
      `No readable versions. This Agent has versions your access does not include. ${askForGrant("AgentRevision read on them")}`,
    )
    .waitFor();
  assert.equal(
    await page.getByText(/Creating an Agent alone does not create a version/).count(),
    0,
  );

  // A first deploy still in flight has no active version, but the Agent is running.
  const pending = await fixture.createAgent(namespace.id, "Pending history", nativeValues("v1"));
  denyRevisionRead(fixture, namespace, await fixture.deployAgent(namespace.id, pending.id));
  await page.goto(detailUrl(fixture, namespace.id, pending.id, "draft", "configuration").href);
  await page.getByRole("heading", { name: "Pending history" }).waitFor();
  await page.getByText(/^No readable versions\. This Agent has versions your access/).waitFor();
  // Agent operate and AgentRevision read are separate grants. This reader may stop the Agent but
  // cannot read the deploying version, so Stop stays on the page and the Agents list: the API
  // answers if nothing runs. Its dialog cannot say which, so it names both outcomes instead of
  // describing a gateway that may not exist (finding D691).
  const stop = stopAgentButton(page);
  await waitForEnabled(stop);
  await stop.click();
  let dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog.getByText(STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.goto(new URL(`/console/agents?namespace=${namespace.id}`, page.url()).href);
  const row = page.getByRole("row").filter({ hasText: "Pending history" });
  await row.getByText("No visible deployments", { exact: true }).waitFor();
  const rowStop = row.getByRole("button", { name: "Stop Pending history", exact: true });
  await waitForEnabled(rowStop);
  await rowStop.click();
  dialog = page.getByRole("dialog", { name: "Stop Pending history?" });
  await dialog.getByText(STOP_UNKNOWN_DEPLOYMENT_CONFIRMATION, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });

  // A never-deployed Agent keeps the creation hint.
  const fresh = await fixture.createAgent(namespace.id, "No history", nativeValues("v1"));
  await page.goto(detailUrl(fixture, namespace.id, fresh.id, "draft", "configuration").href);
  await page.getByRole("heading", { name: "No history" }).waitFor();
  await page
    .getByText(
      "No readable versions. Creating an Agent alone does not create a version; if this Agent was deployed before, your access does not include its versions.",
    )
    .waitFor();
});

test("Agent detail reports a failed dedicated replacement as probably not serving", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Failed replacement", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Dedicated Agent",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const replacement = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    replacement,
    "failed",
    authenticationFailure,
  );

  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 1);
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("May be offline", { exact: true }).waitFor();
  await page
    .getByText(
      /v2 did not deploy successfully \(RUNTIME_AUTHENTICATION_FAILED\)\. v1 is still selected, but its runtime was probably stopped/,
    )
    .waitFor();
});

// Embedded activation selects the new version before its gateway is ready, so a failed
// embedded redeploy leaves the failed version selected and nothing else serving (D225).
test("Agent detail reports a failed selected version as probably not serving", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Failed selection", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const selected = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    selected.revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_TIMEOUT"),
  );

  const url = detailUrl(fixture, namespace.id, agent.id, selected.revision.id, "configuration");
  await login(page, fixture, url);
  await waitForChosenVersion(page, 2);
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("May be offline", { exact: true }).waitFor();
  await page
    .getByText(
      /v2 is still selected, but its runtime replaced the previous version before deployment finished/,
    )
    .waitFor();
  // The warning is the whole answer: no note says that nothing checked serving (finding 2367).
  const liveServingNote = summary
    .locator(".stat")
    .filter({ hasText: "Live serving" })
    .locator(".stat-help");
  assert.equal(await liveServingNote.textContent(), "");
});

// A startup model check that failed or timed out, or a Gateway that refused its own
// CLI, is not a rejected credential, so its next step points at the Configuration and the failed version's Logs, not at Credentials.
// OpenClaw reports an unreachable provider (refused connection, DNS failure) as a timeout and
// Codex as a failure, so each text names the harness it applies to.
// The API's message carries the next step, so occ and HTTP clients get it too (finding 1393);
// the console shows that message once and adds only the link to the page that holds the fix.
test("Deployment activity guides a failed model check or an unauthorized gateway cli", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Model check", { ready: true });
  const { page } = await newPage(t, fixture);
  const cases = [
    {
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          component: "gateway",
          check: "model-probe",
          checkedAt: "2026-10-03T08:00:00.000Z",
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "rate_limit" },
        },
      }),
      nextStep:
        /^The startup model check failed, but not for a rejected credential: .*, or, with Codex, an unreachable provider\. Check these and the provider account, then deploy a new version\.$/,
      // The runtime's classified cause names why this check failed.
      cause:
        "The model provider rejected the request: rate or usage limit reached (rate_limit). Wait for the provider's limit to reset or use an account with remaining quota, then deploy a new version.",
    },
    {
      // A cause without its own text keeps the kind label and the detail token.
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: "2026-10-03T08:00:00.000Z",
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "error-event" },
        },
      }),
      nextStep: /^The startup model check failed, but not for a rejected credential: /,
      cause: "The model provider check reported a failure (error-event)",
    },
    {
      // A billing refusal has its own provider text, as a rate limit does.
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: "2026-10-03T08:00:00.000Z",
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail: "billing" },
        },
      }),
      nextStep: /^The startup model check failed, but not for a rejected credential: /,
      cause:
        "The model provider rejected the request: billing or credit problem (billing). Check the provider account's plan and credits, then deploy a new version.",
    },
    // Finding 1600: a Codex check retried once ends its detail -attempt2. The advice
    // follows the token without the suffix, and the text says the retry also failed.
    ...[
      [
        "rate_limit-attempt2",
        "The model provider rejected the request: rate or usage limit reached (rate_limit). Wait for the provider's limit to reset or use an account with remaining quota, then deploy a new version. The check was retried once and failed again.",
      ],
      [
        "turn-failed-attempt2",
        "The model provider check reported a failure (turn-failed). The check was retried once and failed again.",
      ],
    ].map(([detail, cause]) => ({
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED", {
        runtimeFailure: {
          component: "agent",
          check: "model-probe",
          checkedAt: "2026-10-03T08:00:00.000Z",
          code: "MODEL_PROBE_FAILED",
          cause: { kind: "PROBE_STATUS", detail },
        },
      }),
      nextStep: /^The startup model check failed, but not for a rejected credential: /,
      cause,
    })),
    {
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_TIMEOUT"),
      nextStep:
        /^The startup model check got no reply from the provider in time\. With OpenClaw this includes an unreachable provider \(refused connection or unknown host\)\..* then deploy a new version\.$/,
    },
    {
      // The Configuration holds the fix (Enable gateway password access), not Credentials.
      error: persistedDeploymentError("AGENT_GATEWAY_UNAUTHORIZED"),
      nextStep: /\(Enable gateway password access\), then deploy again\.$/,
    },
  ];
  for (const [index, { error, nextStep, cause }] of cases.entries()) {
    const agent = await fixture.createAgent(namespace.id, `Agent ${index}`, nativeValues("v1"));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    await routeDeploymentStatus(page, fixture, namespace, agent, revision, "failed", error);

    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    if (index === 0) {
      await login(page, fixture, url);
    } else {
      await page.goto(url.href);
    }
    assert.match(error.message, nextStep);
    const activity = await openFailureDetails(page);
    await activity.getByText(`${error.code}: ${error.message}`, { exact: true }).waitFor();
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    // A failed or timed-out model check leads as one; a refused gateway CLI does not.
    const lead = error.code.startsWith("RUNTIME_MODEL_PROBE_")
      ? "v1 failed its startup model check"
      : "v1 did not deploy successfully";
    assert.ok(
      (await recovery.locator(".status-body").textContent()).startsWith(
        `${lead} (${error.code}). `,
      ),
      error.code,
    );
    assert.equal(
      await activity.getByText("Cause", { exact: true }).count(),
      cause === undefined ? 0 : 1,
    );
    if (cause !== undefined) {
      await activity.getByText(cause, { exact: true }).waitFor();
    }
    assert.match(
      await recovery.getByRole("link", { name: "Open Configuration" }).getAttribute("href"),
      new RegExp(`agents/${agent.id}\\?revision=draft&tab=configuration`),
    );
    assert.match(
      await recovery.getByRole("link", { name: "Open v1 Logs" }).getAttribute("href"),
      new RegExp(`revision=${revision.id}&tab=logs`),
    );
    assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
  }
});

test("Agent detail keeps an embedded Agent's failed redeploy separate from serving", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Embedded redeploy", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const replacement = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    replacement,
    "failed",
    authenticationFailure,
  );

  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, url);
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("v2 · Failed").waitFor();
  await summary.getByText("Not verified", { exact: true }).waitFor();
  assert.equal(await page.getByText("May be offline", { exact: true }).count(), 0);
});

// The API records a deployment ended by REVISION_SUPERSEDED (a newer version took over first,
// finding 1353) or REVISION_STOPPED (its owner stopped the Agent, finding 1375) as failed, but the
// version did not fail, so the console shows a neutral outcome. A reader who cannot read the newer
// version learns nothing about it. A real failure on the same record still renders red, and so does
// REPOSITORY_REVISION_STOPPED: the repository credential worker also records it when the Namespace
// is not ready. Its REPOSITORY_REVISION_SUPERSEDED is neutral.
const neutralDeployments = [
  {
    agent: "Superseded Agent",
    outcome: "superseded",
    error: {
      code: "REVISION_SUPERSEDED",
      message: "Deployment was superseded by a newer revision.",
    },
    note: "Superseded by a newer version.",
    summaryNote: "Superseded by a newer version.",
    explanation: (code) =>
      `Superseded by a newer version before this one became current (${code}). This version did not fail; no action is needed.`,
    stages: [
      "Deployment work stopped because a newer version superseded this one.",
      "Not needed: this version did not become current.",
    ],
    failure: authenticationFailure,
    alsoNeutral: "REPOSITORY_REVISION_SUPERSEDED",
    newerHidden: true,
  },
  {
    agent: "Stopped Agent",
    outcome: "stopped",
    error: {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    },
    note: "Stopped before it finished.",
    summaryNote: "Stopped before it finished. Deploy a new version when you want it running.",
    explanation: (code) =>
      `The Agent was stopped before this deployment finished (${code}). This version did not fail; deploy a new version when you want it running.`,
    stages: [
      "Deployment work ended because the Agent was stopped.",
      "Not recorded: the Agent was stopped first. Deploy a new version when you want it running.",
    ],
    failure: {
      code: "REPOSITORY_REVISION_STOPPED",
      message:
        "Deployment ended because the Agent was stopped or its Namespace is no longer ready. To run the Agent, deploy again once its Namespace is ready.",
    },
  },
];

test("Agent detail and list show superseded and stopped deployments as neutral, not failed", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Neutral deploys", { ready: true });
  const { page } = await newPage(t, fixture);
  // Each Agent's recorded deployment error and detail page, by Agent name.
  const errors = new Map();
  const urls = new Map();
  for (const c of neutralDeployments) {
    const agent = await fixture.createAgent(namespace.id, c.agent, nativeValues("v1"));
    const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    if (c.newerHidden) {
      const newer = await fixture.seedActiveAgentRevision(
        namespace.id,
        agent.id,
        first.revision.id,
      );
      denyRevisionRead(fixture, namespace, newer.revision);
    }
    errors.set(c.agent, c.error);
    urls.set(
      c.agent,
      detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration"),
    );
    const deployment = deploymentRecordUrl(fixture, namespace.id, agent.id, first.revision.id);
    await page.route(deployment, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: deploymentBody(
          namespace.id,
          agent.id,
          first.revision.id,
          "failed",
          errors.get(c.agent),
        ),
      }),
    );
    await page.route(`${deployment}/diagnostics`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            revisionId: first.revision.id,
            observedAt: "2026-10-14T16:00:01.000Z",
            checks: [
              {
                component: "gateway",
                check: "connectivity",
                state: "unknown",
                checkedAt: "2026-10-14T16:00:00.000Z",
                code: "UNAVAILABLE",
              },
            ],
          },
          meta: { requestId: "req_test_neutral_diagnostics" },
        }),
      }),
    );
  }

  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  for (const c of neutralDeployments) {
    const row = page.getByRole("row").filter({ hasText: c.agent });
    await row
      .getByRole("link", { name: `v1 · ${c.outcome[0].toUpperCase()}${c.outcome.slice(1)}` })
      .waitFor();
    await row.getByText(c.note, { exact: true }).waitFor();
    assert.equal(await row.getByText(/failed|Deployment (was|ended)/).count(), 0);
  }

  const summary = page.locator(".agent-current-summary");
  const activity = page.locator(".deployment-status");
  const record = page.locator(".version-deployment-record");
  const statusLine = page.locator(".agent-status-line");
  const outcome = page.locator(
    ".agent-current-summary, .deployment-status, .version-deployment-record",
  );
  const absent = /\bv2\b|failed|Live serving is unverified|check the recorded error/i;
  // After a refresh from a failure, the hidden status line keeps its old text, so its text is
  // checked only when the page first renders the neutral record.
  const expectNeutral = async (c, code, checkStatusLineText = true) => {
    const label = `${c.outcome[0].toUpperCase()}${c.outcome.slice(1)}`;
    await summary.getByText(`v1 · ${label}`, { exact: true }).waitFor();
    await summary.getByText(c.summaryNote, { exact: true }).waitFor();
    await summary.getByText("Not verified", { exact: true }).waitFor();
    await expectDeploymentOutcome(page, label);
    await activity.getByText(c.explanation(code)).waitFor();
    for (const stage of c.stages) {
      await activity.getByText(stage, { exact: true }).waitFor();
    }
    assert.equal(await activity.locator(`.deployment-step-${c.outcome}`).count(), 2);
    assert.equal(await activity.locator(".deployment-step-failed").count(), 0);
    assert.equal(await activity.getByRole("alert").count(), 0);
    await expectVersionRecord(page, label);
    await record.getByText(c.explanation(code), { exact: true }).waitFor();
    // No failure banner, no suspected outage, and nothing names the newer version, which this
    // reader cannot read.
    assert.equal(await statusLine.isVisible(), false);
    assert.equal(
      await page.getByRole("region", { name: "Deployment needs attention" }).isVisible(),
      false,
    );
    assert.equal(await page.getByText("May be offline", { exact: true }).count(), 0);
    assert.equal(await outcome.getByText(absent).count(), 0);
    if (checkStatusLineText) {
      assert.equal(await statusLine.getByText(absent).count(), 0);
    }
  };
  for (const c of neutralDeployments) {
    await page.goto(urls.get(c.agent).href);
    await waitForChosenVersion(page, 1);
    await expectNeutral(c, c.error.code);
    // A neutral record is not a failure, so the version's notice does not call it failed. The
    // superseded v1 is not current (the hidden v2 is), so it is history.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    assert.equal(
      (await page.locator(".version-selection-notice").textContent()).split(" ·")[0],
      c.newerHidden ? "Historical version" : "Current version",
    );
    // Diagnostics do not ask the reader to resolve a neutral record first.
    await showDeploymentTab(page);
    const observations = page.locator(".version-diagnostics");
    await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
    await observations
      .getByText(/Check this version's recorded outcome and its Logs tab/)
      .waitFor();
    assert.equal(await observations.getByText(diagnosticsRecordedFailure(c.error.code)).count(), 0);

    errors.set(c.agent, c.failure);
    await activity.getByRole("button", { name: "Refresh deployment" }).click();
    await summary.getByText("v1 · Failed", { exact: true }).waitFor();
    if (!c.newerHidden) {
      await openFailureDetails(page);
    }
    await expectDeploymentOutcome(page, "Failed", { folded: false });
    await activity.getByText(`${c.failure.code}: ${c.failure.message}`).waitFor();
    assert.equal(await activity.locator(".deployment-step-failed").count(), 1);
    assert.equal(await activity.locator(`.deployment-step-${c.outcome}`).count(), 0);
    if (c.newerHidden) {
      // The current version is hidden and may be newer, so the failure raises no recovery
      // (finding 1458).
      await statusLine
        .getByText(/cannot tell whether the failed v1 deployment affects it\./)
        .waitFor();
      assert.equal(
        await page.getByRole("region", { name: "Deployment needs attention" }).isVisible(),
        false,
      );
    } else {
      await page.getByRole("link", { name: "Open v1 Logs" }).waitFor();
    }

    if (c.alsoNeutral) {
      errors.set(c.agent, { ...c.error, code: c.alsoNeutral });
      await activity.getByRole("button", { name: "Refresh deployment" }).click();
      await expectNeutral(c, c.alsoNeutral, false);
    }
  }
});

test("Agent detail reads the selected version's deployment record once on load", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Single record read", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Single read Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  let recordReads = 0;
  let failFirst = false;
  const recovery = Promise.withResolvers();
  t.after(() => recovery.resolve());
  await page.route(
    deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id),
    async (route) => {
      recordReads += 1;
      if (failFirst && recordReads === 1) {
        return route.fulfill(apiErrorResponse(503, "DEPENDENCY_UNAVAILABLE", "Try again."));
      }
      if (failFirst) {
        await recovery.promise;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: deploymentBody(namespace.id, agent.id, revision.id, "succeeded"),
      });
    },
  );
  await trackSettledFetches(page);
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByText("v1 · Completed", { exact: true }).waitFor();
  await expectVersionRecord(page, "Completed");
  await waitForIdleFetches(page);
  // Deployment activity and the version's record panel show the same record.
  assert.equal(recordReads, 1);

  // When the shared read fails, the selected panel recovers the same record for both panels.
  recordReads = 0;
  failFirst = true;
  await page.reload();
  await expectDeploymentOutcome(page, "Unavailable");
  recovery.resolve();
  await expectVersionRecord(page, "Completed");
  await expectDeploymentOutcome(page, "Completed");
  await waitForIdleFetches(page);
  assert.equal(recordReads, 2);
});

test("Agent detail does not move shown sections when Deployment activity first settles", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady detail", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Steady detail Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const record = await holdRequests(
    t,
    page,
    deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id),
    {
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: deploymentBody(namespace.id, agent.id, revision.id, "succeeded"),
      },
    },
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByRole("link", { name: "Steady detail Agent" }).waitFor();
  // A paused clock keeps the reveal waiting for the read instead of FIRST_ACTIVITY_WAIT_MS.
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await page.addInitScript(recordLayoutShifts);
  // A full load, so no recent input excuses a shift.
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration").href);
  // The Agent page renders hidden behind the startup status until its overview reveals
  // (finding 1537). Its header (← Agents among it) comes with the reveal, so wait on the page.
  await page.locator(".agent-detail-pending").waitFor({ state: "attached" });
  // The version's own reads finish while Deployment activity's first read is still held.
  await page
    .locator(".agent-version-heading", { hasText: "Version v1" })
    .waitFor({ state: "attached" });
  assert.equal(await page.locator(".agent-detail-pending").count(), 1);
  assert.equal(await page.locator(".agent-version-layout").isVisible(), false);
  // Paint what is shown, with its fonts. The load up to here (startup status, shell, Agent heading)
  // must not shift either; then measure the first read settling on its own.
  await page.evaluate(() => globalThis.document.fonts.ready);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { shift: loadShift, shifts: loadShifts } = await takeLayoutShifts(page);
  assert.ok(loadShift < 0.01, `load shift ${loadShift}: ${JSON.stringify(loadShifts)}`);

  record.release();
  await page.getByText("v1 · Completed", { exact: true }).waitFor();
  await page.locator(".agent-version-layout").waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const { shift, shifts } = await takeLayoutShifts(page);
  assert.ok(shift < 0.01, `layout shift ${shift}: ${JSON.stringify(shifts)}`);
});

const listUrl = (namespaceId) => `/console/agents?namespace=${namespaceId}`;

for (const width of [1440, 390]) {
  test(`Agent row content opens its detail at ${width}px and Back restores the list`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Row navigation ${width}`);
    const agent = await fixture.createAgent(namespace.id, "Clickable Agent", nativeValues("row"));
    const { page } = await newPage(t, fixture);
    await page.setViewportSize({ width, height: 900 });
    await login(page, fixture, listUrl(namespace.id));
    const row = page.getByRole("row").filter({ hasText: agent.name });
    const name = row.getByRole("link", { name: agent.name, exact: true });
    await name.waitFor();
    const destination = await name.getAttribute("href");

    // Non-link cells, nested text and padding all follow the same route as the name.
    // Returning after each click also detects an accidental second navigation entry.
    for (const target of [
      row.locator('[data-label="Execution mode"]'),
      row.locator(".resource-id"),
      row.locator('[data-label="Created"]'),
    ]) {
      await target.click({ position: { x: 8, y: 8 } });
      await page.waitForURL((url) => `${url.pathname}${url.search}` === destination);
      await page.getByRole("heading", { name: agent.name, exact: true }).waitFor();
      await page.goBack();
      await name.waitFor();
      assert.equal(new URL(page.url()).pathname, "/console/agents");
    }
  });
}

test("Agents list row actions stop and delete an Agent through the real API", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Row actions", { ready: true });
  const running = await fixture.createAgent(namespace.id, "Running Agent", nativeValues("run"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, running.id);
  const draft = await fixture.createAgent(namespace.id, "Draft Agent", nativeValues("draft"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, listUrl(namespace.id));
  const runningRow = page.getByRole("row").filter({ hasText: "Running Agent" });
  const draftRow = page.getByRole("row").filter({ hasText: "Draft Agent" });
  const stop = runningRow.getByRole("button", { name: "Stop Running Agent" });
  const remove = runningRow.getByRole("button", { name: "Delete Running Agent" });
  await stop.waitFor();
  // A new Agent is created with a stopped requested state and no version, so like Agent detail
  // its row offers no Stop until a first deploy; Delete stays available.
  await draftRow.getByRole("button", { name: "Delete Draft Agent" }).waitFor();
  assert.equal(await draftRow.getByRole("button", { name: "Stop Draft Agent" }).count(), 0);
  await waitForEnabled(stop);
  // Only a stop with a selected version is labelled; a never-deployed draft reads "No current version".
  assert.equal(await draftRow.getByText("Stop requested", { exact: true }).count(), 0);
  assert.equal(await runningRow.getByText("Stop requested", { exact: true }).count(), 0);
  requests.length = 0;

  // Cancelling the confirmation sends nothing and returns focus to the row's icon.
  await stop.click();
  let dialog = page.getByRole("dialog", { name: "Stop Running Agent?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/)
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await stop.evaluate((node) => node.ownerDocument.activeElement === node), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // In a narrow window above the phone layout (where rows stack), the table scrolls sideways to
  // reach Actions. Accepting a row action redraws the table, which must keep that position
  // instead of jumping back to the names.
  await page.setViewportSize({ width: 800, height: 844 });
  const scrolledLeft = await page.evaluate(() => {
    const scroller = globalThis.document.querySelector(".table-scroll");
    scroller.scrollLeft = scroller.scrollWidth;
    return scroller.scrollLeft;
  });
  assert.ok(scrolledLeft > 0, "the narrow table should scroll horizontally");
  await stop.click();
  dialog = page.getByRole("dialog", { name: "Stop Running Agent?" });
  const stopResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${running.id}/stop`,
  );
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  assert.equal((await stopResponse).status(), 202);
  await page.getByRole("status").getByText("Stop requested for Running Agent.").waitFor();
  await runningRow.getByText("Stop requested", { exact: true }).waitFor();
  assert.equal(await stop.isDisabled(), true);
  // With Stop now disabled, focus falls back to the Agent's name, which sits off-screen to the
  // left; moving focus there must not scroll the table either.
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Running Agent",
  );
  assert.equal(
    await page.evaluate(() => globalThis.document.querySelector(".table-scroll").scrollLeft),
    scrolledLeft,
  );
  // The list stays in place: stopping from a row does not open the Agent.
  assert.equal(new URL(page.url()).pathname, "/console/agents");
  assert.equal(agentStopRequests(requests, namespace.id, running.id).length, 1);
  // Stop records only the requested state; the selected version is kept for the worker.
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${running.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(stopped.data.activeRevisionId, active.revision.id);

  // Deletion names the kept Configuration and model Secret, then queues cleanup.
  await remove.click();
  dialog = page.getByRole("dialog", { name: "Delete Running Agent?" });
  await dialog
    .getByText("The Configuration and model credential Secret stay in this Namespace.")
    .waitFor();
  const cli = `occ --namespace ${namespace.id}`;
  const configuration = dialog.getByText(`${cli} configuration delete ${running.configurationId}`);
  assert.equal(await configuration.isVisible(), false);
  await dialog.getByText("View separate cleanup commands").click();
  await configuration.waitFor();
  await dialog.getByText(`${cli} secret delete ${running.harnessAuth.source.id}`).waitFor();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${running.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  assert.equal((await deleteResponse).status(), 202);
  await page.getByRole("status").getByText("Deletion requested for Running Agent.").waitFor();
  await runningRow.getByText("Deleting", { exact: true }).waitFor();
  assert.equal(await remove.isDisabled(), true);
  assert.equal(await stop.isDisabled(), true);
  assert.equal(agentDeleteRequests(requests, namespace.id, running.id).length, 1);
  const deleting = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${running.id}`);
  assert.equal(deleting.data.status, "deleting");

  // Each row acts on its own Agent: the other one stays active and deletable.
  const untouched = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${draft.id}`);
  assert.equal(untouched.data.status, "active");
  assert.equal(
    await draftRow.getByRole("button", { name: "Delete Draft Agent" }).isDisabled(),
    false,
  );
});

for (const action of ["Stop", "Delete"]) {
  test(`Agents list cannot confirm ${action} from a response naming a different Agent`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, `Uncertain ${action}`);
    const target = await fixture.createAgent(
      namespace.id,
      "Selected Agent",
      nativeValues("target"),
    );
    await fixture.seedActiveAgentRevision(namespace.id, target.id);
    const other = await fixture.createAgent(namespace.id, "Other Agent", nativeValues("other"));
    const { page } = await newPage(t, fixture);
    await login(page, fixture, listUrl(namespace.id));
    const requests = apiRequests(page, fixture.origin);

    const stopping = action === "Stop";
    const agentPath = `/namespaces/${namespace.id}/agents/${target.id}`;
    const path = agentPath + (stopping ? "/stop" : "");
    const method = stopping ? "POST" : "DELETE";
    await page.route(
      `${fixture.origin}${path}`,
      async (route) => {
        // Let the real controller accept this write. Change only which Agent the reply identifies.
        const response = await route.fetch();
        assert.equal(response.status(), 202);
        const json = await response.json();
        assert.equal(json.data.id, target.id);
        assert.equal(
          stopping ? json.data.desiredRuntimeState : json.data.status,
          stopping ? "stopped" : "deleting",
        );
        json.data = { ...json.data, id: other.id, name: other.name };
        await route.fulfill({ response, json });
      },
      { times: 1 },
    );

    const targetRow = page.getByRole("row").filter({ hasText: target.name });
    const invoke = targetRow.getByRole("button", { name: `${action} ${target.name}` });
    await invoke.click();
    const dialog = page.getByRole("dialog", { name: `${action} ${target.name}?` });
    await dialog
      .getByRole("button", { name: stopping ? "Stop Agent" : "Permanently delete Agent" })
      .click();
    await dialog.waitFor({ state: "hidden" });

    const badge = stopping ? "Stop requested" : "Deleting";
    const otherRow = page.getByRole("row").filter({ hasText: other.name });
    assert.equal(
      await otherRow.getByText(badge, { exact: true }).count(),
      0,
      `the response for ${other.name} must not change that row`,
    );
    assert.equal(await invoke.isDisabled(), true);
    await page
      .getByRole("alert")
      .getByText(
        `Outcome unknown. ${stopping ? "Stop" : "Deletion"} may have been accepted for ${target.name}. Select Refresh before trying again.`,
        { exact: true },
      )
      .waitFor();

    // Refresh recovers the actual outcome with a read, never another Stop or Delete.
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await targetRow.getByText(badge, { exact: true }).waitFor();
    assert.equal(await otherRow.getByText(badge, { exact: true }).count(), 0);
    assert.deepEqual(
      nonAuthWriteRequests(requests).map((r) => [r.method, r.path]),
      [[method, path]],
    );
  });
}

// A row's Stop and Delete have no form: a schema refusal does not ask to check entered values, a
// typed 409 shows the API's sentence, and a conflict the API does not explain keeps the list's own
// sentence (findings 2538, 2561).
test("Agents list row Stop and Delete show the API's 400 and 409 reasons", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Row refusals", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Refused Row", nativeValues("row"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  let answer;
  await page.route(`${fixture.origin}${agentPath}/stop`, (route) => route.fulfill(answer));
  await page.route(`${fixture.origin}${agentPath}`, (route) =>
    route.request().method() === "DELETE" ? route.fulfill(answer) : route.fallback(),
  );
  await login(page, fixture, listUrl(namespace.id));
  const row = page.getByRole("row").filter({ hasText: "Refused Row" });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  for (const [kind, status, serverMessage, reason] of [
    ["stop", 400, "The request does not match the operation contract.", MALFORMED_REQUEST],
    [
      "stop",
      409,
      "The Agent lifecycle changed during stop.",
      "The Agent lifecycle changed during stop. Select Refresh before trying again.",
    ],
    [
      "delete",
      409,
      RESOURCE_CONFLICT,
      "Refused Row changed while the request was sent. Select Refresh before trying again.",
    ],
    ["delete", 400, "The request does not match the operation contract.", MALFORMED_REQUEST],
  ]) {
    answer = apiErrorResponse(
      status,
      status === 400 ? "INVALID_REQUEST" : "RESOURCE_CONFLICT",
      serverMessage,
    );
    const stopping = kind === "stop";
    await waitForEnabled(
      row.getByRole("button", { name: `${stopping ? "Stop" : "Delete"} Refused Row`, exact: true }),
    );
    await row
      .getByRole("button", { name: `${stopping ? "Stop" : "Delete"} Refused Row`, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: `${stopping ? "Stop" : "Delete"} Refused Row?` })
      .getByRole("button", {
        name: stopping ? "Stop Agent" : "Permanently delete Agent",
        exact: true,
      })
      .click();
    await page
      .getByText(`Could not ${kind} Refused Row. ${reason}`, { exact: false })
      .first()
      .waitFor();
    assert.equal(await page.getByText(/entered values/).count(), 0);
    if (status === 409) {
      await refresh.click();
    }
  }
});

test("Agents list row actions explain missing access and still report a refused or uncertain write", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["row-reader"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Row denial", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Guarded Agent", nativeValues("guard"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const person = fixture.provisionedAccounts[0];
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const bind = async (permissions, resourceKind, resourceId) => {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201);
    const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: person.principal.id,
        roleId: role.data.id,
        resourceKind,
        resourceId,
      },
    });
    assert.equal(binding.status, 201);
    return binding.data;
  };
  // A reader who can list and open the Agent but holds neither operate nor delete on it.
  await bind([{ action: "read", resourceKind: "namespace" }], "namespace", namespace.id);
  await bind([{ action: "read", resourceKind: "agent" }], "agent", agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  const stopEnabled = () =>
    page.waitForFunction(
      () =>
        globalThis.document.querySelector('[aria-label="Stop Guarded Agent"]')?.disabled === false,
    );

  // Hold the first permission read so the reader can open Stop before the real answer arrives.
  const advice = await holdRequests(t, page, `${fixture.origin}${agentPath}/permissions`, {
    once: true,
  });

  await login(page, fixture, listUrl(namespace.id), person.credentials);
  const row = page.getByRole("row").filter({ hasText: "Guarded Agent" });
  const stop = row.getByRole("button", { name: "Stop Guarded Agent" });
  const remove = row.getByRole("button", { name: "Delete Guarded Agent" });

  // A refusal that arrives while the dialog is open disables confirmation and moves focus to
  // Cancel. The redraw replaced the icon that opened the dialog, so closing it must land focus
  // on the row (its name, since Stop is now disabled) rather than dropping it to the page.
  await stop.click();
  const dialog = page.getByRole("dialog", { name: "Stop Guarded Agent?" });
  await dialog.waitFor();
  advice.release();
  await dialog.getByText(AGENT_STOP_DENIED).waitFor();
  const confirm = dialog.getByRole("button", { name: "Stop Agent" });
  assert.equal(await confirm.isDisabled(), true);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  assert.equal(await cancel.evaluate((node) => node.ownerDocument.activeElement === node), true);
  await cancel.click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Guarded Agent",
  );

  // The Agent's real permission read reports neither action, so both icons are disabled with a
  // visible reason before any confirmation, and nothing is sent. The row's one line names the
  // grants; the whole reason, with who gives them, is its tooltip and the icons' description.
  const bothDenied = AGENT_STOP_AND_DELETE_DENIED;
  await row.getByText(bothDenied, { exact: true }).waitFor();
  const note = row.locator(".row-action-note");
  const line = note.locator("[aria-hidden=true]");
  assert.equal(await line.textContent(), "Needs operate and delete");
  // The reserved line fits the grant: it is not cut short with an ellipsis.
  assert.equal(
    await note.evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
    "the row's note line fits",
  );
  assert.equal(await note.getAttribute("title"), bothDenied);
  assert.equal(
    await stop.evaluate(
      (node) =>
        globalThis.document.getElementById(node.getAttribute("aria-describedby").split(" ")[0])
          ?.title,
    ),
    bothDenied,
  );
  assert.equal(await stop.isDisabled(), true);
  assert.equal(await remove.isDisabled(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // An operate grant shows after Refresh: Stop becomes available while Delete stays explained.
  const operate = await bind([{ action: "operate", resourceKind: "agent" }], "agent", agent.id);
  await refresh.click();
  await row.getByText(AGENT_DELETE_DENIED, { exact: true }).waitFor();
  await stopEnabled();
  assert.equal(await remove.isDisabled(), true);

  // The read is advice, not authorization: once the grant is removed, the controller refuses the
  // confirmed write and the row reports that refusal without changing the Agent.
  const removed = await fixture.request("DELETE", `${policyPath}/access-bindings/${operate.id}`);
  assert.ok([200, 204].includes(removed.status), `binding removal answered ${removed.status}`);
  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop Guarded Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page.getByRole("alert").getByText(stopRefused("Guarded Agent")).waitFor();
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  assert.equal((await fixture.request("GET", agentPath)).data.desiredRuntimeState, "running");

  // A dropped connection leaves the outcome unknown, so the row refuses another write until
  // Refresh rereads the Agent; the console never resends the stop by itself.
  await bind([{ action: "operate", resourceKind: "agent" }], "agent", agent.id);
  await refresh.click();
  await stopEnabled();
  await page.route(`${fixture.origin}${agentPath}/stop`, (route) => route.abort("failed"), {
    times: 1,
  });
  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop Guarded Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page
    .getByRole("alert")
    .getByText(
      "Outcome unknown. Stop may have been accepted for Guarded Agent. Select Refresh before trying again.",
    )
    .waitFor();
  assert.equal(await stop.isDisabled(), true);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 2);
  await refresh.click();
  await page.getByRole("alert").waitFor({ state: "detached" });
  await stopEnabled();
  assert.equal((await fixture.request("GET", agentPath)).data.desiredRuntimeState, "running");

  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop Guarded Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await row.getByText("Stop requested", { exact: true }).waitFor();
  assert.equal((await fixture.request("GET", agentPath)).data.desiredRuntimeState, "stopped");
});

test("Agents list permission advice updates its own row without moving focus elsewhere", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["row-browser"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Row focus", { ready: true });
  const guarded = await fixture.createAgent(namespace.id, "Guarded Agent", nativeValues("guard"));
  await fixture.seedActiveAgentRevision(namespace.id, guarded.id);
  const other = await fixture.createAgent(namespace.id, "Other Agent", nativeValues("other"));
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  const person = fixture.provisionedAccounts[0];
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const bind = async (permissions, resourceKind, resourceId) => {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201);
    const binding = await fixture.request("POST", `${policyPath}/access-bindings`, {
      body: {
        subjectKind: "identity",
        subjectId: person.principal.id,
        roleId: role.data.id,
        resourceKind,
        resourceId,
      },
    });
    assert.equal(binding.status, 201);
  };
  // A reader of both Agents with neither operate nor delete, so each permission read refuses.
  await bind([{ action: "read", resourceKind: "namespace" }], "namespace", namespace.id);
  await bind([{ action: "read", resourceKind: "agent" }], "agent", guarded.id);
  await bind([{ action: "read", resourceKind: "agent" }], "agent", other.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // Hold only Guarded Agent's permission read; its real answer is released on cue.
  const holdGuardedAdvice = async () =>
    (
      await holdRequests(
        t,
        page,
        `${fixture.origin}/namespaces/${namespace.id}/agents/${guarded.id}/permissions`,
        { once: true },
      )
    ).release;
  const focusedText = () => page.evaluate(() => globalThis.document.activeElement?.textContent);
  const guardedRow = page.getByRole("row").filter({ hasText: "Guarded Agent" });
  const otherRow = page.getByRole("row").filter({ hasText: "Other Agent" });

  // Someone browsing by keyboard sits on Other Agent's link when Guarded Agent's refusal
  // arrives. Guarded Agent's icons must update, and focus must stay where it was.
  let release = await holdGuardedAdvice();
  await login(page, fixture, listUrl(namespace.id), person.credentials);
  await otherRow.getByText(AGENT_STOP_AND_DELETE_DENIED, { exact: true }).waitFor();
  const otherLink = otherRow.getByRole("link", { name: "Other Agent" });
  await otherLink.focus();
  release();
  await guardedRow.getByText(AGENT_STOP_AND_DELETE_DENIED, { exact: true }).waitFor();
  assert.equal(
    await guardedRow.getByRole("button", { name: "Stop Guarded Agent" }).isDisabled(),
    true,
  );
  assert.equal(await otherLink.evaluate((node) => node.ownerDocument.activeElement === node), true);

  // When the focused icon is the one the refusal disables, focus stays in that row.
  release = await holdGuardedAdvice();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const guardedStop = guardedRow.getByRole("button", { name: "Stop Guarded Agent" });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[aria-label="Stop Guarded Agent"]')?.disabled === false,
  );
  await guardedStop.focus();
  release();
  await guardedRow.getByText(AGENT_STOP_AND_DELETE_DENIED, { exact: true }).waitFor();
  await page.waitForFunction(
    () => globalThis.document.activeElement?.textContent === "Guarded Agent",
  );
  assert.equal(await focusedText(), "Guarded Agent");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DELETION_POLL_MS } from "../../apps/controller/src/console/agents/deletion.mjs";
import { FIRST_ACTIVITY_WAIT_MS } from "../../apps/controller/src/console/agents/detail.mts";
import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import { deploymentFailureStep } from "../../apps/controller/src/console/agents/deployment-recovery.mts";
import { fileConsoleApp } from "../helpers/console-app.mjs";
import {
  createProviderSandboxDriver,
  createRuntimeLogComputeDriver,
} from "../helpers/runtime-logs.mjs";
import {
  apiRequests,
  asksBeforeUnload,
  consoleViewports,
  deploymentStatusResponse,
  detailUrl,
  fileBrowser,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nextFrames,
  persistedDeploymentError,
  recordLayoutShifts,
  routeFailedDeployment,
  settledFetches,
  settledView,
  takeLayoutShifts,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import {
  deploymentActivity,
  deploymentDetailsOpen,
  deploymentRecordUrl,
  expectDeploymentOutcome,
  expectVersionRecord,
  openDeploymentActivity,
} from "./console-deployment-activity-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import { fileReadyNamespace } from "./console-ready-namespace.mjs";

// The Agent page's first screen while its reads settle and its polls run: loading cues, quiet
// polls, a steady layout, and failed-version recovery scoped to the caller.

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();
// One app for the tests that pass no fixture options; each makes its own Namespace.
const overviewApp = fileConsoleApp();
const readyNamespace = fileReadyNamespace(overviewApp);

async function agentPage(t, namespaceName, agentName, fixtureOptions) {
  const { fixture, namespace } = await readyNamespace(t, namespaceName, fixtureOptions);
  const agent = await fixture.createAgent(namespace.id, agentName, nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  return { fixture, namespace, agent, page };
}

// A runtime log Compute Driver with the Agent runtime log API enabled.
function runtimeLogs() {
  return {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  };
}

// The API's message for the model probe failure the recovery tests below record.
const PROBE_FAILED_MESSAGE = persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED").message;

function routeFailedRecord(
  page,
  fixture,
  namespace,
  agent,
  revision,
  code = "RUNTIME_MODEL_PROBE_FAILED",
) {
  return routeFailedDeployment(page, fixture, {
    namespaceId: namespace.id,
    agentId: agent.id,
    deploymentId: revision.id,
    code,
  });
}

// The Agent summary showed "vN · Loading…" for a frame or more on every load while the newest
// version's deployment record was read (finding 1438). Its loading text now follows the 250 ms
// rule: it is hidden for the first 250 ms, so a read that settles sooner never shows it.
test("the Agent summary's loading text follows the 250 ms rule", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Quiet summary", "Quiet Summary");
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const record = await holdRequests(
    t,
    page,
    deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id),
    {
      fulfill: deploymentStatusResponse(revision, { status: "succeeded" }),
    },
  );
  await page.clock.install();
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  const value = summary.locator(":scope > div:nth-child(2) > strong");
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('[aria-label="Agent state at a glance"] > div:nth-child(2) > strong')
      ?.textContent.startsWith("v1 · "),
  );
  // The held read keeps the page hidden until the overview's bounded wait runs out; run it out
  // rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  // The version shows at once; only the loading word waits, hidden by a 250 ms animation.
  const delayed = (node) =>
    [...node.querySelectorAll("*")].map((child) => {
      const style = child.ownerDocument.defaultView.getComputedStyle(child);
      return {
        text: child.textContent,
        animation: `${style.animationName} ${style.animationDuration}`,
      };
    });
  assert.equal(await value.textContent(), "v1 · Loading…");
  assert.deepEqual(await value.evaluate(delayed), [
    { text: "Loading…", animation: "loading-delay 0.25s" },
  ]);
  const note = summary.locator(":scope > div:nth-child(2) > p");
  assert.deepEqual(await note.evaluate(delayed), [
    { text: "Reading recorded deployment status.", animation: "loading-delay 0.25s" },
  ]);

  record.release();
  await summary.getByText("v1 · Completed", { exact: true }).waitFor();
});

// While an Agent was deleting, every 3 s poll flipped "Refresh deletion status" to a disabled
// "Checking…", which dropped its focus, and rebuilt the role=status notice, which screen
// readers announced again (finding 1409). A poll now leaves both alone unless they change.
test("deletion status polls leave Refresh and the deletion notice untouched", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Quiet deletion",
    "Quiet Deletion",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const agentUrl = `${fixture.origin}${agentPath}`;
  await trackSettledFetches(page);
  await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Quiet Deletion" }).first().waitFor();
  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Quiet Deletion?" });
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  // Polls run only when the test advances the clock. Pause 1 s ahead of the page's own time,
  // short of the first poll: a fixed time fails once sign-in and delete outlast it.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
  // The confirmation removes itself on its close event, a task after the request settles.
  await page.locator(".deletion-note dialog").waitFor({ state: "detached" });
  const refresh = page.getByRole("button", { name: "Refresh deletion status" });
  await refresh.focus();
  await page.evaluate(() => {
    globalThis.deletionChanges = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        globalThis.deletionChanges.push(
          record.type === "attributes"
            ? `${record.target.textContent}: ${record.attributeName}`
            : `${record.type}: ${record.target.textContent.slice(0, 40)}`,
        );
      }
    }).observe(globalThis.document.querySelector(".deletion-note"), {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });

  for (let poll = 0; poll < 2; poll += 1) {
    const settled = await settledFetches(page, agentPath);
    const read = page.waitForResponse(
      (response) => response.url() === agentUrl && response.request().method() === "GET",
    );
    await page.clock.runFor(DELETION_POLL_MS);
    assert.equal((await read).status(), 200);
    // The poll's read has settled and the page has handled it.
    await waitForSettledFetches(page, agentPath, settled + 1);
  }
  assert.deepEqual(await page.evaluate(() => globalThis.deletionChanges), []);
  assert.equal(await refresh.evaluate((node) => node.matches(":focus")), true);

  // Refresh pressed while a quiet poll reads turns that poll into a shown check, and focus
  // comes back to Refresh when it ends.
  for (const during of ["poll", "idle"]) {
    const read = await holdRequests(t, page, agentUrl, { once: true });
    if (during === "poll") {
      await page.clock.runFor(DELETION_POLL_MS);
      await read.requested;
      assert.equal(await refresh.isEnabled(), true);
    }
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Checking…" }).waitFor();
    read.release();
    await refresh.waitFor();
    await page.waitForFunction(() => globalThis.document.activeElement?.tagName === "BUTTON");
    assert.equal(await refresh.evaluate((node) => node.matches(":focus")), true, during);
  }
});

// Share Agent hid its form until the sharing policy loaded, so the form popped in and pushed
// the grants list down on every Agent page load (finding 1410). It now shows, disabled, while
// the policy loads, under a placeholder line that the loaded result replaces.
test("the Share Agent form shows disabled while the sharing policy loads", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Steady sharing",
    "Steady Sharing",
  );
  const roles = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/roles`,
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  await roles.requested;
  const sharing = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = sharing.getByLabel("Existing person’s Principal ID");
  await principal.waitFor();
  const share = sharing.getByRole("button", { name: "Share Agent" });
  assert.equal(await principal.isDisabled(), true);
  assert.equal(await share.isDisabled(), true);
  const grants = sharing.getByRole("heading", { name: "Direct Agent grants" });
  const before = await grants.boundingBox();

  roles.release();
  await sharing.getByText("Current policy loaded.", { exact: false }).waitFor();
  await waitForEnabled(principal);
  // The read's placeholder held the line its result takes, so nothing below moved.
  const after = await grants.boundingBox();
  assert.ok(Math.abs(after.y - before.y) < 1, `the grants moved ${after.y - before.y}px`);
});

function denyRevisionRead(fixture, namespace, revision) {
  fixture.policy.restrictions.push({
    id: `deny-read-${revision.id}`,
    namespaceId: namespace.id,
    resourceKind: "agent_revision",
    resourceId: revision.id,
    action: "read",
    effect: "deny",
  });
}

// The overview's "Deployment needs attention" recovery speaks for the version that is current
// for this caller, and offers only the links that caller may use (finding 1458).
test("A failed older version raises no recovery while the current version is hidden", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Hidden current",
    "Hidden current",
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v2 is current and serving, but this reader cannot read it; v1, the newest it can read,
  // failed earlier.
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  denyRevisionRead(fixture, namespace, second.revision);
  await routeFailedRecord(page, fixture, namespace, agent, first.revision);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Hidden current" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v1 · Failed", { exact: true }).waitFor();
  await summary.getByText("Selected for service · you cannot read this version").waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(
      /The current version, rev_.*, is one you cannot read, so this page cannot tell whether the failed v1 deployment affects it\. Ask an Agent administrator for read access/,
    )
    .waitFor();
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByText("v1 deployment failed").count(), 0);
  assert.equal(await summary.getByText("May be offline").count(), 0);
});

// The Versions list reads only the latest version's deployment record. A failed version lost
// its mark once a newer version was deployed, so after a recovery every earlier failure looked
// like an ordinary version (finding 2383). A failed record is final, so the mark stays. After a
// reload only the latest record is read again, so the earlier failed version read "Historical"
// with no mark beside its own record's "Failed" (finding 2407); opening it reads that record.
test("The Versions list keeps an earlier failed version's mark after a newer deploy", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Failed then", "Failed then");
  const first = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, first);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const rail = page.getByRole("toolbar", { name: "Versions" });
  await rail.getByRole("button", { name: "View version v1, deployment failed" }).waitFor();
  // A second deploy makes v2 the latest version, whose record is the one the list reads.
  await fixture.deployAgent(namespace.id, agent.id);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await rail.getByRole("button", { name: /^View version v2/ }).waitFor();
  await rail.getByRole("button", { name: "View version v1, deployment failed" }).waitFor();
  assert.equal(
    await rail
      .getByRole("button", { name: "View version v1, deployment failed" })
      .locator(".version-outcome")
      .textContent(),
    "Failed",
  );

  await page.reload();
  await rail.getByRole("button", { name: /^View version v2/ }).waitFor();
  // Hold v1's record until v1's page and its notice show. The record that lands then must
  // relabel the notice at once: no later poll rerenders it (finding 2407).
  const record = await holdRequests(
    t,
    page,
    deploymentRecordUrl(fixture, namespace.id, agent.id, first.id),
    {
      once: true,
      fulfill: deploymentStatusResponse(first, {
        status: "failed",
        error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
      }),
    },
  );
  await rail.getByRole("button", { name: /^View version v1/ }).click();
  await record.requested;
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await page.locator(".version-selection-notice").waitFor();
  record.release();
  await page.getByText("Recorded outcome: Failed", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".version-selection-notice").textContent(),
    "Failed version · read-only admitted snapshot. Its deployment did not complete.",
  );
  await rail.getByRole("button", { name: "View version v1, deployment failed" }).waitFor();
});

// A first deployment that failed leaves the Agent requested to run with no version selected
// (finding 2385). Stop would change nothing, so the danger zone disables it and says why,
// instead of offering to stop "the running version".
test("Stop is disabled with its reason when a failed first deployment left nothing running", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Failed first", "Failed first");
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, failed);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v1 · Failed", { exact: true }).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion
    .getByText(
      "No version is running, so there is nothing to stop. Deploy a new version to start this Agent.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).isDisabled(),
    true,
  );
});

// Only a failed first deployment leaves nothing to stop. While a first deployment is still queued
// no version is current either, but Stop ends that deployment, so it stays enabled.
test("Stop stays enabled while a first deployment is queued", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Queued first", "Queued first");
  const queued = await fixture.deployAgent(namespace.id, agent.id);
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, queued.id), (route) =>
    route.fulfill(deploymentStatusResponse(queued, { status: "queued" })),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v1 · Queued", { exact: true }).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await waitForEnabled(stopRegion.getByRole("button", { name: "Stop Agent", exact: true }));
  assert.equal(await stopRegion.getByText(/nothing to stop/).count(), 0);
});

// The failed first version's own page (finding 2403) said "Not verified" for Live serving while
// nothing ran, called the only version "Historical" and offered diagnostics for a runtime that
// never started. "Create new version" also showed twice: in the header and in the Versions list.
test("A failed first version's page says nothing runs and offers one Create new version", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Failed only", "Failed only");
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, failed);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, failed.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("v1 · Failed", { exact: true }).waitFor();
  const liveServing = summary.locator(".stat").filter({ hasText: "Live serving" });
  await liveServing.getByText("Not running", { exact: true }).waitFor();
  await page
    .getByText("Failed version · read-only admitted snapshot. Its deployment did not complete.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByText(/^Historical version/).count(), 0);
  // The version's record stays; there is no runtime for diagnostics to check.
  await page.getByRole("heading", { name: "This version’s deployment record" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Run diagnostics for this version" }).count(),
    0,
  );
  // The header holds the action; the Versions list names the draft as one of its entries.
  assert.equal(
    await page.getByRole("button", { name: "Create new version", exact: true }).count(),
    1,
  );
  await page
    .getByRole("button", { name: "View new version, editable Configuration", exact: true })
    .click();
  await page.getByRole("heading", { name: "Configuration draft" }).waitFor();
  await liveServing.getByText("Not running", { exact: true }).waitFor();
});

// Nothing restarts a lost Sandbox (finding 2152): after a node restart the current version's
// Sandbox can stay stopped while the Agent still reads active and its gateway refuses requests.
// Live serving says so with the next step. Its note line is reserved from the first paint, so a
// Sandbox read that lands after the page shows moves nothing. A healthy Sandbox carries no
// warning, and a Sandbox the Driver cannot read is unknown, never lost.
test("Live serving shows a lost Sandbox and its next step without moving the page", async (t) => {
  const { driver: sandboxDriver, state } = createProviderSandboxDriver();
  const { fixture, namespace } = await readyNamespace(t, "Lost Sandbox", {
    computeDriver: createRuntimeLogComputeDriver({ sandboxNamespace: "tenant-console" }),
    sandboxDriver,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Lost Sandbox",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const liveServing = (page) =>
    page
      .getByRole("region", { name: "Agent state at a glance" })
      .locator(".stat")
      .filter({ hasText: "Live serving" });
  async function openOverview(viewport, { statusFailure = false } = {}) {
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    const harnessReads = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/harness-status")) {
        harnessReads.push(request.url());
      }
    });
    // The fixture has no worker; the deployment that made v1 current succeeded.
    await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
      route.fulfill(deploymentStatusResponse(revision, { status: "succeeded" })),
    );
    await trackSettledFetches(page);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Lost Sandbox" }).waitFor();
    await waitForIdleFetches(page);
    // The Agents list reads no Sandbox: a list costs no Sandbox Driver call per Agent. A read it
    // started later would still count against the one read per page checked below.
    assert.deepEqual(harnessReads, []);
    // The Sandbox read lands after the page shows, as on a gateway that takes a moment: it is
    // held until the page shows Live serving's note waiting for it.
    const sandboxRead = await holdRequests(
      t,
      page,
      `${fixture.origin}/namespaces/**/harness-status`,
      {
        fulfill: statusFailure
          ? {
              status: 503,
              json: { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." } },
            }
          : null,
      },
    );
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
    await liveServing(page).locator(".stat-help", { hasText: "Checking Sandbox…" }).waitFor();
    await sandboxRead.requested;
    await nextFrames(page);
    sandboxRead.release();
    // The answer renders before any click below, which would excuse a shift it causes.
    await waitForSettledFetches(page, new URL(harnessReads[0]).pathname, 1);
    await nextFrames(page);
    await expectDeploymentOutcome(page, "Completed");
    return { page, harnessReads };
  }

  // The node-restart case: OpenShell keeps the Sandbox record, stopped. Beside the sidebar
  // (900 wide) the Live serving column is narrowest; its note still fits the reserved line.
  state.harness = { state: "lost", code: "SANDBOX_STOPPED" };
  for (const viewport of [...consoleViewports, { width: 900, height: 900 }]) {
    const { page, harnessReads } = await openOverview(viewport);
    const badge = liveServing(page).locator(".badge");
    await liveServing(page).getByText("Deploy a new version.", { exact: true }).waitFor();
    assert.equal(await badge.textContent(), "Sandbox lost");
    assert.equal(await badge.getAttribute("data-tone"), "danger");
    await page.evaluate(() => globalThis.document.fonts.ready);
    await waitForIdleFetches(page);
    await nextFrames(page);
    const { shift, shifts } = await takeLayoutShifts(page);
    t.diagnostic(`${viewport.width}x${viewport.height} shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `${viewport.width}x${viewport.height} shift ${shift}`);
    // Only the Live serving fact itself may change; nothing below it moves.
    const moved = shifts
      .flatMap((entry) => entry.sources)
      .filter((source) => !/stat-value|stat-help/.test(source.node));
    assert.deepEqual(moved, [], `${viewport.width}x${viewport.height}`);
    // One read for the page's serving state, not a poll.
    assert.equal(harnessReads.length, 1);
  }

  // A healthy Sandbox, one the Driver cannot read and a status read that fails leave Live
  // serving unverified, with no warning.
  for (const [harness, harnessError, statusFailure, note] of [
    [{ state: "running" }, undefined, false, "Sandbox running."],
    [
      undefined,
      new Error("gateway refused sandbox:read token-secret"),
      false,
      "Sandbox status unknown.",
    ],
    [{ state: "lost", code: "SANDBOX_STOPPED" }, undefined, true, "Sandbox status unknown."],
  ]) {
    state.harness = harness;
    state.harnessError = harnessError;
    const { page } = await openOverview(consoleViewports[0], { statusFailure });
    await liveServing(page).getByText(note, { exact: true }).waitFor();
    const badge = liveServing(page).locator(".badge");
    assert.equal(await badge.textContent(), "Not verified");
    assert.equal(await badge.getAttribute("data-tone"), null);
    assert.equal(await page.getByText("Sandbox lost").count(), 0);
    assert.equal(await page.getByText("token-secret", { exact: false }).count(), 0);
  }

  // A Sandbox Driver that keeps no lifecycle record answers unobserved. With no record to show,
  // the note says why serving is not verified (finding 2367).
  {
    const { observeHarness } = sandboxDriver;
    delete sandboxDriver.observeHarness;
    try {
      const { page } = await openOverview(consoleViewports[0]);
      await liveServing(page).getByText("OCC sends no test request.", { exact: true }).waitFor();
      assert.equal(await liveServing(page).locator(".badge").textContent(), "Not verified");
    } finally {
      sandboxDriver.observeHarness = observeHarness;
    }
  }

  // Stopping the Agent drops the answer for the old serving state: a stopped Agent's Sandbox
  // is removed by design, so Live serving no longer reports it lost, and nothing is read.
  {
    state.harness = { state: "lost", code: "SANDBOX_STOPPED" };
    state.harnessError = undefined;
    const { page, harnessReads } = await openOverview(consoleViewports[0]);
    await liveServing(page).getByText("Sandbox lost", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop Agent" }).click();
    await page
      .getByRole("dialog", { name: "Stop this Agent?" })
      .getByRole("button", { name: "Stop Agent" })
      .click();
    const summary = page.getByRole("region", { name: "Agent state at a glance" });
    await summary.getByText("Stop requested", { exact: true }).waitFor();
    await waitForIdleFetches(page);
    assert.equal(await liveServing(page).locator(".badge").textContent(), "Not verified");
    assert.equal(await liveServing(page).locator(".stat-help").textContent(), "");
    assert.equal(harnessReads.length, 1);
  }
});

// Recovery leads with the newest failed version; another failed version's record keeps its own
// error, which nothing above repeats (finding 2368).
test("An older failed version's record keeps its own error under a newer failure's recovery", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Two failures", runtimeLogs());
  const agent = await fixture.createAgent(namespace.id, "Two Failures", nativeValues("v1"));
  // Never deployed: v1 and then v2 failed.
  const first = await fixture.deployAgent(namespace.id, agent.id);
  const second = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const firstError = await routeFailedRecord(
    page,
    fixture,
    namespace,
    agent,
    first,
    "CONVERGENCE_DEADLINE_EXCEEDED",
  );
  await routeFailedRecord(page, fixture, namespace, agent, second);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, first.id, "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.getByRole("heading", { name: "v2 deployment failed", exact: true }).waitFor();
  const record = await expectVersionRecord(page, "Failed");
  await record.getByText(`${firstError.code}: ${firstError.message}`, { exact: true }).waitFor();
  assert.equal(
    await record.getByText("The error and its next step are at the top of this page.").count(),
    0,
  );
});

// Operator-managed harness credentials have no Credentials tab step the reader can take, so a
// rejected credential's recovery offers no Open Credentials link, even with Agent update.
test("Recovery offers no Credentials link for operator-managed harness credentials", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime credentials");
  const agent = await fixture.createAgent(
    namespace.id,
    "Runtime Credentials",
    nativeValues("runtime-credentials"),
    { harnessAuth: { method: "runtime" } },
  );
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await routeFailedRecord(page, fixture, namespace, agent, failed, "RUNTIME_AUTHENTICATION_FAILED");
  await trackSettledFetches(page);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText("v1 did not deploy successfully (RUNTIME_AUTHENTICATION_FAILED).", {
      exact: false,
    })
    .waitFor();
  await recovery.getByRole("link", { name: "Open v1 Logs" }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(await recovery.getByRole("link", { name: "Open Credentials" }).count(), 0);
});

// One readable version per history page: the first page lists the newest readable version.
// `olderRead`, when given, is told of each older-page request and answers when it resolves.
function routeOneVersionPerPage(page, fixture, namespace, agent, olderRead) {
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  return page.route(
    (url) => url.origin === fixture.origin && url.pathname === revisionsPath,
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "older-page") {
        await olderRead?.();
      }
      const response = await route.fetch({ url: `${fixture.origin}${revisionsPath}` });
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          data: cursor === "older-page" ? body.data.slice(1) : body.data.slice(0, 1),
          meta: { ...body.meta, nextCursor: cursor === "older-page" ? null : "older-page" },
        },
      });
    },
  );
}

test("A failed version raises no recovery while the current version is on no loaded page", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Paged history", "Paged history");
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  // v3 is current and serving, but this reader cannot read it; v2, the newest it can read,
  // failed earlier, and v1 is on the next history page (finding 1477).
  const third = await fixture.seedActiveAgentRevision(namespace.id, agent.id, second.revision.id);
  denyRevisionRead(fixture, namespace, third.revision);
  await routeFailedRecord(page, fixture, namespace, agent, second.revision);
  // The older page is held until the test releases it.
  let olderRequests = 0;
  let olderRequested;
  const requested = new Promise((resolve) => {
    olderRequested = resolve;
  });
  let releaseOlder;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  await routeOneVersionPerPage(page, fixture, namespace, agent, () => {
    olderRequests += 1;
    olderRequested();
    return olderGate;
  });
  await trackSettledFetches(page);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Paged history" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v2 · Failed", { exact: true }).waitFor();
  const statusLine = page.locator(".agent-status-line");
  await statusLine
    .getByText(
      /^The current version, rev_.*, is not among the versions listed, so this page cannot tell whether the failed v2 deployment affects it\. Show older versions to check\.$/,
    )
    .waitFor();
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Open Configuration" }).count(), 0);

  // Show older versions follows the Versions list rather than sitting in it: the arrows stay on
  // versions and Tab reaches it next. Focus stays on it while it loads, then moves to the first
  // older version, scrolled into view (finding 2115). A short list makes v1 overflow it.
  await page.evaluate(() => {
    const sheet = [...globalThis.document.styleSheets].find((item) => item.href);
    sheet.insertRule(".version-list { max-height: 100px; }", sheet.cssRules.length);
  });
  const rail = page.getByRole("toolbar", { name: "Versions" });
  assert.equal(await rail.getByRole("button", { name: "Show older versions" }).count(), 0);
  await rail.getByRole("button", { name: /^View version v2/ }).focus();
  await page.keyboard.press("Tab");
  const focusedName = () =>
    page.evaluate(() => {
      const active = globalThis.document.activeElement;
      return active.getAttribute("aria-label") ?? active.textContent;
    });
  assert.equal(await focusedName(), "Show older versions");
  // While the older page loads, focus stays on the busy button, and pressing it again sends
  // nothing more.
  await page.keyboard.press("Enter");
  await requested;
  const loading = page.getByRole("button", { name: "Loading older versions…" });
  await loading.waitFor();
  assert.equal(await focusedName(), "Loading older versions…");
  assert.equal(await loading.getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Enter");
  // With every page loaded, the current version is known to be hidden.
  releaseOlder();
  await rail.getByRole("button", { name: /^View version v1/ }).waitFor();
  await waitForIdleFetches(page);
  assert.equal(olderRequests, 1);
  assert.equal(await focusedName(), "View version v1");
  assert.deepEqual(
    await rail.evaluate((list) => {
      const box = list.getBoundingClientRect();
      const item = globalThis.document.activeElement.getBoundingClientRect();
      return {
        overflows: list.scrollHeight > list.clientHeight,
        visible: item.top >= box.top && item.bottom <= box.bottom,
      };
    }),
    { overflows: true, visible: true },
  );
  assert.equal(await page.getByRole("button", { name: "Show older versions" }).count(), 0);
  await statusLine
    .getByText(
      /The current version, rev_.*, is one you cannot read, so this page cannot tell whether the failed v2 deployment affects it\. Ask an Agent administrator for read access/,
    )
    .waitFor();
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByText("v2 deployment failed").count(), 0);
});

// A viewed version on no loaded page shows on its own below the list. When Show older versions
// loads the page that holds it, focus goes to the first newly listed version, not the viewed
// one that was already shown (finding 2115).
test("Show older versions hands focus to the first version it lists", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Paged viewed", "Paged viewed");
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  await fixture.seedActiveAgentRevision(namespace.id, agent.id, second.revision.id);
  await routeOneVersionPerPage(page, fixture, namespace, agent);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration"),
  );
  const rail = page.getByRole("toolbar", { name: "Versions" });
  await rail.getByRole("button", { name: "View version v1" }).waitFor();
  assert.equal(await rail.getByRole("button", { name: /^View version v2/ }).count(), 0);
  // A short list, so the newly listed version must be scrolled into view.
  await page.evaluate(() => {
    const sheet = [...globalThis.document.styleSheets].find((item) => item.href);
    sheet.insertRule(".version-list { max-height: 100px; }", sheet.cssRules.length);
  });
  await rail.getByRole("button", { name: "View version v1" }).focus();
  await page.keyboard.press("Tab");
  await page.getByRole("button", { name: "Show older versions" }).waitFor();
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement.textContent),
    "Show older versions",
  );
  await page.keyboard.press("Enter");
  await rail.getByRole("button", { name: /^View version v2/ }).waitFor();
  assert.deepEqual(
    await rail.evaluate((list) => {
      const active = globalThis.document.activeElement;
      const box = list.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      return {
        focused: active.getAttribute("aria-label"),
        overflows: list.scrollHeight > list.clientHeight,
        visible: item.top >= box.top && item.bottom <= box.bottom,
      };
    }),
    { focused: "View version v2", overflows: true, visible: true },
  );
});

// A succeeded deployment becomes current, so a different current version on no loaded page may
// be a newer one this reader cannot read; the summary still read "v2 · Completed" with no hint
// (finding 1485, a sibling of 1477).
test("A succeeded version says when the current version is on no loaded page", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Paged success", "Paged success");
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  // v3 is current, but this reader cannot read it; v2, the newest it can read, succeeded
  // earlier, and v1 is on the next history page.
  const third = await fixture.seedActiveAgentRevision(namespace.id, agent.id, second.revision.id);
  denyRevisionRead(fixture, namespace, third.revision);
  await page.route(
    deploymentRecordUrl(fixture, namespace.id, agent.id, second.revision.id),
    (route) => route.fulfill(deploymentStatusResponse(second.revision, { status: "succeeded" })),
  );
  await routeOneVersionPerPage(page, fixture, namespace, agent);

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Paged success" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v2 · Completed", { exact: true }).waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(
      /^The current version, rev_.*, is not among the versions listed, so this page cannot tell whether it is newer than v2\. Show older versions to check\.$/,
    )
    .waitFor();

  // With every page loaded, the current version is known to be hidden and newer.
  await page.getByRole("button", { name: "Show older versions" }).click();
  await page.getByRole("button", { name: /^View version v1/ }).waitFor();
  await summary.getByText("Newer version hidden", { exact: true }).waitFor();
});

test("Recovery offers no draft link without Agent update or deploy permission", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Read-only recovery",
    "Read-only Agent",
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  // Agent permissions do not describe this reader's Configuration permissions.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { update: false, deploy: false, operate: false, delete: false },
          meta: { requestId: "req_test_recovery_permissions" },
        }),
      }),
  );

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.getByText("v2 deployment failed").waitFor();
  // The header relabels once the permission answer arrives; the recovery follows it.
  await page.getByRole("button", { name: "Open version draft" }).first().waitFor();
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  assert.equal(await logs.getAttribute("class"), "button button--primary");
  assert.equal(await recovery.getByRole("link", { name: "Open Configuration" }).count(), 0);
  assert.equal(await recovery.getByRole("link").count(), 1);
});

test("Recovery stops offering a failed version's Logs once this page saw log text denied", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Denied logs",
    "Denied logs",
    runtimeLogs(),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  // Log text has its own grant (read_logs); this reader's log read is denied.
  await page.route(new RegExp(`/deployments/${revision.id}/runtime/logs(\\?|$)`), (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Access denied." },
        meta: { requestId: "req_test_recovery_logs" },
      }),
    }),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText(
      `v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED). ${PROBE_FAILED_MESSAGE}`,
      { exact: true },
    )
    .waitFor();
  await recovery.getByRole("link", { name: "Open v2 Logs" }).click();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();

  // The denial updates the recovery at once: it says who can check the logs instead of
  // steering the reader into another denied read.
  const askForLogs = recovery.getByText(
    `v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED). ${PROBE_FAILED_MESSAGE} Ask someone with log access to check the failed version’s logs.`,
    { exact: true },
  );
  await askForLogs.waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  // Leaving Logs for another tab of the same version keeps that.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await askForLogs.waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  const configuration = recovery.getByRole("link", { name: "Open Configuration" });
  assert.equal(await configuration.getAttribute("class"), "button button--primary");

  // A later visit in this page session starts without the Logs link too.
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Denied logs" }).click();
  await recovery.getByText("Ask someone with log access", { exact: false }).waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  await recovery.getByRole("link", { name: "Open Configuration" }).waitFor();
});

// When a failed newer version replaced the running one, the replacement sentence overrode the
// "ask someone with log access" line, so a reader without log access got no action and no hint
// (finding 1484).
test("A replaced current version still says who can check the logs once Logs is denied", async (t) => {
  const logs = runtimeLogs();
  const { fixture, namespace } = await readyNamespace(t, "Replaced denied", logs);
  const model = await fixture.createSecret(namespace.id, "Replaced model key", "hidden-model");
  // Dedicated deploys stop the previous version's workload before the new one starts.
  const agent = await fixture.createAgent(
    namespace.id,
    "Replaced denied",
    nativeValues("v1", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: { method: "api_key", source: model.ref } },
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  await page.route(new RegExp(`/deployments/${revision.id}/runtime/logs(\\?|$)`), (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Access denied." },
        meta: { requestId: "req_test_recovery_logs" },
      }),
    }),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.getByRole("heading", { name: "This Agent may be offline" }).waitFor();
  // Over a line about serving, the label names the failed version.
  assert.equal(await recovery.locator(".status-label").textContent(), "Deployment failed · v2");
  assert.equal(await recovery.locator(".status-label").isVisible(), true);
  await recovery.getByRole("link", { name: "Open v2 Logs" }).click();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();
  await recovery
    .getByText(
      `v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED). v1 is still selected, but its runtime was probably stopped for this deployment. ${PROBE_FAILED_MESSAGE} Ask someone with log access to check the failed version’s logs.`,
      { exact: true },
    )
    .waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
});

test("Recovery waits for the caller's permission answer before offering the draft link", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Pending permissions",
    "Pending permissions",
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  const permissions = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    {
      fulfill: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { update: true, deploy: true, operate: true, delete: true },
          meta: { requestId: "req_test_recovery_pending" },
        }),
      },
    },
  );

  await page.clock.install();
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.locator(".agent-current-summary");
  const failed = summary.getByText("v2 · Failed", { exact: true });
  await failed.waitFor({ state: "attached" });
  await permissions.requested;
  // The pending answer keeps the page hidden until the overview's bounded wait runs out; run it
  // out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  await failed.waitFor();
  // While the answer is pending, the recovery is held rather than offering a draft link
  // the caller may not be allowed to use (finding 1478).
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByRole("link", { name: "Open Configuration" }).count(), 0);

  permissions.release();
  await recovery
    .getByText("v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).", { exact: false })
    .waitFor();
  assert.equal(
    await recovery.getByRole("link", { name: "Open v2 Logs" }).getAttribute("class"),
    "button button--primary",
  );
  await recovery.getByRole("link", { name: "Open Configuration" }).waitFor();
});

test("Recovery offers no draft link when the caller's permission answer fails", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Failed permissions",
    "Failed permissions",
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Try again later." },
          meta: { requestId: "req_test_recovery_permissions_failed" },
        }),
      }),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery.getByText("v2 deployment failed").waitFor();
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  assert.equal(await logs.getAttribute("class"), "button button--primary");
  assert.equal(await recovery.getByRole("link", { name: "Open Configuration" }).count(), 0);
  assert.equal(await recovery.getByRole("link").count(), 1);
});

// The banner gave every code the same "check the failed version's logs" advice; each code's own
// next step sat in Deployment details, below the fold at phone width (finding 1898). It now
// leads with the API's message and that step's link, in view at desktop and phone width.
for (const c of [
  {
    code: "RUNTIME_AUTHENTICATION_FAILED",
    step: "update or replace the Agent's model credential",
    action: "Open Credentials",
    primary: "Open v1 Logs",
  },
  {
    code: "DEPENDENCY_UNAVAILABLE",
    step: "Deploy again; if it keeps failing, ask an admin to check the controller worker log.",
    action: "Deploy again",
    primary: "Deploy again",
  },
  {
    code: "CONVERGENCE_DEADLINE_EXCEEDED",
    step: "Check its logs and runtime diagnostics",
    action: "Open v1 Logs",
    primary: "Open v1 Logs",
  },
]) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`A failed deployment's banner shows the ${c.code} next step in view at ${size}`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, `Next step ${c.code}`, runtimeLogs());
      const agent = await fixture.createAgent(namespace.id, "Next Step Agent", nativeValues("v1"));
      // Never deployed: v1 failed.
      const failed = await fixture.deployAgent(namespace.id, agent.id);
      const { page } = await newPage(t, fixture, { browser, context: { viewport } });
      await routeFailedRecord(page, fixture, namespace, agent, failed, c.code);

      await login(
        page,
        fixture,
        new URL(`/console/agents/${agent.id}?namespace=${namespace.id}`, fixture.origin),
      );
      const recovery = page.getByRole("region", { name: "Deployment needs attention" });
      const { message } = persistedDeploymentError(c.code);
      assert.ok(message.includes(c.step), `${c.code}: ${message}`);
      const text = recovery.getByText(`v1 did not deploy successfully (${c.code}). ${message}`, {
        exact: true,
      });
      await text.waitFor();
      const action = recovery.getByRole("link", { name: c.action, exact: true });
      await action.waitFor();
      await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
      assert.equal(await page.evaluate(() => globalThis.scrollY), 0);
      // The step and its link are on the first screen.
      const inView = (node) =>
        node.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, innerHeight: globalThis.innerHeight };
        });
      const textBox = await inView(text);
      const actionBox = await inView(action);
      t.diagnostic(
        `${c.code} ${size}: text ${JSON.stringify(textBox)} action ${JSON.stringify(actionBox)}`,
      );
      assert.ok(textBox.top < textBox.innerHeight, `the message starts below the fold`);
      assert.ok(actionBox.top < actionBox.innerHeight, `${c.action} starts below the fold`);
      assert.ok(actionBox.bottom <= actionBox.innerHeight, `${c.action} ends below the fold`);
      assert.equal(
        await recovery.getByText("before deploying a new version", { exact: false }).count(),
        0,
      );
      // A danger status block (spec 3.4): the title names the failed version (with nothing else
      // selected, no label above it repeats that, finding 2368), the code ends the message's
      // first sentence, and the page's one primary is Deploy again where the message says to
      // deploy again, else the failed version's Logs; the other actions are secondary.
      assert.equal(await recovery.getAttribute("data-tone"), "danger");
      await recovery.getByRole("heading", { name: "v1 deployment failed", exact: true }).waitFor();
      assert.equal(await recovery.locator(".status-label").isVisible(), false);
      assert.equal(await recovery.locator(".status-body code").textContent(), c.code);
      const actions = await recovery.locator(".status-actions a").evaluateAll((links) =>
        links.map((link) => {
          const box = link.getBoundingClientRect();
          const row = link.parentElement.getBoundingClientRect();
          return {
            name: link.textContent,
            className: link.className,
            fullWidth: Math.abs(box.width - row.width) < 1,
          };
        }),
      );
      assert.deepEqual(
        actions.map((link) => [link.name, link.className]),
        actions.map((link) => [
          link.name,
          link.name === c.primary ? "button button--primary" : "button",
        ]),
      );
      assert.ok(
        actions.some((link) => link.name === c.primary),
        `${c.primary} offered`,
      );
      // The page's only accent-filled control is that primary: the draft's own Deploy new version
      // steps down while the block offers an action.
      assert.deepEqual(
        await page.evaluate(() => {
          const probe = globalThis.document.createElement("div");
          probe.style.backgroundColor = "var(--color-accent)";
          globalThis.document.body.append(probe);
          const accent = globalThis.getComputedStyle(probe).backgroundColor;
          probe.remove();
          return [...globalThis.document.querySelectorAll("a, button")]
            .filter(
              (node) =>
                node.checkVisibility() &&
                globalThis.getComputedStyle(node).backgroundColor === accent,
            )
            .map((node) => node.textContent);
        }),
        [c.primary],
      );
      // At phone width the actions stack, each the block's full width.
      assert.deepEqual(
        actions.map((link) => link.fullWidth),
        actions.map(() => viewport.width < 520),
        JSON.stringify(actions),
      );
      // Only a message that says to deploy again offers it, as the step's own link.
      assert.equal(
        await recovery.getByRole("link", { name: "Deploy again" }).count(),
        c.action === "Deploy again" ? 1 : 0,
      );
      if (c.action === "Deploy again") {
        assert.equal(await action.getAttribute("class"), "button button--primary");
        // It opens the draft with its Deploy new version in view.
        await action.click();
        // The link scrolls smoothly; wait for it to settle with Deploy new version focused.
        await page.waitForFunction(() => {
          const active = globalThis.document.activeElement;
          const box = active?.getBoundingClientRect();
          return (
            active?.textContent === "Deploy new version" &&
            box.top >= 0 &&
            box.bottom <= globalThis.innerHeight
          );
        });
        const deploy = page.getByRole("button", { name: "Deploy new version" });
        const deployBox = await inView(deploy);
        assert.ok(
          deployBox.top >= 0 && deployBox.bottom <= deployBox.innerHeight,
          `Deploy new version in view: ${JSON.stringify(deployBox)}`,
        );
      }
    });
  }
}

// The banner reads each failure's next step from the API's own message, so the two stay in step:
// a rewording that drops "Deploy again", or a step, fails here rather than silently changing the
// banner (finding 1898).
test("Every failed deployment message maps to its banner step", () => {
  const deployAgain = [
    "ACTOR_REVOKED",
    "COMPUTE_DRIVER_MISMATCH",
    "DEPENDENCY_UNAVAILABLE",
    "HARNESS_DESCRIPTOR_MISMATCH",
    "LEASE_EXPIRED",
    "NAMESPACE_NOT_READY",
    "REPOSITORY_BINDING_CHANGED",
    "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED",
    "REPOSITORY_DRIVER_MISMATCH",
  ];
  // These name no step: the banner adds the generic logs advice.
  const none = [
    "AGENT_GATEWAY_UNAVAILABLE",
    "KUBERNETES_API_UNAVAILABLE",
    "SANDBOX_ADMISSION_LIMIT_REACHED",
    "SANDBOX_GATEWAY_UNAVAILABLE",
    "SANDBOX_HARNESS_UNSUPPORTED",
    "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
    // The API's catch-all message.
    "UNLISTED_FAILURE_CODE",
  ];
  const named = [
    "AGENT_GATEWAY_UNAUTHORIZED",
    "AUTHORIZATION_DENIED",
    "BACKEND_UNAVAILABLE",
    "CONVERGENCE_DEADLINE_EXCEEDED",
    "CREDENTIAL_GATEWAY_MISMATCH",
    "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT",
    "CREDENTIAL_SOURCE_UNAVAILABLE",
    "CREDENTIAL_WITHDRAWN",
    "HARNESS_AUTH_REQUIRED",
    "HARNESS_AUTH_SOURCE_CHANGED",
    "HARNESS_AUTH_SOURCE_UNAVAILABLE",
    "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
    "HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT",
    "REPOSITORY_BINDING_UNAVAILABLE",
    "REPOSITORY_RUNTIME_UNSUPPORTED",
    "RUNTIME_AUTHENTICATION_FAILED",
    "RUNTIME_CPU_STARVED",
    "RUNTIME_LOGIN_FAILED",
    "RUNTIME_MODEL_PROBE_FAILED",
    "RUNTIME_MODEL_PROBE_TIMEOUT",
    "RUNTIME_STARTUP_FAILED",
    "SANDBOX_GATEWAY_UNAUTHORIZED",
    "SECRET_BINDING_UNAVAILABLE",
    "SECRET_DRIVER_MISMATCH",
    "SERVICE_ACCOUNT_BACKEND_MISMATCH",
    "WORKSPACE_SETUP_REFUSED",
    "WORKSPACE_SETUP_UNSUPPORTED",
  ];
  for (const [expected, codes] of [
    ["deploy-again", deployAgain],
    [null, none],
    ["named", named],
  ]) {
    for (const code of codes) {
      const { message } = persistedDeploymentError(code);
      assert.equal(deploymentFailureStep(message), expected, `${code}: ${message}`);
    }
  }
  assert.equal(deploymentFailureStep(""), null);
  assert.equal(deploymentFailureStep(undefined), null);
});

// A message that names no step keeps the generic advice after it.
test("A failed deployment's banner keeps the logs advice when the message names no step", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "No step", "No Step Agent");
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision, "AGENT_GATEWAY_UNAVAILABLE");

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText(
      `v1 did not deploy successfully (AGENT_GATEWAY_UNAVAILABLE). ${persistedDeploymentError("AGENT_GATEWAY_UNAVAILABLE").message} Check the failed version’s logs before deploying a new version.`,
      { exact: true },
    )
    .waitFor();
  await recovery.getByRole("link", { name: "Open v1 Logs" }).waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
});

// A draft whose Configuration this caller cannot read builds no Deploy new version, so Deploy
// again would lead nowhere and push the usable Logs link down.
test("A failed deployment's banner offers no Deploy again once the Configuration read is denied", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Deploy again unreadable",
    "Unreadable Configuration Agent",
  );
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision, "DEPENDENCY_UNAVAILABLE");
  const configurationPath = `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  await page.route(configurationPath, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "FORBIDDEN", message: "Access denied." },
            meta: { requestId: "req_test_recovery_configuration_denied" },
          }),
        })
      : route.fallback(),
  );
  const denied = page.waitForResponse(
    (response) => response.url() === configurationPath && response.status() === 403,
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await denied;
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText(persistedDeploymentError("DEPENDENCY_UNAVAILABLE").message, { exact: false })
    .waitFor();
  const logs = recovery.getByRole("link", { name: "Open v1 Logs" });
  await logs.waitFor();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(".deployment-recovery-actions .button--primary")
        ?.textContent === "Open v1 Logs",
  );
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).count(), 0);
});

// From the current version's page, Deploy again opens the draft at its deploy step too.
test("A failed deployment's Deploy again opens the draft's deploy step from another version", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Deploy again elsewhere");
  const agent = await fixture.createAgent(namespace.id, "Elsewhere Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 } },
  });
  await routeFailedRecord(page, fixture, namespace, agent, revision, "DEPENDENCY_UNAVAILABLE");

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const again = page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByRole("link", { name: "Deploy again" });
  await again.waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  await again.click();
  await page.waitForURL((next) => next.searchParams.get("revision") === "draft");
  await page.waitForFunction(() => {
    const active = globalThis.document.activeElement;
    const box = active?.getBoundingClientRect();
    return (
      active?.textContent === "Deploy new version" &&
      box.top >= 0 &&
      box.bottom <= globalThis.innerHeight
    );
  });
});

// Deploy again leads to the draft's deploy, so a caller who cannot deploy is not offered it.
test("A failed deployment's banner offers Deploy again only with deploy permission", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Deploy again denied",
    "No Deploy Agent",
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision, "DEPENDENCY_UNAVAILABLE");
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { update: true, deploy: false, operate: true, delete: true },
          meta: { requestId: "req_test_recovery_no_deploy" },
        }),
      }),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText(persistedDeploymentError("DEPENDENCY_UNAVAILABLE").message, { exact: false })
    .waitFor();
  const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
  await logs.waitFor();
  assert.equal(await logs.getAttribute("class"), "button button--primary");
  assert.equal(await recovery.getByRole("link", { name: "Deploy again" }).count(), 0);
});

function line(second, raw) {
  return { time: `2026-09-30T12:00:${String(second).padStart(2, "0")}.000000001Z`, raw };
}

// Opening the Logs tab by URL scrolled to the log view before the runtime status strip above
// it had filled. The strip's Pod cards then pushed the output down, out of a phone screen:
// CLS 0.11-0.17 at desktop and 0.555 at 390x844 (finding 1413). At phone width the menu
// button's margin also collapsed through body and moved the whole page on every load.
test("opening the Logs tab by URL does not move the page", async (t) => {
  const logs = runtimeLogs();
  const { fixture, namespace } = await readyNamespace(t, "Steady logs", logs);
  const agent = await fixture.createAgent(namespace.id, "Steady Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  logs.computeDriver.state.lines = Array.from({ length: 30 }, (_, index) =>
    line(index, `startup line ${index}`),
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    // The runtime status read settles after the page has scrolled to the Logs tab, as on a
    // live cluster where it takes about a second.
    await page.route(
      `${deploymentRecordUrl(fixture, namespace.id, agent.id, active.revision.id)}/runtime`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.continue().catch(() => {});
      },
    );
    await trackSettledFetches(page);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Steady Logs Agent" }).waitFor();
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs").href);
    await page.getByText("startup line 29", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    // The slow status read and every other read have landed and painted.
    await waitForIdleFetches(page);
    await nextFrames(page);
    const { shift, shifts } = await takeLayoutShifts(page);
    t.diagnostic(`${viewport.width}x${viewport.height} shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `${viewport.width}x${viewport.height} shift ${shift}`);
    // The output held back for the first reads still opens at its newest line.
    assert.ok(
      await page
        .getByRole("log", { name: "Runtime log output" })
        .evaluate((pane) => pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 24),
    );
  }
});

// Clicking the Logs tab left an empty Logs area with Stop and Delete right under it, then the
// strip and output pushed them down 0.6-1.7 s later: CLS up to 0.444 (finding 1479). The tab
// now keeps its height and hides those cards until the view shows.
test("opening the Logs tab by click does not move the cards below it", async (t) => {
  const logs = runtimeLogs();
  const { fixture, namespace } = await readyNamespace(t, "Steady logs tab", logs);
  const agent = await fixture.createAgent(namespace.id, "Steady Logs Tab", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  logs.computeDriver.state.lines = Array.from({ length: 30 }, (_, index) =>
    line(index, `startup line ${index}`),
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    // The status read settles well after the click's 500 ms input window, as on a live cluster.
    await page.route(
      `${deploymentRecordUrl(fixture, namespace.id, agent.id, active.revision.id)}/runtime`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.continue().catch(() => {});
      },
    );
    await trackSettledFetches(page);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    );
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await page.getByRole("button", { name: "Stop Agent" }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    // A reader scrolls the tabs into view, then selects Logs once the page is still.
    const logsTab = page.getByRole("tab", { name: "Logs", exact: true });
    await logsTab.evaluate((tab) => tab.scrollIntoView({ block: "center" }));
    await waitForIdleFetches(page);
    await nextFrames(page);
    await page.evaluate(recordLayoutShifts);
    await logsTab.click();
    await page.getByText("startup line 29", { exact: false }).waitFor();
    // The slow status read and every other read have landed and painted.
    await waitForIdleFetches(page);
    await nextFrames(page);
    // The Logs view and the cards below it; headless Chromium also reports a body shift at
    // phone width after any tab click, on main as well, that a reader does not see.
    const { shifts } = await takeLayoutShifts(page);
    const shift = shifts
      .filter((entry) =>
        entry.sources.some((source) =>
          /danger-zone|stop-note|deletion-note|agent-logs|log-/.test(source.node),
        ),
      )
      .reduce((sum, entry) => sum + entry.value, 0);
    t.diagnostic(`${viewport.width}x${viewport.height} shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `${viewport.width}x${viewport.height} shift ${shift}`);
    assert.equal(await page.locator(".agent-logs-opening").count(), 0);
  }
});

// On a slow link the overview showed once its bounded wait ran out, and the failed version's
// banner landed above it about a second later, pushing Selected version and Share Agent down:
// CLS 0.149 at 400 ms per request (finding 1489). The overview now waits for the latest
// deployment's outcome, and for a failure the caller's permission answer, within a longer bound.
test("a failed version's banner does not move the overview on a slow link", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Slow banner");
  const agent = await fixture.createAgent(namespace.id, "Slow Banner", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  // Every Namespace read takes 600 ms, so the latest deployment's outcome lands about 1.2 s
  // after the page renders, as on the live slow link where the shift was measured. The second
  // pass also answers the caller's permission read after that outcome.
  for (const permissionsDelay of [600, 1400]) {
    const { page } = await newPage(t, fixture, { browser });
    await routeFailedRecord(page, fixture, namespace, agent, revision);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Slow Banner" }).waitFor();
    await page.route(`${fixture.origin}/namespaces/**`, async (route) => {
      const delay = route.request().url().endsWith("/permissions") ? permissionsDelay : 600;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fallback().catch(() => {});
    });
    await page.addInitScript(recordLayoutShifts);
    await trackSettledFetches(page);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    await recovery
      .getByText("v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).", {
        exact: false,
      })
      .waitFor();
    await page
      .locator(".agent-current-summary")
      .getByText("v2 · Failed", { exact: true })
      .waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    // Every slow read has landed and painted.
    await waitForIdleFetches(page);
    await nextFrames(page);
    const { shift, shifts } = await takeLayoutShifts(page);
    t.diagnostic(`permissions ${permissionsDelay} ms: shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `permissions ${permissionsDelay} ms: shift ${shift}`);
    // A failure known before the page shows leads it, above the overview (finding 1655 moves
    // only a card that lands later), and a later render of the shown card, as a tab change
    // makes, leaves it there.
    const leadsOverview = () =>
      recovery.evaluate((card) =>
        Boolean(
          card.compareDocumentPosition(card.ownerDocument.querySelector(".agent-overview-status")) &
          globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      );
    assert.equal(await leadsOverview(), true);
    const plugins = page.locator(".agent-tabs").getByRole("tab", { name: "Plugins", exact: true });
    await plugins.click();
    await page.locator('.agent-tabs [aria-selected="true"]', { hasText: "Plugins" }).waitFor();
    assert.equal(await leadsOverview(), true, "a tab change keeps the card above the overview");
  }
});

// When Deployment activity's first read outlasts FIRST_ACTIVITY_WAIT_MS the page shows without
// it, and the record landing later moved the version tabs: down 227 px for a running deploy, up
// 65 px for a completed one (finding 2163). The stand-in is now the folded panel's one row, and a
// late first record fills it without opening it, since the summary above shows the outcome. The
// summary's note and the viewed version's record keep their rows, so nothing above the tabs moves
// at desktop or phone width. Only a failure's card, which leads the page (finding 2094), and the
// viewed version's own failure or read error, which its record states in full, may move them.
test("a late first deployment read moves nothing above the version tabs", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Late activity");
  const agent = await fixture.createAgent(namespace.id, "Late Activity", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: consoleViewports[0] },
  });
  // Each load's first read of the record waits for the case's answer.
  let answer = null;
  let requested = null;
  await page.route(
    deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id),
    async (route) => {
      requested?.();
      // A poll from the page a later goto replaced is answered into nothing.
      await route.fulfill(await answer).catch(() => {});
    },
  );
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.clock.install();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  const activity = deploymentActivity(page);
  const record = page.locator(".version-deployment-record");
  // Positions in the page at each width: the version tabs, the overview (the facts and
  // Deployment activity) and the viewed version's record.
  const measure = async () => {
    const sizes = [];
    for (const viewport of consoleViewports) {
      await page.setViewportSize(viewport);
      await nextFrames(page);
      sizes.push(
        await page.evaluate(() => {
          const box = (selector) => {
            const node = globalThis.document.querySelector(selector);
            const rect = node?.getBoundingClientRect();
            return node ? { top: rect.top + globalThis.scrollY, height: rect.height } : null;
          };
          return {
            tabs: box(".agent-tabs").top,
            overview: box(".agent-overview-status"),
            record: box(".version-deployment-record")?.height ?? 0,
            diagnostics: box(".version-diagnostics")?.height ?? 0,
          };
        }),
      );
    }
    await page.setViewportSize(consoleViewports[0]);
    return sizes;
  };
  // Control: a pending record read before the page shows opens its details as before, and the
  // summary's note, empty by then, gives its line back.
  answer = Promise.resolve(deploymentStatusResponse(revision, { status: "running" }));
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
  await page.locator(".agent-detail-pending").waitFor({ state: "detached" });
  await expectDeploymentOutcome(page, "In progress", { folded: false });
  assert.equal(
    await summary
      .locator(":scope > div:nth-child(2) > p")
      .evaluate((node) => node.checkVisibility()),
    false,
  );

  const unavailable = {
    status: 503,
    json: { error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable." } },
  };
  for (const c of [
    { status: "succeeded", label: "Completed", stillOn: ["draft", "version"] },
    { status: "running", label: "In progress", stillOn: ["draft", "version"] },
    { status: "failed", label: "Failed", stillOn: [] },
    { status: "read error", label: "Unavailable", stillOn: ["draft"] },
  ]) {
    for (const view of ["draft", "version"]) {
      const name = `${c.status} on the ${view}`;
      let respond;
      answer = new Promise((resolve) => {
        respond = resolve;
      });
      const read = new Promise((resolve) => {
        requested = resolve;
      });
      const selected = view === "draft" ? "draft" : revision.id;
      await page.goto(detailUrl(fixture, namespace.id, agent.id, selected, "configuration").href);
      await read;
      // The held read keeps the page hidden until the overview's bounded wait runs out; run it
      // out rather than wait for it.
      await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
      await page.locator(".agent-detail-pending").waitFor({ state: "detached" });
      await page.locator(settledView).waitFor();
      await page.evaluate(() => globalThis.document.fonts.ready);
      // The stand-in is one panel without controls: no empty panel, Refreshing… or "has not
      // loaded" comes first.
      assert.equal(await activity.count(), 1);
      await activity.getByText("Loading the most recent visible deployment…").waitFor();
      assert.equal(await activity.getByRole("button").count(), 0);
      const before = await measure();

      respond(
        c.status === "read error"
          ? unavailable
          : deploymentStatusResponse(revision, {
              status: c.status,
              error:
                c.status === "failed"
                  ? persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED")
                  : null,
            }),
      );
      await summary.getByText(`v1 · ${c.label}`, { exact: true }).waitFor();
      await activity.getByRole("button", { name: "Refresh deployment" }).waitFor();
      if (c.status === "read error") {
        // Folded, so hidden.
        await activity.getByRole("alert", { includeHidden: true }).waitFor({ state: "attached" });
      } else {
        await expectDeploymentOutcome(page, c.label, { folded: true });
      }
      if (c.status === "failed") {
        await page.getByRole("region", { name: "Deployment needs attention" }).waitFor();
      }
      if (view !== "draft") {
        await (c.status === "read error"
          ? record.getByRole("alert").waitFor()
          : expectVersionRecord(page, c.label));
      }
      await waitForIdleFetches(page);
      assert.equal(await deploymentDetailsOpen(page), false, `${name}: the details stay folded`);
      assert.equal(await activity.count(), 1);
      const after = await measure();
      t.diagnostic(`${name}: ${JSON.stringify({ before, after })}`);
      for (const [index, { width }] of consoleViewports.entries()) {
        const [was, is] = [before[index], after[index]];
        // The overview keeps its height; the tabs move only as far as a card above it pushes it
        // and the viewed version's record grows.
        const near = (actual, expected, what) =>
          assert.ok(Math.abs(actual - expected) < 1, `${name} at ${width}: ${what}`);
        near(is.overview.height, was.overview.height, "the overview keeps its height");
        const expected = is.overview.top - was.overview.top + (is.record - was.record);
        // A failed version that is not current offers no diagnostics (finding 2403): the panel
        // leaves once the record says so, and the tabs can rise by up to its height and the gap
        // above it (the Versions rail beside it may keep part of that space).
        const diagnosticsLeft = was.diagnostics - is.diagnostics;
        if (diagnosticsLeft > 0) {
          const moved = is.tabs - was.tabs;
          assert.ok(
            moved <= expected + 1 && moved >= expected - diagnosticsLeft - 32,
            `${name} at ${width}: only the card, the record and the diagnostics move the tabs`,
          );
        } else {
          near(is.tabs - was.tabs, expected, "only the card and the record move the tabs");
        }
        if (c.stillOn.includes(view)) {
          near(is.tabs, was.tabs, "the tabs stay");
        }
      }
    }
  }
});

// The version's detail is in view: its top edge at (or, where the page cannot scroll that far,
// below) the window's top, inside the upper half of the window.
function versionDetailInView() {
  const top = globalThis.document
    .querySelector(".agent-version-detail")
    .getBoundingClientRect().top;
  return globalThis.scrollY > 0 && top >= -1 && top < globalThis.innerHeight / 2;
}

const focusedTab = (page) =>
  page.evaluate(() => {
    const active = globalThis.document.activeElement;
    return active?.closest(".agent-tabs") && active.getAttribute("aria-selected") === "true"
      ? active.textContent
      : null;
  });

// A failed deployment's "Open Configuration" (or "Open version draft") changed only the URL: the
// window stayed at the top, under the banner, while the draft sat 1110-3168 px below the fold, so
// the link looked dead (finding 1586). Every way the link opens its tab now brings it into view and
// focuses it: the draft already open below, another tab of the draft, and another version.
for (const c of [
  { name: "the open draft", entry: "draft", tab: "configuration", label: "Open Configuration" },
  { name: "another draft tab", entry: "draft", tab: "plugins", label: "Open Configuration" },
  { name: "another version", entry: "active", tab: "configuration", label: "Open Configuration" },
  {
    name: "another version without update",
    entry: "active",
    tab: "configuration",
    label: "Open version draft",
    update: false,
  },
]) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`A failed deployment's ${c.label} link brings ${c.name} into view at ${size}`, async (t) => {
      const { fixture, namespace } = await readyNamespace(t, `Recovery ${c.name} ${size}`);
      const agent = await fixture.createAgent(namespace.id, "Recovery Agent", nativeValues("v1"));
      // Never deployed: v1 failed its startup model check. "another version" first deploys v1.
      const active =
        c.entry === "active" ? await fixture.seedActiveAgentRevision(namespace.id, agent.id) : null;
      const failed = await fixture.deployAgent(namespace.id, agent.id);
      const { page } = await newPage(t, fixture, { browser, context: { viewport } });
      await routeFailedRecord(page, fixture, namespace, agent, failed);
      if (c.update === false) {
        await page.route(
          `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
          (route) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                data: { update: false, deploy: true, operate: true, delete: true },
                meta: { requestId: "req_test_recovery_view" },
              }),
            }),
        );
      }
      const url =
        c.entry === "active"
          ? detailUrl(fixture, namespace.id, agent.id, active.revision.id, c.tab)
          : c.tab === "configuration"
            ? // The Agent's own address: a never-deployed Agent opens its draft.
              new URL(`/console/agents/${agent.id}?namespace=${namespace.id}`, fixture.origin)
            : detailUrl(fixture, namespace.id, agent.id, "draft", c.tab);
      await login(page, fixture, url);
      const recovery = page.getByRole("region", { name: "Deployment needs attention" });
      const open = recovery.getByRole("link", { name: c.label });
      await open.waitFor();
      await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
      assert.equal(await page.evaluate(() => globalThis.scrollY), 0);
      // The detail starts low in the first screen or below it: with the Deployment details folded
      // under the card (finding 2094), it can start above the fold at 1440.
      const start = await page.evaluate(
        () =>
          globalThis.document.querySelector(".agent-version-detail").getBoundingClientRect().top /
          globalThis.innerHeight,
      );
      assert.ok(start >= 0.5, `the version's detail starts ${start} windows down`);

      await open.click();
      // The draft already open below keeps its address.
      if (c.entry !== "draft" || c.tab !== "configuration") {
        await page.waitForURL(
          (next) =>
            next.searchParams.get("revision") === "draft" &&
            next.searchParams.get("tab") === "configuration",
        );
      }
      await page.getByRole("heading", { name: "Configuration draft" }).waitFor();
      await page.waitForFunction(versionDetailInView);
      assert.equal(await focusedTab(page), "Configuration");
    });
  }
}

// The link's own page scrolls at once for a reader who asked for reduced motion.
test("A failed deployment's recovery link scrolls without motion under reduced motion", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Recovery reduced motion");
  const agent = await fixture.createAgent(namespace.id, "Still Agent", nativeValues("v1"));
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" },
  });
  await routeFailedRecord(page, fixture, namespace, agent, failed);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const open = page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByRole("link", { name: "Open Configuration" });
  await open.waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  // A modified or middle click (open in a new tab or window) is left to the browser.
  const taken = await open.evaluate((link) =>
    [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }].map(
      (modifier) => {
        let prevented;
        globalThis.addEventListener(
          "click",
          (event) => {
            prevented = event.defaultPrevented;
            event.preventDefault();
          },
          { once: true },
        );
        link.dispatchEvent(
          new globalThis.MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }),
        );
        return prevented;
      },
    ),
  );
  assert.deepEqual(taken, [false, false, false, false, false]);
  // Click and read the position in one task: an instant scroll has already landed.
  const top = await open.evaluate((link) => {
    link.click();
    return globalThis.document.querySelector(".agent-version-detail").getBoundingClientRect().top;
  });
  assert.ok(Math.abs(top) <= 1, `the version's detail is at ${top} px right after the click`);
  assert.equal(await focusedTab(page), "Configuration");
});

// A version whose deploy is running, and a page at `viewport` for it. Once the test routes its
// record, open() signs in to its Access tab (where Share Agent is) under a fake clock and waits
// for it to settle.
async function pendingDeploy(t, viewport, name) {
  const size = `${viewport.width}x${viewport.height}`;
  const { fixture, namespace } = await readyNamespace(t, `${name} deploy ${size}`);
  const agent = await fixture.createAgent(namespace.id, `${name} Deploy`, nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser, context: { viewport } });
  await trackSettledFetches(page);
  const recordUrl = deploymentRecordUrl(fixture, namespace.id, agent.id, pending.id);
  const open = async () => {
    await page.clock.install({ time: new Date("2026-10-16T12:00:00Z") });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, pending.id, "access"));
    await expectDeploymentOutcome(page, "In progress");
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    await page.getByRole("heading", { name: "Share Agent" }).waitFor();
    await waitForIdleFetches(page);
  };
  return { page, recordUrl, agent, pending, open };
}

// A deploy in progress rewrote the deployment record and diagnostics on every 5 s poll, about half
// of them unchanged, and moved Share Agent twice: down when the first attempt was recorded and
// up when the deploy settled, CLS 0.024 (finding 1598). An unchanged poll now touches no node, a
// changed one only what changed, and the details keep their space until the deploy is over.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`deployment polls touch only what changed and keep Share Agent in place at ${size}`, async (t) => {
    const { page, recordUrl, pending, open } = await pendingDeploy(t, viewport, "Quiet");
    // The fixture has no deployment worker: serve the record a deploy reports as it runs.
    let record = { status: "running" };
    // Set to hold the record's reads until the test releases them.
    let recordGate = null;
    await page.route(recordUrl, async (route) => {
      await recordGate;
      await route.fulfill(deploymentStatusResponse(pending, record));
    });
    await open();
    // Polls run only when the test advances the clock.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(new Date(now + 1000));
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.evaluate(() => {
      globalThis.pollChanges = [];
      new globalThis.MutationObserver((records) => {
        for (const change of records) {
          const where = change.target.nodeType === 1 ? change.target : change.target.parentNode;
          const region = where.closest(
            ".version-diagnostics, .version-deployment-record, .deployment-evidence, .agent-overview-status",
          );
          globalThis.pollChanges.push(
            `${change.type} ${region?.className ?? "page"} > ${where.className || where.nodeName}: ${change.attributeName ?? ""}`,
          );
        }
      }).observe(globalThis.document, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
    const shareTop = () =>
      page.evaluate(
        () =>
          globalThis.document.querySelector(".agent-access").getBoundingClientRect().top +
          globalThis.scrollY,
      );
    const firstTop = await shareTop();
    const poll = async () => {
      const read = page.waitForResponse(recordUrl);
      await page.clock.runFor(DEPLOYMENT_POLL_MS);
      await read;
      await waitForIdleFetches(page);
    };

    await poll();
    assert.deepEqual(await page.evaluate(() => globalThis.pollChanges.splice(0)), []);

    // The first attempt is recorded.
    record = {
      status: "running",
      attempt: { at: new Date("2026-10-16T12:00:20.000Z"), code: "REVISION_INCOMPLETE" },
    };
    await poll();
    await page.getByText("Waiting for the runtime to become ready.").waitFor();
    // A patched row drops the attributes the new one lacks: the result is no longer muted.
    assert.equal(
      await page.getByText("Waiting for the runtime to become ready.").getAttribute("class"),
      null,
    );
    const changed = await page.evaluate(() => globalThis.pollChanges.splice(0));
    assert.ok(changed.length > 0);
    // Only the activity's details changed: the version's record and diagnostics read the same.
    assert.ok(
      changed.every((entry) => entry.includes("deployment-evidence")),
      `only the changed details were written: ${changed.join(" | ")}`,
    );
    const attemptTop = await shareTop();

    // Refresh pressed during a poll shows busy and reads once the poll lands.
    let releaseRecord;
    recordGate = new Promise((resolve) => {
      releaseRecord = resolve;
    });
    const held = page.waitForRequest(recordUrl);
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    await held;
    const refresh = page.getByRole("button", { name: "Refresh deployment" });
    await refresh.click();
    assert.equal(await refresh.getAttribute("aria-disabled"), "true");
    const queued = page.waitForRequest(recordUrl);
    recordGate = null;
    releaseRecord();
    await queued;
    await waitForIdleFetches(page);
    assert.equal(await refresh.getAttribute("aria-disabled"), "false");

    // The deploy settles.
    record = { status: "succeeded" };
    await poll();
    await expectDeploymentOutcome(page, "Completed", { folded: false });
    await waitForIdleFetches(page);
    const settledTop = await shareTop();
    t.diagnostic(`${size} Share Agent at ${firstTop}, ${attemptTop}, ${settledTop}`);
    assert.ok(Math.abs(attemptTop - firstTop) <= 1, `moved ${attemptTop - firstTop} px`);
    assert.ok(Math.abs(settledTop - firstTop) <= 1, `moved ${settledTop - firstTop} px`);
  });
}

// Watching a deploy that failed, the "Deployment needs attention" card appeared above the
// overview and pushed it down (finding 1655), so it moved below the deployment activity. There it
// sat under the open Deployment details, below the fold at 1440, and the failure's error showed
// once more than after a reload, which put the card first (finding 2094). A watched failure now
// renders as a reload of the same page does: the card leads the page and the details fold.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`a watched deploy that fails shows its recovery as a reload does at ${size}`, async (t) => {
    const { page, recordUrl, agent, pending, open } = await pendingDeploy(t, viewport, "Failing");
    let record = deploymentStatusResponse(pending, { status: "running" });
    await page.route(recordUrl, (route) => route.fulfill(record));
    // Native administration is open, so its link is the primary action until the card shows.
    await page.route(`**/agents/${agent.id}/native-admin`, (route) =>
      route.fulfill({
        json: {
          data: { status: "available", url: "https://admin.example.test/" },
          meta: { requestId: "req_test_failing_deploy" },
        },
      }),
    );
    await open();
    await page.evaluate(() => globalThis.document.fonts.ready);
    await nextFrames(page);
    // Polls run only when the test advances the clock.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(new Date(now + 1000));
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    assert.equal(await recovery.isVisible(), false);
    // open() left the running deploy's details open, as the reader sees them before it fails.
    assert.equal(await deploymentDetailsOpen(page), true);
    const background = (locator) =>
      locator.evaluate((node) => globalThis.getComputedStyle(node).backgroundColor);
    const admin = page.getByRole("link", { name: "Open admin console" });
    const adminBefore = await background(admin);

    // The deploy fails its startup model check; the next poll reads it.
    record = deploymentStatusResponse(pending, {
      status: "failed",
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
    });
    const read = page.waitForResponse(recordUrl);
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    await read;
    const failure = "v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).";
    await recovery.getByText(failure, { exact: false }).waitFor();
    await waitForIdleFetches(page);
    // Where the card sits, whether the details are open, and how often the error shows.
    const layout = () =>
      page.evaluate((message) => {
        const document = globalThis.document;
        const card = document.querySelector(".deployment-recovery");
        const shown = [...document.querySelectorAll("p, li, dd")].filter(
          (node) => node.checkVisibility() && node.textContent.includes(message),
        );
        return {
          leadsOverview: Boolean(
            card.compareDocumentPosition(document.querySelector(".agent-overview-status")) &
            globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
          ),
          top: Math.round(card.getBoundingClientRect().top + globalThis.scrollY),
          detailsOpen: document.querySelector(".deployment-status > details").open,
          errorShown: shown.length,
        };
      }, PROBE_FAILED_MESSAGE);
    const watched = await layout();
    t.diagnostic(`${size} watched: ${JSON.stringify(watched)}`);
    // The card's first action is the page's one primary: native administration's link steps back.
    const logs = recovery.getByRole("link", { name: "Open v2 Logs" });
    assert.equal(await admin.isVisible(), true);
    assert.notEqual(await background(admin), await background(logs));
    assert.notEqual(adminBefore, await background(admin), "the admin link stepped back");

    // A failed record is not polled, so the clock may run again for the reload.
    await page.clock.resume();
    await page.reload();
    await recovery.getByText(failure, { exact: false }).waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    await waitForIdleFetches(page);
    await page.evaluate(() => globalThis.document.fonts.ready);
    await nextFrames(page);
    const loaded = await layout();
    t.diagnostic(`${size} reloaded: ${JSON.stringify(loaded)}`);
    assert.deepEqual(watched, loaded, "the watched failure renders as a reload of the page does");
    // The card leads the page with its action in the first screen, and the folded details leave
    // the card as the one place the error shows.
    assert.equal(watched.leadsOverview, true);
    assert.equal(watched.detailsOpen, false);
    assert.equal(watched.errorShown, 1);
    assert.ok(
      (await logs.boundingBox()).y + 40 < viewport.height,
      "the card's action is above the fold",
    );
    // The version's Configuration tab shows its deployment record too: it names the outcome and
    // points at the card rather than repeating the error (finding 2368).
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    const versionRecord = await expectVersionRecord(page, "Failed");
    await versionRecord
      .getByText("The error and its next step are at the top of this page.", { exact: true })
      .waitFor();
    assert.equal((await layout()).errorShown, 1, "the error shows once with the record in view");
    // Folded once, the details stay open when the reader opens them.
    await openDeploymentActivity(page);
    assert.equal(await deploymentDetailsOpen(page), true);
  });
}

// The patch behind those quiet polls keeps what is unchanged, rewrites only changed text, drops
// children a shorter render no longer has, and replaces a node whose role (or role node kind)
// changes, since a live region or alert announces reliably only when it is inserted.
test("deployment poll patches rewrite only changed text and replace a node whose role changes", async (t) => {
  const fixture = await overviewApp(t);
  const { page } = await newPage(t, fixture, { browser });
  await page.goto(new URL("/console/", fixture.origin).href);
  const outcome = await page.evaluate(async () => {
    const { element, patchChildren } = await import("/console/dom.mjs");
    const parent = globalThis.document.createElement("div");
    globalThis.document.body.append(parent);
    const render = (state, role, className) => [
      element("p", {}, "Recorded status: ", element("b", {}, state)),
      element("p", { role, className }, "Deploying"),
      ...(state === "running" ? [element("p", {}, "Not recorded yet")] : []),
    ];
    patchChildren(parent, render("running", "status", "hint"));
    const [label, region] = parent.children;
    const records = [];
    new globalThis.MutationObserver((list) => {
      records.push(...list.map((record) => record.type));
    }).observe(parent, { attributes: true, characterData: true, childList: true, subtree: true });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const unchanged = patchChildren(parent, render("running", "status", "hint"));
    await flush();
    const quiet = records.splice(0);
    patchChildren(parent, render("succeeded", "status", "hint"));
    await flush();
    const settled = records.splice(0);
    const kept = parent.children[0] === label && parent.children[1] === region;
    patchChildren(parent, render("succeeded", "alert", "hint"));
    const roleReplaced = parent.children[1] !== region;
    const alert = parent.children[1];
    patchChildren(parent, render("succeeded", "alert", "error"));
    const kindReplaced = parent.children[1] !== alert;
    return {
      unchanged,
      quiet,
      settled,
      kept,
      shown: parent.textContent,
      roleReplaced,
      kindReplaced,
    };
  });
  assert.deepEqual(outcome, {
    unchanged: false,
    quiet: [],
    // Only the state's text and the dropped row; the unchanged label text is not rewritten.
    settled: ["characterData", "childList"],
    kept: true,
    shown: "Recorded status: succeededDeploying",
    roleReplaced: true,
    kindReplaced: true,
  });
});

// A recovery link that opened another version, abandoned (Back) before that page was built, left
// its request for a later visit to the same tab, which would scroll and steal focus unasked.
test("A recovery link left before its page opens does not scroll a later visit", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Recovery left");
  const agent = await fixture.createAgent(namespace.id, "Left Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await routeFailedRecord(page, fixture, namespace, agent, failed);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const settled = page.locator('.content [aria-live="polite"][aria-busy="false"]');
  const open = page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByRole("link", { name: "Open Configuration" });
  await open.waitFor();
  await settled.waitFor();
  const agentRead = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    { once: true },
  );
  await open.click();
  await agentRead.requested;
  await page.goBack();
  await page.waitForURL((url) => url.searchParams.get("revision") === active.revision.id);
  agentRead.release();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await settled.waitFor();

  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Create new version" })
    .click();
  await page.getByRole("heading", { name: "Configuration draft" }).waitFor();
  await settled.waitFor();
  // A page opened by the link scrolls as it shows.
  await page.locator(".agent-detail-pending").waitFor({ state: "detached" });
  await nextFrames(page);
  assert.equal(await page.evaluate(() => globalThis.scrollY), 0);
  assert.equal(await focusedTab(page), null);
});

// A recovery link whose draft page is restored for Back mounts it at its old scroll position,
// at the top: the restored page brings the tab into view too.
test("A recovery link to a draft retained from an earlier visit brings it into view", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Recovery retained");
  const agent = await fixture.createAgent(namespace.id, "Retained Agent", nativeValues("v1"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    browser,
    context: { viewport: { width: 1440, height: 900 } },
  });
  await routeFailedRecord(page, fixture, namespace, agent, failed);
  await trackSettledFetches(page);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  const settled = page.locator('.content [aria-live="polite"][aria-busy="false"]');
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await settled.waitFor();
  // Visit the draft through the page's own control, so leaving it retains its view.
  await page.locator(".revision-create").click();
  await page.getByRole("heading", { name: "Configuration draft" }).waitFor();
  await settled.waitFor();
  await waitForIdleFetches(page);
  await page.evaluate(() => {
    globalThis.document.querySelector('.content [aria-live="polite"]').dataset.retainedTag =
      "draft";
  });
  await page.locator('.revision-selector [aria-label^="View version v1"]').click();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await settled.waitFor();
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page
    .getByRole("region", { name: "Deployment needs attention" })
    .getByRole("link", { name: "Open Configuration" })
    .click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await page.getByRole("heading", { name: "Configuration draft" }).waitFor();
  await page.waitForFunction(versionDetailInView);
  assert.equal(await focusedTab(page), "Configuration");
  // The retained page, not a rebuilt one.
  assert.equal(
    await page.evaluate(
      () => globalThis.document.querySelector('.content [aria-live="polite"]').dataset.retainedTag,
    ),
    "draft",
  );
});

// The Agent's facts are a stat row inside one card (UX spec 3.5): three columns at desktop
// width, one column at phone width with each label and value on one line. A recorded outcome
// and Live serving are badges. What the page cannot confirm is said once, in one closed
// disclosure under the facts (spec 3.6, plan D5), not under each fact or card.
const GUARANTEES = [
  "Selection does not confirm that this version is serving.",
  "Deployment records don’t verify live serving or model access.",
  "Listed bindings describe present configuration; they do not confirm a previous request’s outcome.",
];
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`The Agent's facts are a stat row with one disclosure at ${size}`, async (t) => {
    const { fixture, namespace } = await readyNamespace(t, `Stat row ${size}`);
    const agent = await fixture.createAgent(
      namespace.id,
      "Stat Row Agent",
      nativeValues("v1", { harnessId: "codex" }),
      { executionMode: "dedicated" },
    );
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const replacement = await fixture.deployAgent(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await routeFailedRecord(page, fixture, namespace, agent, replacement);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    );
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    const summary = page.getByRole("region", { name: "Agent state at a glance" });
    await summary.getByText("May be offline", { exact: true }).waitFor();

    const facts = await summary.evaluate((node) =>
      [...node.children].map((stat) => {
        const [label, value] = stat.children;
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return { top: Math.round(rect.top), left: Math.round(rect.left), bottom: rect.bottom };
        };
        const badge = value.querySelector(".badge");
        return {
          className: stat.className,
          label: label.textContent,
          value: value.textContent,
          valueSize: globalThis.getComputedStyle(value).fontSize,
          badge: badge ? [badge.textContent, badge.dataset.tone ?? null] : null,
          labelBox: box(label),
          valueBox: box(value),
          card: node.parentElement.classList.contains("card"),
        };
      }),
    );
    assert.deepEqual(
      facts.map((fact) => [fact.className, fact.label, fact.value, fact.valueSize, fact.badge]),
      [
        ["stat", "Selected version", "v1", "18px", null],
        ["stat", "Latest visible deployment", "v2 · Failed", "18px", ["Failed", "danger"]],
        ["stat", "Live serving", "May be offline", "18px", ["May be offline", "warning"]],
      ],
    );
    assert.ok(
      facts.every((fact) => fact.card),
      "the facts sit inside a card",
    );
    if (viewport.width > 760) {
      // Three columns side by side.
      assert.equal(new Set(facts.map((fact) => fact.labelBox.top)).size, 1, JSON.stringify(facts));
      assert.ok(
        facts[0].labelBox.left < facts[1].labelBox.left &&
          facts[1].labelBox.left < facts[2].labelBox.left,
        JSON.stringify(facts),
      );
    } else {
      // One column; each label and its value share a line.
      for (const fact of facts) {
        assert.ok(
          fact.labelBox.bottom > fact.valueBox.top && fact.valueBox.bottom > fact.labelBox.top,
          JSON.stringify(fact),
        );
        assert.ok(fact.valueBox.left > fact.labelBox.left, JSON.stringify(fact));
      }
      assert.ok(
        facts[0].labelBox.top < facts[1].labelBox.top &&
          facts[1].labelBox.top < facts[2].labelBox.top,
        JSON.stringify(facts),
      );
    }

    // Each guarantee appears once on the page, inside the one closed disclosure.
    const disclosure = page.locator("details.disclosure");
    assert.equal(await disclosure.count(), 1);
    assert.equal(await disclosure.evaluate((node) => node.open), false);
    const placement = () =>
      page.evaluate((sentences) => {
        const text = globalThis.document.body.textContent;
        const details = globalThis.document.querySelector("details.disclosure");
        return sentences.map((sentence) => [
          text.split(sentence).length - 1,
          details.textContent.split(sentence).length - 1,
        ]);
      }, GUARANTEES);
    assert.deepEqual(await placement(), [
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    for (const sentence of GUARANTEES) {
      assert.equal(await page.getByText(sentence, { exact: true }).isVisible(), false);
    }
    const toggle = disclosure.getByText("What this page can tell you", { exact: true });
    await toggle.click();
    // The bindings sentence speaks for the Access tab's list, so the Configuration tab leaves it
    // out (finding 2091).
    for (const [index, sentence] of GUARANTEES.entries()) {
      assert.equal(
        await disclosure.getByText(sentence, { exact: true }).isVisible(),
        index < 2,
        sentence,
      );
    }
    // The version tab's notice no longer repeats the first one.
    await page
      .getByText("Current version · read-only admitted snapshot.", { exact: true })
      .waitFor();
    assert.deepEqual(await placement(), [
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    // On the Access tab, beside the sharing panel, the open disclosure shows all three.
    await page.getByRole("tab", { name: "Access", exact: true }).click();
    await page
      .getByRole("region", { name: "Share Agent", exact: true })
      .getByText("Current policy loaded.", { exact: true })
      .waitFor();
    for (const sentence of GUARANTEES) {
      assert.equal(await disclosure.getByText(sentence, { exact: true }).isVisible(), true);
    }
    assert.deepEqual(await placement(), [
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  });
}

// The bindings sentence speaks for the sharing panel's list: without that panel (sharing reads
// refused on the Access tab), the disclosure leaves it out.
test("The page's disclosure names listed bindings only beside the sharing panel", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Disclosure sharing");
  const agent = await fixture.createAgent(namespace.id, "Disclosure Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Forbidden." },
        meta: { requestId: "req_test_disclosure_sharing" },
      }),
    }),
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  // The refused read hides the tab and opens Configuration in its place.
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  await page.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  const disclosure = page.locator("details.disclosure");
  await disclosure.getByText("What this page can tell you", { exact: true }).click();
  await disclosure.getByText(GUARANTEES[0], { exact: true }).waitFor();
  await disclosure.getByText(GUARANTEES[1], { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "Share Agent", exact: true }).count(), 0);
  assert.equal(await disclosure.getByText(GUARANTEES[2], { exact: true }).isVisible(), false);
  // Each policy read was asked once: the denial is not retried on Configuration.
  assert.deepEqual(
    requests
      .filter((request) => request.path.includes("/iam/"))
      .map((request) => request.path)
      .sort(),
    [`/namespaces/${namespace.id}/iam/access-bindings`, `/namespaces/${namespace.id}/iam/roles`],
  );
});

// Share Agent moved off the overview into an Access tab, last in the strip (UX spec 3.8, plan
// D1). The overview no longer reads sharing policy; the tab reads it when it opens, and a link to
// the tab survives sign-in.
test("Share Agent is on the Access tab, not the overview", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Access tab");
  const agent = await fixture.createAgent(namespace.id, "Access Tab Agent", nativeValues("v1"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const policyReads = () => requests.filter((request) => request.path.includes("/iam/"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await page.getByText("Current version · read-only admitted snapshot.", { exact: true }).waitFor();
  const tabNames = () => page.getByRole("tab").allTextContents();
  assert.deepEqual(await tabNames(), [
    "Configuration",
    "Plugins",
    "Channels",
    "Workspace files",
    "Policy denials",
    "Logs",
    "Access",
  ]);
  assert.equal(await page.getByRole("heading", { name: "Share Agent" }).count(), 0);
  assert.deepEqual(policyReads(), []);

  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "access");
  await page.getByRole("tab", { name: "Access", selected: true }).waitFor();
  const panel = page
    .getByRole("tabpanel")
    .getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agent access" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Share Agent", exact: true }).count(), 1);
  assert.deepEqual(
    policyReads()
      .map((request) => request.path)
      .sort(),
    [`/namespaces/${namespace.id}/iam/access-bindings`, `/namespaces/${namespace.id}/iam/roles`],
  );

  // A draft's strip has the tab too, last; a link to it opens there after sign-in.
  const second = (await newPage(t, fixture, { browser })).page;
  await login(second, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  await second.getByRole("tab", { name: "Access", selected: true }).waitFor();
  await second
    .getByRole("tabpanel")
    .getByRole("region", { name: "Share Agent", exact: true })
    .getByText("Current policy loaded.", { exact: true })
    .waitFor();
  assert.equal((await second.getByRole("tab").allTextContents()).at(-1), "Access");
});

// The sharing panel is built once per page with the page's own context, as it was on the
// overview: a share still running when the reader opens another tab finishes, and its outcome
// shows when they come back. Each grant is written once.
test("A share in flight finishes across a tab switch", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Share in flight", {
    provisionedPeople: ["flight-recipient"],
  });
  const agent = await fixture.createAgent(namespace.id, "Flight Agent", nativeValues("v1"));
  const person = fixture.provisionedAccounts[0];
  const { page } = await newPage(t, fixture, { browser });
  const requests = apiRequests(page, fixture.origin);
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "POST", once: true },
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await write.requested;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "plugins");
  assert.equal(await panel.count(), 0);
  write.release();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  const writes = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/iam/access-bindings"),
  );
  assert.deepEqual(
    writes.map((request) => [request.body.resourceKind, request.body.subjectId]),
    [
      ["namespace", person.principal.id],
      ["agent", person.principal.id],
    ],
  );
  const bindings = (
    await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)
  ).data.filter((binding) => binding.subjectId === person.principal.id);
  assert.equal(bindings.length, 2);
});

// A share writes the Namespace discovery grant, then the Agent grant. Leaving the page between
// the two cut the share in half and said nothing (finding 2108), so another version, ← Agents and
// Refresh wait for it, as they do for a draft's writes; the tabs still switch. A reload or tab
// close asks first (finding 2125).
test("A share in flight holds version and page changes until it finishes", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Share hold", {
    provisionedPeople: ["hold-recipient"],
  });
  const agent = await fixture.createAgent(namespace.id, "Hold Agent", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const person = fixture.provisionedAccounts[0];
  const { page } = await newPage(t, fixture, { browser });
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "POST", once: true },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, url);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  const version = page.getByRole("button", { name: "View version v1, current version" });
  await waitForEnabled(version);
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  assert.equal(await asksBeforeUnload(page), false);
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await write.requested;

  assert.equal(await version.isDisabled(), true);
  assert.equal(await asksBeforeUnload(page), true);
  const held = page.getByRole("tabpanel").getByText("This page stays open until sharing finishes.");
  await page.getByRole("link", { name: "← Agents" }).click();
  await held.waitFor();
  // Refresh would make the shown page inert at once while it rebuilds; held, it stays live.
  const shown = await version.elementHandle();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(page.url(), url.href);
  assert.equal(await shown.evaluate((node) => node.isConnected && !node.closest("[inert]")), true);
  // A tab switch keeps the page, so it is not held.
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "plugins");
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.getByRole("link", { name: "← Agents" }).click();
  await held.waitFor();

  write.release();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await held.waitFor({ state: "detached" });
  await waitForEnabled(version);
  assert.equal(await asksBeforeUnload(page), false);
  const bindings = (
    await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)
  ).data.filter((binding) => binding.subjectId === person.principal.id);
  assert.deepEqual(bindings.map((binding) => binding.resourceKind).sort(), ["agent", "namespace"]);
});

// The page's own reloads of its current address (here a failed read's Retry) rebuild it, so a
// share waits for them too (finding 2108; untested until finding 2125).
test("A share in flight holds a Retry that would rebuild the page", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Share retry hold", {
    provisionedPeople: ["retry-recipient"],
  });
  const agent = await fixture.createAgent(namespace.id, "Retry Hold Agent", nativeValues("v1"));
  const person = fixture.provisionedAccounts[0];
  const { page } = await newPage(t, fixture, { browser });
  // The draft's Configuration read fails, so its tab offers Retry.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "DEPENDENCY_UNAVAILABLE", message: "Read unavailable" },
            }),
          })
        : route.fallback(),
  );
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "POST", once: true },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  const retry = page.getByRole("tabpanel").getByRole("button", { name: "Retry", exact: true });
  await retry.waitFor();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await write.requested;

  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  const configurationUrl = page.url();
  const entries = await page.evaluate(() => globalThis.history.length);
  const shown = await retry.elementHandle();
  await retry.click();
  const held = page.getByRole("tabpanel").getByText("This page stays open until sharing finishes.");
  await held.waitFor();
  // The page was not rebuilt: the same Retry is still shown and live.
  assert.equal(page.url(), configurationUrl);
  assert.equal(await page.evaluate(() => globalThis.history.length), entries);
  assert.equal(await shown.evaluate((node) => node.isConnected && !node.closest("[inert]")), true);

  write.release();
  await held.waitFor({ state: "detached" });
  const bindings = (
    await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)
  ).data.filter((binding) => binding.subjectId === person.principal.id);
  assert.deepEqual(bindings.map((binding) => binding.resourceKind).sort(), ["agent", "namespace"]);
});

// Delete replaces the page with its deletion row. During a share that took the hold's note with
// it, so ← Agents was refused in silence until the share finished (finding 2125).
test("Delete during a share in flight keeps saying why the page stays open", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Share delete hold", {
    provisionedPeople: ["delete-recipient"],
  });
  const agent = await fixture.createAgent(namespace.id, "Delete Hold Agent", nativeValues("v1"));
  const person = fixture.provisionedAccounts[0];
  const { page } = await newPage(t, fixture, { browser });
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "POST", once: true },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, url);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await write.requested;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  await page
    .getByRole("dialog", { name: "Delete Delete Hold Agent?" })
    .getByRole("button", { name: "Permanently delete Agent" })
    .click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  assert.equal(await panel.count(), 0);
  const held = page.getByText("This page stays open until sharing finishes.", { exact: true });
  await page.getByRole("link", { name: "← Agents" }).click();
  await held.waitFor();
  assert.equal(await held.isVisible(), true);
  assert.equal(page.url(), url.href);

  write.release();
  await held.waitFor({ state: "detached" });
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
});

// The Configuration editor says why it holds the page beside itself. Delete took the editor away
// as well, so its hold now says why above the deletion row (finding 2125).
test("Delete during a Configuration save keeps saying why the page stays open", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Save delete hold");
  const agent = await fixture.createAgent(namespace.id, "Save Delete Agent", nativeValues("v1"));
  const { page } = await newPage(t, fixture, { browser });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill(JSON.stringify(nativeValues("v2"), null, 2));
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH", once: true },
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await write.requested;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  await page
    .getByRole("dialog", { name: "Delete Save Delete Agent?" })
    .getByRole("button", { name: "Permanently delete Agent" })
    .click();
  await page.getByRole("status").getByText("Deletion was requested").waitFor();
  const held = page.getByText("Wait for Configuration save to finish before leaving the editor.", {
    exact: true,
  });
  await page.getByRole("link", { name: "← Agents" }).click();
  await held.waitFor();
  assert.equal(await held.isVisible(), true);
  assert.equal(page.url(), url.href);

  write.release();
  // The settled save holds nothing more: there is no editor left to reread it into.
  await held.waitFor({ state: "detached" });
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
});

// A page that opens on a deleting Agent shows only its deletion row and returns before the rest
// of the page is set up. ← Agents and the reload check read that part, threw, and did nothing
// (finding 2125).
test("A page that opens on a deleting Agent can still be left", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Opened deleting");
  const agent = await fixture.createAgent(
    namespace.id,
    "Opened Deleting Agent",
    nativeValues("v1"),
  );
  const deletion = await fixture.request(
    "DELETE",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.equal(deletion.status, 202, JSON.stringify(deletion.body));
  const { page } = await newPage(t, fixture, { browser });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("button", { name: "Request deletion again" }).waitFor();
  assert.equal(await asksBeforeUnload(page), false);
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

// The same hold from a version's Access tab: Create new version and Back to another version
// keep the page (and its history) while the share runs (finding 2108).
test("A share in flight on a version preserves Back to the draft and Forward to Access", async (t) => {
  const { fixture, namespace } = await readyNamespace(t, "Share hold version", {
    provisionedPeople: ["hold-version-recipient"],
  });
  const agent = await fixture.createAgent(namespace.id, "Hold Version Agent", nativeValues("v1"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const person = fixture.provisionedAccounts[0];
  const { page } = await newPage(t, fixture, { browser });
  const write = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/iam/access-bindings`,
    { method: "POST", once: true },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration"),
  );
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Create new version" })
    .click();
  const draft = page.getByRole("heading", { name: "Configuration draft" });
  await draft.waitFor();
  const draftUrl = page.url();
  await page.getByRole("button", { name: "View version v1, current version" }).click();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await page.getByRole("tab", { name: "Access", exact: true }).click();
  await page.waitForURL((current) => current.searchParams.get("tab") === "access");
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByText("Current policy loaded.", { exact: true }).waitFor();
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await write.requested;

  const held = page.getByRole("tabpanel").getByText("This page stays open until sharing finishes.");
  const entries = () => page.evaluate(() => globalThis.history.length);
  const before = await entries();
  const accessUrl = page.url();
  // The page header's button; the rail's own is disabled while the share runs.
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Create new version", exact: true })
    .click();
  await held.waitFor();
  assert.equal(page.url(), accessUrl);
  assert.equal(await entries(), before);

  // Back to the version's Configuration is a tab switch; Back again would leave the version.
  await page.goBack();
  await page.waitForURL((current) => current.searchParams.get("tab") === "configuration");
  const configurationUrl = page.url();
  assert.equal(new URL(configurationUrl).searchParams.get("revision"), revision.id);
  await page.goBack();
  await held.waitFor();
  await page.waitForURL(configurationUrl);
  assert.equal(await entries(), before);

  write.release();
  await held.waitFor({ state: "detached" });
  const bindings = (
    await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)
  ).data.filter((binding) => binding.subjectId === person.principal.id);
  assert.deepEqual(bindings.map((binding) => binding.resourceKind).sort(), ["agent", "namespace"]);

  // A held Back used to overwrite the draft entry. Visit the actual destinations in both
  // directions: replacing the draft or pushing a copy of Configuration loses one of them.
  await page.goBack();
  assert.equal(page.url(), draftUrl);
  await draft.waitFor();
  await page.goForward();
  await page.waitForURL(configurationUrl);
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await page.goForward();
  await page.waitForURL(accessUrl);
  await page.getByRole("tab", { name: "Access", selected: true }).waitFor();
});

// A draft's next step (UX spec 3.7, plan D1): beside the Versions rail, a checklist whose steps
// say what is done, then Deploy on the first screen with its status beside it. The deploy
// explanation moved into the page's disclosure, and the empty Deployment activity card left.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`A draft's next-step card brings Deploy up at ${size}`, async (t) => {
    const { fixture, namespace } = await readyNamespace(t, `Next step ${size}`);
    const agent = await fixture.createAgent(namespace.id, "Next Step Agent", nativeValues("v1"));
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    const card = page.locator(".agent-draft-actions");
    await card.getByText("Ready to deploy.", { exact: true }).waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    assert.equal(await page.evaluate(() => globalThis.scrollY), 0);

    await card.getByRole("heading", { level: 2, name: "Prepare this version" }).waitFor();
    const steps = await card
      .getByRole("listitem")
      .evaluateAll((items) =>
        items.map((item) => [
          item.dataset.state,
          item.querySelector(".visually-hidden").textContent,
          item.querySelector(".checklist-detail").textContent,
        ]),
      );
    assert.deepEqual(steps, [
      ["done", "Done: ", `Saved · Configuration ${agent.configurationId} · generation 1`],
      ["done", "Done: ", "Saved · API key · Secret configured"],
      ["pending", "Not done: ", "Creates an immutable version from the saved draft"],
    ]);

    // Deploy is the page's one primary.
    const deploy = card.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    const layout = await page.evaluate(() => {
      const doc = globalThis.document;
      const box = (node) => node.getBoundingClientRect();
      const deployBox = box(doc.querySelector(".agent-draft-actions .primary"));
      const status = box(doc.querySelector('.agent-draft-actions [role="status"]'));
      return {
        deployTop: deployBox.top,
        deployBottom: deployBox.bottom,
        sameLine: status.top < deployBox.bottom && deployBox.top < status.bottom,
        cardTop: box(doc.querySelector(".agent-draft-actions")).top,
        cardBottom: box(doc.querySelector(".agent-draft-actions")).bottom,
        railTop: box(doc.querySelector(".revision-selector")).top,
        tabsTop: box(doc.querySelector(".agent-tabs")).top,
        tabsWidth: box(doc.querySelector(".agent-tabs")).width,
        layoutWidth: box(doc.querySelector(".agent-version-layout")).width,
        primaries: doc.querySelectorAll(".content .button--primary:not(:disabled)").length,
        activityShown: [...doc.querySelectorAll(".deployment-status")].some((node) =>
          node.checkVisibility(),
        ),
        innerHeight: globalThis.innerHeight,
      };
    });
    // On the first screen at 1440x900; on a phone, within 1,100 px of the top (spec P7).
    assert.ok(
      viewport.width > 1100 ? layout.deployBottom <= layout.innerHeight : layout.deployTop < 1100,
      JSON.stringify(layout),
    );
    assert.equal(layout.primaries, 1, JSON.stringify(layout));
    assert.equal(layout.activityShown, false, "no empty Deployment activity card");
    // The tabs run full width under the card, and the rail.
    assert.ok(layout.tabsTop > layout.cardBottom, JSON.stringify(layout));
    assert.equal(layout.tabsWidth, layout.layoutWidth);
    if (viewport.width > 1100) {
      // Beside the Versions rail, Deploy and its status on one line.
      assert.equal(Math.round(layout.cardTop), Math.round(layout.railTop));
      assert.equal(layout.sameLine, true, JSON.stringify(layout));
    } else {
      // Stacked, the card leads the rail.
      assert.ok(layout.cardBottom < layout.railTop, JSON.stringify(layout));
    }
    // The draft's heading steps aside; the step names its Configuration instead.
    assert.equal(await page.getByRole("heading", { name: "Create new version" }).count(), 0);
    await page.getByText(/^Saved · Configuration .* · generation 1$/).waitFor();

    // What a deploy does is in the page's disclosure, once, and only beside the next step.
    const explanation =
      "Deployment creates an immutable version from the saved Configuration and plugin selections. Connection credentials are generated automatically on first deployment when needed. A successful request means work was admitted; readiness is tracked above.";
    assert.equal(await card.getByText(explanation).count(), 0);
    const disclosure = page.locator("details.disclosure");
    await disclosure.getByText("What this page can tell you", { exact: true }).click();
    await disclosure.getByText(explanation, { exact: true }).waitFor();
    assert.equal(await page.getByText(explanation).count(), 1);

    // An unsaved edit reopens the first step; Deploy waits for it.
    await page.getByRole("button", { name: "Edit Configuration" }).click();
    const editor = page.locator("#configuration-json");
    await editor.fill(`${await editor.inputValue()}\n`);
    await card.getByText("Save or cancel Configuration edits before deploying.").waitFor();
    const first = card.getByRole("listitem").first();
    assert.equal(await first.getAttribute("data-state"), "pending");
    assert.equal(
      await first.locator(".checklist-detail").textContent(),
      `Unsaved changes · Configuration ${agent.configurationId} · generation 1`,
    );
    assert.equal(await deploy.isDisabled(), true);
  });
}

// The Versions list marked only the current version: a failed v2 looked like v1 (finding 2095),
// and each version was its own Tab stop, 51 on one Agent (finding 2101). The latest version now
// carries its deployment's outcome while it is in progress or failed, and the
// list is one Tab stop on the viewed version: Up/Down (wrapping) and Home/End move focus, Enter
// opens a version, and Tab leaves the list. A poll that lands the outcome rebuilds the list and
// keeps focus on the same version (finding 2115).
test("Versions list marks the latest version's outcome and is one Tab stop", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Version rail", "Rail Agent");
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.deployAgent(namespace.id, agent.id);
  const latest = await fixture.deployAgent(namespace.id, agent.id);
  const recordUrl = deploymentRecordUrl(fixture, namespace.id, agent.id, latest.id);
  let record = deploymentStatusResponse(latest, { status: "queued" });
  await page.route(recordUrl, (route) => route.fulfill(record));
  await page.setViewportSize({ width: 1200, height: 800 });
  await trackSettledFetches(page);
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  // Polls run only when the test advances the clock.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
  const poll = async () => {
    const read = page.waitForResponse(recordUrl);
    await page.clock.runFor(DEPLOYMENT_POLL_MS);
    await read;
    await waitForIdleFetches(page);
  };
  const rail = page.getByRole("toolbar", { name: "Versions" });
  assert.equal(await rail.getAttribute("aria-orientation"), "vertical");
  const state = () =>
    rail.evaluate((list) => {
      const items = [...list.querySelectorAll(".version-item:not(.version-older)")];
      return {
        names: items.map((item) => item.getAttribute("aria-label")),
        outcomes: items.map((item) => {
          const badge = item.querySelector(".version-outcome");
          return badge ? `${badge.textContent}/${badge.dataset.tone}` : null;
        }),
        stops: items.filter((item) => item.tabIndex === 0).map((item) => item.textContent),
        focused: list.contains(globalThis.document.activeElement)
          ? globalThis.document.activeElement.querySelector("strong").textContent
          : null,
      };
    });
  await rail.getByRole("button", { name: "View version v3, deployment queued" }).waitFor();
  const first = await state();
  assert.deepEqual(first.outcomes, ["Queued/info", null, null]);
  assert.deepEqual(first.names, [
    "View version v3, deployment queued",
    "View version v2",
    "View version v1, current version",
  ]);
  assert.equal(first.stops.length, 1);
  assert.match(first.stops[0], /^v1/);

  // A reader arrows to v2 while the deploy runs, then fails: each poll marks v3, and the one that
  // reads the failure rebuilds the list without taking focus off v2 or scrolling the list. A
  // short list makes it scroll.
  await page.evaluate(() => {
    const sheet = [...globalThis.document.styleSheets].find((item) => item.href);
    sheet.insertRule(".version-list { max-height: 120px; }", sheet.cssRules.length);
  });
  await rail.getByRole("button", { name: "View version v1, current version" }).focus();
  await page.keyboard.press("ArrowUp");
  const shownV2 = await rail.getByRole("button", { name: "View version v2" }).elementHandle();
  const scrolled = await rail.evaluate((list) => list.scrollTop);
  assert.ok(scrolled > 0, `the list scrolled to v2: ${scrolled}`);
  record = deploymentStatusResponse(latest, { status: "running" });
  await poll();
  await rail.getByRole("button", { name: "View version v3, deployment in progress" }).waitFor();
  assert.deepEqual((await state()).outcomes, ["In progress/info", null, null]);
  record = deploymentStatusResponse(latest, {
    status: "failed",
    error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  });
  await poll();
  await rail.getByRole("button", { name: "View version v3, deployment failed" }).waitFor();
  const failed = await state();
  assert.deepEqual(failed.outcomes, ["Failed/danger", null, null]);
  // The list was rebuilt, and focus and scroll position carried over to the new one.
  assert.equal(await shownV2.evaluate((node) => node.isConnected), false);
  assert.equal(failed.focused, "v2");
  assert.deepEqual(
    await rail.evaluate((list) => {
      const box = list.getBoundingClientRect();
      const item = globalThis.document.activeElement.getBoundingClientRect();
      return {
        scrollTop: list.scrollTop,
        visible: item.top >= box.top && item.bottom <= box.bottom,
      };
    }),
    { scrollTop: scrolled, visible: true },
  );
  assert.equal(failed.stops.length, 1);
  assert.match(failed.stops[0], /^v2/);
  await page.clock.resume();

  // One Tab stop on the viewed version; the arrows move focus without opening a version.
  await rail.getByRole("button", { name: "View version v1, current version" }).focus();
  for (const [key, focused] of [
    ["ArrowUp", "v2"],
    ["ArrowUp", "v3"],
    ["ArrowUp", "v1"],
    ["ArrowDown", "v3"],
    ["End", "v1"],
    ["Home", "v3"],
  ]) {
    await page.keyboard.press(key);
    const now = await state();
    assert.equal(now.focused, focused, `${key} to ${focused}`);
    assert.equal(now.stops.length, 1);
    assert.match(now.stops[0], new RegExp(`^${focused}`));
  }
  assert.equal(new URL(page.url()).searchParams.get("revision"), active.revision.id);
  // Tab leaves the list, and Shift+Tab comes back to the viewed version.
  await page.keyboard.press("Tab");
  assert.equal((await state()).focused, null);
  await page.keyboard.press("Shift+Tab");
  assert.equal((await state()).focused, "v1");
  // Enter opens the focused version.
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.waitForURL(`**revision=${latest.id}**`);
});

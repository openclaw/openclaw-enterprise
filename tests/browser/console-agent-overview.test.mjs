import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DELETION_POLL_MS } from "../../apps/controller/src/console/agents/deletion.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  detailUrl,
  holdRequests,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
  recordLayoutShifts,
  takeLayoutShifts,
} from "./console-agents-browser-helpers.mjs";

// The Agent page's first screen while its reads settle and its polls run: loading cues, quiet
// polls, a steady layout, and failed-version recovery scoped to the caller.

async function agentPage(t, namespaceName, agentName, fixtureOptions) {
  const fixture = await createConsoleAppFixture(t, fixtureOptions);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(namespaceName, { ready: true });
  const agent = await fixture.createAgent(namespace.id, agentName, nativeValues("v1"));
  const { page } = await newPage(t, fixture);
  return { fixture, namespace, agent, page };
}

// A runtime log Compute Driver with the Agent runtime log API enabled.
function runtimeLogs() {
  return {
    computeDriver: createRuntimeLogComputeDriver(),
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  };
}

const deploymentUrl = (fixture, namespace, agent, revision) =>
  `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`;

// A deployment record response, as the API returns it for this version.
function deploymentRecord(namespace, agent, revision, status, error = null) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: {
        deploymentId: revision.id,
        namespaceId: namespace.id,
        agentId: agent.id,
        status,
        error,
        warnings: [],
        progress: null,
      },
      meta: { requestId: "req_test_agent_overview" },
    }),
  };
}

function routeFailedRecord(page, fixture, namespace, agent, revision) {
  const failed = deploymentRecord(
    namespace,
    agent,
    revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
  return page.route(deploymentUrl(fixture, namespace, agent, revision), (route) =>
    route.fulfill(failed),
  );
}

// The Agent summary showed "vN · Loading…" for a frame or more on every load while the newest
// version's deployment record was read (finding 1438). Its loading text now follows the 250 ms
// rule: it is hidden for the first 250 ms, so a read that settles sooner never shows it.
test("the Agent summary's loading text follows the 250 ms rule", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(t, "Quiet summary", "Quiet Summary");
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const record = await holdRequests(t, page, deploymentUrl(fixture, namespace, agent, revision), {
    fulfill: deploymentRecord(namespace, agent, revision, "succeeded"),
  });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  const value = summary.locator(":scope > div:nth-child(2) > strong");
  await page.waitForFunction(() =>
    globalThis.document
      .querySelector('[aria-label="Agent state at a glance"] > div:nth-child(2) > strong')
      ?.textContent.startsWith("v1 · "),
  );
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
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
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
    const read = page.waitForResponse(
      (response) => response.url() === agentUrl && response.request().method() === "GET",
    );
    await page.clock.runFor(DELETION_POLL_MS);
    assert.equal((await read).status(), 200);
    // Let the poll's render run.
    await new Promise((resolve) => setTimeout(resolve, 200));
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
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
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
  assert.equal(await principal.isEnabled(), true);
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

// One readable version per history page: the first page lists the newest readable version.
function routeOneVersionPerPage(page, fixture, namespace, agent) {
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  return page.route(
    (url) => url.origin === fixture.origin && url.pathname === revisionsPath,
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
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
  await routeOneVersionPerPage(page, fixture, namespace, agent);

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

  // With every page loaded, the current version is known to be hidden.
  await page.getByRole("button", { name: "Show older versions" }).click();
  await page.getByRole("button", { name: /^View version v1/ }).waitFor();
  await statusLine
    .getByText(
      /The current version, rev_.*, is one you cannot read, so this page cannot tell whether the failed v2 deployment affects it\. Ask an Agent administrator for read access/,
    )
    .waitFor();
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByText("v2 deployment failed").count(), 0);
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
  await page.route(deploymentUrl(fixture, namespace, agent, second.revision), (route) =>
    route.fulfill(deploymentRecord(namespace, agent, second.revision, "succeeded")),
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

test("Recovery offers the draft link only to callers who may update the Agent", async (t) => {
  const { fixture, namespace, agent, page } = await agentPage(
    t,
    "Read-only recovery",
    "Read-only Agent",
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await routeFailedRecord(page, fixture, namespace, agent, revision);
  // The caller's permission answer says this reader may not update the Agent's Configuration.
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
  assert.equal(await logs.getAttribute("class"), "overview-primary");
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
      "v2 failed its startup model check. Check the failed version’s logs before deploying a new version.",
    )
    .waitFor();
  await recovery.getByRole("link", { name: "Open v2 Logs" }).click();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();

  // The denial updates the recovery at once: it says who can check the logs instead of
  // steering the reader into another denied read.
  const askForLogs = recovery.getByText(
    "v2 failed its startup model check. Ask someone with log access to check the failed version’s logs before deploying a new version.",
  );
  await askForLogs.waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  // Leaving Logs for another tab of the same version keeps that.
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await askForLogs.waitFor();
  assert.equal(await recovery.getByRole("link", { name: "Open v2 Logs" }).count(), 0);
  const configuration = recovery.getByRole("link", { name: "Open Configuration" });
  assert.equal(await configuration.getAttribute("class"), "overview-primary");

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
  const fixture = await createConsoleAppFixture(t, logs);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Replaced denied", { ready: true });
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
  const { page } = await newPage(t, fixture);
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
  await recovery.getByRole("link", { name: "Open v2 Logs" }).click();
  await page
    .getByText("Log text requires Agent read_logs (or administer) and read access.")
    .waitFor();
  await recovery
    .getByText(
      "v2 failed its startup model check. v1 is still selected, but its runtime was probably stopped for this deployment. Ask someone with log access to check the failed version’s logs.",
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

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v2 · Failed", { exact: true }).waitFor();
  await permissions.requested;
  // While the answer is pending, the recovery is held rather than offering a draft link
  // the caller may not be allowed to use (finding 1478).
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByRole("link", { name: "Open Configuration" }).count(), 0);

  permissions.release();
  await recovery.getByText("v2 failed its startup model check.", { exact: false }).waitFor();
  assert.equal(
    await recovery.getByRole("link", { name: "Open v2 Logs" }).getAttribute("class"),
    "overview-primary",
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
  assert.equal(await logs.getAttribute("class"), "overview-primary");
  assert.equal(await recovery.getByRole("link", { name: "Open Configuration" }).count(), 0);
  assert.equal(await recovery.getByRole("link").count(), 1);
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
  const fixture = await createConsoleAppFixture(t, logs);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady logs", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Steady Logs Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  logs.computeDriver.state.lines = Array.from({ length: 30 }, (_, index) =>
    line(index, `startup line ${index}`),
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const { page } = await newPage(t, fixture, { context: { viewport } });
    // The runtime status read settles after the page has scrolled to the Logs tab, as on a
    // live cluster where it takes about a second.
    await page.route(
      `${deploymentUrl(fixture, namespace, agent, active.revision)}/runtime`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await route.continue().catch(() => {});
      },
    );
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Steady Logs Agent" }).waitFor();
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, active.revision.id, "logs").href);
    await page.getByText("startup line 29", { exact: false }).waitFor();
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
  const fixture = await createConsoleAppFixture(t, logs);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Steady logs tab", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Steady Logs Tab", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  logs.computeDriver.state.lines = Array.from({ length: 30 }, (_, index) =>
    line(index, `startup line ${index}`),
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 720 },
  ]) {
    const { page } = await newPage(t, fixture, { context: { viewport } });
    // The status read settles well after the click's 500 ms input window, as on a live cluster.
    await page.route(
      `${deploymentUrl(fixture, namespace, agent, active.revision)}/runtime`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await route.continue().catch(() => {});
      },
    );
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    );
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await page.getByRole("button", { name: "Stop Agent" }).waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    // A reader scrolls the tabs into view, then selects Logs once the page is still.
    const logsTab = page.getByRole("button", { name: "Logs", exact: true });
    await logsTab.evaluate((tab) => tab.scrollIntoView({ block: "center" }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await page.evaluate(recordLayoutShifts);
    await logsTab.click();
    await page.getByText("startup line 29", { exact: false }).waitFor();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // The Logs view and the cards below it; headless Chromium also reports a body shift at
    // phone width after any tab click, on main as well, that a reader does not see.
    const { shifts } = await takeLayoutShifts(page);
    const shift = shifts
      .filter((entry) =>
        entry.sources.some((source) => /stop-note|deletion-note|agent-logs|log-/.test(source.node)),
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
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slow banner", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Slow Banner", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  // Every Namespace read takes 600 ms, so the latest deployment's outcome lands about 1.2 s
  // after the page renders, as on the live slow link where the shift was measured. The second
  // pass also answers the caller's permission read after that outcome.
  for (const permissionsDelay of [600, 1400]) {
    const { page } = await newPage(t, fixture);
    await routeFailedRecord(page, fixture, namespace, agent, revision);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Slow Banner" }).waitFor();
    await page.route(`${fixture.origin}/namespaces/**`, async (route) => {
      const delay = route.request().url().endsWith("/permissions") ? permissionsDelay : 600;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.fallback().catch(() => {});
    });
    await page.addInitScript(recordLayoutShifts);
    // A full load, so no recent input excuses a shift.
    await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href);
    const recovery = page.getByRole("region", { name: "Deployment needs attention" });
    await recovery.getByText("v2 failed its startup model check.", { exact: false }).waitFor();
    await page
      .locator(".agent-current-summary")
      .getByText("v2 · Failed", { exact: true })
      .waitFor();
    await page.evaluate(() => globalThis.document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { shift, shifts } = await takeLayoutShifts(page);
    t.diagnostic(`permissions ${permissionsDelay} ms: shift ${shift}: ${JSON.stringify(shifts)}`);
    assert.ok(shift < 0.01, `permissions ${permissionsDelay} ms: shift ${shift}`);
  }
});

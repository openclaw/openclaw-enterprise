import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.mjs";
import {
  detailUrl,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
} from "./console-agents-browser-helpers.mjs";

// The overview's "Deployment needs attention" recovery speaks for the version that is current
// for this caller, and offers only the links that caller may use (finding 1458).

function routeDeploymentStatus(page, fixture, namespace, agent, revision, status, error = null) {
  return page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) =>
      route.fulfill({
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
          meta: { requestId: "req_test_recovery_access" },
        }),
      }),
  );
}

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

test("A failed older version raises no recovery while the current version is hidden", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Hidden current", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Hidden current", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v2 is current and serving, but this reader cannot read it; v1, the newest it can read,
  // failed earlier.
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  denyRevisionRead(fixture, namespace, second.revision);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    first.revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );

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

test("A failed version raises no recovery while the current version is on no loaded page", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Paged history", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Paged history", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  // v3 is current and serving, but this reader cannot read it; v2, the newest it can read,
  // failed earlier, and v1 is on the next history page (finding 1477).
  const third = await fixture.seedActiveAgentRevision(namespace.id, agent.id, second.revision.id);
  denyRevisionRead(fixture, namespace, third.revision);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    second.revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
  // One readable version per history page.
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  await page.route(
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

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Paged history" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v2 · Failed", { exact: true }).waitFor();
  const statusLine = page.locator(".agent-status-line");
  await statusLine
    .getByText(
      /^The current version, rev_.*, is not among the versions listed, so this page cannot tell whether the failed v2 deployment affects it\.$/,
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

test("Recovery offers the draft link only to callers who may update the Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Read-only recovery", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Read-only Agent", nativeValues("v1"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
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
  const computeDriver = createRuntimeLogComputeDriver();
  const fixture = await createConsoleAppFixture(t, {
    computeDriver,
    agentRuntimeLogs: { enabled: true, cursorSecret: `console-logs-${randomUUID()}` },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Denied logs", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Denied logs", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
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

test("Recovery waits for the caller's permission answer before offering the draft link", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pending permissions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Pending permissions", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
  const answer = Promise.withResolvers();
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`,
    async (route) => route.fulfill(await answer.promise),
  );

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("v2 · Failed", { exact: true }).waitFor();
  // While the answer is pending, the recovery is held rather than offering a draft link
  // the caller may not be allowed to use (finding 1478).
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  assert.equal(await page.locator(".deployment-recovery").isHidden(), true);
  assert.equal(await page.getByRole("link", { name: "Open Configuration" }).count(), 0);

  answer.resolve({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      data: { update: true, deploy: true, operate: true, delete: true },
      meta: { requestId: "req_test_recovery_pending" },
    }),
  });
  await recovery.getByText("v2 failed its startup model check.", { exact: false }).waitFor();
  assert.equal(
    await recovery.getByRole("link", { name: "Open v2 Logs" }).getAttribute("class"),
    "overview-primary",
  );
  await recovery.getByRole("link", { name: "Open Configuration" }).waitFor();
});

test("Recovery offers no draft link when the caller's permission answer fails", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Failed permissions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Failed permissions", nativeValues("v1"));
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // v1 keeps serving; the v2 redeploy failed.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(
    page,
    fixture,
    namespace,
    agent,
    revision,
    "failed",
    persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
  );
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

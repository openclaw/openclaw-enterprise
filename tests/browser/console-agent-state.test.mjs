import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/detail.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  login,
  nativeValues,
  newPage,
  persistedDeploymentError,
  trackSettledFetches,
  waitForIdleFetches,
} from "./console-agents-browser-helpers.mjs";

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
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) =>
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
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const activity = page.locator(".deployment-status");
  const record = page.locator(".version-deployment-record");
  await activity.getByText("Recorded status: running").waitFor();
  await record.getByText("Recorded outcome: running").waitFor();

  status = "failed";
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await activity.getByText("Recorded status: failed").waitFor();
  await record.getByText("Recorded outcome: failed").waitFor();
  await record
    .getByText(`RUNTIME_AUTHENTICATION_FAILED: ${authenticationFailure.message}`)
    .waitFor();
  assert.equal(await record.getByText("No persisted startup failure.").count(), 0);
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
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) => {
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
    },
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const activity = page.locator(".deployment-status");
  const record = page.locator(".version-deployment-record");
  await activity.getByText("Recorded status: running").waitFor();
  await record.getByText("Recorded outcome: running").waitFor();

  // Pending work is reread on its own; the reader does not have to press Refresh deployment.
  status = "failed";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await activity.getByText("Recorded status: failed").waitFor();
  await record.getByText("Recorded outcome: failed").waitFor();
  await page.getByText("v1 · Failed", { exact: true }).waitFor();

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
  let cleanup = { status: "queued", nextAttemptAt: null };
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) =>
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
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const activity = page.locator(".deployment-status");
  await activity.getByText("Recorded status: failed").waitFor();

  // The same retire cleanup also covers repository credential resources, so the
  // status names the version's cleanup rather than bootstrap resources.
  const status = activity.locator(".deployment-cleanup");
  assert.equal(
    await status.innerText(),
    "Revision cleanup pending. This version's resources have not been confirmed removed; the controller will retry.",
  );
  cleanup = { status: "succeeded", nextAttemptAt: null };
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await status.getByText("Revision cleanup completed for this version.").waitFor();
  await activity.getByText("Recorded status: failed").waitFor();
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
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) => {
      statusReads += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: deploymentBody(namespace.id, agent.id, revision.id, status),
      });
    },
  );
  await page.clock.install({ time: new Date("2026-09-30T12:00:00Z") });
  await trackSettledFetches(page);
  const url = detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const activity = page.locator(".deployment-status");
  await activity.getByText("Recorded status: running").waitFor();
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
  await activity.getByText("Recorded status: running").waitFor();

  // The restored view resumes following without a manual Refresh deployment.
  status = "succeeded";
  const readsBeforeResult = statusReads;
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await activity.getByText("Recorded status: succeeded").waitFor();
  assert.ok(statusReads > readsBeforeResult);
});

test("Diagnostics explain UNAVAILABLE checks and point at the recorded failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Diagnostics explain", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Diagnostics Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
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
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const observations = page.locator(".version-diagnostics");
  await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
  await observations.getByText("gateway / authentication").waitFor();
  await observations.getByText(/UNAVAILABLE means the runtime did not answer/).waitFor();
  await observations
    .getByText(/recorded deployment failed with RUNTIME_AUTHENTICATION_FAILED/)
    .waitFor();
});

test("Diagnostics explain a missing Slack channel and keep the recorded failure in view", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Diagnostics scope", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Embedded Agent", nativeValues("v1"));
  const revision = await fixture.deployAgent(namespace.id, agent.id);
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
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const observations = page.locator(".version-diagnostics");
  await observations.getByText(/gateway checks cover only the Slack channel/).waitFor();
  await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
  await observations.getByText("gateway / authentication").waitFor();
  await observations.getByText(/NOT_CONFIGURED means this version has no Slack channel/).waitFor();
  await observations
    .getByText(/recorded deployment failed with RUNTIME_AUTHENTICATION_FAILED/)
    .waitFor();
  assert.equal(await observations.getByText(/UNAVAILABLE means the runtime/).count(), 0);
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
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "RESOURCE_NOT_FOUND", message: "Agent not found." },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000404" },
        }),
      });
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
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Shared Agent" }).waitFor();
  const panel = page.locator(".agent-access");
  await panel.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByText(/Sharing policy requires Installation administration/).count(),
    0,
  );
});

function routeDeploymentStatus(page, fixture, namespace, agent, revision, status, error = null) {
  return page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revision.id}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: deploymentBody(namespace.id, agent.id, revision.id, status, error),
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

test("Agent detail says when the current or requested version cannot be read", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Hidden versions", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Hidden Agent", nativeValues("v1"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // Revision read is granted per version: v2 is current, but this reader cannot read it.
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  denyRevisionRead(fixture, namespace, second.revision);
  const { page } = await newPage(t, fixture);
  await routeDeploymentStatus(page, fixture, namespace, agent, first.revision, "succeeded");

  const url = detailUrl(fixture, namespace.id, agent.id, second.revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Hidden Agent" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("Newer version hidden", { exact: true }).waitFor();
  await summary.getByText("Selected for service · you cannot read this version").waitFor();
  assert.equal(await summary.getByText("v1 · Succeeded").count(), 0);
  await page
    .locator(".agent-status-line")
    .getByText(/The current version, rev_.*, is one you cannot read; v1 is an older version\./)
    .waitFor();
  // Members have no chat or native admin surface, so the hint names only paths that work.
  await page
    .locator(".agent-status-line")
    .getByText(
      /Ask an Agent administrator for read access to new versions\. If this Agent is set up for a channel such as Slack, you can message it there when that channel allows you\.$/,
    )
    .waitFor();
  await page.getByRole("heading", { name: "You cannot read this version" }).waitFor();
  assert.equal(await page.getByText("Configuration unavailable").count(), 0);

  // After a deploy the console opens the requested version; its outcome stays hidden too.
  const requested = await fixture.deployAgent(namespace.id, agent.id);
  denyRevisionRead(fixture, namespace, requested);
  const requestedUrl = detailUrl(fixture, namespace.id, agent.id, requested.id, "configuration");
  await page.goto(requestedUrl.href);
  await page.getByRole("heading", { name: "Hidden Agent" }).waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(
      /Version rev_.* was requested, but you cannot read it, so its progress and outcome are not shown here\./,
    )
    .waitFor();
  await page.getByRole("heading", { name: "You cannot read this version" }).waitFor();
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
      "No readable versions. This Agent has versions your access does not include. Ask an Agent administrator for read access to them.",
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
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("Probably down", { exact: true }).waitFor();
  await summary.getByText("v2 failed; v1 was probably stopped for it.").waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(
      /^v2 deployment failed\. v1 is still recorded as current, but deploying a dedicated Agent stops the previous version first, so this Agent is probably not serving: expect no answers in its channels or anywhere else until a new version deploys\. Fix the failure, then deploy a new version\.$/,
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
  await page.getByRole("heading", { name: "Version v2" }).waitFor();
  const summary = page.locator(".agent-current-summary");
  await summary.getByText("Probably down", { exact: true }).waitFor();
  await summary.getByText("v2 is selected and its deployment failed.").waitFor();
  await page
    .locator(".agent-status-line")
    .getByText(
      /^v2 deployment failed\. v2 is still selected because its runtime already replaced the previous version, so this Agent is probably not serving: expect no answers in its channels or anywhere else until a new version deploys\. Fix the failure, then deploy a new version\.$/,
    )
    .waitFor();
  assert.equal(await page.getByText("Live serving is unverified").count(), 0);
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
        /^The startup model check failed for a reason other than a rejected credential, .*, or, with Codex, a provider the runtime cannot reach\. .*and that the runtime can reach the provider, then deploy a new version\.$/,
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
      nextStep: /^The startup model check failed for a reason other than a rejected credential, /,
      cause: "The model provider check reported a failure (error-event)",
    },
    {
      error: persistedDeploymentError("RUNTIME_MODEL_PROBE_TIMEOUT"),
      nextStep:
        /^The startup model check did not get a reply from the model provider in time\. With OpenClaw this includes a provider the runtime cannot reach \(refused connection or unknown host\)\..* then deploy a new version\.$/,
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
    const activity = page.locator(".deployment-status");
    assert.match(error.message, nextStep);
    await activity.getByText(`${error.code}: ${error.message}`, { exact: true }).waitFor();
    // The next step appears once, in the API's message; the hint holds only the link.
    assert.equal(
      await activity.locator(".deployment-failure-guidance").textContent(),
      "Open Configuration",
    );
    assert.equal(
      await activity.locator(".deployment-failure-guidance").getByRole("link").count(),
      1,
    );
    assert.equal(
      await activity.getByText("Cause", { exact: true }).count(),
      cause === undefined ? 0 : 1,
    );
    if (cause !== undefined) {
      await activity.getByText(cause, { exact: true }).waitFor();
    }
    assert.match(
      await activity.getByRole("link", { name: "Open Configuration" }).getAttribute("href"),
      new RegExp(`agents/${agent.id}\\?revision=draft&tab=configuration`),
    );
    assert.match(
      await activity.getByRole("link", { name: "Open v1 Logs" }).getAttribute("href"),
      new RegExp(`revision=${revision.id}&tab=logs`),
    );
    assert.equal(await activity.getByRole("link", { name: "Open Credentials" }).count(), 0);
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
  await page
    .locator(".agent-status-line")
    .getByText("v2 deployment is recorded as failed. v1 is selected. Live serving is unverified.")
    .waitFor();
  assert.equal(await page.getByText("Probably down", { exact: true }).count(), 0);
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
    failedLine:
      /^v1 deployment is recorded as failed\. rev_.* is selected\. Live serving is unverified\.$/,
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
        "Deployment ended because the Agent was stopped or its Namespace is no longer ready.",
    },
    failedLine: /^v1 deployment failed\./,
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
    const deployment = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${first.revision.id}`;
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
    await row.getByRole("link", { name: `v1 · ${c.outcome}` }).waitFor();
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
    await activity.getByText(`Recorded status: ${c.outcome}`, { exact: true }).waitFor();
    await activity.getByText(c.explanation(code)).waitFor();
    for (const stage of c.stages) {
      await activity.getByText(stage, { exact: true }).waitFor();
    }
    assert.equal(await activity.locator(`.deployment-step-${c.outcome}`).count(), 2);
    assert.equal(await activity.locator(".deployment-step-failed").count(), 0);
    assert.equal(await activity.getByRole("alert").count(), 0);
    await record.getByText(`Recorded outcome: ${c.outcome}`, { exact: true }).waitFor();
    await record.getByText(c.explanation(code), { exact: true }).waitFor();
    // No failure banner, no "probably down", and nothing names the newer version, which this
    // reader cannot read.
    assert.equal(await statusLine.isVisible(), false);
    assert.equal(await page.getByText("Probably down", { exact: true }).count(), 0);
    assert.equal(await outcome.getByText(absent).count(), 0);
    if (checkStatusLineText) {
      assert.equal(await statusLine.getByText(absent).count(), 0);
    }
  };
  for (const c of neutralDeployments) {
    await page.goto(urls.get(c.agent).href);
    await page.getByRole("heading", { name: "Version v1" }).waitFor();
    await expectNeutral(c, c.error.code);
    // Diagnostics do not ask the reader to resolve a neutral record first.
    const observations = page.locator(".version-diagnostics");
    await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
    await observations
      .getByText(/Check this version's recorded outcome and its Logs tab/)
      .waitFor();
    assert.equal(await observations.getByText(/recorded deployment failed with/).count(), 0);

    errors.set(c.agent, c.failure);
    await activity.getByRole("button", { name: "Refresh deployment" }).click();
    await summary.getByText("v1 · Failed", { exact: true }).waitFor();
    await activity.getByText("Recorded status: failed", { exact: true }).waitFor();
    await activity.getByText(`${c.failure.code}: ${c.failure.message}`).waitFor();
    assert.equal(await activity.locator(".deployment-step-failed").count(), 1);
    assert.equal(await activity.locator(`.deployment-step-${c.outcome}`).count(), 0);
    await statusLine.getByText(c.failedLine).waitFor();

    if (c.alsoNeutral) {
      errors.set(c.agent, { ...c.error, code: c.alsoNeutral });
      await activity.getByRole("button", { name: "Refresh deployment" }).click();
      await expectNeutral(c, c.alsoNeutral, false);
    }
  }
});

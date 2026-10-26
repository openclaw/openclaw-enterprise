import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  AGENT_READ,
  apiRequests,
  deniedCreateSecretOption,
  detailUrl,
  expectNoText,
  expireSessions,
  grantMember,
  grantSecretOperate,
  hasFocus,
  holdRequests,
  login,
  MEMBER_WRITE,
  nativeValues,
  newPage,
  nextFrames,
  settlePageRequests,
  nonAuthWriteRequests,
  operateDeniedSecretOption,
  pathRequests,
  deploymentStatusResponse,
  persistedDeploymentError,
  recordLayoutShifts,
  revealNativeConfiguration,
  revokeMemberGrant,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  settledFetches,
  settledView,
  takeLayoutShifts,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForInputValue,
  waitForSettledFetches,
  statusTone,
  isMaskedSecretValue,
} from "./console-agents-browser-helpers.mjs";
import { FIRST_ACTIVITY_WAIT_MS } from "../../apps/controller/src/console/agents/detail.mts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
  expectVersionRecord,
  openFailureDetails,
} from "./console-deployment-activity-helpers.mjs";
import {
  openAdvancedSettings,
  withholdPermissionSummary,
  assertRevisionUrl,
  agentStopRequests,
  replyWithDifferentAgentId,
  configurationPatchRequests,
  nativeAdminValues,
  waitForLiveControls,
} from "./console-agents-test-support.mjs";
import {
  AGENT_SAVE_DENIED,
  CONFIGURATION_EDITS_PENDING,
  CONFIGURATION_SAVE_DENIED,
  NEW_SECRET_OPERATE_DENIED,
  NEW_SECRET_OPERATE_REMEDY,
  READ_UNAVAILABLE,
  SAVED_CONFIGURATION_CHANGED,
  SECRET_OPERATE_DENIED,
  WORKSPACE_FILES_UNAVAILABLE,
  namespaceListDenied,
  secretOperateRefused,
} from "../helpers/refusal-text.mjs";

test("Agent detail separates the current version, viewed version, and latest deployment", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deployment activity", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Deployment Agent", nativeValues("v1"));
  const current = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("v2"));
  // Admission creates v2 while v1 stays selected until activation.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const deploymentPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${pending.id}`;
  const diagnosticsPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${current.revision.id}/diagnostics`;

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // The in-memory API fixture has no worker records. Supply contract-shaped status
  // reads to prove the UI keeps each version's outcome tied to its exact ID.
  let pendingRecord = { status: "queued" };
  for (const [revision, recorded] of [
    [
      current.revision,
      () => ({
        status: "succeeded",
        warnings: [{ code: "PLUGIN_AUTH_REQUIRED", pluginId: "linear@openai-curated-remote" }],
      }),
    ],
    [pending, () => pendingRecord],
  ]) {
    await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) =>
      route.fulfill(deploymentStatusResponse(revision, recorded())),
    );
  }
  const diagnosticsRequest = await holdRequests(t, page, `${fixture.origin}${diagnosticsPath}`, {
    method: "POST",
    fulfill: {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          revisionId: current.revision.id,
          observedAt: "2026-09-27T12:00:00.000Z",
          checks: [
            {
              component: "slack",
              check: "authentication",
              state: "succeeded",
              checkedAt: "2026-09-27T11:59:59.000Z",
            },
          ],
        },
        meta: { requestId: "req_test_exact_diagnostics" },
      }),
    },
  });
  const url = detailUrl(fixture, namespace.id, agent.id, current.revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Versions" }).waitFor();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const overview = page.locator(".agent-current-summary > div");
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await overview.nth(1).getByText("v2 · Queued").waitFor();
  await overview.nth(2).getByText("Not verified").waitFor();
  // A running version's unverified serving says why (finding 2367).
  await overview.nth(2).getByText("OCC sends no test request.", { exact: true }).waitFor();
  const activity = await expectDeploymentOutcome(page, "Queued");
  await activity.getByText("Most recent visible deployment · v2").waitFor();
  await activity.getByText("Waiting for a worker claim.").waitFor();
  await activity.getByText("No reconciliation result is available yet.").waitFor();
  // Simulate a subsequent status read: the first attempt deferred, so the work waits for its next
  // attempt and the deploy reads as running (finding 2456). Persistence and attribution are
  // proved separately by the PostgreSQL queue/worker test, not by this browser fixture.
  pendingRecord = {
    status: "running",
    attempt: { at: new Date("2026-09-27T12:01:00.000Z"), code: "REVISION_INCOMPLETE" },
    nextAttemptAt: "2026-09-27T12:01:01.000Z",
  };
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await expectDeploymentOutcome(page, "In progress");
  await activity.getByText("Deployment work started; waiting for the next attempt.").waitFor();
  await activity.getByText("Waiting for the runtime to become ready.").waitFor();
  await activity.getByText("Since", { exact: true }).waitFor();
  assert.equal(await activity.getByText("Waiting for a worker claim.").count(), 0);
  await activity.getByText("Successful completion is not recorded yet.").waitFor();
  const versionRecord = await expectVersionRecord(page, "Completed");
  await versionRecord.getByRole("heading", { name: "This version’s deployment record" }).waitFor();
  // D331: a startup warning says what happened to the plugin, not only its code.
  await versionRecord
    .getByText(
      "linear@openai-curated-remote was disabled for this startup because it is not authenticated: Codex plugins need a ChatGPT login rather than an API key, and some also need their app connected to that account. (PLUGIN_AUTH_REQUIRED)",
    )
    .waitFor();
  const observations = page.locator(".version-diagnostics");
  await observations
    .getByText(/For Kubernetes Compute, gateway checks cover only the Slack channel/)
    .waitFor();
  const idle = observations.getByText(
    "No current observation has been requested for this version.",
  );
  const waiting = observations
    .getByRole("status")
    .filter({ hasText: "Waiting for diagnostic results…" });
  const runDiagnostics = observations.getByRole("button", {
    name: "Run diagnostics for this version",
  });
  await idle.waitFor();
  // Record what a screen reader hears from the panel: text added or changed inside a live
  // region, where aria-live=off silences a subtree. The click once also changed the button to
  // "Running diagnostics...", which the Agent view's live region announced beside the waiting
  // status (finding 1698).
  await page.evaluate(() => {
    const announced = (node) => {
      for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
        const live = el.getAttribute("aria-live");
        if (live) {
          return live !== "off";
        }
        if (["status", "alert", "log"].includes(el.getAttribute("role"))) {
          return true;
        }
      }
      return false;
    };
    globalThis.diagnosticsAnnouncements = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.type === "characterData" ? [record.target] : [...record.addedNodes];
        for (const node of nodes) {
          const text = node.textContent.trim();
          if (text && announced(node)) {
            globalThis.diagnosticsAnnouncements.push(text);
          }
        }
      }
    }).observe(globalThis.document.querySelector(".version-diagnostics"), {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  // Run it from the keyboard: the button disables itself, so focus moves to the waiting line
  // and returns to the button with the result, instead of falling to the page (finding 1705).
  const refreshRecord = versionRecord.getByRole("button", { name: "Refresh record" });
  const recordPath = `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${current.revision.id}`;
  await runDiagnostics.focus();
  await page.keyboard.press("Enter");
  try {
    await diagnosticsRequest.requested;
    await waiting.waitFor();
    assert.equal(await idle.isVisible(), false);
    assert.equal(await hasFocus(waiting), true);
    // A record read re-renders the panel (as each deployment poll does); the waiting line
    // keeps focus through it. A dispatched click leaves focus where it is.
    const recordReads = pathRequests(requests, "GET", recordPath).length;
    await refreshRecord.dispatchEvent("click");
    await refreshRecord.waitFor();
    assert.equal(pathRequests(requests, "GET", recordPath).length, recordReads + 1);
    assert.equal(await hasFocus(waiting), true);
    assert.deepEqual(await page.evaluate(() => globalThis.diagnosticsAnnouncements), [
      "Waiting for diagnostic results…",
    ]);
    assert.equal(await runDiagnostics.isDisabled(), true);
  } finally {
    diagnosticsRequest.release();
  }
  await observations.getByText(/Observed /).waitFor();
  await observations.getByText("slack / authentication").waitFor();
  assert.equal(await waiting.isVisible(), false);
  await waitForEnabled(runDiagnostics);
  assert.equal(await hasFocus(runDiagnostics), true);
  const description = () =>
    runDiagnostics.evaluate(
      (node) =>
        globalThis.document.getElementById(node.getAttribute("aria-describedby"))?.textContent,
    );
  // A record read re-renders the panel, as each deployment poll does. The button keeps focus
  // and its description through it (finding 1712).
  const pollPanel = async () => {
    const recordReads = pathRequests(requests, "GET", recordPath).length;
    await refreshRecord.dispatchEvent("click");
    await refreshRecord.waitFor();
    assert.equal(pathRequests(requests, "GET", recordPath).length, recordReads + 1);
    assert.equal(await hasFocus(runDiagnostics), true);
  };
  // The "Observed" line, not the whole check list.
  assert.match(await description(), /^Observed /);
  assert.doesNotMatch(await description(), /authentication/);
  await pollPanel();
  assert.match(await description(), /^Observed /);
  assert.equal(pathRequests(requests, "POST", diagnosticsPath).length, 1);
  // A refused run returns focus the same way, described by its alert. This route answers the
  // later diagnostics runs in this test.
  const unavailable = {
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "DEPENDENCY_UNAVAILABLE", message: "Diagnostics are unavailable." },
      meta: { requestId: "req_test_diagnostics_unavailable" },
    }),
  };
  await page.route(`${fixture.origin}${diagnosticsPath}`, (route) => route.fulfill(unavailable));
  const unavailableAlert = observations
    .getByRole("alert")
    .getByText(/Current-runtime diagnostics are unavailable/);
  await page.keyboard.press("Enter");
  await unavailableAlert.waitFor();
  assert.equal(await hasFocus(runDiagnostics), true);
  assert.match(await description(), /^Current-runtime diagnostics are unavailable/);
  await pollPanel();
  assert.match(await description(), /^Current-runtime diagnostics are unavailable/);
  // A reader who moves on while the run waits keeps their place when the result arrives.
  const movedOnRequest = await holdRequests(t, page, `${fixture.origin}${diagnosticsPath}`, {
    method: "POST",
    once: true,
    fulfill: unavailable,
  });
  await page.keyboard.press("Enter");
  try {
    await movedOnRequest.requested;
    await waiting.waitFor();
    assert.equal(await hasFocus(waiting), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await hasFocus(refreshRecord), true);
  } finally {
    movedOnRequest.release();
  }
  await unavailableAlert.waitFor();
  assert.equal(await hasFocus(refreshRecord), true);
  // That run started by dropping the earlier result's description, and nothing described the
  // button again.
  assert.equal(await runDiagnostics.getAttribute("aria-describedby"), null);
  await expectVersionRecord(page, "Completed");
  await expectDeploymentOutcome(page, "In progress", { folded: false });
  assert.ok(pathRequests(requests, "GET", deploymentPath).length >= 1);
  assert.ok(
    pathRequests(
      requests,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/deployments/${current.revision.id}`,
    ).length >= 1,
  );

  await page.getByRole("button", { name: "View version v2" }).click();
  await page.getByRole("heading", { name: "Version v2" }).waitFor();
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "View version v1" }).click();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await activity.getByText("Most recent visible deployment · v2").waitFor();
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("v3"));
  const newer = await fixture.deployAgent(namespace.id, agent.id);
  let newerStatus = "queued";
  await page.route(
    deploymentRecordUrl(fixture, namespace.id, agent.id, newer.id),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId: newer.id,
            namespaceId: namespace.id,
            agentId: agent.id,
            status: newerStatus,
            error:
              newerStatus === "failed"
                ? {
                    code: "REVISION_FINALIZATION_INCOMPLETE",
                    message: "Deployment reconciliation failed.",
                  }
                : null,
            warnings: [],
          },
          meta: { requestId: "req_test_new_deployment_activity" },
        }),
      });
    },
  );
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await activity.getByText("Most recent visible deployment · v3").waitFor();
  await page.getByRole("button", { name: "View version v3" }).waitFor();
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await overview.nth(1).getByText("v3 · Queued").waitFor();
  await fixture.activateRevision(namespace.id, agent.id, newer.id, current.revision.id);
  newerStatus = "failed";
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await overview.nth(0).getByText("v3", { exact: true }).waitFor();
  await overview.nth(1).getByText("v3 · Failed").waitFor();
  await openFailureDetails(page);
  await expectDeploymentOutcome(page, "Failed", { folded: false });
  await activity
    .getByText("REVISION_FINALIZATION_INCOMPLETE: Deployment reconciliation failed.")
    .waitFor();
  await activity
    .getByText("Deployment work failed; check the recorded error and current version.")
    .waitFor();
  await activity.getByText("Successful completion was not recorded for this deployment.").waitFor();
});

for (const unreadable of ["draft", "revision"]) {
  test(`Agent browsing isolates an unreadable ${unreadable} from other saved settings`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unreadable saved settings", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Affected Agent", nativeValues("saved"));
    await fixture.createAgent(namespace.id, "Healthy Agent", nativeValues("healthy"));
    const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const agentsPath = `/namespaces/${namespace.id}/agents`;
    const agentPath = `${agentsPath}/${agent.id}`;
    const revisionsPath = `${agentPath}/revisions`;
    const revisionPath = `${revisionsPath}/${revision.id}`;
    const degradedId = unreadable === "draft" ? agent.id : revision.id;
    const metadataFields =
      unreadable === "draft"
        ? [
            "id",
            "namespaceId",
            "name",
            "configurationId",
            "backendId",
            "executionMode",
            "servicePrincipalId",
            "activeRevisionId",
            "desiredRuntimeState",
            "status",
            "createdAt",
          ]
        : ["id", "namespaceId", "agentId", "revision", "backendId", "createdAt"];
    function unreadableProjection(value) {
      return value.id === degradedId
        ? {
            ...Object.fromEntries(
              metadataFields
                .filter((field) => Object.hasOwn(value, field))
                .map((field) => [field, value[field]]),
            ),
            configurationReadError: { code: "SAVED_CONFIGURATION_UNREADABLE", field: "plugins" },
          }
        : value;
    }
    // The real authorized response supplies the metadata. This simulates only the
    // supported degraded wire shape; PostgreSQL tests own the decode-failure proof.
    for (const path of unreadable === "draft"
      ? [agentsPath, agentPath]
      : [revisionsPath, revisionPath]) {
      await page.route(`${fixture.origin}${path}`, async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.data = Array.isArray(payload.data)
          ? payload.data.map(unreadableProjection)
          : unreadableProjection(payload.data);
        await route.fulfill({ response, json: payload });
      });
    }

    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByRole("link", { name: "Healthy Agent", exact: true }).waitFor();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: "Affected Agent", exact: true }) });
    assert.equal(
      await row.getByText("Saved configuration unreadable", { exact: true }).count(),
      unreadable === "draft" ? 1 : 0,
    );
    await row.getByRole("link", { name: "Affected Agent", exact: true }).click();
    await page.getByRole("heading", { name: "Affected Agent", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "View version v1, current version", exact: true })
      .waitFor();
    if (unreadable === "draft") {
      await page.getByRole("heading", { name: "Configuration snapshot", exact: true }).waitFor();
      await page.getByRole("button", { name: "Edit current Configuration", exact: true }).click();
    }
    await page
      .getByRole("heading", { name: "Saved configuration unreadable", exact: true })
      .waitFor();
    const tabs = [
      "Configuration",
      "Plugins",
      "Channels",
      ...(unreadable === "draft" ? ["Credentials"] : []),
    ];
    for (const tab of tabs) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      await page
        .getByRole("heading", { name: "Saved configuration unreadable", exact: true })
        .waitFor();
      await page.getByText(/Saved plugin selections could not be read/).waitFor();
      for (const name of [
        "Deploy new version",
        "Edit Configuration",
        "Save plugin selections",
        "Save authentication source",
      ]) {
        assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
      }
    }
    if (unreadable === "draft") {
      assert.equal(
        pathRequests(
          requests,
          "GET",
          `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        ).length,
        0,
      );
      await page
        .getByRole("button", { name: "View version v1, current version", exact: true })
        .click();
      await page.getByRole("heading", { name: "Configuration snapshot", exact: true }).waitFor();
    } else {
      await page.getByRole("button", { name: "Create new version", exact: true }).first().click();
      await page.getByRole("button", { name: "Edit Configuration", exact: true }).waitFor();
    }
    assert.equal(
      await page
        .getByRole("heading", { name: "Saved configuration unreadable", exact: true })
        .count(),
      0,
    );
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

test("Configuration save stops when fresh Agent settings become unreadable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unreadable during edit", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Editing Agent", nativeValues("saved"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill(JSON.stringify(nativeValues("changed")));

  // A saved Agent can become unreadable after the editor opens. The independent
  // Configuration PATCH must not proceed using the stale Agent draft.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const field of ["harnessAuth", "plugins", "pluginApprovers", "repositoryBindings"]) {
        delete payload.data[field];
      }
      payload.data.configurationReadError = {
        code: "SAVED_CONFIGURATION_UNREADABLE",
        field: "plugins",
      };
      await route.fulfill({ response, json: payload });
    },
  );
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await page.getByText(/Saved plugin selections could not be read/).waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // Another Agent in this Namespace may use this very Configuration. A successful read of
  // that Agent is not preflight for saving this one, even when the generation still matches.
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  await page.unroute(agentUrl);
  await page.route(agentUrl, (route) => replyWithDifferentAgentId(route, agent.id, 200));
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  const refused = page.getByText(READ_UNAVAILABLE, {
    exact: true,
  });
  const incorrectlySaved = page.getByText("Configuration saved.", { exact: true });
  await refused.or(incorrectlySaved).first().waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(await refused.isVisible(), true);
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(saved.data.values, nativeValues("saved"));
});

test("Configuration save names the field that holds an inline model credential without showing it", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Inline credential", { ready: true });
  const values = nativeValues("inline-credential");
  const agent = await fixture.createAgent(namespace.id, "Inline credential Agent", values);
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  // A pasted provider key is a value, not the Secret reference the field requires.
  const sentinel = `synthetic-inline-key-${randomUUID()}`;
  const edited = structuredClone(values);
  edited.models = {
    ...edited.models,
    providers: { ...edited.models?.providers, openai: { apiKey: sentinel } },
  };
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(edited, null, 2));
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${agent.configurationId}`),
  );
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  assert.equal((await rejected).status(), 400);
  const feedback = page.getByText(
    "Configuration field /models/providers/openai/apiKey holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
  );
  await feedback.waitFor();
  // Only the editor holds the key; the explanation never repeats it.
  assert.equal((await feedback.textContent()).includes(sentinel), false);
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(saved.data.values, values);
});

test("Agent deployment shows the API's reason when it rejects the saved model", async (t) => {
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Unqualified model", {
    configurationDriver,
  });
  const values = nativeValues("unqualified-model");
  const agent = await fixture.createAgent(namespace.id, "Unqualified model Agent", values, {
    harnessAuth: { method: "runtime" },
  });
  const bare = {
    ...values,
    agents: { ...values.agents, defaults: { ...values.agents.defaults, model: "gpt-5.1" } },
  };
  const reason =
    "Configuration setting agents.defaults.model must name each model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1.";
  // Save refuses a bare model name with deployment's text (finding 1828).
  const saved = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { body: { values: bare } },
  );
  assert.equal(saved.status, 400, JSON.stringify(saved.body));
  assert.equal(saved.body.error.message, reason);
  // A row an older release saved with it still reads, and deployment refuses it.
  const stored = configurationDriver.stored({
    namespaceId: namespace.id,
    id: agent.configurationId,
  });
  assert.ok(stored);
  await configurationDriver.update({ ...stored, values: bare });
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/agents/${agent.id}/deploy`),
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  assert.equal((await rejected).status(), 400);
  // The generic "check the entered values" text cannot tell the user which setting to fix.
  await page.getByText(reason, { exact: true }).waitFor();
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.deepEqual(revisions.data, []);
});

test("Plugin save distinguishes a refusal, a stale read, and an unconfirmed success", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Plugin rejection", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Plugin rejection Agent",
    nativeValues("plugin-rejection", { harnessId: "codex" }),
    { executionMode: "dedicated", harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  const pluginId = "codex-plugin:linear@openai-curated-remote";
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page
    .getByLabel("Plugin selections JSON", { exact: true })
    .fill(JSON.stringify({ [pluginId]: { enabled: "yes" } }));
  const collection = `/namespaces/${namespace.id}/agents`;
  const agentPath = `${collection}/${agent.id}`;
  const agentUrl = `${fixture.origin}${agentPath}`;
  const patched = (response) =>
    response.request().method() === "PATCH" && response.url() === agentUrl;
  const save = page.getByRole("button", { name: "Save plugin selections", exact: true });

  // A 400 without a server sentence keeps the plugin-specific text, not the generic one.
  const unexplained = async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INVALID_REQUEST" } }),
    });
  };
  await page.route(agentUrl, unexplained);
  const unexplainedResponse = page.waitForResponse(patched);
  await save.click();
  assert.equal((await unexplainedResponse).status(), 400);
  await page
    .getByText("Plugin selections were rejected. Check plugin IDs and policy JSON, then retry.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByText("Check the entered values", { exact: false }).count(), 0);
  await page.unroute(agentUrl, unexplained);
  await page.getByRole("button", { name: "Save plugin selections", disabled: false }).waitFor();

  const rejected = page.waitForResponse(patched);
  await save.click();
  const response = await rejected;
  assert.equal(response.status(), 400);
  // The API's sentence names the field; the generic text only says the selections were rejected.
  const reason = (await response.json()).error.message;
  assert.equal(
    reason,
    `The request does not match the operation contract: body /plugins/${pluginId}/enabled has the wrong type (expected boolean).`,
  );
  await page.getByText(reason, { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Plugin selections were rejected.", { exact: false }).count(),
    0,
  );
  const saved = await fixture.request("GET", agentPath);
  assert.deepEqual(saved.data.plugins ?? {}, {});

  // Two real Agents can share a Configuration and the same saved selections. Substitute only
  // the response data: before a write it must stop the save; after one it cannot confirm it.
  const other = await fixture.request("POST", collection, {
    body: {
      name: "Other plugin Agent",
      configurationId: agent.configurationId,
      executionMode: "dedicated",
      harnessAuth: null,
    },
  });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  assert.notEqual(other.data.id, agent.id);
  for (const field of ["namespaceId", "configurationId", "plugins", "pluginApprovers"]) {
    assert.deepEqual(other.data[field], saved.data[field]);
  }
  const policy = { toolDefaults: { approval: "all_actions" }, enabled: true };
  const edits = { [pluginId]: policy };
  const editor = page.getByLabel("Plugin selections JSON", { exact: true });
  const requests = apiRequests(page, fixture.origin);
  for (const [method, replyData] of [
    ["GET", () => other.data],
    [
      "PATCH",
      async (data) => {
        const otherAgent = await fixture.updateAgent(namespace.id, other.data.id, {
          configurationId: agent.configurationId,
          plugins: edits,
        });
        assert.deepEqual(data.plugins, otherAgent.plugins);
        return otherAgent;
      },
    ],
    ["PATCH", ({ id, namespaceId, configurationId }) => ({ id, namespaceId, configurationId })],
    ["PATCH", (data) => ({ ...data, plugins: {} })],
    ["PATCH", (data) => ({ ...data, pluginApprovers: [] })],
    // The last reply confirms the exact settings with a different object key order. The plugin
    // editor must not replace the rest of the Agent (represented here by its name) from that reply.
    ["PATCH", null],
  ]) {
    const beforeWrite = method === "GET";
    const expected = beforeWrite ? {} : edits;
    const confirmed = replyData === null;
    requests.length = 0;
    if (!(await editor.isVisible())) {
      await page.getByText("Plugin selections JSON", { exact: true }).click();
    }
    await page.route(agentUrl, async (route) => {
      if (route.request().method() !== method) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const body = await response.json();
      assert.equal(body.data.id, agent.id);
      assert.deepEqual(body.data.plugins ?? {}, expected);
      const data = confirmed
        ? {
            ...body.data,
            name: "Unrelated acknowledgement field",
            plugins: { [pluginId]: { enabled: true, toolDefaults: policy.toolDefaults } },
          }
        : await replyData(body.data);
      await route.fulfill({ response, json: { ...body, data } });
    });
    await editor.fill(JSON.stringify(edits));
    const previous = await editor.elementHandle();
    await save.click();
    if (confirmed) {
      // Wait for the rebuilt editor, not the first confirmation on the editor being replaced.
      await page.waitForFunction((node) => !node.isConnected, previous);
    }
    const message = beforeWrite
      ? "Plugin selections changed. Reload this Agent before saving again."
      : "Outcome unknown. Plugin selections may have been saved. Reload this Agent before trying again.";
    const outcome = page
      .getByText(message, { exact: true })
      .or(page.getByText("Plugin selections saved.", { exact: true }));
    await outcome.waitFor();
    assert.equal(await outcome.textContent(), confirmed ? "Plugin selections saved." : message);
    if (!confirmed) {
      assert.equal(await editor.inputValue(), JSON.stringify(edits));
    }
    assert.equal(await save.isDisabled(), true);
    assert.equal(
      await page.getByRole("heading", { name: agent.name, exact: true }).isVisible(),
      true,
    );
    await page.unroute(agentUrl);

    // Reconcile an unconfirmed result by reading, never by repeating the PATCH.
    if (!confirmed) {
      await page.getByRole("button", { name: "Reload plugin selections", exact: true }).click();
      await page.getByText("Plugin selections reloaded.", { exact: true }).waitFor();
    }
    assert.deepEqual(JSON.parse(await editor.inputValue()), expected);
    assert.deepEqual((await fixture.request("GET", agentPath)).data.plugins ?? {}, expected);
    assert.deepEqual(
      pathRequests(requests, "PATCH", agentPath).map(({ body }) => body.plugins),
      beforeWrite ? [] : [edits],
    );
  }
});

test("Agent sharing shows a rejected write's reason, but generic text after an accepted write", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["sharing-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing rejection");
  const agent = await fixture.createAgent(namespace.id, "Sharing Agent", nativeValues("sharing"));
  const { page } = await newPage(t, fixture);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const policyPath = `${fixture.origin}/namespaces/${namespace.id}/iam`;
  const reason = "The request does not match the operation contract: body /name is too long.";
  // The real API accepts these writes, so a 400 naming a field is simulated for one request.
  const reject = async (route) => {
    if (route.request().method() === "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "INVALID_REQUEST", message: reason },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000999" },
      }),
    });
  };
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel
    .getByLabel("Existing person’s Principal ID")
    .fill(fixture.provisionedAccounts[0].principal.id);
  await panel.getByRole("checkbox").check();

  // The first write (the discovery Role) is rejected: its reason is shown.
  await page.route(`${policyPath}/roles`, reject);
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText(reason, { exact: false }).waitFor();
  assert.equal(await panel.getByText("Check the entered values", { exact: false }).count(), 0);
  await page.unroute(`${policyPath}/roles`, reject);

  // The Role is created, then its binding is rejected: the outcome is partial, so generic text.
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
  await page.route(`${policyPath}/access-bindings`, reject);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Check the entered values and resource IDs", { exact: false }).waitFor();
  assert.equal(await panel.getByText(reason, { exact: false }).count(), 0);
  const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  assert.equal(roles.data.length, 1);

  // The discovery Role now exists, so its rejected binding is the first write: reason shown.
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText(reason, { exact: false }).waitFor();
  assert.equal(await panel.getByText("Check the entered values", { exact: false }).count(), 0);
  await page.unroute(`${policyPath}/access-bindings`, reject);

  // A rejected binding removal also shows its reason.
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  const bindings = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(bindings.data.length, 2);
  await page.route(`${policyPath}/access-bindings/*`, reject);
  const removeBinding = panel.getByRole("button", { name: "Remove binding", exact: true });
  // Removal deletes the binding at once, so it takes the destructive tone (finding 1967).
  assert.match(await removeBinding.getAttribute("class"), /\bbutton--danger\b/);
  await removeBinding.click();
  await panel.getByText(reason, { exact: false }).waitFor();
  assert.equal(await panel.getByText("Check the entered values", { exact: false }).count(), 0);
  assert.equal(await panel.getByText("Binding removed.", { exact: false }).count(), 0);
});

test("Gateway password access saves the generated reference without changing admitted versions or Secret bindings", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Gateway password", { ready: true });
  const values = nativeAdminValues("gateway-password", "http://127.0.0.1:18789");
  values.gateway.auth.rateLimit = { maxAttempts: 5 };
  const agent = await fixture.createAgent(namespace.id, "Gateway password Agent", values);
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const secret = await fixture.createSecret(namespace.id, "External API token", "fixture-token");
  const secretBindings = {
    EXTERNAL_API_TOKEN: { source: secret.ref, delivery: { type: "env" } },
  };
  await fixture.updateConfiguration(namespace.id, agent.configurationId, values, {
    secretBindings,
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url);
  requests.length = 0;
  const enable = page.getByRole("button", { name: "Enable gateway password access", exact: true });
  await enable.click();
  const expected = structuredClone(values);
  expected.gateway.auth.password = {
    source: "env",
    provider: "default",
    id: "OPENCLAW_GATEWAY_PASSWORD",
  };
  assert.deepEqual(JSON.parse(await page.getByLabel("Configuration JSON").inputValue()), expected);
  // The editor replaces the pressed button and takes focus (finding 1620).
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "configuration-json",
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await enable.click();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${agent.configurationId}`),
  );
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page
    .getByText(
      "Gateway password access is enabled in the saved Configuration. Deploy a new version to apply it.",
    )
    .waitFor();
  assert.equal(await enable.count(), 0);
  const current = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(current.data.values, expected);
  assert.deepEqual(current.data.secretBindings, secretBindings);
  const unchanged = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${first.revision.id}`,
  );
  assert.deepEqual(unchanged.data.configuration, first.revision.configuration);
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .activeRevisionId,
    first.revision.id,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 1);
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await page.getByRole("button", { name: "Edit current Configuration", exact: true }).waitFor();
  assert.equal(await enable.count(), 0);

  // A fresh Agent whose v1 was admitted from this exact Configuration generation needs no redeploy.
  const fresh = await fixture.createAgent(namespace.id, "Gateway password fresh Agent", expected);
  const freshV1 = await fixture.seedActiveAgentRevision(namespace.id, fresh.id);
  assert.deepEqual(
    freshV1.revision.configuration.gateway.auth.password,
    expected.gateway.auth.password,
  );
  const freshUrl = detailUrl(fixture, namespace.id, fresh.id, "draft", "configuration");
  await page.goto(freshUrl.href);
  await page
    .getByText(
      `Gateway password access is enabled in the saved Configuration and included in v${freshV1.revision.revision}.`,
    )
    .waitFor();
  assert.equal(await page.getByText(/Deploy a new version to apply it/).count(), 0);
});

test("Agent detail preserves admitted revision history while draft edits change current configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision history", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "External API token", "hidden-token");
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Revisioned Agent",
    nativeValues("rev-one"),
  );
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const generationTwo = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("rev-two"),
  );
  assert.equal(generationTwo.generation, 2);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  const draft = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("draft-current"),
    { secretBindings },
  );
  assert.equal(draft.generation, 3);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  requests.length = 0;

  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "rev-two"|"marker": "draft-current"/, () =>
    waitForIdleFetches(page),
  );

  await page.getByRole("button", { name: "View version v2" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === second.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-two"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "draft-current"/, () =>
    waitForIdleFetches(page),
  );
  assertRevisionUrl(page, second.revision.id);

  await page.getByRole("button", { name: "View version v1" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  assertRevisionUrl(page, first.revision.id);

  await page.getByRole("button", { name: "Create new version" }).last().click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-current"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/, () =>
    waitForIdleFetches(page),
  );
  assertRevisionUrl(page, "draft");

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  assert.match(await editor.inputValue(), /"marker": "draft-current"/);
  const editorError = page.locator("#configuration-json-error");
  for (const [invalidJson, message] of [
    ["{ invalid", "Invalid JSON at line 1, column 3. Enter a valid JSON object."],
    ["[]", "Enter a valid JSON object, not an array or a single value."],
  ]) {
    await editor.fill(invalidJson);
    await page.getByRole("button", { name: "Save Configuration" }).click();
    // One persistent message under the editor, linked to it; no browser bubble (finding 1903).
    await editorError.getByText(message, { exact: true }).waitFor();
    assert.equal(await editor.getAttribute("aria-invalid"), "true");
    assert.match(await editor.getAttribute("aria-describedby"), /\bconfiguration-json-error\b/);
    assert.equal(await editor.evaluate((node) => node.validationMessage), "");
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement?.id),
      "configuration-json",
    );
  }
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await editor.fill(JSON.stringify(nativeValues("stale-client"), null, 2));
  assert.equal(await editorError.isHidden(), true);
  assert.equal(await editor.getAttribute("aria-invalid"), null);
  const stale = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("stale-server"),
  );
  assert.equal(stale.generation, 4);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await waitForLiveControls(page, ["configuration-json"]);
  assert.match(await editor.inputValue(), /stale-client/);
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText(SAVED_CONFIGURATION_CHANGED).waitFor();
  // A conflict is an error, not a hint (finding 1903).
  const feedback = page.locator("#configuration-editor-feedback");
  assert.equal(await feedback.getAttribute("class"), "status");
  assert.equal(await feedback.getAttribute("data-tone"), "danger");
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await page.reload();
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editedValues = nativeValues("draft-edited");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(editedValues, null, 2));
  await page.getByText("Save or cancel these Configuration edits before deploying.").waitFor();
  await page.getByText(CONFIGURATION_EDITS_PENDING).waitFor();
  // Tabs, admitted revision browsing, and global routes preserve this exact unsaved draft.
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  await page.getByLabel("Available versions").selectOption(second.revision.id);
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await waitForLiveControls(page, ["configuration-json"]);
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await waitForLiveControls(page, ["configuration-json"]);
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);
  const savedConfiguration = page.waitForResponse(
    (response) =>
      response.url() ===
        `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  assert.equal((await savedConfiguration).status(), 200);
  await page.getByText(/generation 5/).waitFor();
  const patched = configurationPatchRequests(requests, namespace.id, agent.configurationId);
  assert.deepEqual(
    patched.map((request) => request.body),
    [{ values: editedValues, expectedGeneration: 4 }],
  );
  const currentConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(currentConfiguration.status, 200);
  assert.equal(currentConfiguration.data.generation, 5);
  assert.deepEqual(currentConfiguration.data.values, editedValues);
  assert.deepEqual(currentConfiguration.data.secretBindings, secretBindings);

  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "draft-edited"|"marker": "stale-server"/, () =>
    waitForIdleFetches(page),
  );
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  // Edit current Configuration opens the draft's editor on the saved document (finding 2061).
  await waitForLiveControls(page, ["configuration-json"]);
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);

  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Authentication source").selectOption("");
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await waitForLiveControls(page, ["harness-auth-method"]);
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saved).status(), 200);
  await page
    .getByText("Select a harness authentication source in Credentials before deployment.")
    .waitFor();
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.harnessAuth, null);
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await page
    .getByRole("link", {
      name: "Auth Revisioned Agent",
      exact: true,
    })
    .waitFor();
  // Cancel discards the retained baseline too: reopening uses the freshly read saved document.
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await waitForLiveControls(page, ["configuration-json"]);
  await editor.fill(JSON.stringify(nativeValues("discard-this-edit")));
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeValues("cancel-server"),
  );
  await page.goBack();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  assert.match(await editor.inputValue(), /"marker": "cancel-server"/);
  await editor.fill(JSON.stringify(nativeValues("after-cancel")));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText(/generation 7/).waitFor();
});

test("Agent detail saves plugin changes for the next revision without changing admitted revisions", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Plugin revision editing", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Plugin Revision Agent",
    nativeValues("plugin-revision", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const tokenSecret = await fixture.createSecret(
    namespace.id,
    "Plugin Revision Service Accounts token",
    "at-browser-plugin-revision",
  );
  await fixture.grantAgentSecretOperate(agent, tokenSecret.ref);
  const pluginId = "codex-plugin:linear@openai-curated-remote";
  const originalPlugins = {
    [pluginId]: { enabled: true, toolDefaults: { approval: "all_actions" } },
  };
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "codex_pat", source: tokenSecret.ref },
    plugins: originalPlugins,
  });
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  assert.deepEqual(first.revision.plugins?.plugins, originalPlugins);
  const { page } = await newPage(t, fixture);
  const originalFetch = globalThis.fetch;
  const hostedCalendar = {
    id: "remote-calendar",
    name: "calendar",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Calendar",
      description: "Hosted calendar plugin",
      interface: { short_description: "Calendar tools" },
      requires_local_executor: false,
      app_ids: ["app_calendar"],
      skills: [],
      mcp_servers: [],
    },
  };
  // Only external catalog HTTP is simulated; Console, OCC, and the selected Driver are real.
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const upstream = new URL(typeof input === "string" ? input : (input.url ?? input));
    if (upstream.hostname === "auth.openai.com") {
      return Response.json({
        chatgpt_account_id: "account-plugin-revision-test",
        chatgpt_account_is_fedramp: false,
      });
    }
    if (upstream.hostname !== "chatgpt.com") {
      return originalFetch(input, options);
    }
    if (upstream.pathname.endsWith("/plugins/search")) {
      assert.equal(upstream.searchParams.get("q"), "calendar");
      return Response.json({ plugins: [hostedCalendar], pagination: { next_page_token: null } });
    }
    if (upstream.pathname.endsWith("/plugins/list")) {
      return Response.json({ plugins: [hostedCalendar], pagination: { next_page_token: null } });
    }
    if (upstream.pathname.endsWith("/plugins/remote-calendar")) {
      return Response.json(hostedCalendar);
    }
    assert.equal(upstream.pathname, "/backend-api/ps/apps/batch");
    return Response.json({
      apps: [
        {
          id: "app_calendar",
          status: "ENABLED",
          tools: [
            {
              name: "events/list",
              title: "List events",
              description: "Read events",
              is_enabled: true,
              is_read_only: true,
            },
            {
              name: "events/create",
              title: "Create event",
              description: "Create a calendar event",
              is_enabled: true,
              is_read_only: false,
            },
          ],
        },
      ],
    });
  });
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  const capabilitiesRead = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/plugins/capabilities`,
  );

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Plugin Revision Agent" }).waitFor();
  await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
  const json = page.getByLabel("Plugin selections JSON", { exact: true });
  assert.deepEqual(JSON.parse(await json.inputValue()), originalPlugins);
  requests.length = 0;

  // The draft edits Agent-owned selections. The admitted revision remains immutable.
  assert.equal(await page.getByLabel("Service account token for plugin discovery").count(), 0);
  const pluginListPath = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;
  // Until the policy capabilities answer, the catalog is still being checked and nothing is
  // fetched from it.
  await capabilitiesRead.requested;
  await nextFrames(page);
  assert.equal(
    await page.locator(".plugin-browser-status [role=status]").textContent(),
    "Checking plugin catalog availability…",
  );
  assert.equal(pathRequests(requests, "POST", pluginListPath).length, 0);
  const prefetched = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${pluginListPath}` &&
      response.request().method() === "POST",
  );
  capabilitiesRead.release();
  assert.equal((await prefetched).status(), 200);
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  assert.equal(await dialog.isVisible(), false);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]').waitFor();
  assert.equal(
    await dialog
      .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"] summary code')
      .textContent(),
    "app_calendar/events%2Flist",
  );
  // Opening the picker reuses the first page already fetched with the saved Agent credential.
  assert.deepEqual(
    pathRequests(requests, "POST", pluginListPath).map(({ body }) => body),
    [{}],
  );
  assert.deepEqual(
    pathRequests(requests, "POST", `${pluginListPath}/details`).map(({ body }) => body),
    [{ pluginId: "remote-calendar" }],
  );
  const toolFilter = dialog.getByRole("searchbox", { name: "Filter tools" });
  await toolFilter.click();
  await page.keyboard.type("create");
  assert.equal(await toolFilter.inputValue(), "create");
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Fcreate"]')
    .waitFor();
  assert.equal(
    await dialog
      .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]')
      .isVisible(),
    false,
  );
  await toolFilter.fill("");
  await dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]').waitFor();
  await dialog.getByRole("button", { name: "Add Calendar", exact: true }).click();
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"] summary')
    .click();
  await dialog.getByLabel("Enable List events", { exact: true }).selectOption("false");
  const searched = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${pluginListPath}` &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.q === "calendar",
  );
  await dialog.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
  assert.equal((await searched).status(), 200);
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  // The saved override can render before the new detail response. Wait for a
  // catalog-only tool before switching tabs, which cancels pending discovery.
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Fcreate"]')
    .waitFor();
  await dialog
    .locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"] summary')
    .click();
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`Enable ${pluginId}`, { exact: true }).uncheck();

  // Each picker tab retains its own selection, query and tool details. Switching
  // tabs must not fetch another catalog page or change the surrounding draft.
  const configuredFilter = dialog.getByRole("searchbox", { name: "Filter configured plugins" });
  await configuredFilter.fill("linear");
  const selectedJson = await json.inputValue();
  const discoveryBeforeSwitch = requests.filter(
    ({ method, path }) => method === "POST" && path.startsWith(pluginListPath),
  );
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  await dialog.getByRole("heading", { name: "Calendar", exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Search plugins" }).inputValue(),
    "calendar",
  );
  const listRow = dialog.locator('details.plugin-tool-row[data-tool="app_calendar/events%2Flist"]');
  const createRow = dialog.locator(
    'details.plugin-tool-row[data-tool="app_calendar/events%2Fcreate"]',
  );
  assert.equal(await listRow.getAttribute("open"), "");
  await toolFilter.fill("list");
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("heading", { name: pluginId, exact: true }).waitFor();
  assert.equal(await configuredFilter.inputValue(), "linear");
  await configuredFilter.fill("calendar");
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  assert.equal(await toolFilter.inputValue(), "");
  assert.equal(await listRow.getAttribute("open"), null);
  await toolFilter.fill("create");
  await createRow.locator("summary").click();
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  assert.equal(await toolFilter.inputValue(), "list");
  assert.equal(await listRow.getAttribute("open"), "");
  assert.equal(await createRow.isVisible(), false);
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  assert.equal(await configuredFilter.inputValue(), "calendar");
  assert.equal(await toolFilter.inputValue(), "create");
  assert.equal(await createRow.getAttribute("open"), "");
  assert.equal(await listRow.isVisible(), false);
  assert.equal(await json.inputValue(), selectedJson);
  assert.deepEqual(
    requests.filter(({ method, path }) => method === "POST" && path.startsWith(pluginListPath)),
    discoveryBeforeSwitch,
  );

  // A catalog entry is not a Configured selection after removal. Restoring the
  // original draft through its supported JSON editor must not revive stale UI.
  await dialog.getByRole("button", { name: "Remove Calendar", exact: true }).click();
  assert.equal(await dialog.getByRole("heading", { name: "Calendar", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  await dialog.getByRole("heading", { name: "Calendar", exact: true }).waitFor();
  assert.equal(await toolFilter.inputValue(), "list");
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  assert.equal(await dialog.getByRole("heading", { name: "Calendar", exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByText("Plugin selections JSON", { exact: true }).click();
  await json.fill(selectedJson);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  assert.equal(await toolFilter.inputValue(), "");
  assert.equal(await createRow.getAttribute("open"), null);
  // Like Done, a backdrop dismissal preserves plugin choices in the surrounding draft.
  const pluginBounds = await dialog.boundingBox();
  assert.ok(pluginBounds);
  await page.mouse.click(pluginBounds.x / 2, pluginBounds.y + 8);
  await dialog.waitFor({ state: "hidden" });
  await page.locator("button:focus").filter({ hasText: "Configure plugins" }).waitFor();
  const editedPlugins = {
    [pluginId]: { enabled: false, toolDefaults: { approval: "all_actions" } },
    "codex-plugin:calendar@openai-curated-remote": {
      enabled: true,
      tools: { "app_calendar/events%2Flist": { enabled: false } },
    },
  };
  assert.deepEqual(JSON.parse(await json.inputValue()), editedPlugins);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.deepEqual(
    pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`),
    [],
  );

  const rejectedStatuses = [501, 403];
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    async (route) => {
      if (route.request().method() !== "PATCH" || rejectedStatuses.length === 0) {
        await route.continue();
        return;
      }
      const status = rejectedStatuses.shift();
      const requestId = "req_00000000-0000-4000-8000-000000000434";
      await route.fulfill(
        status === 501
          ? apiErrorResponse(501, "NOT_IMPLEMENTED", "No selected Plugin Driver", { requestId })
          : apiErrorResponse(403, "FORBIDDEN", "Agent update denied", { requestId }),
      );
    },
  );
  const unavailableResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await unavailableResponse).status(), 501);
  await page
    .getByText(
      "This Installation has no compatible Plugin Driver for these selections. Ask an operator to select or configure one, then retry.",
    )
    .waitFor();
  assert.deepEqual(JSON.parse(await json.inputValue()), editedPlugins);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  const deniedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await deniedResponse).status(), 403);
  await page.getByText(AGENT_SAVE_DENIED).waitFor();
  assert.deepEqual(JSON.parse(await json.inputValue()), editedPlugins);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  const beforeRetry = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  assert.deepEqual(beforeRetry.data.plugins, originalPlugins);

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await saveResponse).status(), 200);
  assert.deepEqual(
    pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`).map(
      ({ body }) => body.plugins,
    ),
    [editedPlugins, editedPlugins, editedPlugins],
  );
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(saved.data.plugins, editedPlugins);

  await page.reload();
  await page.getByRole("heading", { name: "Plugins", exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    editedPlugins,
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  await page.waitForURL(
    (current) => current.searchParams.get("revision")?.startsWith("rev_") === true,
  );
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 2);
  // The list carries summaries; each revision's plugin snapshot is on its exact read.
  const pluginSnapshot = async (id) =>
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${encodeURIComponent(id)}`,
      )
    ).data.plugins?.plugins;
  assert.deepEqual(await pluginSnapshot(first.revision.id), originalPlugins);
  assert.deepEqual(
    await pluginSnapshot(revisions.data.find(({ id }) => id !== first.revision.id).id),
    editedPlugins,
  );

  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("pre").textContent()), editedPlugins);
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await page.waitForURL((current) => current.searchParams.get("revision") === first.revision.id);
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("pre").textContent()), originalPlugins);
  assert.equal(await page.getByRole("button", { name: "Save plugin selections" }).count(), 0);
});

// A plugin save rebuilds the page. Rebuilding from the Agent the draft loaded, instead of the save
// response, showed a Stop requested on the same page as running again. A deployment that finished
// since page load takes the same path; this case covers Stop.
test("Plugin save keeps a Stop requested on the same page", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Plugin save after stop");
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const agent = await fixture.createAgent(namespace.id, "Stopped Plugins", nativeValues("stop"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins").href);
  await page.getByRole("heading", { name: "Stopped Plugins", exact: true }).waitFor();

  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  const stop = stopRegion.getByRole("button", { name: "Stop Agent", exact: true });
  await waitForEnabled(stop);
  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  const repeat = stopRegion.getByRole("button", { name: "Request Stop again", exact: true });
  await repeat.waitFor();

  const plugins = { "codex-plugin:linear@openai-curated-remote": { enabled: false } };
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page.getByLabel("Plugin selections JSON", { exact: true }).fill(JSON.stringify(plugins));
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Plugin selections saved." }).waitFor();
  // The save rereads permissions and the draft, then rebuilds the tab.
  await waitForIdleFetches(page);

  const saved = (await fixture.request("GET", path)).data;
  assert.deepEqual(saved.plugins, plugins);
  assert.equal(saved.desiredRuntimeState, "stopped");
  assert.equal(saved.activeRevisionId, active.revision.id);
  // The rebuilt page still shows the stop request instead of offering a first Stop again.
  await repeat.waitFor();
  assert.equal(await stop.count(), 0);
  await page
    .getByRole("region", { name: "Agent state at a glance" })
    .getByText("Stop requested", { exact: true })
    .waitFor();
});

test("Plugin picker clears tab memory when its catalog or credential scope is reset", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/agents");
  // Sign-in reloads the page after its session check, and that reload closes every open
  // dialog in the document: mount the picker once the Agents page has settled.
  await page.locator(settledView).waitFor();
  // Exercise the same component API used by discovery.reset(), without real
  // credentials or a second implementation of catalog/request handling.
  await page.evaluate(async () => {
    const { createPluginFields } = await import("/console/agents/plugin-fields.mjs");
    const input = globalThis.document.createElement("textarea");
    input.id = "scope-plugin-selections";
    input.value = JSON.stringify({ calendar: { enabled: true }, documents: { enabled: true } });
    const entries = [
      { id: "calendar", name: "Calendar", tools: [{ id: "read", name: "Read events" }] },
      { id: "documents", name: "Documents", tools: [{ id: "read", name: "Read documents" }] },
    ];
    const catalog = { status: "ready", canLoad: true, entries, knownEntries: entries };
    const loads = [];
    let cancellations = 0;
    const fields = createPluginFields({
      input,
      catalog,
      onLoadPlugins: (...args) => loads.push(args),
      onCancelDiscovery: () => {
        cancellations += 1;
      },
    });
    fields.section.id = "scope-plugin-picker";
    globalThis.document.body.append(fields.section);
    globalThis.pluginScopeFixture = { fields, catalog, loads, cancellations: () => cancellations };
  });
  const picker = page.locator("#scope-plugin-picker");
  await picker.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = picker.getByRole("dialog");
  await dialog.getByRole("button", { name: "Calendar", exact: true }).click();
  await dialog.locator('details[data-tool="read"] summary').click();
  await dialog.getByRole("searchbox", { name: "Filter tools" }).fill("events");
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: "Documents", exact: true }).click();
  // Tool IDs are shared across plugins; expansion must not cross that identity.
  assert.equal(await dialog.locator('details[data-tool="read"]').getAttribute("open"), null);
  await dialog.getByRole("searchbox", { name: "Filter tools" }).fill("documents");
  await dialog.getByRole("searchbox", { name: "Filter configured plugins" }).fill("documents");
  await page.evaluate(() => {
    const { fields, catalog } = globalThis.pluginScopeFixture;
    fields.setCatalog({ ...catalog, entries: [catalog.entries[1]] });
  });
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  assert.equal(await dialog.getByRole("heading", { name: "Calendar", exact: true }).count(), 0);
  assert.equal(await dialog.getByRole("searchbox", { name: "Filter tools" }).count(), 0);
  await dialog.getByRole("searchbox", { name: "Search plugins" }).fill("new query");
  assert.deepEqual(await page.evaluate(() => globalThis.pluginScopeFixture.loads), [
    ["search", "new query"],
  ]);
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Filter tools" }).inputValue(),
    "documents",
  );
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Filter configured plugins" }).inputValue(),
    "documents",
  );
  assert.equal(await page.evaluate(() => globalThis.pluginScopeFixture.cancellations()), 2);
  await page.evaluate(() => globalThis.pluginScopeFixture.fields.resetSearch());
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Filter configured plugins" }).inputValue(),
    "",
  );
  assert.equal(await dialog.getByRole("searchbox", { name: "Filter tools" }).count(), 0);
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  assert.equal(await dialog.getByRole("searchbox", { name: "Search plugins" }).inputValue(), "");
  assert.equal(await dialog.getByRole("searchbox", { name: "Filter tools" }).count(), 0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
});

test("Agent draft plugin browsing explains a missing hosted credential", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Plugin discovery credential", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Hosted plugin Agent",
    nativeValues("plugin-discovery-auth", { harnessId: "codex" }),
    // No API key: Codex serves plugins only to ChatGPT logins.
    { executionMode: "dedicated", harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog
    .getByText(
      "Hosted plugin browsing requires a saved ChatGPT login or Service Accounts token Secret. Select it under Credentials, or edit existing plugin selections.",
    )
    .waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Load plugins" }).isDisabled(), true);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/plugins`).length,
    0,
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
});

test("Agent draft plugin picker warns that API-key Codex Agents cannot use plugins", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("API-key plugins", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "API-key plugin Agent",
    nativeValues("api-key-plugins", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  assert.equal(agent.harnessAuth.method, "api_key");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  await page
    .getByText(
      "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED).",
      { exact: false },
    )
    .waitFor();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByText("Plugin browsing is unavailable with API-key authentication.").waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Load plugins" }).isDisabled(), true);
  // The empty list must not tell the user to load a catalog they cannot load.
  await dialog
    .getByText("To add a plugin by ID, choose Done and edit Plugin selections JSON.")
    .waitFor();
  assert.equal(await dialog.getByText("Load plugins to browse available choices.").count(), 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/plugins`).length,
    0,
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
});

test("Agent draft browses the curated catalog without a saved Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Curated revision plugins", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Curated plugin Agent",
    nativeValues("curated-revision", { harnessId: "codex" }),
    // No API key: Codex serves plugins only to ChatGPT logins.
    { executionMode: "dedicated", harnessAuth: null },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  const linear = dialog.getByRole("button", { name: "Linear", exact: true });
  await linear.waitFor();
  assert.equal(pathRequests(requests, "GET", "/installation").length, 0);
  const catalogPath = `/namespaces/${namespace.id}/agents/${agent.id}/plugins`;
  assert.deepEqual(
    pathRequests(requests, "POST", catalogPath).map(({ body }) => body),
    [{}],
  );
  // The shared search UI must use the saved-Agent route without supplying a credential.
  const searched = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${catalogPath}` &&
      response.request().postDataJSON()?.q === "linear",
  );
  await dialog.getByLabel("Search plugins", { exact: true }).fill("linear");
  assert.equal((await searched).status(), 200);
  await dialog.locator('.plugin-list[aria-busy="false"]').waitFor();
  assert.deepEqual(
    await dialog
      .locator(".plugin-list-item")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
    ["Linear"],
  );
  assert.deepEqual(pathRequests(requests, "POST", catalogPath).at(-1).body, { q: "linear" });
  await linear.click();
  await dialog.getByRole("button", { name: "Add Linear", exact: true }).click();
  assert.equal(pathRequests(requests, "GET", `${catalogPath}/capabilities`).length, 1);
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), {
    "codex-plugin:linear@openai-curated-remote": { enabled: true },
  });
});

test("Dedicated OpenClaw credentials and plugins do not offer Codex-only controls", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Dedicated OpenClaw controls", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Dedicated OpenClaw Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByLabel("API key Secret", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Authentication source").locator('option[value="codex_pat"]').count(),
    0,
  );
  await waitForEnabled(page.getByLabel("API key Secret", { exact: true }));

  // A credentialless Codex catalog does not make an OpenClaw harness compatible with its plugins.
  const capabilities = page.waitForResponse(
    (response) =>
      response.url() ===
      `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/plugins/capabilities`,
  );
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  assert.equal((await capabilities).status(), 200);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  assert.equal(await dialog.getByRole("button", { name: "Load plugins" }).isDisabled(), true);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/plugins`),
    [],
  );
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
});

test("Agent credentials choose existing Secrets for harness authentication", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret picker", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original harness Secret",
    "hidden-original-harness",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Replacement harness Secret",
    "hidden-replacement-harness",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Picker Agent",
    nativeValues("harness-picker", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Harness Picker Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "API key Secret", replacementSecret);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saveResponse).status(), 200);
  // The saved source re-renders the picker, which reloads the Secret list before naming it.
  // The old, disabled picker already shows the staged Secret, so wait for the rebuilt form.
  await page.waitForFunction(
    () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
  );
  await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacementSecret));

  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(secretPostRequests(requests, namespace.id), []);

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret");
  assert.equal(await serviceAccountSecret.evaluate((node) => node.value), "");
  await page.getByLabel("Authentication source").selectOption("api_key");
  await waitForInputValue(page.getByLabel("API key Secret"), secretOptionLabel(replacementSecret));

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    await route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
  });
  await page.reload();
  // A refused Secret list names the Namespace read it checks, not a bare "Access denied".
  const unavailableSecrets = page.getByText(
    `Secrets unavailable. ${namespaceListDenied("Secrets")}`,
    { exact: true },
  );
  await unavailableSecrets.waitFor();
  assert.deepEqual(await statusTone(unavailableSecrets), {
    className: "status",
    tone: "danger",
    role: "alert",
  });
  const unreadableSecret = page.getByLabel("API key Secret", { exact: true });
  assert.equal(await unreadableSecret.inputValue(), "Bound Secret");
  await unreadableSecret.click();
  await page.getByRole("option", { name: "Bound Secret", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: /View harness authentication Secret metadata/ })
      .getAttribute("href"),
    `/namespaces/${namespace.id}/secrets/${replacementSecret.id}`,
  );
});

test("Agent credentials bind a Secret typed by its exact name without picking the suggestion", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Typed Secret name", { ready: true });
  const originalSecret = await fixture.createSecret(namespace.id, "Original key", "hidden-a");
  const typedSecret = await fixture.createSecret(namespace.id, "Typed key", "hidden-b");
  const enteredSecret = await fixture.createSecret(namespace.id, "Entered key", "hidden-c");
  const agent = await fixture.createAgent(
    namespace.id,
    "Typed Secret Agent",
    nativeValues("typed-secret", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  const picker = page.getByLabel("API key Secret", { exact: true });
  const savedSource = async () =>
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .harnessAuth.source;
  // A successful save checks Secret access, then re-renders the tab. Until the new picker has
  // loaded the Secrets again it can only restore "Bound Secret", so wait for that load.
  const save = async () => {
    const savedPicker = await picker.elementHandle();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
        response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save authentication source" }).click();
    assert.equal((await saved).status(), 200);
    await page.waitForFunction((node) => !node.isConnected, savedPicker);
    await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  };

  // Clicking Save straight after typing the full name used to keep the old Secret silently.
  await picker.fill(typedSecret.name);
  await save();
  assert.deepEqual(await savedSource(), typedSecret.ref);
  assert.equal(await picker.inputValue(), typedSecret.name);

  // Enter commits an exact name the same way, before any save.
  await picker.fill(`  ${enteredSecret.name} `);
  await picker.press("Enter");
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await picker.inputValue(), enteredSecret.name);
  await save();
  assert.deepEqual(await savedSource(), enteredSecret.ref);

  // A partial name is not a choice: leaving the field restores the bound Secret.
  await picker.fill("Origin");
  await picker.blur();
  assert.equal(await picker.inputValue(), enteredSecret.name);
});

test("Agent credential Secret picker distinguishes action labels from Secret names", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret action names", { ready: true });
  const original = await fixture.createSecret(namespace.id, "Hidden binding", "original-value");
  const bound = await fixture.createSecret(namespace.id, "Bound Secret", "bound-value");
  await fixture.createSecret(namespace.id, "No Secret bound", "none-value");
  const create = await fixture.createSecret(namespace.id, "Create new Secret...", "create-value");
  await fixture.createSecret(namespace.id, "Create new Secret... (action)", "action-value");
  await fixture.createSecret(
    namespace.id,
    "Create new Secret... (action)  (action)",
    "whitespace-value",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Action Name Agent",
    nativeValues("secret-action-names", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data = body.data.filter((secret) => secret.id !== original.id);
    await route.fulfill({ response, json: body });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Action Name Agent" }).waitFor();
  const apiKey = page.getByLabel("API key Secret", { exact: true });
  await apiKey.click();
  await page.getByRole("option", { name: "Bound Secret (current binding)", exact: true }).waitFor();
  await page.getByRole("option", { name: "Bound Secret", exact: true }).click();
  assert.equal(await apiKey.inputValue(), bound.name);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await saved).status(), 200);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth.source, bound.ref);

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const token = page.getByLabel("Service account token Secret", { exact: true });
  await token.click();
  await page.getByRole("option", { name: "No Secret bound (no binding)", exact: true }).waitFor();
  await page.getByRole("option", { name: "No Secret bound", exact: true }).waitFor();
  await page
    .getByRole("option", { name: "Create new Secret... (action) (action) (action)", exact: true })
    .waitFor();
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  assert.equal(await token.inputValue(), create.name);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await token.press("ArrowDown");
  await page
    .getByRole("option", { name: "Create new Secret... (action) (action) (action)", exact: true })
    .click();
  await page.getByRole("dialog", { name: "Create harness authentication Secret" }).waitFor();
});

test("Tab leaves a scrolling Secret list for the next control, and the list keeps focus in the picker", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Scrolling Secret list", { ready: true });
  const secrets = [];
  // Nine readable Secrets overflow the open list, which then scrolls.
  for (let index = 1; index <= 9; index += 1) {
    secrets.push(
      await fixture.createSecret(namespace.id, `Scrolling Secret ${index}`, `value-${index}`),
    );
  }
  const agent = await fixture.createAgent(
    namespace.id,
    "Scrolling List Agent",
    nativeValues("scrolling-secret-list", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: secrets[0].ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByText("Choose an existing Secret or create a new one.").waitFor();
  const picker = page.getByLabel("API key Secret", { exact: true });
  const listbox = page.getByRole("listbox", { name: "Available Secrets" });
  await picker.focus();
  await listbox.waitFor();
  assert.ok(await listbox.evaluate((node) => node.scrollHeight > node.clientHeight));

  // The list is not a Tab stop: focus used to enter it, the list hid, and focus fell to the
  // page (finding 1919).
  await picker.fill("Scrolling");
  await page.keyboard.press("Tab");
  assert.equal(
    await hasFocus(page.getByRole("link", { name: /View harness authentication Secret metadata/ })),
    true,
  );
  await listbox.waitFor({ state: "hidden" });
  assert.equal(await picker.inputValue(), secrets[0].name);

  // Focus that still reaches the list, as a press on its scrollbar can, returns to the input
  // with the list and the search kept.
  await page.keyboard.press("Shift+Tab");
  await picker.fill("Secret 9");
  await listbox.focus();
  assert.equal(await hasFocus(picker), true);
  assert.equal(await picker.inputValue(), "Secret 9");
  assert.deepEqual(await listbox.getByRole("option").allTextContents(), [
    secrets[8].name,
    "Create new Secret...",
  ]);
  await page.keyboard.press("Escape");
  await listbox.waitFor({ state: "hidden" });
});

// A failed list read must not replace the staged hint with an error either (finding 1748).
for (const listOutcome of ["arrives", "fails"]) {
  test(`a Secret created before the picker's Secret list ${listOutcome} stays staged and listed`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slow Secret list", { ready: true });
    const original = await fixture.createSecret(namespace.id, "Original binding", "original-value");
    const agent = await fixture.createAgent(
      namespace.id,
      "Slow List Agent",
      nativeValues("slow-secret-list", { harnessId: "codex" }),
      { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    const secretsPath = `/namespaces/${namespace.id}/secrets`;
    // The API answers the list read; the page sees that answer only after the create.
    let releaseList;
    const listGate = new Promise((resolve) => {
      releaseList = resolve;
    });
    t.after(releaseList);
    let listReads = 0;
    await page.route(`${fixture.origin}${secretsPath}`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      listReads += 1;
      const response = await route.fetch();
      await listGate;
      await route.fulfill(
        listOutcome === "arrives"
          ? { response }
          : { status: 500, contentType: "application/json", body: "{}" },
      );
    });
    await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
    const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
    await apiKeySecret.fill("no matching create target");
    await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
    await dialog.getByLabel("Name", { exact: true }).fill("Created while loading");
    await dialog.getByLabel("Value", { exact: true }).fill("created-while-loading");
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const staged = page.getByText("Secret binding staged. Save changes to apply it.");
    await staged.waitFor();
    assert.ok(listReads > 0);
    releaseList();
    // Every held list read and the create have now reached the page's own code.
    await waitForSettledFetches(page, secretsPath, listReads + 1);
    assert.equal(await staged.count(), 1);
    assert.deepEqual(await statusTone(staged), { className: "hint", tone: null, role: "status" });
    const created = (await fixture.request("GET", secretsPath)).data.find(
      (secret) => secret.name === "Created while loading",
    );
    assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(created));
    await apiKeySecret.fill("Created while");
    await page.getByRole("option", { name: secretOptionLabel(created), exact: true }).waitFor();
  });
}

test("a different Secret in a create response cannot stage a binding or repeat the write", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unconfirmed Secret", { ready: true });
  const original = await fixture.createSecret(namespace.id, "Original picker Secret", "synthetic");
  const agent = await fixture.createAgent(
    namespace.id,
    "Unconfirmed picker Agent",
    nativeValues("unconfirmed-picker", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: original.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, original.name);
  const path = `/namespaces/${namespace.id}/secrets`;
  const name = "New picker Secret";
  await page.route(`**${path}`, async (route, request) => {
    if (request.method() !== "POST") {
      return route.continue();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    const body = await response.json();
    assert.equal(body.data.name, name);
    // The create succeeded. Substitute valid metadata for a different Secret in its reply.
    await route.fulfill({ response, json: { ...body, data: original } });
  });
  await picker.fill("no matching Secret");
  const create = page.getByRole("option", { name: "Create new Secret...", exact: true });
  await create.click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  const value = dialog.getByLabel("Value", { exact: true });
  await value.fill("synthetic-new-value");
  const submit = dialog.getByRole("button", { name: "Create Secret", exact: true });
  await submit.click();
  await dialog
    .getByText("Secret creation outcome could not be confirmed.", { exact: false })
    .waitFor({ timeout: 5_000 });
  assert.equal(await value.inputValue(), "");
  assert.equal(await submit.isDisabled(), true);
  await submit.evaluate((button) => button.form.requestSubmit());
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await waitForInputValue(picker, original.name);
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
});

// The Secrets page disables Create Secret when the Namespace's permission answer denies Secret
// create; the inline Create Secret action in the Credentials tab offered the same refused write
// (finding 2442). It stays listed, disabled with the reason, until a grant.
const SECRET_CREATE_DENIED = "Your access does not include creating Secrets in this Namespace.";
test("the Credentials tab's inline Create Secret follows the Secret create answer", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Inline create answer", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound harness Secret", "synthetic");
  const agent = await fixture.createAgent(
    namespace.id,
    "Inline create Agent",
    nativeValues("inline-create", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: bound.ref }, executionMode: "dedicated" },
  );
  const member = await fixture.createNamespaceMember(
    "inline-create-member",
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "create" && kind === "secret")),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  const denied = page.getByRole("option", {
    name: `Create new Secret... ${SECRET_CREATE_DENIED}`,
    exact: true,
  });
  await denied.waitFor();
  assert.equal(await denied.getAttribute("aria-disabled"), "true");
  // A forced click skips the disabled check: choosing the action still opens nothing.
  await denied.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await picker.press("Escape");
  await page.getByText(`Choose an existing Secret. ${SECRET_CREATE_DENIED}`).waitFor();
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);

  // A Secret create grant restores the action on the next page load.
  grantMember(fixture, "inline-create-member", [["create", "secret"]]);
  await page.reload();
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  await page.getByRole("dialog", { name: "Create harness authentication Secret" }).waitFor();
});

test("session expiry clears the unsent value in the Secret picker dialog", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Secret picker session expiry", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Expiring picker Agent",
    nativeValues("expiring-picker", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // Let the picker open before its list read discovers the session has expired.
  const path = `/namespaces/${namespace.id}/secrets`;
  const list = await holdRequests(t, page, `**${path}`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByLabel("API key Secret", { exact: true }).fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  const field = dialog.getByLabel("Value", { exact: true });
  await field.fill("synthetic-unsent-value");
  const input = await field.evaluateHandle((node) => node);
  expireSessions(fixture);
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === path);
  list.release();
  assert.equal((await refused).status(), 401);
  await page.getByText("Your session has expired").waitFor();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await input.evaluate((node) => node.value === ""), true);
  assert.equal(secretPostRequests(requests, namespace.id).length, 0);
});

test("Agent credential Secret picker searches, validates, and preserves duplicate create input", async (t) => {
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential Secret picker UX", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original picker Secret",
    "hidden-original-picker",
  );
  const keyboardSecret = await fixture.createSecret(
    namespace.id,
    "Keyboard replacement Secret",
    "hidden-keyboard-picker",
  );
  const duplicateNameSecret = await fixture.createSecret(
    namespace.id,
    "Duplicate picker Secret",
    "hidden-duplicate-picker",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Combobox Agent",
    nativeValues("credential-picker-ux", { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Combobox Agent" }).waitFor();
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.fill(keyboardSecret.id);
  await page.getByRole("option", { name: keyboardSecret.name, exact: true }).waitFor();
  await apiKeySecret.fill("keyboard");
  const keyboardOption = page.getByRole("option", {
    name: secretOptionLabel(keyboardSecret),
    exact: true,
  });
  await apiKeySecret.press("ArrowDown");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "false");
  assert.equal(
    await keyboardOption.evaluate((node) => node.classList.contains("secret-typeahead-active")),
    true,
  );
  assert.equal(
    await apiKeySecret.getAttribute("aria-activedescendant"),
    await keyboardOption.getAttribute("id"),
  );
  await apiKeySecret.press("Enter");
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(keyboardSecret));
  await apiKeySecret.fill("");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "true");
  await apiKeySecret.press("ArrowDown");
  assert.equal(await keyboardOption.getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("listbox").getByRole("option", { selected: true }).count(), 1);
  await apiKeySecret.fill("does-not-exist");
  await page.getByText("No matching Secrets.", { exact: true }).waitFor();
  await apiKeySecret.press("Escape");
  assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(keyboardSecret));

  await page.getByLabel("Authentication source").selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret", { exact: true });
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal(await serviceAccountSecret.evaluate((input) => input.validity.customError), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  await serviceAccountSecret.fill("no matching create target");
  await page.getByText("No matching Secrets.", { exact: true }).waitFor();
  await serviceAccountSecret.press("ArrowDown");
  await serviceAccountSecret.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Combobox Agent harness authentication",
  );
  assert.equal(await isMaskedSecretValue(dialog.getByLabel("Value", { exact: true })), true);
  await dialog.getByLabel("Name", { exact: true }).fill(duplicateNameSecret.name);
  await dialog.getByLabel("Value", { exact: true }).fill("synthetic-duplicate-value");
  const duplicate = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  assert.equal((await duplicate).status(), 409);
  await dialog
    .getByRole("alert")
    .filter({ hasText: "may already exist in this Namespace" })
    .waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    duplicateNameSecret.name,
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  assert.equal(secretDriver.valueFor(duplicateNameSecret), "hidden-duplicate-picker");

  // Simulate documented controller conflict responses; duplicate rejection above uses the real route.
  let createStatus = 409;
  let conflictCode = "NAMESPACE_NOT_READY";
  const failSecretCreate = (route, request) => {
    if (request.method() !== "POST") {
      return route.fallback();
    }
    return route.fulfill({
      status: createStatus,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: conflictCode, message: "masked Secret create conflict" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  };
  await page.route(`**/namespaces/${namespace.id}/secrets`, failSecretCreate);
  await dialog.getByLabel("Name", { exact: true }).fill("Namespace not ready picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "cannot store Secrets yet" }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Namespace not ready picker Secret",
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );

  conflictCode = "RESOURCE_CONFLICT";
  await dialog.getByLabel("Name", { exact: true }).fill("Backend conflict picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "Secret creation conflicted" }).waitFor();
  assert.equal(
    await dialog.getByLabel("Name", { exact: true }).inputValue(),
    "Backend conflict picker Secret",
  );
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  assert.equal(await dialog.getByRole("alert").filter({ hasText: "may already exist" }).count(), 1);

  // A denied create is a known rejection: it names the permission and keeps the input editable.
  createStatus = 403;
  conflictCode = "FORBIDDEN";
  await dialog.getByLabel("Name", { exact: true }).fill("Denied picker Secret");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({
      hasText: "Access denied. You do not have permission to manage this Secret binding.",
    })
    .waitFor();
  await waitForEnabled(dialog.getByLabel("Name", { exact: true }));
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  await waitForEnabled(dialog.getByRole("button", { name: "Create Secret", exact: true }));
  await page.unroute(`**/namespaces/${namespace.id}/secrets`, failSecretCreate);

  const distinctName = "Combobox Agent corrected service account token";
  await dialog.getByLabel("Name", { exact: true }).fill(distinctName);
  const created = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.name === distinctName,
  );
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  const createdSecret = (await (await created).json()).data;
  await dialog.waitFor({ state: "hidden" });
  assert.notEqual(createdSecret.id, duplicateNameSecret.id);
  assert.equal(createdSecret.name, distinctName);
  assert.equal(secretDriver.valueFor(createdSecret), "synthetic-duplicate-value");
  assert.equal(await serviceAccountSecret.inputValue(), secretOptionLabel(createdSecret));
});

// The shared grant wording for the harness authentication source (findings 1920, 2259).
const HARNESS_GRANT_REFUSED =
  "Authentication source saved, but the request to grant this Agent access to the selected Secret was refused. Granting it needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Save authentication source. Select Retry credential access once you have that access.";
// An Installation administrator's console read the IAM policy and found no grant (finding 2260).
const HARNESS_GRANT_MISSING =
  "This Agent has no access to its authentication Secret, so deploying it would be refused. Select Save authentication source to grant it.";
const HARNESS_GRANT_UNVERIFIED =
  "Authentication source saved, but this session did not verify that this Agent can use the selected Secret. Granting access needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Save authentication source.";

test("Agent credentials report partial harness Secret grant failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Harness Secret grant failure", {
    ready: true,
  });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original denied harness Secret",
    "hidden-denied-original",
  );
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Denied harness Secret",
    "hidden-denied-replacement",
  );
  const agent = await fixture.createAgent(
    namespace.id,
    "Harness Grant Failure Agent",
    nativeValues("harness-grant-failure"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/iam/access-bindings`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill(
      apiErrorResponse(403, "FORBIDDEN", "masked IAM denial", {
        requestId: "req_00000000-0000-4000-8000-000000000633",
      }),
    );
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Harness Grant Failure Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "API key Secret", replacementSecret);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  // The grant request itself was refused: the warning says so, names who grants it, and keeps
  // Retry for when the reader's access is restored (finding 2259).
  await page
    .getByText(`${HARNESS_GRANT_REFUSED} Request ID: req_00000000-0000-4000-8000-000000000633`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  await waitForEnabled(page.getByRole("button", { name: "Retry credential access" }));
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map(({ body }) => [
      body.subjectId,
      body.resourceId,
    ]),
    [[agent.servicePrincipalId, replacementSecret.id]],
  );

  // Retry rereads the Agent before any grant request. Native IAM now refuses that read: the
  // warning is about the read, not a grant refusal, and Retry stays for when the read works.
  fixture.policy.restrictions.push({
    id: "deny-agent-read-on-retry",
    resourceKind: "agent",
    resourceId: agent.id,
    action: "read",
    effect: "deny",
  });
  requests.length = 0;
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page
    .getByText(
      /^Authentication source saved, but this Agent could not be read before retrying its credential access\. .+ Select Retry credential access once the Agent can be read\.$/,
    )
    .waitFor();
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
  await waitForEnabled(page.getByRole("button", { name: "Retry credential access" }));
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-agent-read-on-retry"),
    1,
  );

  // A retry after this denial must not grant the Secret to a different service principal.
  const other = await fixture.createAgent(namespace.id, "Other Agent", nativeValues("other"));
  assert.notEqual(other.servicePrincipalId, agent.servicePrincipalId);
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
  await page.route(agentUrl, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta } = await response.json();
    assert.equal(data.servicePrincipalId, agent.servicePrincipalId);
    await route.fulfill({
      response,
      json: { data: { ...data, servicePrincipalId: other.servicePrincipalId }, meta },
    });
  });
  requests.length = 0;
  const reread = page.waitForResponse(agentUrl);
  const retry = page.getByRole("button", { name: "Retry credential access" });
  await retry.click();
  assert.equal((await reread).status(), 200);
  await waitForEnabled(page.getByRole("button", { name: "Reload authentication source" }));
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(await retry.isDisabled(), true);
  await page.getByText(/Agent identity changed. Reload authentication source/).waitFor();
});

// Granting the Agent its authentication Secret writes IAM policy, which needs Installation
// administration. A member's save sends no IAM request, so it says this session did not verify
// the Agent's access, whether or not an administrator already granted it. It names who finishes
// the grant and how, and offers no Retry the API would refuse. The named step grants it.
test("Agent credentials name the administrator step for a member's harness Secret grant", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Member harness grant", { ready: true });
  const replacementSecret = await fixture.createSecret(
    namespace.id,
    "Member harness Secret",
    "hidden-member-harness",
  );
  const ungranted = await fixture.createAgent(
    namespace.id,
    "Member Harness Agent",
    nativeValues("member-harness"),
  );
  // An administrator already granted this Agent the Secret the member is about to select.
  const granted = await fixture.createAgent(
    namespace.id,
    "Member Granted Agent",
    nativeValues("member-granted"),
  );
  await fixture.grantAgentSecretOperate(granted, replacementSecret.ref);
  const writer = await fixture.createNamespaceMember("member-write", namespace.id, MEMBER_WRITE);

  for (const agent of [ungranted, granted]) {
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const probe = page.waitForResponse(`${fixture.origin}/observability`);
    await login(page, fixture, url, writer.credentials);
    await page.getByRole("heading", { name: agent.name }).waitFor();
    // The session's Installation read already found this account is no administrator.
    assert.equal((await probe).status(), 403);
    await selectSecret(page, "API key Secret", replacementSecret);
    await page.getByRole("button", { name: "Save authentication source" }).click();
    const warning = page.getByRole("alert").filter({ hasText: HARNESS_GRANT_UNVERIFIED });
    await warning.waitFor();
    assert.equal(await warning.textContent(), HARNESS_GRANT_UNVERIFIED);
    assert.deepEqual(await statusTone(warning), {
      className: "status",
      tone: "warning",
      role: "alert",
    });
    // The Agent saved its new source; no IAM request went out that the API would refuse and
    // audit.
    const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.deepEqual(saved.data.harnessAuth, { method: "api_key", source: replacementSecret.ref });
    assert.deepEqual(
      requests.filter(({ path }) => path.includes("/iam/")),
      [],
    );
    // No dead Retry: only Reload remains. The save finished and nothing this member can do
    // confirms the grant, so Deploy is not held: the API checks the Agent's access when it
    // deploys (finding 2547).
    assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Save authentication source" }).count(), 0);
    await waitForEnabled(page.getByRole("button", { name: "Reload authentication source" }));
    const deploy = page.getByRole("button", { name: "Deploy new version" });
    await waitForEnabled(deploy);
    await expectNoText(page, "Confirm authentication and Secret access in Credentials");
    // The rebuilt tab keeps the same words, still offers no Retry and still holds nothing.
    await page.getByRole("tab", { name: "Configuration", exact: true }).click();
    await page.getByRole("tab", { name: "Credentials", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: HARNESS_GRANT_UNVERIFIED }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry credential access" }).count(), 0);
    assert.equal(await deploy.isDisabled(), false);
  }

  // The administrator the warning names opens the Agent's Credentials: its IAM policy read finds
  // the grant missing, so the tab names the same step and Deploy waits (finding 2260).
  const { page: adminPage } = await newPage(t, fixture);
  await login(
    adminPage,
    fixture,
    detailUrl(fixture, namespace.id, ungranted.id, "draft", "credentials"),
  );
  await adminPage.getByRole("heading", { name: "Member Harness Agent" }).waitFor();
  await waitForInputValue(
    adminPage.getByLabel("API key Secret", { exact: true }),
    secretOptionLabel(replacementSecret),
  );
  const missing = adminPage.getByText(HARNESS_GRANT_MISSING, { exact: true });
  await missing.waitFor();
  assert.equal(await missing.getAttribute("data-tone"), "warning");
  await adminPage
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  assert.equal(
    await adminPage.getByRole("button", { name: "Deploy new version" }).isDisabled(),
    true,
  );
  // The named step grants the Agent its Secret; the rebuilt tab reads the grant and clears both.
  await adminPage.getByRole("button", { name: "Save authentication source" }).click();
  await adminPage.getByRole("status").filter({ hasText: "Authentication source saved." }).waitFor();
  await waitForEnabled(adminPage.getByRole("button", { name: "Deploy new version" }));
  assert.equal(await adminPage.getByText(HARNESS_GRANT_MISSING, { exact: true }).count(), 0);
  const grants = await fixture.addedAccessBindings(namespace.id);
  assert.deepEqual(
    grants
      .filter(({ subjectId }) => subjectId === ungranted.servicePrincipalId)
      .map(({ resourceKind, resourceId }) => [resourceKind, resourceId]),
    [["secret", replacementSecret.id]],
  );
});

// The IAM read can finish after the administrator has left Credentials. Deploy already waits,
// and the parked form must still explain Save authentication source when they come back.
test("a harness grant found while Credentials is parked is shown on return", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Parked harness grant", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "Parked harness Secret", "hidden");
  const agent = await fixture.createAgent(
    namespace.id,
    "Parked Grant Agent",
    nativeValues("parked-grant"),
  );
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: secret.ref },
  });
  const { page } = await newPage(t, fixture);
  const held = await holdRequests(t, page, `**/namespaces/${namespace.id}/iam/**`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Parked Grant Agent" }).waitFor();
  await held.requested;
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  held.release();
  await page
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), false);
});

// The missing-grant warning names the Secret Save would grant. Selecting another Secret
// clears it, and selecting the saved Secret again restores it (review of PR 3476).
test("a missing harness grant warning follows the selected Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Selected harness grant", { ready: true });
  const savedSecret = await fixture.createSecret(namespace.id, "Saved harness Secret", "hidden-a");
  const otherSecret = await fixture.createSecret(namespace.id, "Other harness Secret", "hidden-b");
  const agent = await fixture.createAgent(
    namespace.id,
    "Selected Grant Agent",
    nativeValues("selected-grant"),
  );
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: savedSecret.ref },
  });
  const { page } = await newPage(t, fixture);
  const held = await holdRequests(t, page, `**/namespaces/${namespace.id}/iam/**`);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Selected Grant Agent" }).waitFor();
  await held.requested;
  await waitForInputValue(
    page.getByLabel("API key Secret", { exact: true }),
    secretOptionLabel(savedSecret),
  );
  await selectSecret(page, "API key Secret", otherSecret);
  held.release();
  await page
    .getByText("Confirm authentication and Secret access in Credentials before deploying.")
    .waitFor();
  await expectNoText(page, HARNESS_GRANT_MISSING, () =>
    page
      .getByText("Confirm authentication and Secret access in Credentials before deploying.")
      .waitFor(),
  );
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(otherSecret),
  );

  await selectSecret(page, "API key Secret", savedSecret);
  await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(savedSecret),
  );

  await selectSecret(page, "API key Secret", otherSecret);
  await expectNoText(page, HARNESS_GRANT_MISSING, () =>
    page.getByLabel("API key Secret", { exact: true }).inputValue(),
  );
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).inputValue(),
    secretOptionLabel(otherSecret),
  );
});

// The harness grant check reads Namespace IAM; a refused read proves nothing missing, so an
// administrator's Deploy stays as it was and no warning appears (finding 2260).
test("A refused harness grant read leaves an administrator's Deploy alone", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unread harness grant", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unread Grant Agent", nativeValues("u"));
  // The Agent's binding moved to a Secret it holds no grant for.
  const ungranted = await fixture.createSecret(namespace.id, "Ungranted model key", "hidden");
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: ungranted.ref },
  });
  const { page } = await newPage(t, fixture);
  await page.route(`**/namespaces/${namespace.id}/iam/roles`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Access denied." },
        meta: { requestId: "req_00000000-0000-4000-8000-000000002260" },
      }),
    }),
  );
  const read = page.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/iam/roles`),
  );
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  await page.getByRole("heading", { name: "Unread Grant Agent" }).waitFor();
  assert.equal((await read).status(), 403);
  await settlePageRequests(page);
  await waitForEnabled(page.getByRole("button", { name: "Deploy new version" }));
  assert.equal(await page.getByText(HARNESS_GRANT_MISSING, { exact: true }).count(), 0);
});

test("Agent detail blocks repeat Configuration saves after an uncertain draft update", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Uncertain Configuration", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Configuration Agent",
    nativeValues("before-unknown"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  let interceptedPatches = 0;
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    interceptedPatches += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked Configuration response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Uncertain Configuration Agent" }).waitFor();
  requests.length = 0;

  const nextValues = nativeValues("after-unknown");
  await page.locator("button:not([disabled])", { hasText: "Deploy new version" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nextValues, null, 2));
  await page.getByText(CONFIGURATION_EDITS_PENDING).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Configuration" }).click();

  await page.getByText("Outcome unknown. Configuration may have been saved.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("tab", { name: "Channels" }).isDisabled(), true);
  await page.evaluate(() => {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("tab", "channels");
    globalThis.history.pushState(globalThis.history.state, "", next);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  });
  await page.getByText("Outcome unknown. Reload this draft before leaving the editor.").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");
  assert.match(
    await page.getByLabel("Configuration JSON").inputValue(),
    /"marker": "after-unknown"/,
  );
  assert.equal(interceptedPatches, 1);
  assert.equal(configurationPatchRequests(requests, namespace.id, agent.configurationId).length, 1);
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.generation, 2);
  assert.deepEqual(saved.data.values, nextValues);

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByLabel("Configuration JSON").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft" }).click();
  await page.getByText(/generation 2/).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "after-unknown"').waitFor();
  assert.equal(interceptedPatches, 1);

  // The controller accepts this next edit, but the 200 describes another Configuration.
  // Require the same no-repeat recovery as a lost reply; confirm exactly one write reached OCC.
  const otherValues = nativeValues("after-unconfirmed-success");
  await page.unroute(`**${configurationPath}`);
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      return route.continue();
    }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const { data, meta } = await response.json();
    assert.equal(data.id, agent.configurationId);
    assert.deepEqual(data.values, otherValues);
    await route.fulfill({ response, json: { data: { ...data, id: `cfg_${randomUUID()}` }, meta } });
  });
  const save = page.getByRole("button", { name: "Save Configuration", exact: true });
  const editor = page.getByLabel("Configuration JSON");
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await editor.fill(JSON.stringify(otherValues));
  await save.click();
  const unknown = page.getByText("Outcome unknown. Configuration may have been saved.");
  const incorrectlySaved = page.getByText("Configuration saved.", { exact: true });
  await unknown.or(incorrectlySaved).first().waitFor();
  assert.equal(await unknown.isVisible(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(configurationPatchRequests(requests, namespace.id, agent.configurationId).length, 1);
  const confirmed = await fixture.request("GET", configurationPath);
  assert.equal(confirmed.data.generation, saved.data.generation + 1);
  assert.deepEqual(confirmed.data.values, otherValues);
});

test("Agent stop confirmation uses the real API, preserves Agent state, and deploy resumes", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop success");
  const agent = await fixture.createAgent(namespace.id, "Stop Candidate", nativeValues("stop"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  await page.getByRole("heading", { name: "Stop Candidate" }).waitFor();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  let dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/i)
    .waitFor();
  // The dialog names its target Agent as text, and in its accessible description.
  await dialog.getByText("Stop Candidate", { exact: true }).waitFor();
  assert.match(
    await dialog.evaluate((node) =>
      node
        .getAttribute("aria-describedby")
        .split(" ")
        .map((id) => node.ownerDocument.getElementById(id)?.textContent)
        .join(" "),
    ),
    /^Agent: Stop Candidate This interrupts the current runtime gateway/,
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await page.getByRole("button", { name: "Stop Agent" }).click();
  dialog = page.getByRole("dialog", { name: "Stop this Agent?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/i)
    .waitFor();
  const stopResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Stop Agent" }).click();
  const response = await stopResponse;
  assert.equal(response.status(), 202);
  const stoppedBody = await response.json();
  assert.equal(stoppedBody.data.desiredRuntimeState, "stopped");
  assert.equal(stoppedBody.data.activeRevisionId, active.revision.id);

  await page.getByRole("status").getByText("Stop requested.").waitFor();
  await page.getByText(/Runtime shutdown completion is not exposed in Console/).waitFor();
  // The card names the version as the page does, and the overview reports the request
  // (finding 1899).
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByText("v1", { exact: true }).waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("Stop requested", { exact: true }).waitFor();
  await summary
    .getByText(
      "Shutdown completion is not shown here. Deploy a new version to start this Agent again.",
    )
    .waitFor();
  // Only Request Stop again and Refresh remain; no disabled Stop beside them.
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.deepEqual(await stopRegion.getByRole("button").allTextContents(), [
    "Request Stop again",
    "Refresh stop status",
  ]);
  assert.deepEqual(
    agentStopRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, null]],
  );
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");
  assert.equal(stopped.data.activeRevisionId, active.revision.id);
  assert.deepEqual(stopped.data.harnessAuth, { method: "runtime" });
  assert.equal(stopped.data.configurationId, agent.configurationId);
  // Changing only the requested runtime state must reload dependent panels,
  // even while the selected revision remains unchanged pending worker shutdown.
  const stopIndex = requests.findIndex((request) => request.path.endsWith("/stop"));
  assert.ok(
    requests.findIndex((request) => request.path.endsWith("/native-admin")) > stopIndex,
    "native admin status must be reread after stop admission",
  );
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.deepEqual(
    revisions.data.map((revision) => revision.id),
    [active.revision.id],
  );
  await page.getByRole("tab", { name: "Workspace files" }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  // The standing explainer is quiet: an info block that announces nothing.
  assert.deepEqual(
    await statusTone(page.getByText(/^These files belong to the Agent's live workspace\./)),
    { className: "status", tone: "info", role: null },
  );

  const cleared = await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.desiredRuntimeState, "stopped");
  assert.equal(cleared.activeRevisionId, undefined);
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByText("No current version", { exact: true })
    .waitFor();
  await page
    .getByText("No version is selected. Deploy a new version to start this Agent.")
    .waitFor();

  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Create new version", exact: true }).last().click();
  await page.getByRole("button", { name: "Deploy new version" }).click();
  await page.waitForURL(/revision=rev_/);
  const running = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(running.data.desiredRuntimeState, "running");
  assert.equal(running.data.configurationId, agent.configurationId);
  assert.deepEqual(running.data.harnessAuth, { method: "runtime" });
});

// Stop changes only the Agent's runtime state and current version, so the page updates those
// regions in place. Reloading the page for it collapsed the version detail to its loading state,
// scrolled the Stop result away and dropped focus to the page (finding 1419).
test("Agent stop and Refresh stop status update the page in place and keep focus", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop in place", {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ filename }) {
        return { status: "ok", file: { name: filename, content: `Saved ${filename}` } };
      },
    },
  });
  const agent = await fixture.createAgent(namespace.id, "In Place Stop", nativeValues("in-place"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1280, height: 720 } },
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await page.waitForFunction(
    () => !globalThis.document.body.textContent.includes("Loading configuration…"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  const stop = stopRegion.getByRole("button", { name: "Stop Agent", exact: true });
  await stop.scrollIntoViewIfNeeded();
  // Mark the rendered version detail and record any loading state the page shows again.
  await page.evaluate(() => {
    const doc = globalThis.document;
    doc.querySelector(".agent-version-detail").dataset.stopMarker = "kept";
    globalThis.reloadedText = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (/Loading (version details|configuration)/.test(node.textContent ?? "")) {
            globalThis.reloadedText.push(node.textContent);
          }
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  });
  const requests = apiRequests(page, fixture.origin);
  const scrollBefore = await page.evaluate(() => globalThis.scrollY);
  assert.ok(scrollBefore > 0);
  const focusedText = () => page.evaluate(() => globalThis.document.activeElement?.textContent);
  const keptInPlace = () =>
    page.evaluate(() => ({
      marker: globalThis.document.querySelector(".agent-version-detail")?.dataset.stopMarker,
      reloadedText: globalThis.reloadedText,
    }));

  await stop.click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByRole("status").getByText("Stop requested.").waitFor();
  // A closed dialog has no dialog role, so wait for its close handler to remove the element.
  await page.locator("dialog.agent-stop-dialog").waitFor({ state: "detached" });
  assert.deepEqual(await keptInPlace(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(), "Refresh stop status");
  // The page did not jump back up to rebuild above the reader.
  assert.ok((await page.evaluate(() => globalThis.scrollY)) >= scrollBefore - 1);

  // Stop acceptance does not clear the current version. Open Workspace in the interval
  // before the worker clears it, and keep an unsaved edit in the mounted editor.
  const workspace = page.getByRole("tab", { name: "Workspace files", exact: true });
  const file = page.getByLabel("AGENTS.md", { exact: true });
  const draft = "Unsaved workspace edit during Stop";
  await workspace.click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  await file.fill(draft);

  // The worker clears the current version; Refresh stop status shows it without a reload too.
  await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await stopRegion.getByText("No current version", { exact: true }).waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("None", { exact: true }).waitFor();
  // The overview still reports the stop request once no version is selected.
  await summary
    .getByText("Deploy a new version to start this Agent again.", { exact: true })
    .waitFor();
  assert.equal(await summary.getByText("Stop requested", { exact: true }).isVisible(), true);
  assert.deepEqual(await keptInPlace(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(), "Refresh stop status");
  // The viewed version is no longer current, and tabs built from the old state are rebuilt.
  const unavailable = page.getByText(WORKSPACE_FILES_UNAVAILABLE, { exact: true });
  assert.equal(await file.count(), 0, "the mounted Workspace must release the old live editor");
  await unavailable.waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText(/^Historical version · read-only admitted snapshot/).waitFor();
  assert.equal(
    await page.locator('.revision-selector [aria-label$=", current version"]').count(),
    0,
  );
  await workspace.click();
  await unavailable.waitFor();
  assert.equal(await file.count(), 0, "returning must not resurrect the old editor");

  // Files are live Agent data, not a revision snapshot. A later serving revision restores
  // the unsaved draft, but must not silently write it to the workspace.
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await page
    .getByText("Unsaved edits restored. Reload replaces them with the current file.")
    .waitFor();
  assert.equal(await file.inputValue(), draft);
  assert.equal(
    requests.filter((r) => r.method === "PUT" && r.path.includes("/workspace/files/")).length,
    0,
  );
});

test("Refresh stop status switches to deletion recovery when another actor starts deletion", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Deletion discovered");
  const agent = await fixture.createAgent(
    namespace.id,
    "Deletion Candidate",
    nativeValues("deletion"),
    { harnessAuth: { method: "runtime" } },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await state.transact((unit) =>
    unit.agents.transitionAgentDesiredRuntimeState(namespace.id, agent.id, "running", "stopped"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, active.revision.id));
  const refreshStop = page.getByRole("button", { name: "Refresh stop status" });
  await refreshStop.waitFor();
  requests.length = 0;

  // Another actor changes lifecycle state after this page loads; the operator only reads it.
  const deleting = await state.transact((unit) =>
    unit.agents.transitionAgentStatus(namespace.id, agent.id, "active", "deleting"),
  );
  assert.equal(deleting.status, "deleting");
  await refreshStop.click();
  await page.getByText(/Deletion was requested\./).waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Request deletion again" }).isVisible(),
    true,
  );
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.textContent),
    "Refresh deletion status",
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// An Agent created through the API starts with desiredRuntimeState stopped and no version,
// so no stop was ever requested and nothing runs to stop (finding 1394). The page shows no
// Stop card and reports no stop request until a deploy creates a version (finding 1899).
test("Agent detail has no Stop row for an Agent that was never deployed", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Never deployed");
  const agent = await fixture.createAgent(namespace.id, "Never Deployed", nativeValues("never"), {
    harnessAuth: { method: "runtime" },
  });
  assert.equal(agent.desiredRuntimeState, "stopped");
  assert.equal(agent.activeRevisionId, undefined);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Never Deployed" }).waitFor();
  // The version list loaded empty, so the console knows there is no version to stop.
  await page.getByText(/^No readable versions\. Creating an Agent alone does not create/).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await page.locator("section.stop-note").waitFor({ state: "hidden" });
  assert.equal(await stopRegion.count(), 0);
  assert.equal(await page.getByText("Requested runtime state").isVisible(), false);
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  assert.equal(await summary.getByText("Stop requested").isVisible(), false);
  // The danger zone keeps its Delete row (UX spec 3.9).
  await waitForDangerZoneRows(page, { stop: false, delete: true });
  assert.deepEqual(
    await page
      .getByRole("region", { name: "Danger zone", exact: true })
      .getByRole("heading", { level: 3 })
      .allTextContents(),
    ["Delete Agent"],
  );

  // The first deploy creates a version and requests the Agent running, so Stop returns.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration").href);
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).waitFor();
  assert.equal(await stopRegion.getByText("No version is selected.").count(), 0);
});

// A viewer who reads no version of a deployed Agent sees the Stop card while a version is
// selected. Once the worker clears it, that viewer cannot tell the Agent from a never-deployed
// one, but a card they just used stays in place with focus on its heading (finding 1899).
test("Agent stop keeps a used card for a viewer who reads no version", async (t) => {
  const { fixture, namespace, state } = await createRuntimeAuthFixture(t, "Stop unreadable");
  const agent = await fixture.createAgent(namespace.id, "Unreadable Stop", nativeValues("unread"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const operator = await fixture.createNamespaceMember("agent-stop-unreadable", namespace.id, [
    ["read", "namespace"],
    ["read", "agent"],
    ["read", "configuration"],
    ["operate", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}`,
    operator.credentials,
  );
  await page.getByRole("heading", { name: "Unreadable Stop" }).waitFor();
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByRole("status").getByText("Stop requested.").waitFor();
  const summary = page.getByRole("region", { name: "Agent state at a glance" });
  await summary.getByText("Stop requested", { exact: true }).waitFor();

  await state.transact((unit) =>
    unit.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  await stopRegion.getByRole("button", { name: "Refresh stop status" }).click();
  await stopRegion.getByText("No current version", { exact: true }).waitFor();
  assert.equal(await stopRegion.getByRole("button").count(), 0);
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    "agent-stop-title",
  );
  assert.equal(await summary.getByText("Stop requested", { exact: true }).count(), 0);
});

test("Agent stop uncertainty requires refresh before another stop request", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop uncertainty");
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Stop Candidate",
    nativeValues("uncertain-stop"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const stopPath = `${agentPath}/stop`;
  await trackSettledFetches(page);
  let interceptedStops = 0;
  await page.route(`**${stopPath}`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    interceptedStops += 1;
    await replyWithDifferentAgentId(route, agent.id, 202);
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Uncertain Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  // Only Refresh is offered until a readback settles the outcome.
  const stopControls = page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button");
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");

  // A read for a different Agent cannot unlock another destructive request either.
  await page.route(
    fixture.origin + agentPath,
    (route) => replyWithDifferentAgentId(route, agent.id, 200),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await page.getByText("Could not refresh stop status.").waitFor();
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);

  // Even this Agent's active status cannot tell us whether it is requested to run or stop.
  // Omit only the desired state from the controller's real, committed Stop readback.
  await page.route(
    fixture.origin + agentPath,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const { data, meta } = await response.json();
      const { desiredRuntimeState, ...rest } = data;
      assert.equal(rest.id, agent.id);
      assert.equal(rest.namespaceId, namespace.id);
      assert.equal(rest.status, "active");
      assert.equal(desiredRuntimeState, "stopped");
      await route.fulfill({ response, json: { data: rest, meta } });
    },
    { times: 1 },
  );
  const reads = await settledFetches(page, agentPath);
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  await waitForSettledFetches(page, agentPath, reads + 1);
  assert.deepEqual(await stopControls.allTextContents(), ["Refresh stop status"]);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh stop status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Stop requested.").waitFor();
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  // Readback permits an explicit new intent; it never resends the masked request.
  await waitForEnabled(page.getByRole("button", { name: "Request Stop again" }));
});

test("An uncertain repeated Stop offers only Refresh stop status", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Repeat uncertainty");
  const agent = await fixture.createAgent(namespace.id, "Repeat Unknown", nativeValues("rep-unk"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  assert.equal((await fixture.request("POST", stopPath)).status, 202);
  const { page } = await newPage(t, fixture);
  await page.route(`**${stopPath}`, (route, request) =>
    request.method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
          }),
        })
      : route.continue(),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Request Stop again", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  // No disabled Request Stop again beside Refresh (finding 1899).
  assert.deepEqual(await stopRegion.getByRole("button").allTextContents(), ["Refresh stop status"]);
});

// A Stop whose answer was lost before it reached the API leaves the Agent running; the readback
// says so as information, not a warning, and offers Stop again (finding 2035).
test("an uncertain Stop the API never received reads back as still requested to run", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Unsent stop");
  const agent = await fixture.createAgent(namespace.id, "Unsent Stop", nativeValues("unsent"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  const { page } = await newPage(t, fixture);
  await page.route(`**${stopPath}`, (route, request) =>
    request.method() === "POST"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
            meta: { requestId: "req_00000000-0000-4000-8000-000000002035" },
          }),
        })
      : route.continue(),
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  const stopRegion = page.getByRole("region", { name: "Stop Agent", exact: true });
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await stopRegion.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.desiredRuntimeState, "running");
  await stopRegion.getByRole("button", { name: "Refresh stop status", exact: true }).click();
  const notice = stopRegion.getByText("The Agent is still requested to run.", { exact: true });
  await notice.waitFor();
  assert.deepEqual(await statusTone(notice), { className: "status", tone: "info", role: "status" });
  await waitForEnabled(stopRegion.getByRole("button", { name: "Stop Agent", exact: true }));
});

test("Agent stop denial keeps the Agent running with permission feedback", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Stop denial");
  const agent = await fixture.createAgent(
    namespace.id,
    "Denied Stop Candidate",
    nativeValues("stop-denied"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const limited = await fixture.createNamespaceMember(
    "agent-stop-denied",
    namespace.id,
    AGENT_READ,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await withholdPermissionSummary(page, fixture, namespace.id, agent.id);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Stop Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Stop Agent" }).click();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/stop` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog", { name: "Stop this Agent?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to stop this Agent").waitFor();
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  await waitForEnabled(page.getByRole("button", { name: "Stop Agent" }));
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.desiredRuntimeState, "running");
  assert.equal(current.data.activeRevisionId, active.revision.id);
});

test("a read-only principal sees Agent mutation controls disabled or absent before any denial", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Read-only controls", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Read-only Agent", nativeValues("ro"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const viewer = await fixture.createNamespaceMember(
    "agent-controls-viewer",
    namespace.id,
    AGENT_READ,
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents?namespace=${namespace.id}`, viewer.credentials);
  await page.getByText("Your access does not include creating Agents in this Namespace.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  const current = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(current.href);
  await page.getByRole("heading", { name: "Read-only Agent" }).waitFor();
  const openDraft = page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open version draft" });
  await openDraft.waitFor();
  await waitForEnabled(openDraft);
  // The answer denies operate and delete, so the page has no danger zone at all (UX spec 3.9):
  // a reader is not offered Stop or Delete, disabled or not.
  await waitForDangerZoneRows(page, { stop: false, delete: false });
  assert.equal(await page.getByRole("region", { name: "Danger zone" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).count(), 0);
  for (const reason of ["stopping", "deleting"]) {
    const text = page.getByText(`Your access does not include ${reason} this Agent.`);
    assert.equal(await text.isVisible(), false, reason);
  }

  const draft = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await page.goto(draft.href);
  await page.getByText("Your access does not include deploying this Agent.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  // The summary is a probe, not an attempted operation: no write was sent and nothing was
  // audited as a denial for the summary or the gated operations.
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  const deniedActions = auditSink
    .list()
    .filter((event) => event.kind === "authorization_denial")
    .map((event) => event.action);
  for (const action of [
    "openclaw.namespaces.permissions.read",
    "openclaw.agents.permissions.read",
    "openclaw.agents.delete",
    "openclaw.agents.stop",
    "openclaw.agents.deploy",
  ]) {
    assert.equal(deniedActions.includes(action), false, action);
  }
});

// Waits until the danger zone shows exactly the given rows. The zone is attached at the end of
// the page build and the view is held back while it loads, so neither a missing zone nor a
// pending view counts: a row is judged by the hidden flag its component sets, the zone by
// whether it renders.
async function waitForDangerZoneRows(page, rows) {
  await page.waitForFunction(({ stop, delete: remove }) => {
    const zone = globalThis.document.querySelector("section.danger-zone");
    const stopRow = zone?.querySelector("section.stop-note");
    const deleteRow = zone?.querySelector("section.deletion-note");
    if (!stopRow || !deleteRow || zone.closest(".agent-detail-pending")) {
      return false;
    }
    return (
      !stopRow.hidden === stop &&
      !deleteRow.hidden === remove &&
      zone.getClientRects().length > 0 === (stop || remove)
    );
  }, rows);
}

// Stop and Delete were two full cards, each a heading, a paragraph and one button (finding
// 1910). They are now the two rows of one danger zone card; the paragraphs moved into the
// confirmations, and only a confirmation's own button is filled (UX spec 3.9, plan D2).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`Stop and Delete share one danger zone card at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Danger zone", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Danger Zone Agent", nativeValues("dz"));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { context: { viewport } });
    const requests = apiRequests(page, fixture.origin);
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    );
    await page.getByRole("heading", { name: "Danger Zone Agent" }).first().waitFor();
    const zone = page.getByRole("region", { name: "Danger zone", exact: true });
    await zone.waitFor();
    await waitForDangerZoneRows(page, { stop: true, delete: true });
    assert.equal(await page.locator(".card--danger").count(), 1);
    assert.equal(await zone.locator(".card--danger").count(), 1);
    assert.deepEqual(await zone.getByRole("heading", { level: 3 }).allTextContents(), [
      "Stop Agent",
      "Delete Agent",
    ]);
    // The zone closes the page: nothing renders below it.
    assert.equal(await zone.evaluate((node) => node.nextElementSibling === null), true);

    const rows = [
      {
        name: "Stop Agent",
        sentence: "Stops the running version. The Agent stays and can be deployed again.",
        dialog: "Stop this Agent?",
        confirm: "Stop Agent",
        prose: /Configuration, versions, Credentials, and workspace data are retained\./,
      },
      {
        name: "Delete Agent",
        sentence:
          "Permanently deletes this Agent, its versions and its workspace data. Cannot be undone.",
        dialog: "Delete Danger Zone Agent?",
        confirm: "Permanently delete Agent",
        prose:
          /This permanently deletes the Agent, its version history, and its workspace data\. This cannot be undone\./,
      },
    ];
    const danger = "rgb(185, 28, 28)";
    for (const row of rows) {
      const region = zone.getByRole("region", { name: row.name, exact: true });
      // One sentence under the title, and the confirmation's prose is not on the page.
      assert.deepEqual(await region.locator(".danger-zone-text p").allTextContents(), [
        row.sentence,
      ]);
      assert.equal(await page.getByText(row.prose).count(), 0);
      const action = region.getByRole("button", { name: row.name, exact: true });
      const [title, button] = await Promise.all([
        region.getByRole("heading", { name: row.name, exact: true }).boundingBox(),
        action.boundingBox(),
      ]);
      if (viewport.width >= 1440) {
        // Title and sentence at the left, the button at the right of the same row.
        assert.ok(button.x > title.x + title.width, `${row.name} button beside its text`);
        assert.ok(button.y < title.y + 60, `${row.name} button on the title's row`);
      } else {
        assert.ok(button.y > title.y + title.height, `${row.name} button under its text`);
      }
      // The row's button is outlined; only the confirmation's is filled.
      const paint = (locator) =>
        locator.evaluate((node) => {
          const style = globalThis.getComputedStyle(node);
          return { color: style.color, border: style.borderTopColor, fill: style.backgroundColor };
        });
      const outlined = await paint(action);
      assert.equal(outlined.color, danger);
      assert.equal(outlined.border, danger);
      assert.notEqual(outlined.fill, danger);

      await action.click();
      const dialog = page.getByRole("dialog", { name: row.dialog });
      await dialog.getByText(row.prose).waitFor();
      const confirm = dialog.getByRole("button", { name: row.confirm, exact: true });
      assert.deepEqual(await paint(confirm), {
        color: "rgb(255, 255, 255)",
        border: danger,
        fill: danger,
      });
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await page.locator("dialog[open]").waitFor({ state: "detached" });
    }
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

// A viewer the answer allows to delete but not to operate gets the Delete row only.
test("the danger zone offers only the rows the caller's permission answer allows", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete only", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Delete Only Agent", nativeValues("do"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const deleter = await fixture.createNamespaceMember("danger-zone-deleter", namespace.id, [
    ...AGENT_READ,
    ["delete", "agent"],
  ]);
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    deleter.credentials,
  );
  await page.getByRole("heading", { name: "Delete Only Agent" }).first().waitFor();
  await waitForDangerZoneRows(page, { stop: false, delete: true });
  const zone = page.getByRole("region", { name: "Danger zone", exact: true });
  assert.deepEqual(await zone.getByRole("heading", { level: 3 }).allTextContents(), [
    "Delete Agent",
  ]);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).count(), 0);
  assert.equal(
    await zone.getByRole("button", { name: "Delete Agent", exact: true }).isEnabled(),
    true,
  );
  // The lone row has no divider above it.
  assert.equal(
    await zone
      .locator("section.deletion-note")
      .evaluate((node) => globalThis.getComputedStyle(node).borderTopStyle),
    "none",
  );
});

// Only a negative answer hides a row: without an answer the page keeps both, and the API decides.
test("the danger zone keeps both rows when the permission answer fails", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("No permission answer", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Unanswered Agent", nativeValues("ua"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const permissionPath = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/permissions`;
  await page.route(permissionPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." } }),
    }),
  );
  const answered = page.waitForResponse((response) => response.url() === permissionPath);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
  );
  assert.equal((await answered).status(), 503);
  await page.getByRole("heading", { name: "Unanswered Agent" }).first().waitFor();
  await waitForDangerZoneRows(page, { stop: true, delete: true });
  await settlePageRequests(page);
  const zone = page.getByRole("region", { name: "Danger zone", exact: true });
  for (const name of ["Stop Agent", "Delete Agent"]) {
    assert.equal(await zone.getByRole("button", { name, exact: true }).isEnabled(), true, name);
  }
});

// A member's full load of Agents painted Create Agent enabled, then disabled it and put the note
// above the table: 59 px at 390x844, 36 px on desktop (finding 1517). In an empty Namespace the
// copy then invited creating, and Create Agent by URL refused only at submit (finding 1521).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a member without Agent create is refused from the first paint at ${viewport.width}x${viewport.height}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const listed = await fixture.createNamespace("Member list", { ready: true });
    const empty = await fixture.createNamespace("Member empty", { ready: true });
    await fixture.createAgent(listed.id, "Member visible Agent", nativeValues("m1"));
    const member = await fixture.createAccountWithPolicy("agent-list-member", (principal) => {
      for (const namespace of [listed, empty]) {
        fixture.policy.roles.push({
          id: `role-agent-list-member-${namespace.id}`,
          namespaceId: namespace.id,
          permissions: [
            { action: "read", resourceKind: "namespace" },
            { action: "read", resourceKind: "agent" },
          ],
        });
        fixture.policy.bindings.push({
          id: `binding-agent-list-member-${namespace.id}`,
          namespaceId: namespace.id,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: `role-agent-list-member-${namespace.id}`,
        });
      }
    });
    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(page, fixture, `/console/agents?namespace=${listed.id}`, member.credentials);
    await page.getByText("Member visible Agent", { exact: true }).waitFor();

    // A full load has no recent input to excuse a shift.
    await page.addInitScript(recordLayoutShifts);
    await page.addInitScript(() => {
      const states = [];
      globalThis.__createStates = states;
      new globalThis.MutationObserver(() => {
        const create = [...globalThis.document.querySelectorAll("button")].find(
          (node) => node.textContent === "Create Agent",
        );
        const state = create ? (create.disabled ? "disabled" : "enabled") : null;
        if (state && states.at(-1) !== state) {
          states.push(state);
        }
      }).observe(globalThis.document, { subtree: true, childList: true, attributes: true });
    });
    await page.reload();
    const note = page.getByText("Your access does not include creating Agents in this Namespace.");
    await note.waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
    await page.getByText("Reading deployment…").first().waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => globalThis.__createStates), ["disabled"]);
    const { shifts } = await takeLayoutShifts(page);
    // Headless Chromium reports a body entry when the page gets shorter; the list must not move.
    const listShifts = shifts.filter((entry) =>
      entry.sources.some((source) => !source.node.startsWith("BODY")),
    );
    assert.deepEqual(listShifts, []);

    // An empty Namespace does not invite creating under the note.
    await page.goto(`${fixture.origin}/console/agents?namespace=${empty.id}`);
    await page.getByRole("heading", { name: "No Agents yet" }).waitFor();
    await note.waitFor();
    await page
      .getByText("Agents in this Namespace that are shared with you appear here.")
      .waitFor();
    assert.equal(await page.getByText(/Create an Agent in this Namespace/).count(), 0);

    // Create Agent by URL refuses up front instead of at submit.
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${empty.id}`);
    await page.getByRole("heading", { name: "Creating Agents is not available" }).waitFor();
    await page
      .getByText(/Your access does not include creating Agents in this Namespace\./)
      .waitFor();
    assert.equal(await page.getByRole("button", { name: "Start without Preset" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "← Agents" }).isVisible(), true);
  });
}

test("a version editor without Agent update can recover a failed deployment from the draft", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Version editor");
  const agent = await fixture.createAgent(
    namespace.id,
    "Version editor Agent",
    nativeValues("v1"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const failed = await fixture.deployAgent(namespace.id, agent.id);
  const editor = await fixture.createNamespaceMember("version-editor", namespace.id, [
    ...AGENT_READ,
    ["deploy", "agent"],
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  // The fixture has no deployment worker; supply its persisted failure record for v2.
  await page.route(`${fixture.origin}${path}/deployments/${failed.id}`, (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          deploymentId: failed.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "failed",
          error: persistedDeploymentError("RUNTIME_MODEL_PROBE_FAILED"),
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_version_editor_failure" },
      },
    }),
  );
  const requests = apiRequests(page, fixture.origin);
  // Hold the permission answer until the Versions list is built: the draft entry and the chooser
  // option must be labelled again when it lands (finding 2405).
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    editor.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  await page.locator(".revision-create").waitFor();
  const summary = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  firstPermissions.release();
  const response = await summary;
  assert.equal(response.status(), 200);
  assert.deepEqual((await response.json()).data, {
    update: false,
    deploy: true,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: true,
    configurationRead: true,
    configurationSecretsOperate: true,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: false,
    sandboxPolicyRead: false,
  });

  // The header label confirms the page applied the permission answer before recovery is used.
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open version draft" })
    .waitFor();
  // Without Agent update the Versions list's draft entry is not called editable, nor read-only:
  // this caller can save the Configuration (finding 2405).
  await page.getByRole("button", { name: "View version draft", exact: true }).waitFor();
  // The narrow-width version chooser names the draft the same way.
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "Version draft",
  );
  const recovery = page.getByRole("region", { name: "Deployment needs attention" });
  await recovery
    .getByText("v2 failed its startup model check (RUNTIME_MODEL_PROBE_FAILED).", { exact: false })
    .waitFor();
  // This caller may edit the Configuration, so recovery opens it as such (finding 2450).
  await recovery.getByRole("link", { name: "Open Configuration", exact: true }).click();
  await recovery.getByRole("link", { name: "Open Configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  // Hold the save's permission reread before it reaches the API, so the refreshed details render
  // first and the reread sees Configuration update revoked after the save.
  const permission = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    once: true,
  });
  const saving = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith("/configurations/" + agent.configurationId),
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  const saved = await saving;
  assert.equal(saved.status(), 200);
  assert.deepEqual((await saved.json()).data.values, nativeValues("edited"));
  await permission.requested;
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  assert.equal(
    await recovery.getByRole("link", { name: "Open Configuration", exact: true }).isVisible(),
    true,
  );
  const restoreGrants = revokeMemberGrant(fixture, "version-editor", ["update", "configuration"]);
  const reread = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  permission.release();
  assert.equal((await (await reread).json()).data.configurationUpdate, false);
  // The reread applies to recovery: the Configuration is now read-only, so this deployer is
  // offered the draft to read and deploy.
  await recovery
    .getByRole("link", { name: "Open Configuration", exact: true })
    .waitFor({ state: "detached" });
  await recovery.getByRole("link", { name: "Open version draft", exact: true }).waitFor();

  restoreGrants();
  await page.reload();

  const deploying = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(path + "/deploy"),
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const deployed = await deploying;
  assert.equal(deployed.status(), 202);
  assert.equal((await deployed.json()).data.agentId, agent.id);
  assert.equal(pathRequests(requests, "PATCH", path).length, 0);
});

// The Agent page's copy for a caller without Configuration update (finding 2421).
const CONFIGURATION_READ_ONLY = "Your access does not include editing this Configuration.";
const CHANNELS_READ_ONLY = `These are the version draft’s channel settings. ${CONFIGURATION_READ_ONLY}`;
const CONFIGURATION_SECRETS_READ_ONLY =
  "Saving this Configuration needs Secret operate on each Secret it binds, which your access does not include.";
// A channel save keeps a binding whose Secret the member may not operate (finding 2444).
const KEPT_SECRET_CHANNEL_SECRETS =
  "Each Configuration save needs Secret operate on every Secret it keeps bound. Your access does not include it for EXTERNAL_API_TOKEN, which channel saves keep.";
const REPLACE_BOT_TOKEN =
  "Your access does not include Secret operate on the Secret bound to Slack bot token. Each save needs it for every Secret it keeps bound, so choose another Secret for it before saving.";
const KEEPS_BOT_TOKEN =
  "This save keeps Slack bot token on a Secret your access cannot operate. Choose another Secret for it, then save.";
const DISABLE_KEEPS_BOT_TOKEN =
  "Disabling keeps Slack bot token on a Secret your access cannot operate. Choose another Secret for it in Edit Slack first, then disable.";
const AGENT_SOURCES_DENIED =
  "Saving these settings needs operate on each Secret and credential source this Agent and its Configuration bind, which your access does not include. Ask an administrator for that access.";
// Slack Socket Mode reading its tokens from SLACK_APP_TOKEN and SLACK_BOT_TOKEN, which a test
// binds to Secrets or leaves unbound.
const SOCKET_SLACK = {
  enabled: true,
  mode: "socket",
  appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
  botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  allowFrom: ["U123"],
  channels: { C123: { requireMention: true } },
};
const READ_ONLY_DRAFT_NOTICE =
  "Version draft · read-only with your access. The next deployment uses it as saved.";
const PLUGINS_READ_ONLY =
  "These are the version draft's plugin selections, read-only with your access. The next deployment uses them as saved.";

// A member who can only read the Agent views its draft: the saved JSON with no editor whose
// Save answers 403, and no editor's copy or checklist (finding 2421).
test("a reader without update views the version draft read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Draft reader");
  const agent = await fixture.createAgent(namespace.id, "Draft reader Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember("draft-reader", namespace.id, AGENT_READ);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    reader.credentials,
  );
  assert.deepEqual((await (await permissions).json()).data, {
    update: false,
    deploy: false,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: false,
    configurationRead: true,
    configurationSecretsOperate: false,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: false,
    sandboxPolicyRead: false,
  });
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  await page.getByText("View native Configuration", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Enable gateway password access" }).count(),
    0,
  );
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/New version\. Changes affect/).count(), 0);
  // The draft card names the draft; Deploy says why it is disabled, with no editor's steps.
  await page.getByRole("heading", { name: "Version draft", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Prepare this version" }).count(), 0);
  assert.equal(
    await page.getByText("Edit and save Configuration, plugins, or Channels").isVisible(),
    false,
  );
  await page.getByText("Your access does not include deploying this Agent.").waitFor();
  const entry = page.getByRole("button", { name: "View version draft", exact: true });
  await entry.getByText("Read-only Configuration", { exact: true }).waitFor();

  // Plugin selections are an Agent-side save. The reader reads them, with no editor's copy, and
  // the page does not ask for the policy capabilities, a read that needs Agent update and would
  // answer 403 (finding 2436).
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  // The version notice addresses the reader too, not an editor whose changes reach the next
  // deployment (finding 2455).
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Plugin changes to this Agent appear/).count(), 0);
  // A read-only summary: no editor, no disabled Save or Discard, no instructions (finding 2455).
  assert.equal(await page.getByLabel("Plugin selections JSON", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /Save plugin|Discard/ }).count(), 0);
  await expectNoText(
    page,
    /remains editable|Save selections on this Agent|No plugin changes|Select plugins/,
  );
  assert.deepEqual(pathRequests(requests, "GET", `${path}/plugins/capabilities`), []);

  // The current version's Configuration opens the draft to read it; it offers no editor.
  await page.goto(
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").href,
  );
  const snapshot = page
    .locator("section.agent-card")
    .filter({ has: page.getByRole("heading", { name: "Configuration snapshot" }) });
  await snapshot.getByRole("button", { name: "Open version draft", exact: true }).click();
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("revision"), "draft");
  assert.equal(await page.getByRole("button", { name: "Edit current Configuration" }).count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// The permission answer can land after a version's page or the Plugins tab is drawn. A reader's
// Edit current Configuration turns into Open version draft in place, and the Plugins tab waits
// for the answer before it reads the policy capabilities, which need Agent update (finding 2436).
test("a late permission answer relabels a reader's version entry and skips plugin capabilities", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Late plugin reader");
  const agent = await fixture.createAgent(namespace.id, "Late plugin Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await fixture.createNamespaceMember(
    "late-plugin-reader",
    namespace.id,
    AGENT_READ,
  );
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const capabilities = () => pathRequests(requests, "GET", `${path}/plugins/capabilities`);
  const firstAnswer = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    reader.credentials,
  );
  await firstAnswer.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  const snapshot = page
    .locator("section.agent-card")
    .filter({ has: page.getByRole("heading", { name: "Configuration snapshot" }) });
  // Until the answer lands the page assumes an editor.
  await snapshot.getByRole("button", { name: "Edit current Configuration", exact: true }).waitFor();
  firstAnswer.release();
  await snapshot.getByRole("button", { name: "Open version draft", exact: true }).waitFor();

  const secondAnswer = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.goto(detailUrl(fixture, namespace.id, agent.id, "draft", "plugins").href);
  await secondAnswer.requested;
  await page.getByLabel("Plugin selections JSON", { exact: true }).waitFor({ state: "attached" });
  assert.deepEqual(capabilities(), []);
  secondAnswer.release();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  assert.deepEqual(capabilities(), []);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Agent update and Configuration update are separate grants. A member with only Agent update
// keeps the Agent's own editors, but the draft's Configuration, its Versions entry and Channels
// say they are read-only, so no Save answers 403 (finding 2421).
test("an Agent editor without Configuration update sees the Configuration read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Agent-only editor");
  const agent = await fixture.createAgent(namespace.id, "Agent-only Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await fixture.createNamespaceMember("agent-only-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  assert.deepEqual((await (await permissions).json()).data, {
    update: true,
    deploy: false,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: false,
    configurationRead: true,
    configurationSecretsOperate: false,
    configurationSecretsOperateDeniedBindings: [],
    agentSourcesOperate: true,
    sandboxPolicyRead: false,
  });
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  // The draft stays a new version (this member can change the Agent's own settings), but its
  // Configuration is not called editable.
  const entry = page.getByRole("button", {
    name: "View new version, read-only Configuration",
    exact: true,
  });
  await entry.getByText("Read-only Configuration", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "New version · read-only Configuration",
  );
  // Agent update alone keeps the draft a member can change, so the notice is not a reader's.
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Each Configuration save and each Agent update also checks operate on every Secret the
// Configuration binds. A member with Agent update and Configuration update but no operate on the
// bound Secret had every editor disabled, yet the draft still read as a new version they could
// change (finding 2441). Its labels, notice and card now follow the combined answer.
test("an editor without operate on a bound Secret views the version draft read-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unoperated Secret editor", { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound token", "bound-token-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Unoperated Secret Agent",
    nativeValues("v1"),
    {
      secretBindings: { EXTERNAL_API_TOKEN: { source: bound.ref, delivery: { type: "env" } } },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const member = await fixture.createNamespaceMember("unoperated-secret-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  assert.deepEqual((await (await permissions).json()).data, {
    update: true,
    deploy: false,
    operate: false,
    delete: false,
    administer: false,
    configurationUpdate: true,
    configurationRead: true,
    configurationSecretsOperate: false,
    configurationSecretsOperateDeniedBindings: ["EXTERNAL_API_TOKEN"],
    agentSourcesOperate: false,
    sandboxPolicyRead: false,
  });
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  assert.equal(await page.getByText(/New version\. Changes affect/).count(), 0);
  const entry = page.getByRole("button", { name: "View version draft", exact: true });
  await entry.getByText("Read-only Configuration", { exact: true }).waitFor();
  assert.equal(
    await page.locator("#revision-selector option[value=draft]").textContent(),
    "Version draft",
  );
  // No editor's checklist: this member can change nothing here and cannot deploy.
  await page.getByRole("heading", { name: "Version draft", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Prepare this version" }).count(), 0);
  // The current version's header opens the draft rather than offering to create a version.
  await page.goto(
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").href,
  );
  await page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open version draft", exact: true })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Deploy is its own grant. A member who can deploy the draft but change none of it reads it, and
// keeps the checklist of what the next deployment needs. Deploy's status says what is missing and
// that this member cannot change the draft to fix it (finding 2421).
test("a deployer without update keeps the draft checklist", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Draft deployer", { ready: true });
  // Slack is on and its token Secrets are not bound, so the draft is not ready to deploy.
  const agent = await fixture.createAgent(
    namespace.id,
    "Draft deployer Agent",
    nativeValues("slack", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    { executionMode: "dedicated" },
  );
  const deployer = await fixture.createNamespaceMember("draft-deployer", namespace.id, [
    ...AGENT_READ,
    ["deploy", "agent"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    deployer.credentials,
  );
  const answer = (await (await permissions).json()).data;
  assert.equal(answer.deploy, true);
  assert.equal(answer.update, false);
  assert.equal(answer.configurationUpdate, false);
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Prepare this version", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Version draft", exact: true }).count(), 0);
  await page
    .locator(".agent-draft-actions")
    .getByText(/\. Your access does not include changing this version draft\.$/)
    .waitFor();
});

// The permission answer can land after the draft is drawn; nothing waits for it. When it denies
// Configuration update, the Channels tab, the draft card and the Credentials tab's Channel
// Secrets panel turn read-only in place (findings 2421, 2432).
test("a late permission answer turns a reader's Channels and Channel Secrets read-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Late reader answer", { ready: true });
  // Slack is on and its token Secrets are not bound yet, so an editor's draft offers to set them.
  const agent = await fixture.createAgent(
    namespace.id,
    "Late reader Agent",
    nativeValues("slack", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    { executionMode: "dedicated" },
  );
  const reader = await fixture.createNamespaceMember("late-reader", namespace.id, [
    ...AGENT_READ,
    ["read", "secret"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    reader.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  // Until the answer lands the page assumes an editor.
  await page.getByText(/^Save and Disable update only the shared Configuration draft\./).waitFor();
  await page.getByRole("button", { name: "Set up credentials", exact: true }).waitFor();
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  firstPermissions.release();
  assert.equal((await (await answer).json()).data.configurationUpdate, false);
  await page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor();
  await page.getByText("Read-only with your access.", { exact: true }).waitFor();
  // A reader's card offers no editor's action; Deploy says why it is disabled.
  await page
    .getByRole("button", { name: "Set up credentials", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByText("Your access does not include deploying this Agent.").waitFor();

  // The Channel Secrets panel was built before the answer, with enabled pickers.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page
    .getByText(
      "Your access does not include editing this Configuration, so its channel Secrets are read-only.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(await page.getByLabel("Slack bot token").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);
  // A disabled picker says what is bound, not how to choose or create a Secret (finding 2438).
  const channelSecrets = page.locator("section.channel-secrets");
  await channelSecrets.getByText("No Secret is bound.", { exact: true }).nth(1).waitFor();
  assert.equal(
    await channelSecrets.getByText("Choose an existing Secret or create a new one.").count(),
    0,
  );
  // At desktop width the Channel Secrets card is as wide as the Harness authentication card
  // above it (finding 2438).
  await page.setViewportSize({ width: 1440, height: 900 });
  const width = (locator) => locator.evaluate((node) => node.getBoundingClientRect().width);
  assert.equal(
    await width(channelSecrets),
    await width(page.locator("form:has(#harness-auth-method)")),
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// Every Configuration save also needs Secret operate on each Secret it keeps bound. A member with
// Configuration update but no Secret operate on a Secret bound to a name channel saves keep is
// told so up front: no picker, editor or Save whose PATCH would answer 403 (findings 2437, 2444).
test("a Configuration editor without Secret operate on a kept bound Secret reads the channel Secrets", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Secrets editor", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Bound app token", "xapp-bound-value");
  const bot = await fixture.createSecret(namespace.id, "Bound bot token", "xoxb-bound-value");
  const external = await fixture.createSecret(namespace.id, "External token", "external-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Bound Secrets Agent",
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
        // Channel saves resubmit this binding, so they need operate on its Secret.
        EXTERNAL_API_TOKEN: { source: external.ref, delivery: { type: "env" } },
      },
    },
  );
  const member = await fixture.createNamespaceMember("bound-secrets-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
    ["read", "secret"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const answer = (await (await permissions).json()).data;
  assert.equal(answer.configurationUpdate, true);
  assert.equal(answer.configurationSecretsOperate, false);
  assert.deepEqual(answer.configurationSecretsOperateDeniedBindings, [
    "EXTERNAL_API_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_BOT_TOKEN",
  ]);
  await page.getByRole("heading", { name: "Channel Secrets" }).waitFor();
  await page.getByText(KEPT_SECRET_CHANNEL_SECRETS, { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(await page.getByLabel("Slack bot token").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).count(), 0);

  // The Configuration editor's Save binds the same Secrets, so it is read-only too.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText(CONFIGURATION_SECRETS_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page
    .getByText(`These are the version draft’s channel settings. ${KEPT_SECRET_CHANNEL_SECRETS}`, {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Slack" }).count(), 0);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// The replace persona (finding 2444): a member with Configuration update who may operate the app
// token Secret and their own Secret, but not the administrator's bot token Secret, which the
// draft binds. `agentUpdate` adds Agent update and operate on the model key Secret, so only the
// bot token Secret refuses Agent-side saves (finding 2470).
async function replaceSecretFixture(t, label, { agentUpdate = false } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(label, { ready: true });
  const app = await fixture.createSecret(namespace.id, "Admin app token", "xapp-admin-value");
  const bot = await fixture.createSecret(namespace.id, "Admin bot token", "xoxb-admin-value");
  const own = await fixture.createSecret(namespace.id, "Member bot token", "xoxb-member-value");
  const agent = await fixture.createAgent(
    namespace.id,
    `${label} Agent`,
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const slug = label.toLowerCase().replaceAll(" ", "-");
  const member = await fixture.createNamespaceMember(slug, namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
    ["read", "secret"],
    ...(agentUpdate ? [["update", "agent"]] : []),
  ]);
  const operated = [app.id, own.id];
  if (agentUpdate) {
    const { data } = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    operated.push(data.harnessAuth.source.id);
  }
  grantSecretOperate(fixture, namespace.id, member.principal, operated);
  return {
    fixture,
    namespace,
    agent,
    member,
    app,
    own,
    path: `/namespaces/${namespace.id}/agents/${agent.id}`,
    configurationPath: `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  };
}

// A save is checked on the Secrets it submits, not on the ones it replaces. A member who may not
// operate the administrator's bot token Secret, but may operate the app token Secret and their
// own, can bind their own Secret for the bot token. A save that keeps the administrator's Secret
// is refused before any request, naming the binding to replace (finding 2444).
test("a channel Secrets save may replace a bound Secret the member cannot operate", async (t) => {
  const { fixture, namespace, agent, member, app, own, path, configurationPath } =
    await replaceSecretFixture(t, "Replaced Secret editor");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const answer = (await (await permissions).json()).data;
  assert.equal(answer.configurationSecretsOperate, false);
  assert.deepEqual(answer.configurationSecretsOperateDeniedBindings, ["SLACK_BOT_TOKEN"]);
  // The panel stays editable and says which binding a save must replace, so the draft is not
  // called read-only.
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor();
  await waitForEnabled(page.getByLabel("Slack app token"));
  assert.equal(await page.getByText(KEPT_SECRET_CHANNEL_SECRETS).count(), 0);
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).count(), 0);
  // The Configuration editor submits no bindings, so its save keeps the administrator's Secret:
  // it stays read-only for this member.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByText(CONFIGURATION_SECRETS_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor();

  // Changing only the app token keeps the administrator's bot token Secret: refused up front.
  await selectSecret(page, "Slack app token", own);
  requests.length = 0;
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  await page
    .locator(".channel-secrets [role=alert]")
    .getByText(KEEPS_BOT_TOKEN, { exact: true })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // The app token back on its Secret and the member's own Secret for the bot token: saved.
  await selectSecret(page, "Slack app token", app);
  await selectSecret(page, "Slack bot token", own);
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  const saved = await fixture.request("GET", configurationPath);
  assert.deepEqual(saved.data.secretBindings, {
    SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: own.ref, delivery: { type: "env" } },
  });
  // The bot token now binds the member's own Secret. The page reads the answer again, so nothing
  // is left to replace: neither the next panel save nor a Channels drawer save is refused
  // (finding 2457).
  await page.getByText(REPLACE_BOT_TOKEN, { exact: true }).waitFor({ state: "detached" });
  await selectSecret(page, "Slack app token", own);
  const resaving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await resaving).status(), 200);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Require a mention").waitFor();
  assert.equal(await dialog.getByText(/choose another Secret/).count(), 0);
  await dialog.getByLabel("Require a mention").setChecked(false);
  const drawerSaving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await drawerSaving).status(), 200);
});

// The Channels drawer saves the same bindings. While the administrator's bot token Secret stays
// bound, its save is refused before any request; replacing it saves (finding 2444).
test("the Channels drawer save must replace a bound Secret the member cannot operate", async (t) => {
  const { fixture, namespace, agent, member, app, own, configurationPath } =
    await replaceSecretFixture(t, "Replaced drawer editor");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    member.credentials,
  );
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByText(REPLACE_BOT_TOKEN, { exact: false }).waitFor();
  // A channel setting alone keeps the administrator's Secret bound: refused up front.
  await dialog.getByLabel("Require a mention").setChecked(false);
  requests.length = 0;
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByText(KEEPS_BOT_TOKEN, { exact: true }).waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // With the member's own Secret for the bot token the same save goes through.
  await selectSecret(dialog, "Slack bot token", own);
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await saving).status(), 200);
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.secretBindings.SLACK_BOT_TOKEN.source.id, own.id);
  assert.equal(saved.data.secretBindings.SLACK_APP_TOKEN.source.id, app.id);
});

// Binding a Secret needs Secret operate on it. A Configuration editor with operate on only the
// two bound Slack Secrets was offered a third readable Secret, saw it staged, and met a 403 that
// asked for the Configuration update they had (finding 2453, D710). Each Secret field now lists
// it disabled with the reason and never stages it; a save refused after a revocation names it.
test("Secret fields refuse a readable Secret the editor cannot operate", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Operate-only Secrets", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Bound app token", "xapp-bound-value");
  const bot = await fixture.createSecret(namespace.id, "Bound bot token", "xoxb-bound-value");
  const spare = await fixture.createSecret(namespace.id, "Spare token", "xoxb-spare-value");
  const extra = await fixture.createSecret(namespace.id, "Extra token", "xoxb-extra-value");
  const other = await fixture.createSecret(namespace.id, "Other token", "xoxb-other-value");
  const agent = await fixture.createAgent(
    namespace.id,
    "Operate-only Agent",
    nativeValues("bound", { harnessId: "codex", channels: { slack: SOCKET_SLACK } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
      },
    },
  );
  const member = await fixture.createNamespaceMember("operate-only-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "agent"],
    ["update", "configuration"],
    ["read", "secret"],
  ]);
  // Secret operate on the bound Secrets, the Harness authentication Secret and the extra token:
  // every save is allowed, but binding the spare token is not.
  const operate = grantSecretOperate(fixture, namespace.id, member.principal, [
    app.id,
    bot.id,
    extra.id,
    other.id,
    agent.harnessAuth.source.id,
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  // The draft reads the answer when it opens, for its Deploy gate; the pickers reuse it.
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions/secrets"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const save = page.getByRole("button", { name: "Save channel Secrets" });
  await waitForEnabled(page.getByLabel("Slack bot token", { exact: true }));
  const denied = await operateDeniedSecretOption(page, "Slack bot token", spare);
  assert.deepEqual((await (await answer).json()).data, { operateDenied: [spare.id] });
  // A forced click skips the disabled check: choosing it still stages nothing.
  await denied.click({ force: true });
  await page.getByLabel("Slack bot token", { exact: true }).press("Enter");
  await page.getByLabel("Slack bot token", { exact: true }).press("Escape");
  assert.equal(await page.getByText("Secret binding staged. Save changes to apply it.").count(), 0);
  assert.equal(await save.isDisabled(), true);
  // The Harness authentication field and the Edit Slack drawer list it the same way.
  await waitForEnabled(page.getByLabel("API key Secret", { exact: true }));
  await operateDeniedSecretOption(page, "API key Secret", spare);
  await page.getByLabel("API key Secret", { exact: true }).press("Escape");
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await operateDeniedSecretOption(dialog, "Slack bot token", spare);
  await dialog.getByLabel("Slack bot token", { exact: true }).press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Nothing was saved: the drawer's only writes are its Slack directory lookups.
  assert.deepEqual(
    nonAuthWriteRequests(requests).filter(
      (request) => !request.path.endsWith("/channel-directory/lookup"),
    ),
    [],
  );

  // An operable Secret stages and saves as before. Operate on it is revoked after it is staged,
  // so the PATCH is refused: the refusal names the Secret and the grant, not Configuration
  // update, which this editor has.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  await selectSecret(page, "Slack bot token", extra);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  operate.revoke(extra.id);
  const refused = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await save.click();
  assert.equal((await refused).status(), 403);
  await page
    .locator(".channel-secrets [role=alert]")
    .getByText(secretOperateRefused(extra.name), { exact: false })
    .waitFor();

  // With Configuration update revoked too, the answer cannot say operate is all that is missing:
  // the refusal keeps the text that names both grants.
  await selectSecret(page, "Slack bot token", other);
  await page.getByText("Secret binding staged. Save changes to apply it.").waitFor();
  operate.revoke(other.id);
  revokeMemberGrant(fixture, "operate-only-editor", ["update", "configuration"]);
  const refusedAgain = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await save.click();
  assert.equal((await refusedAgain).status(), 403);
  const alert = page.locator(".channel-secrets [role=alert]");
  await alert.getByText(CONFIGURATION_SAVE_DENIED, { exact: false }).waitFor();
  assert.equal(
    await alert.getByText(secretOperateRefused(other.name), { exact: false }).count(),
    0,
  );
});

// An Agent whose harness key is bound, and a member with every write except Secret operate, which
// it holds on the bound key only. `withSpare` adds a readable Secret the member may not operate.
async function boundKeyMemberSetup(t, name, { withSpare = false } = {}) {
  const slug = name.toLowerCase().replaceAll(" ", "-");
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const bound = await fixture.createSecret(namespace.id, "Bound harness key", "sk-bound-value");
  const spare = withSpare
    ? await fixture.createSecret(namespace.id, "Spare key", "sk-spare-value")
    : undefined;
  const agent = await fixture.createAgent(
    namespace.id,
    `${name} Agent`,
    nativeValues(slug, { harnessId: "codex" }),
    { harnessAuth: { method: "api_key", source: bound.ref }, executionMode: "dedicated" },
  );
  const member = await fixture.createNamespaceMember(
    `${slug}-member`,
    namespace.id,
    MEMBER_WRITE.filter(([action, kind]) => !(action === "operate" && kind === "secret")),
  );
  grantSecretOperate(fixture, namespace.id, member.principal, [bound.id]);
  return { fixture, namespace, bound, spare, agent, member };
}

// Creating a Secret does not grant operate on it. The picker read the operate answer when its list
// opened, before the Secret existed, so a member who may create and read Secrets but operate only
// the bound one saw the new Secret staged and the save refused with an audited 403 (finding 2486).
// After an inline create the picker reads the answer again and refuses the new Secret in place.
test("a Secret created inline that the member cannot operate is not staged", async (t) => {
  // Operate covers every readable Secret, so the answer is empty until the new Secret exists.
  const { fixture, namespace, bound, agent, member } = await boundKeyMemberSetup(
    t,
    "Inline operate",
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const answers = [];
  page.on("response", (response) => {
    if (response.url() === `${fixture.origin}${path}/permissions/secrets`) {
      answers.push(response.status());
    }
  });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await picker.fill("no matching Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create harness authentication Secret" });
  await dialog.getByLabel("Name", { exact: true }).fill("Inline new key");
  await dialog.getByLabel("Value", { exact: true }).fill("sk-inline-new-value");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  // The Secret exists, but the field keeps the bound Secret and names why the new one is refused.
  await page
    .getByText(`Inline new key cannot be chosen. ${SECRET_OPERATE_DENIED}`, { exact: true })
    .waitFor();
  assert.equal(await picker.inputValue(), bound.name);
  assert.equal(await page.getByText("Secret binding staged. Save changes to apply it.").count(), 0);
  // The answer was read once when the list opened and again after the create.
  assert.deepEqual(answers, [200, 200]);
  // The new Secret is listed disabled with the reason.
  const created = (await fixture.request("GET", `/namespaces/${namespace.id}/secrets`)).data.find(
    (secret) => secret.name === "Inline new key",
  );
  assert.ok(created);
  await operateDeniedSecretOption(page, "API key Secret", created);
  await picker.press("Escape");
  // The only write is the Secret create: no save was sent, so no denial was audited.
  assert.deepEqual(
    nonAuthWriteRequests(requests).map(
      ({ method, path: requestPath }) => `${method} ${requestPath}`,
    ),
    [`POST /namespaces/${namespace.id}/secrets`],
  );
});

// A member denied operate on a readable Secret holds Secret operate per Secret, so a Secret it
// creates gets none. The picker offered Create new Secret anyway: the Secret was saved, then
// refused as a choice and left unused (finding 2500). The action is listed disabled with the
// reason the Preset's Create new Secret choice gives, before anything is created.
test("the picker's Create new Secret is disabled when operate covers only some Secrets", async (t) => {
  const { fixture, namespace, bound, spare, agent, member } = await boundKeyMemberSetup(
    t,
    "Operate some",
    { withSpare: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  const picker = page.getByLabel("API key Secret", { exact: true });
  await waitForInputValue(picker, bound.name);
  await waitForEnabled(picker);
  await operateDeniedSecretOption(page, "API key Secret", spare);
  const create = await deniedCreateSecretOption(page, "API key Secret", NEW_SECRET_OPERATE_DENIED);
  // A forced click skips the disabled check: choosing the action still opens nothing.
  await create.click({ force: true });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await picker.press("Escape");
  // The hint names the grant an administrator can give: operate on one Secret (finding 2507).
  await page
    .getByText(
      `Choose an existing Secret. ${NEW_SECRET_OPERATE_DENIED} ${NEW_SECRET_OPERATE_REMEDY}`,
      { exact: true },
    )
    .waitFor();
  assert.equal(await picker.inputValue(), bound.name);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

// A tab parked before the answer landed is shown again with the answer applied (finding 2421).
test("a Channels tab parked before a reader's permission answer returns read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Parked reader tab");
  const agent = await fixture.createAgent(namespace.id, "Parked reader Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  const reader = await fixture.createNamespaceMember("parked-reader", namespace.id, AGENT_READ);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const firstPermissions = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.clock.install();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    reader.credentials,
  );
  await firstPermissions.requested;
  // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
  // out; run it out rather than wait for it.
  await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
  await page.getByText(/^Save and Disable update only the shared Configuration draft\./).waitFor();
  // Park the editor's Channels view, then let the answer land on the Configuration tab.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  firstPermissions.release();
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await expectNoText(page, /^Save and Disable update only the shared Configuration draft\./, () =>
    page.getByText(CHANNELS_READ_ONLY, { exact: true }).waitFor(),
  );
});

// A draft refresh reads the permission answer again. When the reread revokes Configuration
// update after the rebuilt tab was drawn, the notice, the Versions entry and the Configuration
// tab turn read-only without a page Refresh (finding 2421).
test("a permission reread after a save turns the draft read-only", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Reread revocation");
  const agent = await fixture.createAgent(namespace.id, "Reread Agent", nativeValues("v1"), {
    harnessAuth: { method: "runtime" },
  });
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const editor = await fixture.createNamespaceMember("reread-editor", namespace.id, [
    ...AGENT_READ,
    ["update", "configuration"],
  ]);
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    editor.credentials,
  );
  assert.equal((await (await permissions).json()).data.configurationUpdate, true);
  const entry = page.getByRole("button", { name: "View version draft", exact: true });
  await entry.getByText("Configuration draft", { exact: true }).waitFor();
  // Configuration update alone keeps the draft editable, so the notice is not a reader's.
  await page
    .getByText(
      "New version. Changes affect future deployments using this Configuration. Admitted versions stay unchanged.",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  // The save reaches the API with the grant; the grant is revoked before its answer returns, so
  // the draft refresh's reread denies Configuration update.
  const patch = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    { method: "PATCH", afterServer: true, once: true },
  );
  const reread = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await patch.requested;
  revokeMemberGrant(fixture, "reread-editor", ["update", "configuration"]);
  patch.release();
  await reread.requested;
  // The rebuilt tab is drawn from the previous answer while the reread is held.
  await page.getByText("Configuration saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
  const answer = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  reread.release();
  assert.equal((await (await answer).json()).data.configurationUpdate, false);
  await page.getByText(READ_ONLY_DRAFT_NOTICE, { exact: true }).waitFor();
  await entry.getByText("Read-only Configuration", { exact: true }).waitFor();
  await page.getByText(CONFIGURATION_READ_ONLY, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Configuration" }).count(), 0);
});

test("a negative permission answer reaching an open Stop or Delete dialog prevents submission", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Open confirmation");
  const agent = await fixture.createAgent(
    namespace.id,
    "Confirmation race Agent",
    nativeValues("race"),
    {
      harnessAuth: { method: "runtime" },
    },
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const viewer = await fixture.createNamespaceMember(
    "confirmation-viewer",
    namespace.id,
    AGENT_READ,
  );
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  const permissionPath =
    fixture.origin + "/namespaces/" + namespace.id + "/agents/" + agent.id + "/permissions";
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  for (const action of ["Stop", "Delete"]) {
    // Delay delivery, not authorization: these are the controller's actual flags for this viewer.
    const permissions = await holdRequests(t, page, permissionPath, {
      afterServer: true,
      timeout: 0,
    });
    if (action === "Stop") {
      await login(page, fixture, url, viewer.credentials);
    } else {
      await page.goto(url.href);
    }
    const received = await permissions.requested;
    // The held answer keeps the page behind its stand-in until the overview's bounded wait runs
    // out; run it out rather than wait for it.
    await page.clock.fastForward(FIRST_ACTIVITY_WAIT_MS);
    assert.deepEqual(
      { status: received.status(), data: (await received.json()).data },
      {
        status: 200,
        data: {
          update: false,
          deploy: false,
          operate: false,
          delete: false,
          administer: false,
          configurationUpdate: false,
          configurationRead: true,
          configurationSecretsOperate: false,
          configurationSecretsOperateDeniedBindings: [],
          agentSourcesOperate: false,
          sandboxPolicyRead: false,
        },
      },
    );

    await page.getByRole("button", { name: action + " Agent", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: action === "Stop" ? "Stop Agent" : "Permanently delete Agent",
    });
    await confirm.focus();
    permissions.release();
    await dialog.getByText(/Your access does not include/).waitFor();
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement.textContent),
      "Cancel",
    );
    // Exercise the submit guard separately from the button's disabled behavior.
    await confirm.dispatchEvent("click");
    await settlePageRequests(page);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    // The row this viewer used stays, with the reason, instead of vanishing under them.
    const row = page.getByRole("region", { name: action + " Agent", exact: true });
    await row
      .getByRole("status")
      .getByText(/Your access does not include/)
      .waitFor();
    assert.equal(
      await row.getByRole("button", { name: action + " Agent", exact: true }).isDisabled(),
      true,
    );
    // Focus lands on the row's heading, which the visible row can take.
    const heading = action === "Stop" ? "agent-stop-title" : "agent-deletion-title";
    await page
      .waitForFunction((id) => globalThis.document.activeElement?.id === id, heading, {
        timeout: 3000,
      })
      .catch(async (error) => {
        const active = await page.evaluate(() => globalThis.document.activeElement?.outerHTML);
        throw new Error(`focus is on ${active?.slice(0, 200)}`, { cause: error });
      });
    await page.unroute(permissionPath);
  }
});

// A `null` passed to replaceChildren is painted as the text "null" (finding 1567).
test("the draft Configuration card paints no stray text beside its controls", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Configuration card", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Configuration Card Agent",
    nativeValues("card"),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  await page.getByRole("heading", { name: "Configuration Card Agent" }).waitFor();
  const card = page.locator(".configuration-draft-editor");
  const strayText = () =>
    card.evaluate((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === child.TEXT_NODE)
        .map((child) => child.textContent),
    );

  await card.getByText("View native Configuration").waitFor();
  assert.deepEqual(await strayText(), []);

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await card.getByText("View native Configuration").waitFor();
  assert.deepEqual(await strayText(), []);
});

// Agent-side saves check operate on every Secret the Configuration binds, so the administrator's
// bot token Secret also makes Plugins, Repositories and the authentication source read-only for
// this member. Rebinding the bot token on the member's own Secret lifts that: the page reads the
// answer again and those tabs become editable without a reload (finding 2470).
test("a channel save that rebinds a denied Secret makes the Agent-side tabs editable", async (t) => {
  const { fixture, namespace, agent, member, app, own, path, configurationPath } =
    await replaceSecretFixture(t, "Rebound sources editor", { agentUpdate: true });
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"),
    member.credentials,
  );
  assert.equal((await (await permissions).json()).data.agentSourcesOperate, false);
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).waitFor();
  // Repositories is drawn now and parked, so its rebuild is proved too, not only a first draw.
  await page.getByRole("tab", { name: "Repositories", exact: true }).click();
  await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-selection-title").count(), 0);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const saveSource = page.getByRole("button", { name: "Save authentication source" });
  await page.getByText(AGENT_SOURCES_DENIED, { exact: true }).waitFor();
  assert.equal(await saveSource.isDisabled(), true);

  await selectSecret(page, "Slack bot token", own);
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  const reread = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  assert.equal((await (await reread).json()).data.agentSourcesOperate, true);
  // The authentication source form is updated in place; the panel keeps its saved state.
  await expectNoText(page, AGENT_SOURCES_DENIED, () => waitForEnabled(saveSource));
  await waitForInputValue(page.getByLabel("Slack app token"), secretOptionLabel(app));
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Save plugin selections" }).waitFor();
  assert.equal(await page.getByText(PLUGINS_READ_ONLY, { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "Repositories", exact: true }).click();
  // The editor's selection, not the read-only summary with the sources note.
  await expectNoText(page, AGENT_SOURCES_DENIED, () =>
    page.locator("#repository-selection-title").waitFor(),
  );
});

// A tab drawn after the save but before the page's reread answers shows the old denial; the
// answer rebuilds it while it is shown (finding 2470).
test("a Plugins tab shown before the reread answers becomes editable when it lands", async (t) => {
  const { fixture, namespace, agent, member, own, path, configurationPath } =
    await replaceSecretFixture(t, "Held reread editor", { agentUpdate: true });
  const { page } = await newPage(t, fixture);
  const permissions = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"),
    member.credentials,
  );
  await permissions;
  await selectSecret(page, "Slack bot token", own);
  const reread = await holdRequests(t, page, `${fixture.origin}${path}/permissions`, {
    afterServer: true,
    once: true,
  });
  const saving = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await page.getByRole("button", { name: "Save channel Secrets" }).click();
  assert.equal((await saving).status(), 200);
  await reread.requested;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByText(PLUGINS_READ_ONLY, { exact: true }).waitFor();
  reread.release();
  await expectNoText(page, AGENT_SOURCES_DENIED, () =>
    page.getByRole("button", { name: "Save plugin selections" }).waitFor(),
  );
});

// Disable Slack saves no bindings, so it keeps the administrator's bot token Secret bound and the
// API would refuse it. The card offers it disabled, naming the binding to rebind first; after Edit
// Slack rebinds it, Disable saves (finding 2471).
test("Disable Slack waits until the replace persona rebinds the denied Secret", async (t) => {
  const { fixture, namespace, agent, member, own, configurationPath } = await replaceSecretFixture(
    t,
    "Replaced disable editor",
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels"),
    member.credentials,
  );
  const disable = page.getByRole("button", { name: "Disable Slack" });
  await page.getByText(DISABLE_KEEPS_BOT_TOKEN, { exact: true }).waitFor();
  assert.equal(await disable.isDisabled(), true);
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await selectSecret(dialog, "Slack bot token", own);
  const rebinding = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await rebinding).status(), 200);
  await expectNoText(page, DISABLE_KEEPS_BOT_TOKEN, () => waitForEnabled(disable));
  const disabling = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(configurationPath),
  );
  await disable.click();
  assert.equal((await disabling).status(), 200);
  const saved = await fixture.request("GET", configurationPath);
  assert.equal(saved.data.values.channels.slack.enabled, false);
});

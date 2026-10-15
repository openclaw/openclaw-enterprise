import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  login,
  nativeValues,
  newPage,
  settlePageRequests,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  trackSettledFetches,
  waitForInputValue,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  openAdvancedSettings,
  withholdPermissionSummary,
  assertRevisionUrl,
  agentStopRequests,
  configurationPatchRequests,
  nativeAdminValues,
  waitForLiveControls,
} from "./console-agents-test-support.mjs";

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
  let pendingProgress = { lastAttempt: null, nextAttemptAt: "2026-09-27T12:00:00.000Z" };
  for (const [revisionId, status] of [
    [current.revision.id, "succeeded"],
    [pending.id, "queued"],
  ]) {
    await page.route(
      `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${revisionId}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              deploymentId: revisionId,
              namespaceId: namespace.id,
              agentId: agent.id,
              status,
              error: null,
              warnings:
                status === "succeeded"
                  ? [{ code: "PLUGIN_AUTH_REQUIRED", pluginId: "linear@openai-curated-remote" }]
                  : [],
              progress: status === "queued" ? pendingProgress : null,
            },
            meta: { requestId: "req_test_deployment_activity" },
          }),
        });
      },
    );
  }
  await page.route(`${fixture.origin}${diagnosticsPath}`, async (route) => {
    assert.equal(route.request().method(), "POST");
    await route.fulfill({
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
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, current.revision.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Versions" }).waitFor();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const overview = page.locator(".agent-current-summary > div");
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await overview.nth(1).getByText("v2 · Queued").waitFor();
  await overview.nth(2).getByText("Not verified").waitFor();
  const activity = page.locator(".deployment-status");
  await activity.getByText("Most recent visible deployment · v2").waitFor();
  await activity.getByText("Recorded status: queued").waitFor();
  await activity.getByText("Waiting for a worker claim.").waitFor();
  await activity.getByText("No reconciliation result is available yet.").waitFor();
  // Simulate a subsequent status read. Persistence and attribution are proved
  // separately by the PostgreSQL queue/worker test, not by this browser fixture.
  pendingProgress = {
    lastAttempt: {
      at: "2026-09-27T12:01:00.000Z",
      code: "REVISION_INCOMPLETE",
      message: "Waiting for the runtime to become ready.",
    },
    nextAttemptAt: "2026-09-27T12:01:01.000Z",
  };
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await activity.getByText("Waiting to continue deployment.").waitFor();
  await activity.getByText("Waiting for the runtime to become ready.").waitFor();
  await activity.getByText("Since", { exact: true }).waitFor();
  assert.equal(await activity.getByText("Waiting for a worker claim.").count(), 0);
  await activity.getByText("Successful completion is not recorded yet.").waitFor();
  const versionRecord = page.locator(".version-deployment-record");
  await versionRecord.getByRole("heading", { name: "This version’s deployment record" }).waitFor();
  await versionRecord.getByText("Recorded outcome: succeeded").waitFor();
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
  await observations
    .getByText("No current observation has been requested for this version.")
    .waitFor();
  await observations.getByRole("button", { name: "Run diagnostics for this version" }).click();
  await observations.getByText(/Observed /).waitFor();
  await observations.getByText("slack / authentication").waitFor();
  assert.equal(pathRequests(requests, "POST", diagnosticsPath).length, 1);
  await versionRecord.getByText("Recorded outcome: succeeded").waitFor();
  await activity.getByText("Recorded status: queued").waitFor();
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
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/deployments/${newer.id}`,
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
  await activity.getByText("Recorded status: failed").waitFor();
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
      await page.getByRole("button", { name: tab, exact: true }).click();
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
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Unqualified model");
  const values = nativeValues("unqualified-model");
  const agent = await fixture.createAgent(namespace.id, "Unqualified model Agent", values, {
    harnessAuth: { method: "runtime" },
  });
  // The Configuration accepts a bare model name; only deployment requires provider/model form.
  const saved = await fixture.request(
    "PATCH",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    {
      body: {
        values: {
          ...values,
          agents: { ...values.agents, defaults: { ...values.agents.defaults, model: "gpt-5.1" } },
        },
      },
    },
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
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
  await page
    .getByText(
      "The configured Agent model must identify its provider and model as <provider>/<model>, such as openai/gpt-5.1 or codex/gpt-5.1.",
      { exact: true },
    )
    .waitFor();
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.deepEqual(revisions.data, []);
});

test("Plugin save shows the API's reason when it rejects the selections, else the plugin text", async (t) => {
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
  const agentUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`;
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
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(saved.data.plugins ?? {}, {});
});

test("Agent sharing shows a rejected write's reason, but generic text after an accepted write", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["sharing-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing rejection");
  const agent = await fixture.createAgent(namespace.id, "Sharing Agent", nativeValues("sharing"));
  const { page } = await newPage(t, fixture);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
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
  await panel.getByRole("button", { name: "Remove binding", exact: true }).click();
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
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration"),
  );
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "rev-two"|"marker": "draft-current"/);

  await page.getByRole("button", { name: "View version v2" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === second.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-two"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "draft-current"/);
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
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/);
  assertRevisionUrl(page, "draft");

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  assert.match(await editor.inputValue(), /"marker": "draft-current"/);
  for (const invalidJson of ["{ invalid", "[]"]) {
    await editor.fill(invalidJson);
    await page.getByRole("button", { name: "Save Configuration" }).click();
    await page.getByText("Enter a valid Configuration JSON object.").waitFor();
  }
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await editor.fill(JSON.stringify(nativeValues("stale-client"), null, 2));
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
  await page.getByText("The saved Configuration changed while you were editing.").waitFor();
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await page.reload();
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editedValues = nativeValues("draft-edited");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(editedValues, null, 2));
  await page.getByText("Save or cancel these Configuration edits before deploying.").waitFor();
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  // Tabs, admitted revision browsing, and global routes preserve this exact unsaved draft.
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
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
    [{ values: editedValues }],
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
  await expectNoText(page, /"marker": "draft-edited"|"marker": "stale-server"/);
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-edited"').waitFor();

  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Authentication source").selectOption("");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
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
  await page.getByRole("button", { name: "Edit Configuration" }).click();
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
  fixture.policy.bindings.push({
    id: `grant-plugin-${tokenSecret.id}`,
    namespaceId: namespace.id,
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: `auth-${agent.id}`,
    resourceKind: "secret",
    resourceId: tokenSecret.id,
  });
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
  const capabilitiesRead = Promise.withResolvers();
  t.after(() => capabilitiesRead.resolve());
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/plugins/capabilities`,
    async (route) => {
      await capabilitiesRead.promise;
      await route.continue();
    },
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
  assert.equal(pathRequests(requests, "POST", pluginListPath).length, 0);
  const prefetched = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${pluginListPath}` &&
      response.request().method() === "POST",
  );
  capabilitiesRead.resolve();
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
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          error:
            status === 501
              ? { code: "NOT_IMPLEMENTED", message: "No selected Plugin Driver" }
              : { code: "ACCESS_DENIED", message: "Agent update denied" },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000434" },
        }),
      });
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
  await page
    .getByText(
      "Access denied. Check Agent update, Configuration read, and access to this Agent's bound Secrets or Service Account.",
    )
    .waitFor();
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

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("pre").textContent()), editedPlugins);
  await page.getByLabel("Available versions").selectOption(first.revision.id);
  await page.waitForURL((current) => current.searchParams.get("revision") === first.revision.id);
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("pre").textContent()), originalPlugins);
  assert.equal(await page.getByRole("button", { name: "Save plugin selections" }).count(), 0);
});

test("Plugin picker clears tab memory when its catalog or credential scope is reset", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/agents");
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
      "Hosted plugin browsing requires a saved Service Accounts token Secret. Select it under Credentials, or edit existing plugin selections.",
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
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isEnabled(), true);

  // A credentialless Codex catalog does not make an OpenClaw harness compatible with its plugins.
  const capabilities = page.waitForResponse(
    (response) =>
      response.url() ===
      `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/plugins/capabilities`,
  );
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
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
  await page.getByText(/Secrets unavailable/).waitFor();
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

test("a Secret created before the picker's Secret list arrives stays staged and listed", async (t) => {
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
    await route.fulfill({ response });
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
  const created = (await fixture.request("GET", secretsPath)).data.find(
    (secret) => secret.name === "Created while loading",
  );
  assert.equal(await apiKeySecret.inputValue(), secretOptionLabel(created));
  await apiKeySecret.fill("Created while");
  await page.getByRole("option", { name: secretOptionLabel(created), exact: true }).waitFor();
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
  assert.equal(await dialog.getByLabel("Value", { exact: true }).getAttribute("type"), "password");
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
  assert.equal(await dialog.getByLabel("Name", { exact: true }).isDisabled(), false);
  assert.equal(
    await dialog.getByLabel("Value", { exact: true }).inputValue(),
    "synthetic-duplicate-value",
  );
  assert.equal(
    await dialog.getByRole("button", { name: "Create Secret", exact: true }).isDisabled(),
    false,
  );
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
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked IAM denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000633" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Harness Grant Failure Agent" }).waitFor();
  requests.length = 0;
  await selectSecret(page, "API key Secret", replacementSecret);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText(/Authentication source saved, but this Agent's Secret access could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Retry credential access" }).isDisabled(),
    false,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);

  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(current.data.harnessAuth, {
    method: "api_key",
    source: replacementSecret.ref,
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [replacementSecret.id],
  );
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
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  await page.getByRole("button", { name: "Save Configuration" }).click();

  await page.getByText("Outcome unknown. Configuration may have been saved.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save Configuration" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels" }).isDisabled(), true);
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
  let dialog = page.getByRole("dialog", { name: "Stop Stop Candidate?" });
  await dialog
    .getByText(/Configuration, versions, Credentials, and workspace data are retained/i)
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await page.getByRole("button", { name: "Stop Agent" }).click();
  dialog = page.getByRole("dialog", { name: "Stop Stop Candidate?" });
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
  await page
    .getByText(`Version ${active.revision.id.slice(0, 12)}…${active.revision.id.slice(-6)}`)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), true);
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
  await page.getByRole("button", { name: "Workspace files" }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();

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

  await page.getByRole("button", { name: "Configuration", exact: true }).click();
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
    .getByRole("dialog", { name: "Stop In Place Stop?" })
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
  const workspace = page.getByRole("button", { name: "Workspace files", exact: true });
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
  await page
    .getByRole("region", { name: "Agent state at a glance" })
    .getByText("None", { exact: true })
    .waitFor();
  assert.deepEqual(await keptInPlace(), { marker: "kept", reloadedText: [] });
  assert.equal(await focusedText(), "Refresh stop status");
  // The viewed version is no longer current, and tabs built from the old state are rebuilt.
  const unavailable = page.getByText(
    "Workspace files require a deployed Agent with a current version and a reachable gateway.",
    { exact: true },
  );
  assert.equal(await file.count(), 0, "the mounted Workspace must release the old live editor");
  await unavailable.waitFor();
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
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

// An Agent created through the API starts with desiredRuntimeState stopped and no version,
// so no stop was ever requested and nothing runs to stop (finding 1394). The panel says how
// to start it and offers no stop controls until a deploy creates a version.
test("Agent stop offers no controls for an Agent that was never deployed", async (t) => {
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
  await stopRegion
    .getByText("No version is selected. Deploy a new version to start this Agent.")
    .waitFor();
  assert.equal(await stopRegion.getByRole("button").count(), 0);

  // The first deploy creates a version and requests the Agent running, so Stop returns.
  const revision = await fixture.deployAgent(namespace.id, agent.id);
  await page.goto(detailUrl(fixture, namespace.id, agent.id, revision.id, "configuration").href);
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  await stopRegion.getByRole("button", { name: "Stop Agent", exact: true }).waitFor();
  assert.equal(await stopRegion.getByText("No version is selected.").count(), 0);
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
  const stopPath = `/namespaces/${namespace.id}/agents/${agent.id}/stop`;
  let interceptedStops = 0;
  await page.route(`**${stopPath}`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    interceptedStops += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked stop response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000503" },
      }),
    });
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
    .getByRole("dialog", { name: "Stop Uncertain Stop Candidate?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  await page.getByText("Outcome unknown. Stop may have been accepted.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), true);
  assert.equal(interceptedStops, 1);
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  const stopped = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(stopped.data.desiredRuntimeState, "stopped");

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
  assert.equal(await page.getByRole("button", { name: "Request Stop again" }).isEnabled(), true);
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
  const limited = await fixture.createAccountWithPolicy("agent-stop-denied", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-stop-denied",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-stop-denied",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-stop-denied",
    });
  });
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
    .getByRole("dialog", { name: "Stop Denied Stop Candidate?" })
    .getByRole("button", { name: "Stop Agent" })
    .click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to stop this Agent").waitFor();
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 1);
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), false);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.desiredRuntimeState, "running");
  assert.equal(current.data.activeRevisionId, active.revision.id);
});

test("a read-only principal sees Agent mutation controls disabled before any denial", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const fixture = await createConsoleAppFixture(t, { auditSink });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Read-only controls", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Read-only Agent", nativeValues("ro"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const viewer = await fixture.createAccountWithPolicy("agent-controls-viewer", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-controls-viewer",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-controls-viewer",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-controls-viewer",
    });
  });
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
  assert.equal(await openDraft.isEnabled(), true);
  await page.getByText("Your access does not include stopping this Agent.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop Agent" }).isDisabled(), true);
  await page.getByText("Your access does not include deleting this Agent.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).isDisabled(), true);

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

test("a version editor without Agent update can open the draft, save it, and deploy", async (t) => {
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
  const editor = await fixture.createAccountWithPolicy("version-editor", (principal) => {
    fixture.policy.roles.push({
      id: "role-version-editor",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "agent_revision" },
        { action: "read", resourceKind: "configuration" },
        { action: "update", resourceKind: "configuration" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-version-editor",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-version-editor",
    });
  });
  const path = "/namespaces/" + namespace.id + "/agents/" + agent.id;
  const { page } = await newPage(t, fixture);
  const summary = page.waitForResponse((r) => r.url().endsWith(path + "/permissions"));
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    editor.credentials,
  );
  const response = await summary;
  assert.equal(response.status(), 200);
  assert.deepEqual((await response.json()).data, {
    update: false,
    deploy: true,
    operate: false,
    delete: false,
  });

  // This button in the header opens the draft. It is not an Agent update.
  const openDraft = page
    .locator(".agent-toolbar-actions")
    .getByRole("button", { name: "Open version draft" });
  await openDraft.click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues("edited")));
  const saving = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().endsWith("/configurations/" + agent.configurationId),
  );
  await page.getByRole("button", { name: "Save Configuration" }).click();
  const saved = await saving;
  assert.equal(saved.status(), 200);
  assert.deepEqual((await saved.json()).data.values, nativeValues("edited"));

  const deploying = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(path + "/deploy"),
  );
  await page.getByRole("button", { name: "Deploy new version" }).click();
  const deployed = await deploying;
  assert.equal(deployed.status(), 202);
  assert.equal((await deployed.json()).data.agentId, agent.id);
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
  const viewer = await fixture.createAccountWithPolicy("confirmation-viewer", (principal) => {
    fixture.policy.roles.push({
      id: "role-confirmation-viewer",
      namespaceId: namespace.id,
      permissions: ["namespace", "agent", "agent_revision", "configuration"].map(
        (resourceKind) => ({ action: "read", resourceKind }),
      ),
    });
    fixture.policy.bindings.push({
      id: "binding-confirmation-viewer",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-confirmation-viewer",
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  const permissionPath =
    fixture.origin + "/namespaces/" + namespace.id + "/agents/" + agent.id + "/permissions";
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  for (const action of ["Stop", "Delete"]) {
    const received = Promise.withResolvers();
    const release = Promise.withResolvers();
    await page.route(permissionPath, async (route) => {
      const response = await route.fetch();
      received.resolve({ status: response.status(), data: (await response.json()).data });
      // Delay delivery, not authorization: these are the controller's actual flags for this viewer.
      await release.promise;
      await route.fulfill({ response });
    });
    if (action === "Stop") {
      await login(page, fixture, url, viewer.credentials);
    } else {
      await page.goto(url.href);
    }
    assert.deepEqual(await received.promise, {
      status: 200,
      data: { update: false, deploy: false, operate: false, delete: false },
    });

    await page.getByRole("button", { name: action + " Agent", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: action === "Stop" ? "Stop Agent" : "Permanently delete Agent",
    });
    await confirm.focus();
    release.resolve();
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
    await page.unroute(permissionPath);
  }
});

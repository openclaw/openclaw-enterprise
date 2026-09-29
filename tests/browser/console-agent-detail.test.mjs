import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { WORKSPACE_DEFAULTS } from "../../packages/contracts/src/workspace-defaults.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  expectNoText,
  login,
  setSlackSelection,
  slackSelectionValue,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
} from "./console-agents-browser-helpers.mjs";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.mjs";
import {
  openAdvancedSettings,
  expectNativeAdminHidden,
  assertRevisionUrl,
  agentDeleteRequests,
  agentStopRequests,
  configurationPatchRequests,
  nativeAdminComputeDriver,
  nativeAdminValues,
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
              warnings: [],
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
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Versions" }).waitFor();
  await page.getByRole("heading", { name: "Version v1" }).waitFor();
  const overview = page.locator(".agent-current-summary > div");
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await overview.nth(1).getByText("v2 · Queued").waitFor();
  await overview.nth(2).getByText("Not verified").waitFor();
  await page
    .getByText("v2 deployment is recorded as queued. v1 is selected. Live serving is unverified.")
    .waitFor();
  const activity = page.locator(".deployment-status");
  await activity.getByRole("heading", { name: "Deployment activity" }).waitFor();
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
  await activity.getByText("Last checked", { exact: true }).waitFor();
  assert.equal(await activity.getByText("Waiting for a worker claim.").count(), 0);
  await activity.getByText("Successful completion is not recorded yet.").waitFor();
  const versionRecord = page.locator(".version-deployment-record");
  await versionRecord.getByRole("heading", { name: "This version’s deployment record" }).waitFor();
  await versionRecord.getByText("Recorded outcome: succeeded").waitFor();
  const observations = page.locator(".version-diagnostics");
  await observations
    .getByText(/For Kubernetes Compute, Gateway checks currently cover Slack configuration/)
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
  await login(page, fixture, url.pathname + url.search);
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

test("Gateway password access saves the generated reference without changing admitted versions or Secret bindings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "occ-gateway-password-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createConsoleAppFixture(t, {
    configurationDriver: new FilesystemConfigurationDriver(root),
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
  await login(page, fixture, url.pathname + url.search);
  requests.length = 0;
  const enable = page.getByRole("button", { name: "Enable Gateway password access", exact: true });
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
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, first.revision.id, "configuration").search,
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
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
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

  await login(page, fixture, url.pathname + url.search);
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
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`Enable ${pluginId}`, { exact: true }).uncheck();
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
  assert.deepEqual(
    revisions.data.find(({ id }) => id === first.revision.id)?.plugins?.plugins,
    originalPlugins,
  );
  assert.deepEqual(
    revisions.data.find(({ id }) => id !== first.revision.id)?.plugins?.plugins,
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
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url.pathname + url.search);
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
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url.pathname + url.search);
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
    nativeValues("harness-picker"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
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
  await page.getByLabel("API key Secret").waitFor({ state: "visible" });
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    secretOptionLabel(replacementSecret),
  );

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
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    secretOptionLabel(replacementSecret),
  );

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
    nativeValues("secret-action-names"),
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
  await login(page, fixture, url.pathname + url.search);
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
    nativeValues("credential-picker-ux"),
    { harnessAuth: { method: "api_key", source: originalSecret.ref }, executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");

  await login(page, fixture, url.pathname + url.search);
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
  let conflictCode = "NAMESPACE_NOT_READY";
  const failSecretCreate = (route, request) => {
    if (request.method() !== "POST") {
      return route.fallback();
    }
    return route.fulfill({
      status: 409,
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
  await dialog.getByRole("alert").filter({ hasText: "not ready for Secret creation" }).waitFor();
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

  await login(page, fixture, url.pathname + url.search);
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
    { harnessAuth: { method: "runtime" } },
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

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Uncertain Configuration Agent" }).waitFor();
  requests.length = 0;

  const nextValues = nativeValues("after-unknown");
  await page.getByText("Configured on the runtime host").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), false);
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
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace").search,
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
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").search,
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

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration").search,
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

test("Agent delete confirmation can be canceled without sending a write request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete cancellation", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Cancel Candidate", nativeValues("keep"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Cancel Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  assert.equal(await cancel.evaluate((node) => node.ownerDocument.activeElement === node), true);
  const unexpectedDelete = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
    { timeout: 300 },
  );
  await cancel.click();
  await assert.rejects(unexpectedDelete, /Timeout/);

  await page.getByRole("heading", { name: "Cancel Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent delete confirmation sends the real delete API and leaves visible queued state", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete success", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Success Candidate", nativeValues("go"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Success Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Success Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const deleteResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  const response = await deleteResponse;
  assert.equal(response.status(), 202);
  assert.equal((await response.json()).data.status, "deleting");

  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  await page.getByRole("status").getByText("Deletion in progress").waitFor();
  await page.getByRole("button", { name: "Refresh deletion status" }).waitFor();
  assert.deepEqual(
    agentDeleteRequests(requests, namespace.id, agent.id).map((request) => [
      request.method,
      request.path,
      request.body,
    ]),
    [["DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`, null]],
  );
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "deleting");

  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "Success Candidate" })
    .getByText("Deleting", { exact: true })
    .waitFor();
});

test("Agent delete uncertainty requires refresh before another destructive request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete uncertainty", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Uncertain Candidate",
    nativeValues("uncertain"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const deletePath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  let interceptedDeletes = 0;
  await page.route(`**${deletePath}`, async (route, request) => {
    if (request.method() !== "DELETE") {
      await route.continue();
      return;
    }
    interceptedDeletes += 1;
    await route.fetch();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "masked deletion response" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
  );
  await page.getByRole("heading", { name: "Uncertain Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Uncertain Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();

  await page.getByText("Outcome unknown. Deletion may have started.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Delete Agent" }).isDisabled(), true);
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const deleting = await fixture.request("GET", deletePath);
  assert.equal(deleting.data.status, "deleting");

  const refresh = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${deletePath}` && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh deletion status" }).click();
  assert.equal((await refresh).status(), 200);
  await page.getByRole("status").getByText("Deletion in progress").waitFor();
  assert.equal(interceptedDeletes, 1);
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
});

test("Agent deletion recovery returns a missing Agent detail to its Namespace list", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deleted detail", { ready: true });
  const agentId = `agt_${randomUUID()}`;
  const { page } = await newPage(t, fixture);
  const unavailable = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agentId}` &&
      response.request().method() === "GET",
  );

  await login(page, fixture, `/console/agents/${agentId}?namespace=${namespace.id}`);
  assert.equal((await unavailable).status(), 404);
  await page.getByRole("heading", { name: "Resource unavailable" }).waitFor();
  await page.getByRole("button", { name: "Back to Agents" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/console/agents" && url.searchParams.get("namespace") === namespace.id,
  );
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
});

test("Agent delete denial keeps the Agent visible with permission feedback", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Delete denial", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Denied Candidate", nativeValues("stay"));
  const limited = await fixture.createAccountWithPolicy("agent-delete-denied", (principal) => {
    fixture.policy.roles.push({
      id: "role-console-agent-delete-denied",
      namespaceId: namespace.id,
      permissions: [
        { action: "read", resourceKind: "namespace" },
        { action: "read", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "read", resourceKind: "agent_revision" },
      ],
    });
    fixture.policy.bindings.push({
      id: "binding-console-agent-delete-denied",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-console-agent-delete-denied",
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").search,
    limited.credentials,
  );
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  requests.length = 0;

  await page.getByRole("button", { name: "Delete Agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Denied Candidate?" });
  await dialog.getByText(/Agent, its revision history, and its workspace data/i).waitFor();
  const denied = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "DELETE",
  );
  await dialog.getByRole("button", { name: "Permanently delete Agent" }).click();
  assert.equal((await denied).status(), 403);

  await page.getByText("You do not have permission to delete this Agent").waitFor();
  await page.getByRole("heading", { name: "Denied Candidate" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/${agent.id}`));
  assert.equal(agentDeleteRequests(requests, namespace.id, agent.id).length, 1);
  const current = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(current.data.status, "active");
});

test("Agent detail opens native admin UI only after real API access checks pass", async (t) => {
  const disabledFixture = await createConsoleAppFixture(t);
  await disabledFixture.bootstrap();
  const disabledNamespace = await disabledFixture.createNamespace("Native admin disabled", {
    ready: true,
  });
  const disabledAgent = await disabledFixture.createAgent(
    disabledNamespace.id,
    "Disabled native admin Agent",
    nativeValues("disabled-ui"),
  );
  const disabledRevision = await disabledFixture.seedActiveAgentRevision(
    disabledNamespace.id,
    disabledAgent.id,
  );
  const disabledPage = (await newPage(t, disabledFixture)).page;
  const disabledDetail = detailUrl(
    disabledFixture,
    disabledNamespace.id,
    disabledAgent.id,
    disabledRevision.revision.id,
    "configuration",
  );

  await login(disabledPage, disabledFixture, `${disabledDetail.pathname}${disabledDetail.search}`);
  await disabledPage.getByRole("heading", { name: "Disabled native admin Agent" }).waitFor();
  await expectNativeAdminHidden(disabledPage);

  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const nativeDomain = `agents.${cookieDomain}`;
  const gatewayEndpoint =
    "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent";
  const fixture = await createConsoleAppFixture(t, {
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver(gatewayEndpoint),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin access", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    nativeValues("unsupported-ui"),
  );
  const { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1,MAP *.${nativeDomain} 127.0.0.1`,
    ],
  });
  const requests = apiRequests(page, fixture.origin);
  const draftDetail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");

  // A fresh shared-cookie login clears legacy host-only cookies from the Console.
  await page.context().addCookies([
    {
      name: "__Secure-openclaw_occ.session_token",
      value: "old-host-only",
      domain: consoleHost,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await login(page, fixture, `${draftDetail.pathname}${draftDetail.search}`);
  assert.equal(
    (await page.context().cookies(fixture.origin)).some(
      (cookie) => cookie.value === "old-host-only",
    ),
    false,
  );

  // New Agents are stopped; missing an active revision must not suggest a routing problem.
  const initiallyStopped = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initiallyStopped.status, 200);
  assert.deepEqual(initiallyStopped.data, { status: "stopped" });
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  // A real deployment requests running before reconciliation selects the admitted revision.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const unavailable = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(unavailable.status, 200);
  assert.deepEqual(unavailable.data, { status: "unavailable" });
  await page.getByRole("button", { name: "Refresh access" }).click();
  await page
    .getByText(
      "Native admin UI access is unavailable because OCE could not load an active AgentRevision. Check this Agent’s deployment, then refresh access.",
    )
    .waitFor({ timeout: 5_000 });
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  let active = { revision: pending };
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  const historicalRevisionId = active.revision.id;
  const initialNativeAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initialNativeAccess.status, 200);
  assert.equal(initialNativeAccess.data.status, "unsupported");
  assert.equal(new URL(initialNativeAccess.data.origin).protocol, "https:");
  const detail = () =>
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Native admin UI" }).waitFor();
  await page
    .getByText("This Agent does not expose a supported native admin UI endpoint.")
    .waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  fixture.policy.restrictions.push({
    id: "deny-native-administer",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "administer",
    effect: "deny",
  });
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await expectNativeAdminHidden(page);
  fixture.policy.restrictions.length = 0;

  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  // Reproduce the state after the worker clears the revision, while this historical URL remains open.
  const cleared = await fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("heading", { name: "Native admin UI" }).waitFor();
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);

  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("supported-ui", initialNativeAccess.data.origin),
  );
  active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByText("Native admin UI is available for this Agent’s active revision.").waitFor();
  const expectedAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(expectedAccess.status, 200);
  assert.equal(expectedAccess.data.status, "available");
  assert.equal(expectedAccess.data.activeRevisionId, active.revision.id);
  assert.equal(expectedAccess.data.bootstrapUrl, undefined);
  assert.equal(new URL(expectedAccess.data.url).origin, expectedAccess.data.origin);
  assert.match(new URL(expectedAccess.data.url).hostname, new RegExp(`\\.${nativeDomain}$`));

  // Viewing an older configuration snapshot must still open the current active gateway.
  await page.getByLabel("Available versions").selectOption(historicalRevisionId);
  await page.getByText("Native admin UI is available for this Agent’s active revision.").waitFor();
  assertRevisionUrl(page, historicalRevisionId);
  assert.equal(
    await page.getByRole("link", { name: "Open native admin UI" }).getAttribute("href"),
    expectedAccess.data.url,
  );
  const sharedCookies = await page.context().cookies(expectedAccess.data.origin);
  const sessionCookies = sharedCookies.filter((cookie) =>
    cookie.name.endsWith("openclaw_occ_shared.session_token"),
  );
  assert.equal(sessionCookies.length, 1);
  assert.equal(sessionCookies[0].domain, `.${cookieDomain}`);
  assert.equal(sessionCookies[0].httpOnly, true);
  assert.equal(sessionCookies[0].sameSite, "Lax");

  let nativeRequestCookie = "";
  await page.context().route(`${expectedAccess.data.origin}/**`, async (route) => {
    nativeRequestCookie = (await route.request().allHeaders()).cookie ?? "";
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Native admin UI</title>",
    });
  });

  await page.context().addCookies([
    {
      name: "openclaw_occ.session_token",
      value: "legacy-host-only",
      domain: consoleHost,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const consoleCookies = await page.context().cookies(fixture.origin);
  assert.ok(
    consoleCookies.some(
      (cookie) =>
        cookie.name === "openclaw_occ.session_token" && cookie.value === "legacy-host-only",
    ),
    "the migration fixture must contain the legacy host-only console cookie",
  );
  const agentCookies = await page.context().cookies(expectedAccess.data.origin);
  assert.equal(
    agentCookies.some((cookie) => cookie.value === "legacy-host-only"),
    false,
    "a legacy host-only console cookie must not authenticate the Agent host",
  );

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open native admin UI" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), expectedAccess.data.url);
  assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
  assert.match(nativeRequestCookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  assert.doesNotMatch(nativeRequestCookie, /legacy-host-only/);

  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

for (const [dmPolicy, groupPolicy, enterpriseOrgInstall] of [
  ["pairing", "allowlist"],
  ["open", "open"],
  ["disabled", "disabled"],
  [undefined, undefined],
  ["disabled", "allowlist", true],
]) {
  test(`Slack channel editing preserves ${dmPolicy ?? "omitted"} DM and ${groupPolicy ?? "omitted"} group policies${enterpriseOrgInstall ? " on an organization-wide install" : ""}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slack policy editing", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      ...(enterpriseOrgInstall ? { enterpriseOrgInstall } : {}),
      ...(dmPolicy === undefined ? {} : { dmPolicy }),
      ...(groupPolicy === undefined ? {} : { groupPolicy }),
      allowFrom: dmPolicy === "open" ? ["*"] : ["UKEEP123"],
      channels: { CKEEP123: { requireMention: true, users: ["UKEEP123"] } },
    };
    const agent = await fixture.createAgent(
      namespace.id,
      "Slack policy Agent",
      nativeValues("policy-preservation", {
        harnessId: "codex",
        channels: { slack },
      }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
    await login(page, fixture, url.pathname + url.search);
    const edit = page.getByRole("button", { name: "Edit Slack", exact: true });
    await edit.waitFor();
    assert.equal(await edit.isEnabled(), true);
    await edit.click();
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    if (enterpriseOrgInstall) {
      // Per-user DM authorization cannot be shared across organization workspaces.
      for (const unsupported of ["pairing", "allowlist"]) {
        await dialog.getByLabel("Direct-message policy").selectOption(unsupported);
        await dialog.getByRole("button", { name: "Save configuration", exact: true }).click();
        await dialog
          .getByText(
            "Choose Disabled or Open for direct messages on an organization-wide Slack install.",
          )
          .waitFor();
      }
      const unchanged = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
      );
      assert.deepEqual(unchanged.data.values.channels.slack, slack);
      await dialog.getByLabel("Direct-message policy").selectOption("disabled");
    }
    const allowedUsers = dialog.getByRole("combobox", {
      name: "Allowed people in these channels",
      exact: true,
    });
    const allowEveryone = dialog.getByLabel("Who can use the agent in these channels?");
    assert.equal(await slackSelectionValue(allowedUsers), "UKEEP123");
    assert.equal(await allowEveryone.inputValue(), "selected");
    await setSlackSelection(
      dialog.getByRole("combobox", { name: "Channels", exact: true }),
      "CKEEP123, CNEW123",
    );
    await dialog.getByLabel("Require a mention", { exact: true }).uncheck();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${agent.configurationId}`),
    );
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await saved).status(), 200);
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Editing channels must neither widen nor narrow DM/group access, including implicit defaults.
    assert.deepEqual(configuration.data.values.channels.slack, {
      ...slack,
      channels: {
        CKEEP123: { requireMention: false, users: ["UKEEP123"] },
        CNEW123: { requireMention: false, users: ["UKEEP123"] },
      },
    });
    assert.equal(
      configuration.data.values.plugins.entries.knowledge.config.marker,
      "policy-preservation",
    );
  });
}

test("Agent detail refocus checks access once without reloading an unfinished revision edit", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision refocus", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Revision refocus Agent",
    nativeValues("before-refocus"),
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).click();
  const editor = page.getByLabel("Configuration JSON", { exact: true });
  const editedValues = nativeValues("after-refocus");
  const editedText = JSON.stringify(editedValues, null, 2);
  await editor.fill(editedText);
  await editor.evaluate((node) => node.setSelectionRange(3, 3));
  const editorNode = await editor.elementHandle();
  const selectorNode = await page.locator(".revision-selector").elementHandle();
  const newNamespace = await fixture.createNamespace("New on refocus", { ready: true });
  assert.equal(
    await page.locator(`#namespace-selector option[value="${newNamespace.id}"]`).count(),
    0,
  );
  const requests = apiRequests(page, fixture.origin);
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  let releaseSession;
  const sessionGate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  t.after(() => releaseSession());
  let sessionReached;
  const sessionHeld = new Promise((resolve) => {
    sessionReached = resolve;
  });
  await page.route(`${fixture.origin}/api/auth/session`, async (route) => {
    const response = await route.fetch();
    sessionReached();
    await sessionGate;
    await route.fulfill({ response });
  });

  // One tab return can emit both events. The saved revision and unsaved editor stay mounted
  // while a single access check waits for the real session response.
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  await sessionHeld;
  assert.equal(pathRequests(requests, "GET", "/api/auth/session").length, 1);
  assert.equal(await selectorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editor.inputValue(), editedText);
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 1);
  assert.equal(await page.getByText("Loading configuration…", { exact: true }).count(), 0);

  const checkedConfiguration = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${configurationPath}` &&
      response.request().method() === "GET",
  );
  releaseSession();
  await checkedConfiguration;
  assert.equal(pathRequests(requests, "GET", "/namespaces").length, 1);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}`).length,
    1,
  );
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}/revisions`)
      .length,
    1,
  );
  assert.equal(pathRequests(requests, "GET", configurationPath).length, 1);
  assert.equal(
    await page.locator(`#namespace-selector option[value="${newNamespace.id}"]`).count(),
    1,
  );
  assert.equal(await selectorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  assert.equal(await editor.inputValue(), editedText);
  assert.deepEqual(
    await editor.evaluate((node) => [
      node === node.ownerDocument.activeElement,
      node.selectionStart,
    ]),
    [true, 3],
  );
  assert.equal(await page.getByText("Loading configuration…", { exact: true }).count(), 0);
  await page.unroute(`${fixture.origin}/api/auth/session`);

  // Refocus must not cancel a Configuration save that already reached the browser API.
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  t.after(() => releaseSave());
  let saveReached;
  const saveHeld = new Promise((resolve) => {
    saveReached = resolve;
  });
  await page.route(`${fixture.origin}${configurationPath}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    saveReached();
    await saveGate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await saveHeld;
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event("focus"));
    globalThis.document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await editorNode.evaluate((node) => node.isConnected), true);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${configurationPath}` &&
      response.request().method() === "PATCH",
  );
  releaseSave();
  assert.equal((await saved).status(), 200);
  await page.getByRole("button", { name: "Edit Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "after-refocus"').waitFor();
  assert.equal(pathRequests(requests, "PATCH", configurationPath).length, 1);
});

for (const kind of ["agent", "configuration", "namespace"]) {
  test(`Agent detail refocus removes a revision when ${kind} access is revoked`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Revision access revoked", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Revoked revision Agent");
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
    fixture.policy.restrictions.push({
      id: `deny-focused-${kind}-read`,
      namespaceId: namespace.id,
      resourceKind: kind,
      ...(kind === "namespace"
        ? {}
        : { resourceId: kind === "agent" ? agent.id : agent.configurationId }),
      action: "read",
      effect: "deny",
    });

    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await page
      .getByRole("heading", {
        name: kind === "namespace" ? "Namespace unavailable" : "Access denied",
        exact: true,
      })
      .waitFor();
    await expectNoText(page, /Configuration draft|Create new version|Revoked revision Agent/);
  });
}

test("Agent detail refocus clears a revision after session expiry", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision session expired", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Expired revision Agent");
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }

  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Login", exact: true }).waitFor();
  await expectNoText(page, /Configuration draft|Create new version|Expired revision Agent/);
});

// Agent detail rechecks in place, so a mounted form must not suppress the refocus check.
for (const variant of ["credentials", "workspace", "sharing"]) {
  test(`Agent detail refocus clears the ${variant} view after session expiry`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Refocus ${variant}`, { ready: true });
    const agent = await fixture.createAgent(
      namespace.id,
      `Refocus ${variant} Agent`,
      nativeValues(variant),
    );
    let revision = "draft";
    if (variant === "workspace") {
      revision = (await fixture.seedActiveAgentRevision(namespace.id, agent.id)).revision.id;
    }
    const tab = variant === "sharing" ? "configuration" : variant;
    const { page } = await newPage(t, fixture);
    const url = detailUrl(fixture, namespace.id, agent.id, revision, tab);
    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: `Refocus ${variant} Agent` }).waitFor();
    if (variant === "sharing") {
      const panel = page.getByRole("region", { name: "Share Agent", exact: true });
      await panel.getByLabel("Existing person’s Principal ID").fill("typed-principal");
    } else {
      await page.locator(".content form:not(.agent-access-form)").first().waitFor();
    }
    for (const session of fixture.memoryDatabase.session) {
      session.expiresAt = new Date(Date.now() - 1000);
    }

    await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    await page.getByText("Your session has expired").waitFor();
    await expectNoText(page, new RegExp(`Refocus ${variant} Agent`));
  });
}

test("Agent detail history navigation rechecks session during refocus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision history refocus", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "History refocus Agent");
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();

  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  t.after(() => releaseSession());
  let sessionReached;
  const held = new Promise((resolve) => {
    sessionReached = resolve;
  });
  let checks = 0;
  await page.route(`${fixture.origin}/api/auth/session`, async (route) => {
    if (++checks === 1) {
      sessionReached();
      await gate;
    }
    try {
      await route.continue();
    } catch {
      // The route is closed when navigation aborts the first access check.
    }
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await held;
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  await page.goBack();
  await page.getByText("Your session has expired").waitFor();
  await expectNoText(page, /Configuration draft|Create new version|History refocus Agent/);
  releaseSession();
});

test("Agent tabs replace only their content and preserve surrounding panels and history", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Tab navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Tab navigation Agent",
    nativeValues("tabs"),
  );
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 1200, height: 650 });
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Configuration draft", exact: true }).waitFor();
  await page.getByRole("button", { name: "Channels", exact: true }).scrollIntoViewIfNeeded();
  const panels = await page
    .locator("h1, .agent-toolbar, .native-admin-access, .revision-selector, .agent-tabs")
    .elementHandles();
  const top = await page.evaluate(() => globalThis.scrollY);
  requests.length = 0;

  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "channels");
  // The surrounding DOM must stay mounted; a fast full-page rerender still loses focus and scroll.
  for (const panel of panels) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.ok(Math.abs((await page.evaluate(() => globalThis.scrollY)) - top) < 2);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const secret = page.getByLabel("API key Secret");
  await secret.waitFor();
  const secretElement = await secret.elementHandle();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page
    .getByText(
      "Workspace files require a deployed Agent with an active revision and a reachable gateway.",
    )
    .waitFor();
  assert.equal(await secretElement.evaluate((node) => node.isConnected), false);
  await page.goBack();
  await page.getByLabel("API key Secret").waitFor();
  assert.equal(
    await secretElement.evaluate((node) => node.isConnected),
    true,
    "Returning to Credentials preserves the loaded controls",
  );
  assert.equal(new URL(page.url()).searchParams.get("tab"), "credentials");
  await page.goForward();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  for (const panel of panels) {
    assert.equal(await panel.evaluate((node) => node.isConnected), true);
  }
  assert.deepEqual(
    requests.filter((request) =>
      [
        "/api/auth/session",
        "/namespaces",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
      ].includes(request.path),
    ),
    [],
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // Refresh is still explicit and rereads the page, unlike a tab change.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  assert.equal(await panels[0].evaluate((node) => node.isConnected), false);
});

test("Agent tab switches ignore late configuration reads and keep direct workspace access independent", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slow tabs", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Slow tab Agent",
    nativeValues("slow-tabs"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "workspace");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Agent workspace", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Versions", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Deployment activity", exact: true }).waitFor();
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal(
    requests.some((request) => request.path === configurationPath),
    false,
  );
  assert.equal(
    requests.some((request) => request.path.endsWith("/revisions")),
    true,
  );
  const tabs = await page.locator(".agent-tabs").elementHandle();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let reached;
  const held = new Promise((resolve) => {
    reached = resolve;
  });
  // Delay a real authorized response to exercise navigation while the first panel read is pending.
  await page.route(`${fixture.origin}${configurationPath}`, async (route) => {
    const response = await route.fetch();
    reached();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await held;
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  const delivered = page.waitForResponse(`${fixture.origin}${configurationPath}`);
  release();
  await delivered;
  // Configuration completion may prepare shared controls, but must not replace the live workspace view.
  await page.getByRole("heading", { name: "Agent workspace", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Workspace files", exact: true }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Configure Slack", exact: true }).count(), 0);
  assert.equal(await tabs.evaluate((node) => node.isConnected), true);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).waitFor();
  assert.equal(requests.filter((request) => request.path === configurationPath).length, 1);
});

test("Agent sharing grants existing people exact discovery and native access, then removes only the selected binding", async (t) => {
  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["shared-person"],
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: {
      enabled: true,
      domain: `agents.${cookieDomain}`,
      sharedCookieDomain: cookieDomain,
    },
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Shared workspace", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Shared research Agent",
    nativeValues("shared"),
  );
  const sibling = await fixture.createAgent(
    namespace.id,
    "Private sibling",
    nativeValues("private"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const native = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("shared", native.data.origin),
  );
  const active = await fixture.seedActiveAgentRevision(
    namespace.id,
    agent.id,
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data
      .activeRevisionId,
  );
  const person = fixture.provisionedAccounts[0];
  const session = await fixture.signIn(person.credentials);
  assert.deepEqual((await fixture.request("GET", "/namespaces", { session })).data, []);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  // A familiar display name must never substitute for the required exact permission set.
  const misleadingRole = await fixture.request("POST", `${policyPath}/roles`, {
    body: {
      name: "Agent native administration",
      permissions: [{ action: "delete", resourceKind: "agent" }],
    },
  });
  assert.equal(misleadingRole.status, 201);
  const browserOptions = {
    args: [...fixture.browserArgs, `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1`],
  };
  const { page, artifacts } = await newPage(t, fixture, browserOptions);
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, `${detail.pathname}${detail.search}`);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-granted.png") });
  const bindings = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.equal(bindings.length, 2);
  assert.equal(
    bindings.some((binding) => binding.roleId === misleadingRole.data.id),
    false,
  );
  assert.deepEqual(bindings.map((binding) => [binding.resourceKind, binding.resourceId]).sort(), [
    ["agent", agent.id],
    ["namespace", namespace.id],
  ]);
  assert.deepEqual(
    (await fixture.request("GET", "/namespaces", { session })).data.map((item) => item.id),
    [namespace.id],
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data.map(
      (item) => item.id,
    ),
    [agent.id],
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${sibling.id}`, { session }))
      .status,
    403,
  );
  assert.equal(
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        { session },
      )
    ).status,
    403,
  );
  assert.equal((await fixture.request("GET", `${policyPath}/roles`, { session })).status, 403);
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
        session,
      })
    ).data.status,
    "available",
  );

  const recipient = (await newPage(t, fixture, browserOptions)).page;
  await login(recipient, fixture, `${detail.pathname}${detail.search}`, person.credentials);
  await recipient
    .getByText("Sharing policy requires Installation administration.", { exact: false })
    .waitFor();
  await recipient.getByRole("heading", { name: "Configuration unavailable" }).waitFor();
  await recipient.getByRole("link", { name: "Open native admin UI" }).waitFor();
  await recipient.screenshot({
    path: join(artifacts, "agent-sharing-recipient.png"),
    fullPage: true,
  });
  // Stop has its own permission. Grant it separately through the real policy API.
  assert.equal(
    (
      await fixture.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`, {
        session,
      })
    ).status,
    403,
  );
  const operateRole = await fixture.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "operate", resourceKind: "agent" }] },
  });
  const operateBinding = await fixture.request("POST", `${policyPath}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: person.principal.id,
      roleId: operateRole.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  assert.equal(operateBinding.status, 201);
  await recipient.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await recipient
    .getByRole("dialog")
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  await recipient.getByText("Stop requested. OCC will not start", { exact: false }).waitFor();

  // The stale administrator list holds the specific sharing binding, not the new operate grant.
  await panel.getByRole("button", { name: "Remove binding", exact: true }).click();
  await panel.getByText("Binding removed.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-removed.png") });
  const after = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.deepEqual(
    after.map((binding) => binding.id).sort(),
    [
      bindings.find((binding) => binding.resourceKind === "namespace").id,
      operateBinding.data.id,
    ].sort(),
  );
  assert.deepEqual(
    (await fixture.request("GET", "/namespaces", { session })).data.map((item) => item.id),
    [namespace.id],
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data,
    [],
  );
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
        session,
      })
    ).status,
    403,
  );
});

test("Agent sharing reconciles a truncated committed response without replaying writes", async (t) => {
  let loseAgentBindingResponse = true;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["response-recipient"],
    async onSend(request, reply, payload) {
      if (
        loseAgentBindingResponse &&
        request.method === "POST" &&
        request.url.endsWith("/iam/access-bindings") &&
        reply.statusCode === 201 &&
        JSON.parse(payload).data.resourceKind === "agent"
      ) {
        // Truncate only the response after the real route committed its grant.
        loseAgentBindingResponse = false;
        return payload.slice(0, 8);
      }
      return payload;
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Sharing recovery");
  const agent = await fixture.createAgent(namespace.id, "Recovery Agent", nativeValues("recovery"));
  const person = fixture.provisionedAccounts[0];
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, `${detail.pathname}${detail.search}`);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Outcome unknown.", { exact: false }).waitFor();
  await panel.getByText("Namespace discovery is enabled.", { exact: true }).waitFor();
  await panel.getByText("Direct grants need a fresh read.", { exact: false }).waitFor();
  assert.equal(await panel.getByText("No direct Agent grants.", { exact: true }).count(), 0);
  assert.equal(
    await panel.getByRole("button", { name: "Share Agent", exact: true }).isDisabled(),
    true,
  );
  await panel.screenshot({ path: join(artifacts, "agent-sharing-unknown.png") });
  const writes = () =>
    nonAuthWriteRequests(requests).filter((request) => request.path.includes("/iam/"));
  assert.equal(writes().length, 4);
  const session = await fixture.signIn(person.credentials);
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data.map(
      (item) => item.id,
    ),
    [agent.id],
  );
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel.getByText("Current policy loaded.", { exact: false }).waitFor();
  assert.equal(writes().length, 4);
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  assert.equal(writes().length, 4);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  assert.equal((await fixture.request("GET", `${policyPath}/roles`)).data.length, 2);
  assert.equal((await fixture.request("GET", `${policyPath}/access-bindings`)).data.length, 2);
  // A sharing read must preserve global expiry handling, including private panel removal.
  for (const savedSession of fixture.memoryDatabase.session) {
    savedSession.expiresAt = new Date(Date.now() - 1000);
  }
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Login", exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
});

test("Agent sharing creates exact Roles instead of reusing strict superset Roles", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["superset-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Superset sharing");
  const agent = await fixture.createAgent(namespace.id, "Superset Agent", nativeValues("superset"));
  const person = fixture.provisionedAccounts[0];
  const policyPath = `/namespaces/${namespace.id}/iam`;
  // Each superset contains every permission sharing needs, plus one it must not grant.
  const supersets = [];
  for (const permissions of [
    [
      { action: "read", resourceKind: "agent" },
      { action: "administer", resourceKind: "agent" },
      { action: "delete", resourceKind: "agent" },
    ],
    [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "secret" },
    ],
  ]) {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    supersets.push(role.data.id);
  }
  const { page } = await newPage(t, fixture);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, `${detail.pathname}${detail.search}`);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();

  const roles = (await fixture.request("GET", `${policyPath}/roles`)).data;
  assert.equal(roles.length, 4, "sharing must add two exact Roles beside the supersets");
  const bindings = (await fixture.request("GET", `${policyPath}/access-bindings`)).data;
  assert.equal(bindings.length, 2);
  const grantPermissions = (resourceKind) => {
    const binding = bindings.find((candidate) => candidate.resourceKind === resourceKind);
    assert.equal(supersets.includes(binding.roleId), false, `${resourceKind} reused a superset`);
    return roles
      .find((role) => role.id === binding.roleId)
      .permissions.map((permission) => `${permission.action}:${permission.resourceKind}`)
      .sort();
  };
  assert.deepEqual(grantPermissions("namespace"), ["read:namespace"]);
  assert.deepEqual(grantPermissions("agent"), ["administer:agent", "read:agent"]);
  const session = await fixture.signIn(person.credentials);
  assert.equal(
    (
      await fixture.request("DELETE", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        session,
      })
    ).status,
    403,
  );
});

for (const method of ["api_key", "codex_pat"]) {
  test(`Credentials grants exact Agent access when rebinding ${method}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Model credential replacement", {
      ready: true,
    });
    const agent = await fixture.createAgent(
      namespace.id,
      "Credential Agent",
      createHarnessConfiguration("codex", "gpt-4.1"),
      { executionMode: "dedicated" },
    );
    const replacement = await fixture.createSecret(
      namespace.id,
      "Replacement model credential",
      "test-replacement-token",
    );
    const unrelated = await fixture.createSecret(
      namespace.id,
      "Unrelated credential",
      "test-unrelated-token",
    );
    const { page } = await newPage(t, fixture);
    await login(
      page,
      fixture,
      `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
    );
    await page.getByLabel("Authentication source").selectOption(method);
    await selectSecret(
      page,
      method === "api_key" ? "API key Secret" : "Service account token Secret",
      replacement,
    );
    await page.getByRole("button", { name: "Save authentication source" }).click();
    // Wait for the real IAM write and the refreshed form, not just the earlier Agent PATCH.
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    const bindings = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/iam/access-bindings`,
    );
    const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
    const grants = bindings.data.filter(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    );
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0], {
      id: grants[0].id,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: grants[0].roleId,
      resourceKind: "secret",
      resourceId: replacement.id,
    });
    assert.deepEqual(roles.data.find((role) => role.id === grants[0].roleId).permissions, [
      { action: "operate", resourceKind: "secret" },
    ]);
    assert.equal(
      bindings.data.some((binding) => binding.resourceId === unrelated.id),
      false,
    );
    const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.deepEqual(saved.data.harnessAuth, { method, source: replacement.ref });
    // Saving the same source again repairs missing access and reuses an existing exact binding.
    await page.getByRole("button", { name: "Save authentication source" }).click();
    await page.waitForFunction(
      () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
    );
    assert.deepEqual(
      (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data,
      bindings.data,
    );
  });
}

test("Credentials retries denied and interrupted grants without repeating the authentication save", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential access recovery", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Recovery Agent",
    createHarnessConfiguration("codex", "gpt-4.1"),
    { executionMode: "dedicated" },
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-retry-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const bindingsPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  // Native IAM denies the actor's grant authority while the Agent update remains authorized.
  fixture.policy.restrictions.push({
    id: "deny-update-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  await page.getByLabel("Authentication source").selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", replacement);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText(/Authentication source saved, but this Agent's Secret access could not be confirmed/)
    .waitFor();
  assert.equal(await page.getByLabel("Authentication source").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 0);
  assert.equal(
    (await fixture.request("GET", agentPath)).data.harnessAuth.source.id,
    replacement.id,
  );
  // A partial save survives navigation without repeating PATCH or enabling deployment.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Retry credential access" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-update-credential-grant"),
    1,
  );
  // Commit the binding through the real API, then lose only its response. Read-before-create makes retry safe.
  await page.route(`**${bindingsPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByText(/Secret access could not be confirmed.*Request interrupted/).waitFor();
  await page.unroute(`**${bindingsPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.getByRole("button", { name: "Save authentication source" }).waitFor();
  const grants = (await fixture.request("GET", bindingsPath)).data.filter(
    (binding) => binding.resourceId === replacement.id,
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].subjectId, agent.servicePrincipalId);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(pathRequests(requests, "POST", bindingsPath).length, 1);
});

test("Credentials blocks repeat saves after losing an authentication PATCH response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unknown credential save", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Unknown save Agent",
    createHarnessConfiguration("openclaw", "gpt-4.1"),
  );
  const replacement = await fixture.createSecret(
    namespace.id,
    "Replacement credential",
    "test-unknown-token",
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.route(`**${agentPath}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    assert.equal((await route.fetch()).status(), 200);
    await route.abort("failed");
  });
  await page.getByLabel("Authentication source").selectOption("api_key");
  await selectSecret(page, "API key Secret", replacement);
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .locator("form.agent-card")
    .getByText(/Outcome unknown/)
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save authentication source" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(pathRequests(requests, "PATCH", agentPath).length, 1);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/access-bindings`).length,
    0,
  );
  // Explicit reload recovers the committed source; saving it again confirms the missing grant.
  await page.unroute(`**${agentPath}`);
  await page.getByRole("button", { name: "Reload authentication source", exact: true }).click();
  await page.getByLabel("API key Secret").waitFor();
  assert.equal(
    await page.getByLabel("API key Secret").evaluate((node) => node.value),
    secretOptionLabel(replacement),
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector("#harness-auth-method")?.disabled === false,
  );
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`)).data.some(
      (binding) =>
        binding.subjectId === agent.servicePrincipalId && binding.resourceId === replacement.id,
    ),
    true,
  );
});

test("live workspace drafts survive navigation, stay Agent-scoped, and clear on explicit reload or save", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "console-workspace-drafts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Exercise the real Console, Fastify, and IAM paths with disk-backed file transport.
  // This checks UI navigation and file requests, not a live Agent gateway.
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }) {
        return {
          status: "ok",
          file: {
            name: filename,
            content: await readFile(join(root, revision.agentId, filename), "utf8"),
          },
        };
      },
      async write({ revision, filename, content }) {
        await writeFile(join(root, revision.agentId, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Workspace draft owner",
    nativeValues("workspace"),
  );
  const other = await fixture.createAgent(
    namespace.id,
    "Other workspace Agent",
    nativeValues("other"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  for (const owner of [agent, other]) {
    await mkdir(join(root, owner.id));
    for (const name of Object.keys(WORKSPACE_DEFAULTS)) {
      await writeFile(join(root, owner.id, name), `# Saved ${name}\n`);
    }
  }
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace");
  await login(page, fixture, url.pathname + url.search);
  const file = page.getByLabel("AGENTS.md", { exact: true });
  await file.fill("# Unsaved instructions\n");
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.waitForFunction(() => {
    const editor = globalThis.document.getElementById("workspace-AGENTS.md");
    return editor && !editor.disabled;
  });
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Other workspace Agent", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(await file.inputValue(), "# Saved AGENTS.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByLabel("Search Agents").fill("Workspace draft owner");
  await page.getByRole("link", { name: "Workspace draft owner", exact: true }).click();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page.waitForFunction(() => {
    const editor = globalThis.document.getElementById("workspace-AGENTS.md");
    return editor && !editor.disabled;
  });
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/workspace/files/AGENTS.md"),
  );
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal(
    await readFile(join(root, agent.id, "AGENTS.md"), "utf8"),
    "# Unsaved instructions\n",
  );
  await page.getByRole("button", { name: "Reload USER.md", exact: true }).click();
  await page.getByText("USER.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  assert.equal(await page.getByLabel("Search Agents").inputValue(), "Workspace draft owner");
  await page.goBack();
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
});

test("authentication drafts retain Secret references and their original save baseline", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Authentication navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Authentication draft",
    nativeValues("auth"),
  );
  const secret = await fixture.createSecret(namespace.id, "Replacement key", "synthetic-auth-key");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "credentials");
  await login(page, fixture, url.pathname + url.search);
  await page.getByLabel("Authentication source").selectOption("api_key");
  await selectSecret(page, "API key Secret", secret);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  // A saved auth change must not rebase the retained local choice when the page is recreated.
  const changed = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(changed.status, 200);
  await page.goBack();
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).evaluate((node) => node.value),
    secretOptionLabel(secret),
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  await page
    .getByText("The Configuration changed. Reload authentication source before saving.")
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await page.getByRole("button", { name: "Reload authentication source" }).click();
  await page.getByLabel("Authentication source").waitFor();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "");
  await page.getByLabel("Authentication source").selectOption("api_key");
  assert.equal(
    await page.getByLabel("API key Secret", { exact: true }).evaluate((node) => node.value),
    "",
  );
});

test("Secret summaries retain revision bindings and distinguish unreadable metadata from absent bindings", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Bound Secret summaries", { ready: true });
  const app = await fixture.createSecret(namespace.id, "Revision Slack app", "hidden-app-value");
  const bot = await fixture.createSecret(namespace.id, "Revision Slack bot", "hidden-bot-value");
  const replacement = await fixture.createSecret(namespace.id, "Draft model", "hidden-model-value");
  const secretBindings = {
    SLACK_APP_TOKEN: { source: app.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: bot.ref, delivery: { type: "env" } },
  };
  const agent = await fixture.createAgent(namespace.id, "Bound Secrets", nativeValues("bound"), {
    secretBindings,
  });
  // Real admission requires exact Agent access to each projected credential.
  for (const secret of [app, bot, replacement]) {
    fixture.policy.bindings.push({
      id: `grant-${secret.id}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: `service-agent-${agent.id}`,
      roleId: `auth-${agent.id}`,
      resourceKind: "secret",
      resourceId: secret.id,
    });
  }
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // Mutate both current owners after admission; the read-only view must keep the old references.
  await fixture.updateAgent(namespace.id, agent.id, {
    configurationId: agent.configurationId,
    harnessAuth: { method: "api_key", source: replacement.ref },
  });
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("changed"), {
    secretBindings: {},
  });
  const limited = await fixture.createAccountWithPolicy("secret-summary-reader", (principal) => {
    fixture.policy.roles.push(
      {
        id: "summary-reader",
        namespaceId: namespace.id,
        permissions: ["namespace", "agent", "configuration", "agent_revision"].map(
          (resourceKind) => ({ action: "read", resourceKind }),
        ),
      },
      {
        id: "exact-secret-reader",
        namespaceId: namespace.id,
        permissions: [{ action: "read", resourceKind: "secret" }],
      },
    );
    fixture.policy.bindings.push({
      id: "summary-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "summary-reader",
    });
    // Only these exact Secrets are readable. No Secret collection grant is present.
    for (const id of [agent.harnessAuth.source.id, app.id, replacement.id]) {
      fixture.policy.bindings.push({
        id: `read-${id}`,
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: "exact-secret-reader",
        resourceKind: "secret",
        resourceId: id,
      });
    }
  });
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, url.pathname + url.search, limited.credentials);
  await page.getByRole("link", { name: "Auth Bound Secrets", exact: true }).waitFor();
  assert.equal(await page.getByText("Draft model", { exact: true }).count(), 0);
  await page.screenshot({ path: join(artifacts, "bound-harness-revision.png"), fullPage: true });
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("link", { name: "Revision Slack app", exact: true }).waitFor();
  await page
    .getByText(`Bound Secret · ${bot.id} · Metadata unavailable (access denied)`, { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: /Configure Slack|Edit Slack/ }).count(), 0);
  await page.screenshot({ path: join(artifacts, "bound-channels-restricted.png"), fullPage: true });
  assert.equal(
    requests.some((request) => request.path === `/namespaces/${namespace.id}/secrets`),
    false,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  for (const value of ["hidden-app-value", "hidden-bot-value", "hidden-model-value"]) {
    assert.equal((await page.locator("body").textContent()).includes(value), false);
  }
  // Active snapshots protect their Secrets even after the draft drops the bindings.
  const secretPath = `/namespaces/${namespace.id}/secrets/${app.id}`;
  assert.equal((await fixture.request("DELETE", secretPath)).status, 409);
  // Admit and select the replacement draft, leaving the viewed revision historical.
  // With no live references, a real deletion makes its bound metadata unavailable.
  await fixture.seedActiveAgentRevision(namespace.id, agent.id, active.revision.id);
  const deleted = await fixture.rawRequest("DELETE", secretPath, {
    headers: authenticatedHeaders(await fixture.signIn()),
  });
  assert.equal(deleted.response.status, 204);
  assert.equal((await fixture.request("GET", secretPath)).status, 404);
  await page.reload();
  await page
    .getByText(`Bound Secret · ${app.id} · Metadata unavailable`, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Create new version", exact: true }).last().click();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByText("No Secret bound", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("No Secret bound", { exact: true }).count(), 2);
  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("link", { name: "Draft model", exact: true }).waitFor();
});

test("Slack directory selections show names and save exact channel IDs", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack directory picker", { ready: true });
  const appSecret = await fixture.createSecret(namespace.id, "Slack app token", "xapp-test-secret");
  const botSecret = await fixture.createSecret(namespace.id, "Slack bot token", "xoxb-test-secret");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "disabled",
    channels: { CEXIST123: { requireMention: true, users: ["*"] } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Directory Agent",
    nativeValues("slack-directory", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const directoryBodies = [];
  const pendingDirectory = Promise.withResolvers();
  const releaseDirectory = Promise.withResolvers();
  // The browser test owns Console selection and saved API state; only provider directory data is simulated.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      directoryBodies.push(body);
      if (body.query === "pending") {
        pendingDirectory.resolve(route.request());
        await releaseDirectory.promise;
      }
      let nextCursor;
      let candidates;
      if (body.kind === "users") {
        candidates = [{ id: "UTEST123", name: "alex", displayName: "Alex" }];
      } else if (body.query === "GENERALX") {
        if (!body.cursor) {
          candidates = Array.from({ length: 7 }, (_, index) => ({
            id: `CUPPER11${index + 1}`,
            name: `GENERALX-first-${index + 1}`,
          }));
          nextCursor = "upper-next";
        } else if (body.cursor === "upper-next") {
          candidates = [];
          nextCursor = "upper-final";
        } else {
          candidates = [{ id: "CUPPER123", name: "GENERALX" }];
        }
      } else {
        candidates = [
          { id: "CEXIST123", name: "existing-room" },
          { id: "CTEST456", name: "release-room" },
          { id: "CGENERAL", name: "general" },
          { id: "CUPPER123", name: "GENERALX" },
        ];
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            workspaceName: "Test workspace",
            candidates: body.ids
              ? candidates.filter((candidate) => body.ids.includes(candidate.id))
              : candidates,
            complete: !nextCursor,
            ...(nextCursor ? { nextCursor } : {}),
          },
          meta: { requestId: "req_test_slack_directory" },
        }),
      });
    },
  );

  const channelsUrl = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, channelsUrl.pathname + channelsUrl.search);
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Edit Slack" });
  const channelSearch = channelDialog.getByRole("combobox", { name: "Channels", exact: true });
  const channelPicker = channelSearch.locator("..").locator("..");
  await channelPicker.getByText("#existing-room", { exact: true }).waitFor();
  await channelSearch.focus();
  await channelPicker.getByRole("option", { name: /existing-room.*CEXIST123/ }).waitFor();
  // Advance browser time explicitly: intermediate keystrokes and dismissed searches must not query.
  const clockTime = new Date("2026-09-27T12:00:00Z");
  await page.clock.install({ time: new Date("2026-09-27T11:59:00Z") });
  await page.clock.pauseAt(clockTime);
  await channelSearch.fill("g");
  await page.clock.runFor(200);
  await channelSearch.fill("ge");
  await page.clock.runFor(200);
  await channelSearch.fill("general");
  await page.clock.runFor(299);
  assert.deepEqual(
    directoryBodies.filter((body) => body.query),
    [],
  );
  await page.clock.runFor(1);
  await channelPicker.getByRole("option", { name: /general.*CGENERAL/ }).waitFor();
  assert.deepEqual(
    directoryBodies.filter((body) => body.query).map((body) => body.query),
    ["general"],
  );
  await channelSearch.fill("dismissed");
  await channelSearch.press("Escape");
  await page.clock.runFor(300);
  assert.equal(
    directoryBodies.some((body) => body.query === "dismissed"),
    false,
  );
  // A new query aborts the old browser request, even while its provider response is held.
  await channelSearch.fill("pending");
  await channelSearch.press("Enter");
  const pendingRequest = await pendingDirectory.promise;
  const canceledRequest = page.waitForEvent(
    "requestfailed",
    (request) => request === pendingRequest,
  );
  await channelSearch.fill("general");
  await canceledRequest;
  releaseDirectory.resolve();
  // Enter submits immediately and removes the queued debounce, so it cannot send the same query twice.
  await channelSearch.press("Enter");
  await channelPicker.getByRole("option", { name: /general.*CGENERAL/ }).waitFor();
  await page.clock.runFor(300);
  assert.equal(directoryBodies.filter((body) => body.query === "general").length, 2);
  await page.clock.resume();
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123");
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.ok(directoryBodies.some((body) => body.query === "general" && !body.ids));
  await channelSearch.press("ArrowUp");
  assert.equal(
    await channelSearch.getAttribute("aria-activedescendant"),
    await channelPicker.getByRole("option").last().getAttribute("id"),
  );
  await channelSearch.press("Escape");
  assert.equal(await channelSearch.getAttribute("aria-expanded"), "false");
  assert.equal(await channelDialog.isVisible(), true);
  await channelSearch.fill("GENERALX");
  await channelPicker.getByRole("option", { name: /GENERALX-first.*CUPPER111/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 5);
  // Seven provider matches span two display pages; neither overflow nor Previous rereads the provider.
  const initialSearchRequests = directoryBodies.filter((body) => body.query === "GENERALX").length;
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX-first-6.*CUPPER116/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 2);
  await channelPicker.getByRole("button", { name: "Previous page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX-first-1.*CUPPER111/ }).waitFor();
  assert.equal(await channelPicker.getByRole("option").count(), 5);
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  assert.equal(
    directoryBodies.filter((body) => body.query === "GENERALX").length,
    initialSearchRequests,
  );
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker
    .getByText("No results on this page. More results may be available.")
    .waitFor();
  // A provider scan without matches still permits continuing to a later matching channel.
  await channelPicker.getByRole("button", { name: "Next page" }).click();
  await channelPicker.getByRole("option", { name: /GENERALX.*CUPPER123/ }).click();
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123, CUPPER123");
  assert.ok(directoryBodies.some((body) => body.ids?.[0] === "GENERALX"));
  assert.ok(directoryBodies.some((body) => body.query === "GENERALX" && !body.ids));
  assert.ok(
    directoryBodies.some((body) => body.query === "GENERALX" && body.cursor === "upper-next"),
  );
  await channelPicker.getByRole("button", { name: "Remove CUPPER123", exact: true }).click();
  await channelSearch.fill("CTEST456");
  await channelPicker.getByRole("option", { name: /release-room.*CTEST456/ }).waitFor();
  await channelSearch.press("ArrowDown");
  await channelSearch.press("Enter");
  assert.equal(await channelSearch.inputValue(), "");
  assert.equal(await slackSelectionValue(channelSearch), "CEXIST123, CTEST456");
  // Clearing specific people must not turn channel access into Everyone.
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("selected");
  const people = channelDialog.getByRole("combobox", {
    name: "Allowed people in these channels",
    exact: true,
  });
  await setSlackSelection(people, "UTEST123");
  await people
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Remove UTEST123", exact: true })
    .click();
  await channelDialog.getByRole("button", { name: "Save configuration" }).click();
  await channelDialog
    .getByText("Choose specific people or select Everyone in these channels.")
    .waitFor();
  assert.equal(
    pathRequests(
      requests,
      "PATCH",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    ).length,
    0,
  );
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
  // Unselected search text is never part of the Configuration save.
  await channelSearch.fill("unselected search text");
  const savedChannels = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/namespaces/${namespace.id}/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await channelDialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await savedChannels).status(), 200);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(Object.keys(configuration.data.values.channels.slack.channels), [
    "CEXIST123",
    "CTEST456",
  ]);
  assert.ok(
    directoryBodies.some(
      (body) =>
        body.secretId === botSecret.id &&
        body.kind === "channels" &&
        body.configurationId === agent.configurationId &&
        body.ids?.[0] === "CTEST456",
    ),
  );
  await page.getByRole("button", { name: "Edit Slack" }).click();
  await page
    .getByRole("dialog", { name: "Edit Slack" })
    .locator('.slack-directory-chip[data-value="CTEST456"]')
    .getByText("#release-room")
    .waitFor();
});

test("Slack editor preserves existing qualified channel and user targets", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Qualified Slack targets", { ready: true });
  const appSecret = await fixture.createSecret(
    namespace.id,
    "Qualified Slack app token",
    "xapp-qualified",
  );
  const botSecret = await fixture.createSecret(
    namespace.id,
    "Qualified Slack bot token",
    "xoxb-qualified",
  );
  const channelUsers = [
    "team:TTEST123:user:UTEST123",
    "user:UTEST124",
    "slack:UTEST125",
    "@legacy-sender",
  ];
  const dmUsers = ["user:UTEST123", "slack:UTEST124", "team:TTEST123:user:UTEST125", "@legacy-dm"];
  const channelIds = ["team:TTEST123:channel:CEXIST123", "channel:GEXIST456", "#legacy-room"];
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "allowlist",
    allowFrom: dmUsers,
    channels: Object.fromEntries(
      channelIds.map((id) => [id, { requireMention: true, users: channelUsers }]),
    ),
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Qualified Slack Agent",
    nativeValues("qualified-slack", { harnessId: "codex", channels: { slack } }),
    {
      executionMode: "dedicated",
      secretBindings: {
        SLACK_APP_TOKEN: { source: appSecret.ref, delivery: { type: "env" } },
        SLACK_BOT_TOKEN: { source: botSecret.ref, delivery: { type: "env" } },
      },
    },
  );
  const { page } = await newPage(t, fixture);
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/channel-directory/lookup`,
    async (route) => {
      const body = route.request().postDataJSON();
      const candidates =
        body.kind === "channels"
          ? [{ id: "CEXIST123", name: "existing-room" }]
          : [{ id: "UTEST123", name: "alex", displayName: "Alex" }];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            workspaceId: "TTEST123",
            candidates: body.ids
              ? candidates.filter((candidate) => body.ids.includes(candidate.id))
              : candidates,
            complete: true,
          },
          meta: { requestId: "req_qualified_slack" },
        }),
      });
    },
  );
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");
  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.deepEqual(
    (
      await slackSelectionValue(dialog.getByRole("combobox", { name: "Channels", exact: true }))
    ).split(", "),
    channelIds,
  );
  assert.deepEqual(
    new Set(
      (
        await slackSelectionValue(
          dialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        )
      ).split(", "),
    ),
    new Set(channelUsers),
  );
  assert.deepEqual(
    (
      await slackSelectionValue(
        dialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
      )
    ).split(", "),
    dmUsers,
  );
  for (const [label, candidate] of [
    ["Channels", /existing-room.*CEXIST123/],
    ["Allowed people in these channels", /Alex.*UTEST123/],
    ["Allowed people in direct messages", /Alex.*UTEST123/],
  ]) {
    const search = dialog.getByRole("combobox", { name: label, exact: true });
    await search.focus();
    await search.locator("..").locator("..").getByRole("option", { name: candidate }).click();
  }
  assert.equal(await dialog.locator('.slack-directory-chip[data-value="CEXIST123"]').count(), 0);
  assert.deepEqual(
    (
      await slackSelectionValue(dialog.getByRole("combobox", { name: "Channels", exact: true }))
    ).split(", "),
    channelIds,
  );
  assert.deepEqual(
    new Set(
      (
        await slackSelectionValue(
          dialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
        )
      ).split(", "),
    ),
    new Set(channelUsers),
  );
  assert.deepEqual(
    (
      await slackSelectionValue(
        dialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
      )
    ).split(", "),
    dmUsers,
  );
  await dialog.getByLabel("Require a mention").uncheck();
  const saved = page.waitForResponse(
    (response) =>
      response
        .url()
        .endsWith(`/namespaces/${namespace.id}/configurations/${agent.configurationId}`) &&
      response.request().method() === "PATCH",
  );
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  assert.equal((await saved).status(), 200);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  const persisted = configuration.data.values.channels.slack;
  assert.deepEqual(Object.keys(persisted.channels), channelIds);
  for (const entry of Object.values(persisted.channels)) {
    assert.deepEqual(new Set(entry.users), new Set(channelUsers));
    assert.equal(entry.requireMention, false);
  }
  assert.deepEqual(persisted.allowFrom, dmUsers);
});

import { openAdvancedSettings, waitForLiveControls } from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Route, Response as PlaywrightResponse } from "playwright";
import type {
  CatalogEntry,
  PluginFieldCatalog,
  PluginFieldsOptions,
} from "/console/agents/plugin-fields.mjs";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { apiErrorResponse } from "../helpers/api-error.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  deploymentStatusResponse,
  authorizationDenials,
  apiRequests,
  detailUrl,
  draftActions,
  expectDeployHeld,
  expectDeployRefused,
  expectNoHorizontalScroll,
  expectNoText,
  expectReachableReason,
  hasFocus,
  holdRequests,
  login,
  memberWriteWithout,
  nativeValues,
  newPage,
  nextFrames,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  saveConfigurationUntilReady,
  settledView,
  storeRefusedConfiguration,
  versionChooser,
  versionOption,
  waitForChosenVersion,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";

import { trackSettledFetches, waitForIdleFetches } from "./console-fetch-accounting.ts";
import { createRuntimeAuthFixture } from "./console-agents-runtime-auth-fixture.ts";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
  expectVersionRecord,
  openFailureDetails,
} from "./console-deployment-activity-helpers.ts";
import {
  assertRevisionUrl,
  replyWithDifferentAgentId,
  configurationPatchRequests,
  nativeAdminValues,
} from "./console-agents-test-support.mjs";
import {
  AGENT_SAVE_DENIED,
  CONFIGURATION_EDITS_PENDING,
  READ_UNAVAILABLE,
  SAVED_CONFIGURATION_CHANGED,
  KUBERNETES_ALLOW_USERS_REFUSAL,
  codexPluginRefusal,
  configIncludeRefusal,
  invalidSecretProviderDefaultsRefusal,
  unreadableGatewayPasswordRefusal,
  unreadablePluginSecretRefusal,
  pluginEntryKeyVariantRefusal,
  pluginPolicyListRefusal,
  providerKeyVariantRefusal,
  NO_TEST_REQUEST,
} from "../helpers/refusal-text.mjs";
import {
  OPENCLAW_SANDBOX_SETTINGS,
  openClawSandboxRefusal,
} from "../helpers/admitted-configuration.mjs";

type PluginScopeFixture = {
  fields: ReturnType<typeof import("/console/agents/plugin-fields.mjs").createPluginFields>;
  catalog: PluginFieldCatalog & { entries: [CatalogEntry, CatalogEntry] };
  loads: Parameters<NonNullable<PluginFieldsOptions["onLoadPlugins"]>>[];
  cancellations(): number;
};

declare global {
  interface Window {
    diagnosticsAnnouncements?: string[];
    pluginScopeFixture?: PluginScopeFixture;
  }
}

type WireRevision = Awaited<
  ReturnType<Awaited<ReturnType<typeof createConsoleAppFixture>>["deployAgent"]>
>;
type DeploymentRecord = Parameters<typeof deploymentStatusResponse>[1];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asObject(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value), "Expected an object at the fixture boundary");
  return value;
}
type AdminConfiguration = Record<string, unknown> & {
  gateway: Record<string, unknown> & {
    auth: Record<string, unknown> & { trustedProxy: Record<string, unknown> };
  };
  agents: Record<string, unknown> & { defaults: Record<string, unknown> };
  plugins: Record<string, unknown> & { entries: Record<string, unknown> };
};
function adminConfiguration(value: unknown): AdminConfiguration {
  function isConfiguration(candidate: unknown): candidate is AdminConfiguration {
    return (
      isObject(candidate) &&
      isObject(candidate.gateway) &&
      isObject(candidate.gateway.auth) &&
      isObject(candidate.gateway.auth.trustedProxy) &&
      isObject(candidate.agents) &&
      isObject(candidate.agents.defaults) &&
      isObject(candidate.plugins) &&
      isObject(candidate.plugins.entries)
    );
  }
  assert.ok(isConfiguration(value), "Expected native administrator Configuration from the fixture");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

test("Deployment shows a historical version's snapshot read failure and Retry recovers", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Deployment snapshot retry", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Snapshot retry", nativeValues("retry"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const current = await fixture.deployAgent(namespace.id, agent.id);
  await fixture.activateRevision(namespace.id, agent.id, current.id, first.revision.id);

  for (const openingTab of ["deployment", "configuration"]) {
    await t.test(`opening from ${openingTab}`, async (t) => {
      const { page } = await newPage(t, fixture);
      const snapshotPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${first.revision.id}`;
      // A transient snapshot read failure must stay visible beside the latest deployment,
      // whether Deployment is opened by address or after another tab already saw the failure.
      await page.route(
        fixture.origin + snapshotPath,
        (route) =>
          route.fulfill(
            apiErrorResponse(
              503,
              "DEPENDENCY_UNAVAILABLE",
              "A required platform dependency is unavailable.",
            ),
          ),
        { times: 1 },
      );
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, first.revision.id, openingTab),
      );
      if (openingTab === "configuration") {
        await page
          .getByRole("heading", { name: "Configuration unavailable", exact: true })
          .waitFor();
        await page.getByRole("tab", { name: "Deployment", exact: true }).click();
      }
      const panel = page.getByRole("tabpanel", { name: "Deployment", exact: true });
      const error = panel.getByRole("alert").filter({
        has: page.getByRole("heading", { name: "Configuration unavailable", exact: true }),
      });
      await error.waitFor();
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await page
        .getByRole("tabpanel", { name: "Deployment", exact: true })
        .locator(".version-evidence")
        .getByRole("heading", { name: "This version’s deployment record", exact: true })
        .waitFor();
      assert.equal(new URL(page.url()).searchParams.get("revision"), first.revision.id);
      assert.equal(new URL(page.url()).searchParams.get("tab"), "deployment");
      assert.equal(
        await page.getByRole("heading", { name: "Configuration unavailable", exact: true }).count(),
        0,
      );
    });
  }
});

test("Refresh record retains keyboard focus without duplicate reads or stealing focus", async (t) => {
  const fixture = await createConsoleAppFixture(t, { recordOperations: true });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Record refresh", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Refresh Agent", nativeValues("v1"));
  const { revision } = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  // The latest deployment polls a different record; only this control reads the viewed version.
  await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, revision.id, "deployment"));
  const record = await expectVersionRecord(page, "Queued");
  const url = deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id);
  const path = new URL(url).pathname;
  const refresh = record.getByRole("button", { name: "Refresh record", exact: true });
  const refreshing = record.getByRole("button", { name: "Refreshing…", exact: true });

  for (const moveFocus of [false, true]) {
    const reads = pathRequests(requests, "GET", path).length;
    const held = await holdRequests(t, page, url, { method: "GET", once: true, afterServer: true });
    await refresh.focus();
    assert.equal(await hasFocus(refresh), true);
    await page.keyboard.press("Enter");
    // Hold a genuine successful Controller answer, not a synthetic deployment response.
    const answer = await held.requested;
    assert.ok(answer);
    assert.equal(answer.status(), 200);
    const data = asObject(asObject(await answer.json()).data);
    assert.equal(data.deploymentId, revision.id);
    assert.equal(data.status, "queued");
    await refreshing.waitFor();
    assert.equal(await hasFocus(refreshing), true);
    assert.equal(await refreshing.getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.equal(pathRequests(requests, "GET", path).length, reads + 1);

    // Remember the reader's actual Tab destination so completion cannot silently move it.
    let destination;
    if (moveFocus) {
      await page.keyboard.press("Tab");
      assert.equal(await hasFocus(refreshing), false);
      destination = await page.evaluateHandle(() => globalThis.document.activeElement);
      assert.equal(await destination.evaluate((node) => node === globalThis.document.body), false);
    }
    const delivered = page.waitForResponse(
      (response) => response.url() === url && response.request().method() === "GET",
    );
    held.release();
    assert.equal((await delivered).status(), 200);
    await refresh.waitFor();
    assert.equal(await refresh.getAttribute("aria-disabled"), null);
    if (moveFocus) {
      assert.ok(destination);
      assert.equal(
        await destination.evaluate((node) => node === globalThis.document.activeElement),
        true,
      );
      await destination.dispose();
    } else {
      assert.equal(await hasFocus(refresh), true);
    }
    assert.equal(pathRequests(requests, "GET", path).length, reads + 1);
  }
});

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
  let pendingRecord: DeploymentRecord = { status: "queued" };
  for (const [revision, recorded] of [
    [
      current.revision,
      () => ({
        status: "succeeded",
        warnings: [{ code: "PLUGIN_AUTH_REQUIRED", pluginId: "linear@openai-curated-remote" }],
      }),
    ],
    [pending, () => pendingRecord],
  ] satisfies [WireRevision, () => DeploymentRecord][]) {
    await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, revision.id), (route) => {
      return route.fulfill(deploymentStatusResponse(revision, recorded()));
    });
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
  await versionChooser(page).waitFor();
  await waitForChosenVersion(page);
  const overview = page.locator(".agent-current-summary > div");
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await overview.nth(1).getByText("v2 · Queued").waitFor();
  await overview.nth(2).getByText("Not verified").waitFor();
  // A running version's unverified serving says why (finding 2367).
  await overview.nth(2).getByText(NO_TEST_REQUEST, { exact: true }).waitFor();
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
  await page.getByRole("tab", { name: "Deployment", exact: true }).click();
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
    const announced = (node: Node) => {
      for (
        let el = node instanceof Element ? node : node.parentElement;
        el;
        el = el.parentElement
      ) {
        const live = el.getAttribute("aria-live");
        if (live) {
          return live !== "off";
        }
        if (["status", "alert", "log"].includes(el.getAttribute("role") ?? "")) {
          return true;
        }
      }
      return false;
    };
    const announcements: string[] = [];
    globalThis.window.diagnosticsAnnouncements = announcements;
    const observed = globalThis.document.querySelector(".version-diagnostics");
    if (!observed) {
      throw new Error("Missing diagnostics panel");
    }
    new globalThis.MutationObserver((records: MutationRecord[]) => {
      for (const record of records) {
        const nodes = record.type === "characterData" ? [record.target] : [...record.addedNodes];
        for (const node of nodes) {
          const text = (node.textContent ?? "").trim();
          if (text && announced(node)) {
            announcements.push(text);
          }
        }
      }
    }).observe(observed, {
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
    assert.deepEqual(
      await page.evaluate(() => {
        const announcements = globalThis.window.diagnosticsAnnouncements;
        if (!announcements) {
          throw new Error("Missing diagnostics announcements");
        }
        return announcements;
      }),
      ["Waiting for diagnostic results…"],
    );
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
        globalThis.document.getElementById(node.getAttribute("aria-describedby") ?? "")
          ?.textContent,
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
  assert.match(text(await description()), /^Observed /);
  assert.doesNotMatch(text(await description()), /authentication/);
  await pollPanel();
  assert.match(text(await description()), /^Observed /);
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
  assert.match(text(await description()), /^Current-runtime diagnostics are unavailable/);
  await pollPanel();
  assert.match(text(await description()), /^Current-runtime diagnostics are unavailable/);
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

  await versionChooser(page).selectOption(
    await page
      .locator("#revision-selector option")
      .filter({ hasText: /^v2(?: ·|$)/ })
      .getAttribute("value"),
  );
  await page
    .locator(".agent-version-metadata .resource-id")
    .filter({ hasText: pending.id })
    .waitFor({ state: "attached" });
  await overview.nth(0).getByText("v1", { exact: true }).waitFor();
  await versionChooser(page).selectOption(
    await page
      .locator("#revision-selector option")
      .filter({ hasText: /^v1(?: ·|$)/ })
      .getAttribute("value"),
  );
  await waitForChosenVersion(page);
  await page
    .locator(".agent-version-metadata .resource-id")
    .filter({ hasText: current.revision.id })
    .waitFor({ state: "attached" });
  await page.getByRole("tab", { name: "Deployment", exact: true }).click();
  await activity.getByText("Most recent visible deployment · v2").waitFor();
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("v3"));
  const newer = await fixture.deployAgent(namespace.id, agent.id);
  let newerStatus = "queued";
  await page.route(
    deploymentRecordUrl(fixture, namespace.id, agent.id, newer.id),
    async (route: Route) => {
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
  await versionOption(page, 3).waitFor({ state: "attached" });
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
    function unreadableProjection(input: unknown) {
      const value = asObject(input);
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
      await page.route(`${fixture.origin}${path}`, async (route: Route) => {
        const response = await route.fetch();
        const payload = asObject(await response.json());
        payload.data = Array.isArray(payload.data)
          ? list(payload.data).map(unreadableProjection)
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
    await versionOption(page, 1).waitFor({ state: "attached" });
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
      await versionChooser(page).selectOption(
        await page
          .locator("#revision-selector option")
          .filter({ hasText: /^v1(?: ·|$)/ })
          .getAttribute("value"),
      );
      await page.getByRole("heading", { name: "Configuration snapshot", exact: true }).waitFor();
    } else {
      await page.getByRole("button", { name: "Open draft", exact: true }).first().click();
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
    async (route: Route) => {
      const response = await route.fetch();
      const payload = asObject(await response.json());
      for (const field of ["harnessAuth", "plugins", "pluginApprovers", "repositoryBindings"]) {
        delete asObject(payload.data)[field];
      }
      asObject(payload.data).configurationReadError = {
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
  assert.deepEqual(asObject(saved.data).values, nativeValues("saved"));
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
  const edited: Omit<ReturnType<typeof nativeValues>, "models"> & {
    models: { providers: Record<string, unknown> };
  } = structuredClone(values);
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
  assert.equal(text(await feedback.textContent()).includes(sentinel), false);
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(asObject(saved.data).values, values);
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
  // Save refuses a bare model name with deployment's text (finding 1828). A row an older release
  // saved with it still reads, and deployment refuses it.
  await storeRefusedConfiguration(fixture, configurationDriver, agent, bare, reason);
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

// A draft an older release saved with a setting the pinned OpenClaw has since retired: save
// refuses the setting, and deploy admission refuses the stored row with the same message. The
// draft's next step says that message with Deploy held, instead of "Ready to deploy." and a
// refusal only after Deploy (finding 2810). Removing the setting makes the draft ready again.
test("A draft that keeps a retired OpenClaw setting shows deployment's refusal before Deploy", async (t) => {
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, { configurationDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Retired setting", { ready: true });
  const values = nativeValues("retired-setting");
  const agent = await fixture.createAgent(namespace.id, "Retired setting Agent", values);
  const retired = { ...values, security: { preset: "corporate" } };
  const reason =
    "Configuration setting security.preset must be removed: the OpenClaw runtime retired it (configure the individual security controls explicitly).";
  // Save refuses it. A row an older release saved with it still reads; the server refuses to
  // deploy it.
  await storeRefusedConfiguration(fixture, configurationDriver, agent, retired, reason);

  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const card = draftActions(page);
  // The Configuration step stays open and says what to do.
  await expectDeployHeld(card, reason, "Remove the retired setting · Configuration ");
  assert.notEqual(await card.getByRole("listitem").first().getAttribute("data-state"), "done");
  // Reading the draft sent no deployment.
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`),
    [],
  );

  // Deploy admission gives this exact text for the stored row (the page shows what it would say).
  await expectDeployRefused(fixture, agent, reason);

  await saveConfigurationUntilReady(page, card, values);
  assert.equal(await card.getByText(reason).count(), 0);
});

test("Plugin save distinguishes a refusal, a stale read, and an unconfirmed success", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver();
  assert.ok(fixture.controller instanceof OpenClawController);
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
  const patched = (response: PlaywrightResponse) =>
    response.request().method() === "PATCH" && response.url() === agentUrl;
  const save = page.getByRole("button", { name: "Save plugin selections", exact: true });

  // A 400 without a server sentence keeps the plugin-specific text, not the generic one.
  const unexplained = async (route: Route) => {
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
  const reason = text(asObject(asObject(await response.json()).error).message);
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
  assert.deepEqual(asObject(saved.data).plugins ?? {}, {});

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
  assert.notEqual(asObject(other.data).id, agent.id);
  for (const field of ["namespaceId", "configurationId", "plugins", "pluginApprovers"]) {
    assert.deepEqual(asObject(other.data)[field], asObject(saved.data)[field]);
  }
  const policy = { toolDefaults: { approval: "all_actions" }, enabled: true };
  const edits = { [pluginId]: policy };
  const editor = page.getByLabel("Plugin selections JSON", { exact: true });
  const requests = apiRequests(page, fixture.origin);
  for (const [method, replyData] of [
    ["GET", () => asObject(other.data)],
    [
      "PATCH",
      async (data) => {
        const otherAgent = await fixture.updateAgent(namespace.id, text(asObject(other.data).id), {
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
  ] satisfies [string, ((data: Record<string, unknown>) => unknown) | null][]) {
    const beforeWrite = method === "GET";
    const expected = beforeWrite ? {} : edits;
    const confirmed = replyData === null;
    requests.length = 0;
    if (!(await editor.isVisible())) {
      await page.getByText("Plugin selections JSON", { exact: true }).click();
    }
    await page.route(agentUrl, async (route: Route) => {
      if (route.request().method() !== method) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const body = asObject(await response.json());
      const dataBody = asObject(body.data);
      assert.equal(dataBody.id, agent.id);
      assert.deepEqual(dataBody.plugins ?? {}, expected);
      const data = confirmed
        ? {
            ...dataBody,
            name: "Unrelated acknowledgement field",
            plugins: { [pluginId]: { enabled: true, toolDefaults: policy.toolDefaults } },
          }
        : await replyData(dataBody);
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
    assert.deepEqual(
      asObject((await fixture.request("GET", agentPath)).data).plugins ?? {},
      expected,
    );
    assert.deepEqual(
      pathRequests(requests, "PATCH", agentPath).map(({ body }) => asObject(body).plugins),
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
  const reject = async (route: Route) => {
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
  assert.ok(fixture.provisionedAccounts[0]);
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
  assert.equal(list(roles.data).length, 1);

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
  assert.equal(list(bindings.data).length, 2);
  await page.route(`${policyPath}/access-bindings/*`, reject);
  const removeBinding = panel.getByRole("button", { name: "Remove binding", exact: true });
  // Removal deletes the binding at once, so it takes the destructive tone (finding 1967).
  assert.match(text(await removeBinding.getAttribute("class")), /\bbutton--danger\b/);
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
  const values = adminConfiguration(
    nativeAdminValues("gateway-password", "http://127.0.0.1:18789"),
  );
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
  assert.deepEqual(asObject(current.data).values, expected);
  assert.deepEqual(asObject(current.data).secretBindings, secretBindings);
  const unchanged = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${first.revision.id}`,
  );
  assert.deepEqual(asObject(unchanged.data).configuration, first.revision.configuration);
  assert.equal(
    asObject((await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).data)
      .activeRevisionId,
    first.revision.id,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 1);
  await page.getByLabel("Viewing version").selectOption(first.revision.id);
  await page.getByRole("button", { name: "Edit current Configuration", exact: true }).waitFor();
  assert.equal(await enable.count(), 0);

  // A fresh Agent whose v1 was admitted from this exact Configuration generation needs no redeploy.
  const fresh = await fixture.createAgent(namespace.id, "Gateway password fresh Agent", expected);
  const freshV1 = await fixture.seedActiveAgentRevision(namespace.id, fresh.id);
  assert.deepEqual(
    asObject(asObject(asObject(freshV1.revision.configuration).gateway).auth).password,
    expected.gateway.auth.password,
  );
  const freshUrl = detailUrl(fixture, namespace.id, fresh.id, "draft", "configuration");
  await page.goto(freshUrl.href);
  await page
    .getByText(
      `Gateway password access is enabled in the saved Configuration and included in v${freshV1.revision.revision}.`,
    )
    .waitFor();
  assert.equal(
    await page
      .getByText(
        "Gateway password access is enabled in the saved Configuration. Deploy a new version to apply it.",
      )
      .count(),
    0,
  );
});

// A Configuration an older release saved with a gateway password reference OpenClaw cannot read
// (here one without a provider, on a Configuration whose default env alias is custom): save and
// deploy refuse it on every Compute, so the page shows that refusal with Deploy held and keeps
// the button that writes the generated reference on that alias (finding 3063).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`An unreadable gateway password reference is not shown as enabled at ${viewport.width}px`, async (t) => {
    const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
    const fixture = await createConsoleAppFixture(t, { configurationDriver });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unreadable password", { ready: true });
    const values = {
      ...adminConfiguration(nativeAdminValues("unreadable-password", "http://127.0.0.1:18789")),
      secrets: { defaults: { env: "custom" } },
    };
    const agent = await fixture.createAgent(namespace.id, "Unreadable password Agent", values);
    const providerless = structuredClone(values);
    providerless.gateway.auth.password = { source: "env", id: "OPENCLAW_GATEWAY_PASSWORD" };
    const reason =
      "Configuration setting gateway.auth.password is a SecretRef without a provider: add provider custom.";
    await storeRefusedConfiguration(fixture, configurationDriver, agent, providerless, reason);

    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    await page
      .getByText(
        `${reason} Enable gateway password access to replace it, save Configuration, then deploy a new version.`,
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByText("Gateway password access is enabled", { exact: false }).count(),
      0,
    );
    const card = draftActions(page);
    await expectDeployHeld(card, reason, "Fix the gateway password · Configuration ");
    // Deploy admission refuses the stored row with the text the page shows.
    await expectDeployRefused(fixture, agent, reason);

    // The button writes the generated reference on the custom alias, which saves and deploys.
    const enable = page.getByRole("button", {
      name: "Enable gateway password access",
      exact: true,
    });
    await enable.scrollIntoViewIfNeeded();
    await enable.click();
    const expected = structuredClone(values);
    expected.gateway.auth.password = {
      source: "env",
      provider: "custom",
      id: "OPENCLAW_GATEWAY_PASSWORD",
    };
    assert.deepEqual(
      JSON.parse(await page.getByLabel("Configuration JSON").inputValue()),
      expected,
    );
    await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
    await page
      .getByText(
        "Gateway password access is enabled in the saved Configuration. Deploy a new version to apply it.",
      )
      .waitFor();
    assert.equal(await enable.count(), 0);
    await card.getByText("Ready to deploy.", { exact: true }).waitFor();
    assert.equal(await card.getByText(reason).count(), 0);
    await expectNoHorizontalScroll(page);
  });
}

// A Configuration an older release saved with a secrets.defaults alias OpenClaw's configuration
// check refuses (upper case here): the Gateway exits at every start whatever the password, and save
// refuses any reference the button could write, so the page names the alias, holds Deploy with
// OCC's refusal and offers no button until the alias is fixed (finding 3064).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A secrets.defaults alias OpenClaw refuses holds gateway password access at ${viewport.width}px`, async (t) => {
    const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
    const fixture = await createConsoleAppFixture(t, { configurationDriver });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Invalid alias", { ready: true });
    const values = adminConfiguration(nativeAdminValues("invalid-alias", "http://127.0.0.1:18789"));
    const agent = await fixture.createAgent(namespace.id, "Invalid alias Agent", values);
    const invalid = { ...structuredClone(values), secrets: { defaults: { env: "BAD" } } };
    const reason = invalidSecretProviderDefaultsRefusal("alias", "env", "BAD", "bad");
    await storeRefusedConfiguration(fixture, configurationDriver, agent, invalid, reason);

    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    await page
      .getByText(
        `${reason} Edit Configuration to fix it before you enable gateway password access.`,
        { exact: true },
      )
      .waitFor();
    const enable = page.getByRole("button", {
      name: "Enable gateway password access",
      exact: true,
    });
    assert.equal(await enable.count(), 0);
    const card = draftActions(page);
    await expectDeployHeld(card, reason, "Fix the secret provider alias · Configuration ");
    // Deploy admission refuses the stored row with the text the page shows.
    await expectDeployRefused(fixture, agent, reason);

    // Once the alias is fixed, the button writes the generated reference on it, which saves.
    const edit = page.getByRole("button", { name: "Edit Configuration", exact: true });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    const fixed = { ...structuredClone(values), secrets: { defaults: { env: "custom" } } };
    await page.getByLabel("Configuration JSON").fill(JSON.stringify(fixed, null, 2));
    await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
    await page
      .getByText(
        "Use generated credentials for direct gateway password access. Enable access, save Configuration, then deploy a new version.",
        { exact: true },
      )
      .waitFor();
    await enable.scrollIntoViewIfNeeded();
    await enable.click();
    const expected = structuredClone(fixed);
    expected.gateway.auth.password = {
      source: "env",
      provider: "custom",
      id: "OPENCLAW_GATEWAY_PASSWORD",
    };
    assert.deepEqual(
      JSON.parse(await page.getByLabel("Configuration JSON").inputValue()),
      expected,
    );
    await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
    await page
      .getByText(
        "Gateway password access is enabled in the saved Configuration. Deploy a new version to apply it.",
      )
      .waitFor();
    await card.getByText("Ready to deploy.", { exact: true }).waitFor();
    assert.equal(await card.getByText(reason).count(), 0);
    await expectNoHorizontalScroll(page);
  });
}

// A Configuration an older release saved with a Google web search header that is a SecretRef
// without a provider: OpenClaw cannot read it, so the Gateway exits at every start, and Kubernetes
// Compute refuses to save or deploy it. The draft holds Deploy with that refusal and the
// Configuration step names it, as for the password and alias cases (finding 3076); once the
// header names a provider, the draft is ready again.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A plugin secret input OpenClaw cannot read holds Deploy at ${viewport.width}px`, async (t) => {
    const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
    const fixture = await createConsoleAppFixture(t, { configurationDriver });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Plugin input", { ready: true });
    const values = adminConfiguration(nativeAdminValues("plugin-input", "http://127.0.0.1:18789"));
    const agent = await fixture.createAgent(namespace.id, "Plugin input Agent", values);
    const header = (reference: { source: string; id: string; provider?: string }) => ({
      ...structuredClone(values),
      plugins: {
        entries: {
          google: { config: { webSearch: { headers: { "X-Goog-User-Project": reference } } } },
        },
      },
    });
    const providerless = header({ source: "env", id: "GOOG_TOKEN" });
    const reason = unreadablePluginSecretRefusal(
      "plugins.entries.google.config.webSearch.headers.X-Goog-User-Project",
      "google",
      "providerless",
    );
    // The row as a release before the save rule stored it.
    await storeRefusedConfiguration(fixture, configurationDriver, agent, providerless, reason);

    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    const card = draftActions(page);
    await expectDeployHeld(card, reason, "Fix the plugin secret input · Configuration ");
    // Deploy admission refuses the stored row with the text the page shows.
    await expectDeployRefused(fixture, agent, reason);

    // A header on the default provider is one OpenClaw reads: it saves and the draft is ready.
    const fixed = header({ source: "env", provider: "default", id: "GOOG_TOKEN" });
    await saveConfigurationUntilReady(page, card, fixed);
    assert.equal(await card.getByText(reason).count(), 0);
    await expectNoHorizontalScroll(page);
  });
}

// A Configuration an older release saved with OpenClaw's $include, with a Codex entry beside
// codex, with OpenClaw's sandbox as well, with an OpenAI model provider key, or with a plugins.deny
// item that is not text: every Compute refuses to save or deploy it (findings 2767, 3077, 3078,
// 3097, 3101), so the draft holds Deploy with the refusal deploy gives first and names it in the
// Configuration step, as for a plugin secret input (findings 3086, 3093). Following the refusal's
// step saves, and the draft is ready again: the include is written out, and the variant's
// settings move into codex instead of being renamed onto a duplicate key (finding 3087).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A stored include, key variant, sandbox or plugin list item holds Deploy at ${viewport.width}px`, async (t) => {
    const [sandboxMode] = OPENCLAW_SANDBOX_SETTINGS;
    assert.ok(sandboxMode);
    const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
    const fixture = await createConsoleAppFixture(t, { configurationDriver });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Stored rules", { ready: true });
    const values = adminConfiguration(nativeAdminValues("stored-rules", "http://127.0.0.1:18789"));
    const codex = { config: { appServer: { approvalPolicy: "on-request" } } };
    const withEntries = (entries: Record<string, unknown>) => ({
      ...structuredClone(values),
      plugins: { entries: { ...values.plugins.entries, ...entries } },
    });
    for (const { name, stored, reason, step, fixed } of [
      {
        name: "Include",
        stored: {
          ...structuredClone(values),
          agents: {
            ...values.agents,
            defaults: { ...values.agents.defaults, $include: "./d.json" },
          },
        },
        reason: configIncludeRefusal("agents.defaults.$include"),
        step: "Remove the $include setting",
        fixed: values,
      },
      {
        name: "Entry key",
        stored: withEntries({ codex, Codex: { enabled: true } }),
        reason: pluginEntryKeyVariantRefusal("plugins.entries.Codex", "codex"),
        step: "Fix the plugin entry key",
        fixed: withEntries({ codex: { enabled: true, ...codex } }),
      },
      // Deploy checks OpenClaw's sandbox before the entry key, so the page names the sandbox
      // too, not the later entry key problem (finding 3093).
      {
        name: "Sandbox",
        stored: {
          ...withEntries({ codex, Codex: { enabled: true } }),
          agents: {
            ...values.agents,
            defaults: { ...values.agents.defaults, sandbox: { mode: "all" } },
          },
        },
        reason: openClawSandboxRefusal(sandboxMode, sandboxMode.path),
        step: "Turn off OpenClaw's sandbox",
        fixed: values,
      },
      // A model provider key spelling is the only problem: deploy refuses it after the other
      // stored-row rules, so the page holds Deploy instead of showing Ready to deploy (3093).
      {
        name: "Provider key",
        stored: {
          ...structuredClone(values),
          models: { providers: { OpenAI: { baseUrl: "https://models.example/v1" } } },
        },
        reason: providerKeyVariantRefusal("models.providers.OpenAI", "openai"),
        step: "Fix the model provider key",
        fixed: values,
      },
      // A plugins.deny item that is not text is the only problem: deploy refuses it last of the
      // stored-row rules, so the page holds Deploy instead of showing Ready to deploy (3102).
      {
        name: "Plugin list",
        stored: {
          ...structuredClone(values),
          plugins: { ...values.plugins, deny: ["discord", 7] },
        },
        reason: pluginPolicyListRefusal("deny"),
        step: "Fix the plugin allow or deny list",
        fixed: values,
      },
    ]) {
      const agent = await fixture.createAgent(namespace.id, `${name} Agent`, values);
      // The row as a release before the save rule stored it.
      await storeRefusedConfiguration(fixture, configurationDriver, agent, stored, reason);

      const { page } = await newPage(t, fixture, { context: { viewport } });
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = draftActions(page);
      await expectDeployHeld(card, reason, `${step} · Configuration `, name);
      // Deploy admission refuses the stored row with the text the page shows.
      await expectDeployRefused(fixture, agent, reason);

      // The step, followed in the editor, saves and the draft is ready.
      await saveConfigurationUntilReady(page, card, fixed);
      await expectNoHorizontalScroll(page);
    }
  });
}

// Only Kubernetes Compute refuses another spelling of file-transfer or a managed plugin key
// (finding 3077): OpenClaw merges it into the entry Kubernetes Compute enables for the workspace
// node. The page does not know the Compute, so it asks Create Agent's preflight, which runs the
// Installation's Compute rules. On Kubernetes a row an older release saved with File-Transfer
// holds Deploy with deploy's refusal and the Configuration step, and following the step makes the
// draft ready (finding 3090). On SSH Compute, which saves and deploys the key, nothing is held.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A plugin entry key only Kubernetes Compute refuses holds Deploy there at ${viewport.width}px`, async (t) => {
    const variant = { "File-Transfer": { enabled: true } };
    const reason = pluginEntryKeyVariantRefusal("plugins.entries.File-Transfer", "file-transfer");
    await t.test("Kubernetes Compute", async (t) => {
      const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
      const fixture = await createConsoleAppFixture(t, { configurationDriver });
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("Kubernetes entry key", { ready: true });
      const values = adminConfiguration(
        nativeAdminValues("kubernetes-entry-key", "http://127.0.0.1:18789"),
      );
      const stored = {
        ...structuredClone(values),
        plugins: { ...values.plugins, entries: { ...values.plugins.entries, ...variant } },
      };
      const agent = await fixture.createAgent(namespace.id, "Kubernetes entry key", values);
      // The row as a release before the save rule stored it.
      await storeRefusedConfiguration(fixture, configurationDriver, agent, stored, reason);

      const { page } = await newPage(t, fixture, { context: { viewport } });
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = draftActions(page);
      await expectDeployHeld(card, reason, "Fix the plugin entry key · ");
      // Deploy admission refuses the stored row with the text the page shows.
      await expectDeployRefused(fixture, agent, reason);

      // The step, followed in the editor, saves and the draft is ready.
      await saveConfigurationUntilReady(page, card, values);
      await expectNoHorizontalScroll(page);
    });

    await t.test("SSH Compute", async (t) => {
      const { fixture, namespace } = await createRuntimeAuthFixture(t, "SSH entry key");
      const values = nativeValues("ssh-entry-key");
      const agent = await fixture.createAgent(namespace.id, "SSH entry key", values, {
        harnessAuth: { method: "runtime" },
      });
      // SSH Compute saves the key: OpenClaw merges it, and no SSH rule reads that entry.
      const saved = await fixture.request(
        "PATCH",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        {
          body: {
            values: {
              ...structuredClone(values),
              plugins: {
                ...values.plugins,
                entries: { ...asObject(values.plugins?.entries ?? {}), ...variant },
              },
            },
          },
        },
      );
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const { page } = await newPage(t, fixture, { context: { viewport } });
      // The page asks the preflight, and SSH Compute admits the Configuration.
      const preflight = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/namespaces/${namespace.id}/agents/validate`),
      );
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      assert.equal((await preflight).status(), 204);
      const card = page.locator(".agent-draft-actions");
      const deploy = card.getByRole("button", { name: "Deploy new version", exact: true });
      await card.getByText("Configured on the runtime host", { exact: false }).waitFor();
      await waitForEnabled(deploy);
      assert.equal(await card.getByText(reason, { exact: true }).count(), 0);
      assert.match(
        text(await card.getByRole("listitem").first().locator(".checklist-detail").textContent()),
        /^Saved · Configuration /,
      );
    });
  });
}

// The preflight above needs Agent create. A member who may deploy but not create Agents here
// sends none, so the API audits no refused preflight on every load and save of such a draft
// (finding 3094). Nothing is held: Deploy gives Kubernetes Compute's refusal, as before #4353.
test("A member without Agent create sends no Compute preflight for a plugin entry key", async (t) => {
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, { configurationDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Entry key member", { ready: true });
  const values = adminConfiguration(
    nativeAdminValues("entry-key-member", "http://127.0.0.1:18789"),
  );
  const agent = await fixture.createAgent(namespace.id, "Entry key member", values);
  // The row as a release before the Kubernetes save rule stored it.
  await configurationDriver.update({
    ...configurationDriver.stored({ namespaceId: namespace.id, id: agent.configurationId }),
    values: {
      ...structuredClone(values),
      plugins: {
        ...values.plugins,
        entries: { ...values.plugins.entries, "File-Transfer": { enabled: true } },
      },
    },
  });
  const member = await fixture.createNamespaceMember(
    "entry-key-member",
    namespace.id,
    memberWriteWithout(["create", "agent"]),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    member.credentials,
  );
  const card = page.locator(".agent-draft-actions");
  await card.getByText("Ready to deploy.", { exact: true }).waitFor();
  await waitForEnabled(card.getByRole("button", { name: "Deploy new version", exact: true }));
  const reason = pluginEntryKeyVariantRefusal("plugins.entries.File-Transfer", "file-transfer");
  assert.equal(await card.getByText(reason, { exact: true }).count(), 0);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`),
    [],
  );
  assert.deepEqual(authorizationDenials(fixture.auditSink, "openclaw.agents.validate"), []);
});

// Every Dedicated Codex Gateway runs the codex plugin, and only Kubernetes Compute refuses a
// plugins setting that turns it off (finding 3096). A Dedicated Codex row stored with
// plugins.enabled false holds Deploy with deploy's refusal and a step, through the same Compute
// preflight as the entry keys above, and following the step makes the draft ready (finding 3105).
// The same row on an OpenClaw Agent sends no preflight and shows no codex refusal.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A Dedicated Codex row that turns off the codex plugin holds Deploy at ${viewport.width}px`, async (t) => {
    const reason = codexPluginRefusal("plugins.enabled", "must not be false", "Remove it");
    const pluginsOff = (values: { plugins: Record<string, unknown> }) => ({
      ...structuredClone(values),
      plugins: { ...values.plugins, enabled: false },
    });
    await t.test("Dedicated Codex", async (t) => {
      const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
      const fixture = await createConsoleAppFixture(t, { configurationDriver });
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("Codex plugin off", { ready: true });
      const values = nativeValues("codex-plugin-off", { harnessId: "codex" });
      const agent = await fixture.createAgent(namespace.id, "Codex plugin off", values, {
        executionMode: "dedicated",
      });
      // The row as a release before the save rule stored it.
      await storeRefusedConfiguration(
        fixture,
        configurationDriver,
        agent,
        pluginsOff(values),
        reason,
      );

      const { page } = await newPage(t, fixture, { context: { viewport } });
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = draftActions(page);
      await expectDeployHeld(card, reason, "Let the codex plugin run · ");
      // Deploy admission refuses the stored row with the text the page shows.
      await expectDeployRefused(fixture, agent, reason);

      // The step, followed in the editor, saves and the draft is ready.
      await saveConfigurationUntilReady(page, card, values);
      await expectNoHorizontalScroll(page);
    });

    await t.test("OpenClaw Agent", async (t) => {
      const fixture = await createConsoleAppFixture(t);
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("OpenClaw plugins off", { ready: true });
      const values = adminConfiguration(
        nativeAdminValues("openclaw-plugins-off", "http://127.0.0.1:18789"),
      );
      const agent = await fixture.createAgent(namespace.id, "OpenClaw plugins off", values);
      // No codex rule applies to an OpenClaw Agent, so Kubernetes Compute saves the row.
      const saved = await fixture.request(
        "PATCH",
        `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        { body: { values: pluginsOff(values) } },
      );
      assert.equal(saved.status, 200, JSON.stringify(saved.body));

      const { page } = await newPage(t, fixture, { context: { viewport } });
      const requests = apiRequests(page, fixture.origin);
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = page.locator(".agent-draft-actions");
      await card.getByText("Ready to deploy.", { exact: true }).waitFor();
      await waitForEnabled(card.getByRole("button", { name: "Deploy new version", exact: true }));
      assert.equal(await card.getByText(reason, { exact: true }).count(), 0);
      assert.deepEqual(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`),
        [],
      );
    });
  });
}

// Every Kubernetes topology refuses a trusted-proxy allowlist without the machine identity
// (finding 3032), and only Kubernetes Compute reads it. A row an older release saved with one
// holds Deploy with deploy's refusal and the Gateway authentication step, through the same Compute
// preflight as the plugin entry keys above, and following the step makes the draft ready (finding
// 3121). A valid allowlist sends no preflight and leaves the draft ready.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`A stored trusted-proxy allowlist Kubernetes Compute refuses holds Deploy at ${viewport.width}px`, async (t) => {
    const withAllowUsers = (values: AdminConfiguration, allowUsers: string[]) => ({
      ...structuredClone(values),
      gateway: {
        ...values.gateway,
        auth: {
          ...values.gateway.auth,
          trustedProxy: { ...values.gateway.auth.trustedProxy, allowUsers },
        },
      },
    });
    await t.test("Allowlist without the machine identity", async (t) => {
      const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
      const fixture = await createConsoleAppFixture(t, { configurationDriver });
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("Trusted proxy allowlist", { ready: true });
      const values = adminConfiguration(
        nativeAdminValues("trusted-proxy-allowlist", "http://127.0.0.1:18789"),
      );
      const stored = withAllowUsers(values, ["oidc:member-01"]);
      const agent = await fixture.createAgent(namespace.id, "Trusted proxy allowlist", values);
      // The row as a release before the save rule stored it.
      await storeRefusedConfiguration(
        fixture,
        configurationDriver,
        agent,
        stored,
        KUBERNETES_ALLOW_USERS_REFUSAL,
      );

      const { page } = await newPage(t, fixture, { context: { viewport } });
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = draftActions(page);
      await expectDeployHeld(
        card,
        KUBERNETES_ALLOW_USERS_REFUSAL,
        "Fix the Gateway authentication · ",
      );
      // Deploy admission refuses the stored row with the text the page shows.
      await expectDeployRefused(fixture, agent, KUBERNETES_ALLOW_USERS_REFUSAL);

      // The step, followed in the editor, saves and the draft is ready.
      await saveConfigurationUntilReady(page, card, values);
      await expectNoHorizontalScroll(page);
    });

    await t.test("Valid allowlist", async (t) => {
      const fixture = await createConsoleAppFixture(t);
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("Valid proxy allowlist", { ready: true });
      // The native admin opt-in's allowlist holds only the machine identity.
      const values = adminConfiguration(
        nativeAdminValues("valid-proxy-allowlist", "http://127.0.0.1:18789"),
      );
      const agent = await fixture.createAgent(namespace.id, "Valid proxy allowlist", values);

      const { page } = await newPage(t, fixture, { context: { viewport } });
      const requests = apiRequests(page, fixture.origin);
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      );
      const card = page.locator(".agent-draft-actions");
      await card.getByText("Ready to deploy.", { exact: true }).waitFor();
      await waitForEnabled(card.getByRole("button", { name: "Deploy new version", exact: true }));
      assert.equal(
        await card.getByText(KUBERNETES_ALLOW_USERS_REFUSAL, { exact: true }).count(),
        0,
      );
      assert.deepEqual(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`),
        [],
      );
    });
  });
}

// The default env alias is a configured env provider whose allowlist leaves out the generated
// password, so OpenClaw cannot read the reference Enable gateway password access would write and
// save refuses it: the page states why and offers no button until the allowlist serves it.
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`An allowlist that omits the generated gateway password holds the button at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Allowlist", { ready: true });
    const base = adminConfiguration(nativeAdminValues("allowlist", "http://127.0.0.1:18789"));
    const secrets = (allowlist: string[]) => ({
      defaults: { env: "vault" },
      providers: { vault: { source: "env", allowlist } },
    });
    const values = { ...structuredClone(base), secrets: secrets(["OTHER_SECRET"]) };
    const agent = await fixture.createAgent(namespace.id, "Allowlist Agent", values);
    const generated = { source: "env", provider: "vault", id: "OPENCLAW_GATEWAY_PASSWORD" };
    const requirement =
      "references OPENCLAW_GATEWAY_PASSWORD, which secrets.providers.vault.allowlist omits: add it to that allowlist";
    // Save refuses the reference the button would write, with the reason the page shows.
    const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
    const withPassword = structuredClone(values);
    withPassword.gateway.auth = { ...withPassword.gateway.auth, password: generated };
    const refusedSave = await fixture.request("PATCH", configurationPath, {
      body: { values: withPassword },
    });
    assert.equal(refusedSave.status, 400, JSON.stringify(refusedSave.body));
    assert.equal(
      asObject(asObject(refusedSave.body).error).message,
      unreadableGatewayPasswordRefusal("allowlist", "OPENCLAW_GATEWAY_PASSWORD", "vault"),
    );

    const { page } = await newPage(t, fixture, { context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    );
    await page
      .getByText(
        `The generated gateway password reference {source: "env", provider: "vault", id: "OPENCLAW_GATEWAY_PASSWORD"} ${requirement}. Edit Configuration to fix it before you enable gateway password access.`,
        { exact: true },
      )
      .waitFor();
    const enable = page.getByRole("button", {
      name: "Enable gateway password access",
      exact: true,
    });
    assert.equal(await enable.count(), 0);
    await expectNoHorizontalScroll(page);

    // Once the allowlist names the variable, the button returns and writes the reference.
    const edit = page.getByRole("button", { name: "Edit Configuration", exact: true });
    await edit.scrollIntoViewIfNeeded();
    await edit.click();
    const fixed = { ...structuredClone(base), secrets: secrets(["OPENCLAW_GATEWAY_PASSWORD"]) };
    await page.getByLabel("Configuration JSON").fill(JSON.stringify(fixed, null, 2));
    await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
    await page
      .getByText(
        "Use generated credentials for direct gateway password access. Enable access, save Configuration, then deploy a new version.",
        { exact: true },
      )
      .waitFor();
    await enable.scrollIntoViewIfNeeded();
    await enable.click();
    assert.deepEqual(
      asObject(
        asObject(
          asObject(JSON.parse(await page.getByLabel("Configuration JSON").inputValue())).gateway,
        ).auth,
      ).password,
      generated,
    );
  });
}

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
  const generationTwo = asObject(
    await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("rev-two")),
  );
  assert.equal(generationTwo.generation, 2);
  const second = await fixture.seedActiveAgentRevision(namespace.id, agent.id, first.revision.id);
  const draft = asObject(
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      nativeValues("draft-current"),
      { secretBindings },
    ),
  );
  assert.equal(draft.generation, 3);
  // The draft is deployable: deployment checks the Agent's grant on every bound Secret, and an
  // administrator's console reads it, Slack or not (finding 3018).
  await fixture.grantAgentSecretOperate(agent, secret.ref);
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
  await page.getByLabel("Viewing version").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "rev-two"|"marker": "draft-current"/, () =>
    waitForIdleFetches(page),
  );

  await versionChooser(page).selectOption(
    await page
      .locator("#revision-selector option")
      .filter({ hasText: /^v2(?: ·|$)/ })
      .getAttribute("value"),
  );
  await page.waitForURL((url) => url.searchParams.get("revision") === second.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-two"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "draft-current"/, () =>
    waitForIdleFetches(page),
  );
  assertRevisionUrl(page, second.revision.id);

  await versionChooser(page).selectOption(
    await page
      .locator("#revision-selector option")
      .filter({ hasText: /^v1(?: ·|$)/ })
      .getAttribute("value"),
  );
  await page.waitForURL((url) => url.searchParams.get("revision") === first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  assertRevisionUrl(page, first.revision.id);

  await page.getByRole("button", { name: "Open draft" }).last().click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-current"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/, () =>
    waitForIdleFetches(page),
  );
  assertRevisionUrl(page, "draft");

  const deploy = page.getByRole("button", { name: "Deploy new version" });
  assert.equal(await deploy.isEnabled(), true);
  const savingMode = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    {
      method: "PATCH",
      once: true,
    },
  );
  // The hint says what managed mode keeps, the tool allowlist included (finding 2690).
  await page
    .getByText(
      "Managed mode keeps the Gateway configuration, including its tool allowlist, as OCE deployed it, and blocks Gateway-local terminals and Gateway-hosted command jobs. With it off, Gateway administrators can change the configuration and widen the tool allowlist until a deployment with managed mode on restores it. Deploy a new version to apply a change.",
      { exact: true },
    )
    .waitFor();
  // An administrator gets the control, not the note for callers who cannot change it.
  assert.equal(
    await page
      .getByText("Only an Installation administrator can change Gateway managed mode.", {
        exact: true,
      })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Turn off managed mode for next deployment" }).click();
  await savingMode.requested;
  assert.equal(await deploy.isDisabled(), true);
  savingMode.release();
  await page.getByRole("button", { name: "Turn on managed mode for next deployment" }).waitFor();

  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  const editor = page.getByLabel("Configuration JSON");
  assert.match(await editor.inputValue(), /"marker": "draft-current"/);
  const editorError = page.locator("#configuration-json-error");
  for (const [invalidJson, message] of [
    ["{ invalid", "Invalid JSON at line 1, column 3. Enter a valid JSON object."],
    ["[]", "Enter a valid JSON object, not an array or a single value."],
  ] as const) {
    await editor.fill(invalidJson);
    await page.getByRole("button", { name: "Save Configuration" }).click();
    // One persistent message under the editor, linked to it; no browser bubble (finding 1903).
    await editorError.getByText(message, { exact: true }).waitFor();
    assert.equal(await editor.getAttribute("aria-invalid"), "true");
    assert.match(
      text(await editor.getAttribute("aria-describedby")),
      /\bconfiguration-json-error\b/,
    );
    assert.equal(
      await editor.evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement)) {
          throw new Error("Expected Configuration textarea");
        }
        return node.validationMessage;
      }),
      "",
    );
    assert.equal(
      await page.evaluate(() => globalThis.document.activeElement?.id),
      "configuration-json",
    );
  }
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await editor.fill(JSON.stringify(nativeValues("stale-client"), null, 2));
  assert.equal(await editorError.isHidden(), true);
  assert.equal(await editor.getAttribute("aria-invalid"), null);
  const stale = asObject(
    await fixture.updateConfiguration(
      namespace.id,
      agent.configurationId,
      nativeValues("stale-server"),
    ),
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
  await page.getByLabel("Viewing version").selectOption(second.revision.id);
  const requestedMode = page.locator(".configuration-summary dt", {
    hasText: "Requested Gateway managed mode",
  });
  assert.equal(await requestedMode.locator("xpath=following-sibling::dd[1]").textContent(), "On");
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
  assert.equal(asObject(currentConfiguration.data).generation, 5);
  assert.deepEqual(asObject(currentConfiguration.data).values, editedValues);
  assert.deepEqual(asObject(currentConfiguration.data).secretBindings, secretBindings);

  await page.getByLabel("Viewing version").selectOption(first.revision.id);
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
  assert.equal(asObject(current.data).harnessAuth, null);
  await page.getByLabel("Viewing version").selectOption(first.revision.id);
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

  // Saving an Agent setting preserves both an unsaved editor and a concurrent reassignment.
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const unsaved = JSON.stringify(nativeValues("unsaved"));
  await editor.fill(unsaved);
  const reassigned = await fixture.createConfiguration(namespace.id, nativeValues("reassigned"));
  await fixture.updateAgent(namespace.id, agent.id, { configurationId: reassigned.id });
  await page.getByRole("button", { name: "Turn on managed mode for next deployment" }).click();
  await page.getByRole("button", { name: "Turn off managed mode for next deployment" }).waitFor();
  assert.equal(await editor.inputValue(), unsaved);
  const savedAgent = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(asObject(savedAgent.data).gatewayManagedMode, true);
  assert.equal(asObject(savedAgent.data).configurationId, reassigned.id);
});

test("Agent detail saves plugin changes for the next revision without changing admitted revisions", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  assert.ok(fixture.controller instanceof OpenClawController);
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
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => {
      const upstream = new URL(input instanceof Request ? input.url : input);
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
    },
  );
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
  const searched = page.waitForResponse((response) => {
    if (
      response.url() !== `${fixture.origin}${pluginListPath}` ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return isObject(body) && body.q === "calendar";
  });
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
  const removeCalendar = dialog.getByRole("button", { name: "Remove Calendar", exact: true });
  assert.equal(await removeCalendar.isVisible(), false);
  await dialog.getByRole("button", { name: "More actions", exact: true }).click();
  await removeCalendar.click();
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
    async (route: Route) => {
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
  assert.deepEqual(asObject(beforeRetry.data).plugins, originalPlugins);

  const saveResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await saveResponse).status(), 200);
  assert.deepEqual(
    pathRequests(requests, "PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`).map(
      ({ body }) => asObject(body).plugins,
    ),
    [editedPlugins, editedPlugins, editedPlugins],
  );
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(asObject(saved.data).plugins, editedPlugins);

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
  assert.equal(list(revisions.data).length, 2);
  // The list carries summaries; each revision's plugin snapshot is on its exact read.
  const pluginSnapshot = async (id: string) => {
    const plugins = asObject(
      (
        await fixture.request(
          "GET",
          `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${encodeURIComponent(id)}`,
        )
      ).data,
    ).plugins;
    return plugins == null ? undefined : asObject(plugins).plugins;
  };
  assert.deepEqual(await pluginSnapshot(first.revision.id), originalPlugins);
  assert.deepEqual(
    await pluginSnapshot(
      text(
        asObject(list(revisions.data).find((value) => asObject(value).id !== first.revision.id)).id,
      ),
    ),
    editedPlugins,
  );

  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(text(await page.locator("pre").textContent())), editedPlugins);
  await page.getByLabel("Viewing version").selectOption(first.revision.id);
  await page.waitForURL((current) => current.searchParams.get("revision") === first.revision.id);
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("heading", { name: "Plugin selections snapshot" }).waitFor();
  assert.deepEqual(JSON.parse(text(await page.locator("pre").textContent())), originalPlugins);
  assert.equal(await page.getByRole("button", { name: "Save plugin selections" }).count(), 0);
});

// A plugin save rebuilds the page. Rebuilding from the Agent the draft loaded, instead of the save
// response, showed a Stop requested on the same page as running again. A deployment that finished
// since page load takes the same path; this case covers Stop.
test("Plugin save keeps a Stop requested on the same page", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Plugin save after stop");
  const pluginDriver = new CodexPluginDriver();
  assert.ok(fixture.controller instanceof OpenClawController);
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const agent = await fixture.createAgent(namespace.id, "Stopped Plugins", nativeValues("stop"), {
    harnessAuth: { method: "runtime" },
  });
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration").href,
  );
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

  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  const plugins = { "codex-plugin:linear@openai-curated-remote": { enabled: false } };
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page.getByLabel("Plugin selections JSON", { exact: true }).fill(JSON.stringify(plugins));
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Plugin selections saved." }).waitFor();
  // The save rereads permissions and the draft, then rebuilds the tab.
  await waitForIdleFetches(page);

  const saved = asObject((await fixture.request("GET", path)).data);
  assert.deepEqual(saved.plugins, plugins);
  assert.equal(saved.desiredRuntimeState, "stopped");
  assert.equal(saved.activeRevisionId, active.revision.id);
  // The rebuilt page still shows the stop request instead of offering a first Stop again.
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
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
    const entries: [CatalogEntry, CatalogEntry] = [
      {
        id: "calendar",
        name: "Calendar",
        tools: [{ id: "read", name: "Read events", ownerId: "calendar" }],
      },
      {
        id: "documents",
        name: "Documents",
        tools: [{ id: "read", name: "Read documents", ownerId: "documents" }],
      },
    ];
    const catalog: PluginScopeFixture["catalog"] = {
      status: "ready",
      canLoad: true,
      entries,
      knownEntries: entries,
    };
    const loads: Parameters<NonNullable<PluginFieldsOptions["onLoadPlugins"]>>[] = [];
    let cancellations = 0;
    const options: PluginFieldsOptions = {
      input,
      catalog,
      onLoadPlugins: (...args: Parameters<NonNullable<PluginFieldsOptions["onLoadPlugins"]>>) =>
        loads.push(args),
      onCancelDiscovery: () => {
        cancellations += 1;
      },
    };
    const fields = createPluginFields(options);
    fields.section.id = "scope-plugin-picker";
    globalThis.document.body.append(fields.section);
    globalThis.window.pluginScopeFixture = {
      fields,
      catalog,
      loads,
      cancellations: () => cancellations,
    };
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
    const fixture = globalThis.window.pluginScopeFixture;
    if (!fixture) {
      throw new Error("Missing plugin scope fixture");
    }
    const { fields, catalog } = fixture;
    fields.setCatalog({ ...catalog, entries: [catalog.entries[1]] });
  });
  await dialog.getByRole("button", { name: "Available plugins", exact: true }).click();
  assert.equal(await dialog.getByRole("heading", { name: "Calendar", exact: true }).count(), 0);
  assert.equal(await dialog.getByRole("searchbox", { name: "Filter tools" }).count(), 0);
  await dialog.getByRole("searchbox", { name: "Search plugins" }).fill("new query");
  assert.deepEqual(
    await page.evaluate(() => {
      const fixture = globalThis.window.pluginScopeFixture;
      if (!fixture) {
        throw new Error("Missing plugin loads");
      }
      return fixture.loads;
    }),
    [["search", "new query"]],
  );
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Filter tools" }).inputValue(),
    "documents",
  );
  assert.equal(
    await dialog.getByRole("searchbox", { name: "Filter configured plugins" }).inputValue(),
    "documents",
  );
  assert.equal(
    await page.evaluate(() => {
      const fixture = globalThis.window.pluginScopeFixture;
      if (!fixture) {
        throw new Error("Missing cancellation counter");
      }
      return fixture.cancellations();
    }),
    2,
  );
  await page.evaluate(() => {
    const fixture = globalThis.window.pluginScopeFixture;
    if (!fixture) {
      throw new Error("Missing plugin fields");
    }
    return fixture.fields.resetSearch();
  });
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
  assert.ok(fixture.controller instanceof OpenClawController);
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
  assert.ok(fixture.controller instanceof OpenClawController);
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("API-key plugins", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "API-key plugin Agent",
    nativeValues("api-key-plugins", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  assert.ok(agent.harnessAuth);
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
  const unavailable = "Plugin browsing is unavailable with API-key authentication.";
  await dialog.getByText(unavailable).waitFor();
  // Load plugins and the pager are disabled for the reason that line gives, each is described
  // by it (finding D796), and Tab still reaches each (finding 2899).
  for (const name of ["Load plugins", "Previous page", "Next page"]) {
    const control = dialog.getByRole("button", { name, exact: true });
    assert.equal(await control.isDisabled(), true, name);
    await expectReachableReason(page, control, unavailable);
  }
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

test("Agent draft plugin browsing names the Plugin Driver, not API-key auth, under occ-plugin", async (t) => {
  // Finding 2791: only the Codex Plugin Driver's catalog depends on Codex auth. Under the OCC
  // Plugin Driver an API-key Codex Agent has no catalog because of the Driver.
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new OCCPluginDriver();
  assert.ok(fixture.controller instanceof OpenClawController);
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("OCC plugins on Codex", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "API-key Codex Agent",
    nativeValues("occ-plugins-codex", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  assert.ok(agent.harnessAuth);
  assert.equal(agent.harnessAuth.method, "api_key");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "plugins");
  await login(page, fixture, url);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog
    .getByText(
      "The selected Plugin Driver does not offer a catalog for this harness and execution mode. You can still edit existing plugin selections.",
    )
    .waitFor();
  assert.equal(
    await dialog.getByText("Plugin browsing is unavailable with API-key authentication.").count(),
    0,
  );
  assert.equal(await dialog.getByRole("button", { name: "Load plugins" }).isDisabled(), true);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/plugins`).length,
    0,
  );
});

test("Agent draft browses the curated catalog without a saved Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  assert.ok(fixture.controller instanceof OpenClawController);
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
  const searched = page.waitForResponse((response) => {
    if (response.url() !== `${fixture.origin}${catalogPath}`) {
      return false;
    }
    const body: unknown = response.request().postDataJSON();
    return isObject(body) && body.q === "linear";
  });
  await dialog.getByLabel("Search plugins", { exact: true }).fill("linear");
  assert.equal((await searched).status(), 200);
  await dialog.locator('.plugin-list[aria-busy="false"]').waitFor();
  assert.deepEqual(
    await dialog
      .locator(".plugin-list-item")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
    ["Linear"],
  );
  const searchRequest = pathRequests(requests, "POST", catalogPath).at(-1);
  assert.ok(searchRequest);
  assert.deepEqual(searchRequest.body, { q: "linear" });
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
  assert.ok(fixture.controller instanceof OpenClawController);
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

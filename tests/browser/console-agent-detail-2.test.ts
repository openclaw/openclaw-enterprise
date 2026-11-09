import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Locator } from "playwright";
import { Check } from "typebox/value";

import {
  AgentCallerPermissionsResponse,
  AgentListResponse,
  AgentReadResponse,
  IAMAccessBindingListResponse,
  IAMAccessBindingResponse,
  IAMRoleResponse,
  NamespaceListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createFixtureResponse } from "../helpers/console-fixture-response.ts";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";

import { fileConsoleApp } from "../helpers/console-app.mjs";
import { createNativeConsoleFixture, nativeBrowserSupported } from "./console-native-ingress.ts";

import {
  apiRequests,
  detailUrl,
  deploymentStatusResponse,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  waitForCondition,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
} from "./console-deployment-activity-helpers.ts";

import {
  expectNativeAdminHidden,
  expectNativeAdminUnavailable,
  assertRevisionUrl,
  nativeAdminComputeDriver,
  nativeAdminValues,
} from "./console-agents-test-support.ts";
import { STOP_REQUESTED, VERSION_READ_DENIED_HEADING } from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";
import {
  registerDeletionAndNavigationCases,
  registerSettingsRefocusAndTabsCases,
  registerSharingCredentialsAndChannelsCases,
} from "./console-agent-detail-cases.mts";

function assertRecord(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${description} must be an object`,
  );
}

// The Console Browser lane runs the two Agent detail test files in parallel.

// Tests that need no app of their own share one (fileConsoleApp); each makes its own Namespace.
// Tests that open an Agent link without a Namespace (which reads every Namespace), expire every
// session, register a Driver, use the bootstrap result, or pass fixture options keep an app of
// their own.
const detailApp = fileConsoleApp();

// Keep registration order around the native admin cases.
registerDeletionAndNavigationCases(detailApp);

test("Agent detail opens native admin UI only after real API access checks pass", async (t) => {
  if (!nativeBrowserSupported(t)) {
    return;
  }
  const disabledFixture = await detailApp(t);
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

  await login(disabledPage, disabledFixture, disabledDetail);
  await disabledPage.getByRole("heading", { name: "Disabled native admin Agent" }).waitFor();
  await expectNativeAdminHidden(disabledPage);

  const gatewayEndpoint =
    "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent";
  const {
    fixture,
    nativePage,
    browserOptions,
    consoleHost,
    nativeDomain,
    cookieDomain,
    untrustedBrowserOptions,
  } = await createNativeConsoleFixture(
    t,
    {
      nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
      agentGatewayManagedMode: false,
      computeDriver: nativeAdminComputeDriver(gatewayEndpoint),
    },
    { serveAgentPage: true },
  );
  assert.ok(nativePage);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin access", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    nativeValues("unsupported-ui"),
  );
  const nativeProbe = `https://probe.${nativeDomain}/`;
  const untrusted = await newPage(t, fixture, untrustedBrowserOptions);
  await assert.rejects(untrusted.page.goto(nativeProbe), /ERR_CERT_AUTHORITY_INVALID/);
  await untrusted.page.close();
  let { page } = await newPage(t, fixture, browserOptions);
  const wrongHost = await page.context().newPage();
  await assert.rejects(
    wrongHost.goto(`https://wrong.${cookieDomain}/`),
    /ERR_CERT_COMMON_NAME_INVALID/,
  );
  await wrongHost.close();
  assert.equal(nativePage.requests.length, 0, "TLS rejections must precede the Agent HTTP handler");
  const response = await page.goto(nativeProbe);
  assert.equal(response?.status(), 200);
  assert.ok(
    await response?.securityDetails(),
    "the Agent wildcard must complete a real TLS handshake",
  );
  assert.deepEqual(nativePage.requests, [{ host: `probe.${nativeDomain}`, cookie: "" }]);
  let requests = apiRequests(page, fixture.origin);
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
  await login(page, fixture, draftDetail);
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
  await expectNativeAdminUnavailable(page, "Start this Agent before opening its native admin UI.");

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
      "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
    )
    .waitFor({ timeout: 5_000 });
  await expectNativeAdminUnavailable(
    page,
    "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
  );

  let active = { revision: pending };
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  const historicalRevisionId = active.revision.id;
  const initialNativeAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initialNativeAccess.status, 200);
  const initialAccess: unknown = initialNativeAccess.data;
  assertRecord(initialAccess, "Initial native admin access");
  assert.equal(initialAccess.status, "unsupported");
  assert.ok(typeof initialAccess.origin === "string", "Native admin origin must be a string");
  assert.equal(new URL(initialAccess.origin).protocol, "https:");
  const detail = () =>
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await page.goto(detail().href);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.locator(".native-admin-access").waitFor();
  await page
    .getByText(
      "Native admin UI is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.",
    )
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );

  restrict(fixture.policy, "administer", "agent", {
    namespaceId: namespace.id,
    resourceId: agent.id,
  });
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await expectNativeAdminHidden(page);
  fixture.policy.restrictions.length = 0;
  // The audited denial is settled for this tab; a new tab in the same session asks afresh.
  const deniedTabWrites = nonAuthWriteRequests(requests);
  const browserContext = page.context();
  await page.close();
  page = await browserContext.newPage();
  requests = apiRequests(page, fixture.origin);
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.locator(".native-admin-access").waitFor();

  const stopped = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/stop`,
  );
  assert.equal(stopped.status, 202);
  // Reproduce the state after the worker clears the revision, while this historical URL remains open.
  const controller: unknown = fixture.controller;
  assert.ok(
    controller instanceof OpenClawController,
    "Bootstrap must create an OpenClawController",
  );
  const cleared = await controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.ok(cleared, "The stopped Agent must have its active revision cleared");
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.locator(".native-admin-access").waitFor();
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );

  const supportedValues: unknown = nativeAdminValues("supported-ui", initialAccess.origin);
  assertRecord(supportedValues, "Native admin Configuration values");
  await fixture.updateConfiguration(namespace.id, agent.configurationId, supportedValues);
  active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(detail().href);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("link", { name: "Open Agent UI" }).waitFor();
  const expectedAccess = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(expectedAccess.status, 200);
  const access: unknown = expectedAccess.data;
  assertRecord(access, "Available native admin access");
  assert.equal(access.status, "available");
  assert.ok(typeof access.origin === "string", "Native admin origin must be a string");
  assert.ok(typeof access.url === "string", "Native admin URL must be a string");
  assert.equal(access.activeRevisionId, active.revision.id);
  assert.equal(access.bootstrapUrl, undefined);
  assert.equal(new URL(access.url).origin, access.origin);
  assert.match(new URL(access.url).hostname, new RegExp(`\\.${nativeDomain}$`));

  // Viewing an older configuration snapshot must still open the current active gateway.
  await page.getByLabel("Viewing version").selectOption(historicalRevisionId);
  await page.getByRole("link", { name: "Open Agent UI" }).waitFor();
  assertRevisionUrl(page, historicalRevisionId);
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI" }).getAttribute("href"),
    access.url,
  );
  const sharedCookies = await page.context().cookies(access.origin);
  const sessionCookies = sharedCookies.filter((cookie) =>
    cookie.name.endsWith("openclaw_occ_shared.session_token"),
  );
  assert.equal(sessionCookies.length, 1);
  const sessionCookie = sessionCookies[0];
  assert.ok(sessionCookie, "The Agent origin must receive the shared session cookie");
  assert.equal(sessionCookie.domain, `.${cookieDomain}`);
  assert.equal(sessionCookie.httpOnly, true);
  assert.equal(sessionCookie.secure, true);
  assert.equal(sessionCookie.sameSite, "Lax");

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
  const agentCookies = await page.context().cookies(access.origin);
  assert.equal(
    agentCookies.some((cookie) => cookie.value === "legacy-host-only"),
    false,
    "a legacy host-only console cookie must not authenticate the Agent host",
  );

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open Agent UI" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), access.url);
  assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
  assert.equal(await popup.title(), "Native admin UI");
  assert.equal(nativePage.requests.length, 2);
  const nativeRequest = nativePage.requests[1];
  assert.ok(nativeRequest, "The Agent HTTPS handler must receive the popup request");
  assert.equal(nativeRequest.host, new URL(access.url).host);
  const names = nativeRequest.cookie.split("; ").map((pair) => pair.split("=", 1)[0]);
  assert.ok(
    names.includes(sessionCookie.name),
    "the Agent HTTPS handler receives the shared session cookie",
  );
  assert.equal(
    names.includes("openclaw_occ.session_token"),
    false,
    "the host-only cookie stays on the Console",
  );

  assert.deepEqual([...deniedTabWrites, ...nonAuthWriteRequests(requests)], []);
});

test("Agent detail rereads native admin access once when a pending deployment activates, and Refresh access keeps keyboard focus", async (t) => {
  if (!nativeBrowserSupported(t)) {
    return;
  }
  const { fixture, browserOptions } = await createNativeConsoleFixture(t, {
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    agentGatewayManagedMode: false,
    computeDriver: nativeAdminComputeDriver(
      "wss://private-gateway.example.invalid/namespaces/native-admin/agents/agent",
    ),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin follow", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin follow Agent",
    nativeValues("follow-ui"),
  );
  // The first deployment requests running before any version is selected for service.
  const pending = await fixture.deployAgent(namespace.id, agent.id);
  const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const { page } = await newPage(t, fixture, browserOptions);
  const requests = apiRequests(page, fixture.origin);
  // Deployment activity reads a recorded status the worker would write; the native admin
  // reads stay on the real API so the card reflects the Agent's actual active revision.
  let deploymentStatus = "running";
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, pending.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: pending.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: deploymentStatus,
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_native_admin_follow" },
      }),
    }),
  );
  await page.clock.install({ time: new Date("2026-10-03T12:00:00Z") });
  const url = detailUrl(fixture, namespace.id, agent.id, pending.id, "configuration");
  await login(page, fixture, url);
  await page.getByRole("heading", { name: "Native admin follow Agent" }).waitFor();
  const activity = await expectDeploymentOutcome(page, "In progress");
  const card = page.locator(".native-admin-access");
  await card
    .getByText(
      "Native admin UI is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
    )
    .waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 1);

  // The worker records success and selects the version for service while the page stays open.
  await fixture.activateRevision(namespace.id, agent.id, pending.id);
  deploymentStatus = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await expectDeploymentOutcome(page, "Completed", { folded: false });
  await card
    .getByText(
      "Native admin UI is not enabled in this Agent’s current version. Someone who can edit its Configuration can enable it (see the native admin UI guide) and deploy a new version.",
    )
    .waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 2);

  // Access is reread only when the serving version changes: Refresh deployment rereads the
  // unchanged Agent through the same path without asking for native admin access again.
  const agentReads = pathRequests(
    requests,
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}`,
  ).length;
  await page.getByRole("tab", { name: "Deployment", exact: true }).click();
  await activity.getByRole("button", { name: "Refresh deployment" }).click();
  await waitForCondition(
    () =>
      pathRequests(requests, "GET", `/namespaces/${namespace.id}/agents/${agent.id}`).length >
      agentReads,
    "Refresh deployment did not reread the Agent",
  );
  // The button returns from "Refreshing…" only after the reread Agent was applied.
  await activity.getByRole("button", { name: "Refresh deployment", disabled: false }).waitFor();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 2);

  // A keyboard reader who refreshes access keeps focus on the button through the read: a second
  // Enter while it reads sends nothing, and the next Tab continues from the card (issue 3311).
  const reload = card.getByRole("button", { name: "Refresh access" });
  const isFocused = (locator: Locator) =>
    locator.evaluate((node) => node === node.ownerDocument.activeElement);
  const readSettled = async () => {
    await waitForEnabled(reload);
    // Chromium moves focus off a disabled control when it next renders.
    await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
  };
  let held = await holdRequests(t, page, `${fixture.origin}${nativeAdminPath}`, { once: true });
  await reload.focus();
  await page.keyboard.press("Enter");
  await held.requested;
  await page.keyboard.press("Enter");
  held.release();
  await readSettled();
  assert.equal(pathRequests(requests, "GET", nativeAdminPath).length, 3);
  assert.equal(await isFocused(reload), true);

  // Focus the reader moves during a read stays where they put it.
  held = await holdRequests(t, page, `${fixture.origin}${nativeAdminPath}`, { once: true });
  await page.keyboard.press("Enter");
  await held.requested;
  await page.keyboard.press("Tab");
  const next = card.getByRole("link", { name: "Open draft", exact: true });
  assert.equal(await isFocused(next), true);
  held.release();
  await readSettled();
  assert.equal(await isFocused(next), true);
});

registerSettingsRefocusAndTabsCases(detailApp);

test("Agent sharing grants existing people exact discovery and native access, then removes only the selected binding", async (t) => {
  if (!nativeBrowserSupported(t)) {
    return;
  }
  const { fixture, browserOptions } = await createNativeConsoleFixture(t, {
    provisionedPeople: ["shared-person"],
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    agentGatewayManagedMode: false,
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
  });
  await fixture.bootstrap();
  const fixtureResponse = createFixtureResponse(fixture.app.getSchemas());
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
  const nativeAccess: unknown = native.data;
  assertRecord(nativeAccess, "Shared Agent native admin access");
  assert.ok(typeof nativeAccess.origin === "string", "Native admin origin must be a string");
  const sharedValues: unknown = nativeAdminValues("shared", nativeAccess.origin);
  assertRecord(sharedValues, "Shared Agent native admin Configuration values");
  await fixture.updateConfiguration(namespace.id, agent.configurationId, sharedValues);
  const currentAgent = fixtureResponse(
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`),
    200,
    AgentReadResponse,
    "Read shared Agent before revision activation",
  ).data;
  assert.ok(currentAgent.activeRevisionId, "The shared Agent must have an active revision");
  const active = await fixture.seedActiveAgentRevision(
    namespace.id,
    agent.id,
    currentAgent.activeRevisionId,
  );
  const person = fixture.provisionedAccounts[0];
  assert.ok(person, "The shared person must be provisioned");
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
  const misleadingRoleData = fixtureResponse(
    misleadingRole,
    201,
    IAMRoleResponse,
    "Create misleading native administration Role",
  ).data;
  const { page, artifacts } = await newPage(t, fixture, browserOptions);
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-granted.png") });
  const bindings: unknown = await fixture.addedAccessBindings(namespace.id);
  assert.ok(
    Check(IAMAccessBindingListResponse.properties.data, bindings),
    "Shared access bindings must match the Controller contract",
  );
  assert.equal(bindings.length, 2);
  assert.equal(
    bindings.some((binding) => binding.roleId === misleadingRoleData.id),
    false,
  );
  assert.deepEqual(
    bindings
      .map((binding) => {
        assert.ok("resourceKind" in binding, "Shared access bindings must target exact resources");
        return [binding.resourceKind, binding.resourceId];
      })
      .sort(),
    [
      ["agent", agent.id],
      ["namespace", namespace.id],
    ],
  );
  assert.deepEqual(
    fixtureResponse(
      await fixture.request("GET", "/namespaces", { session }),
      200,
      NamespaceListResponse,
      "List Namespaces visible to the recipient",
    ).data.map((item) => item.id),
    [namespace.id],
  );
  assert.deepEqual(
    fixtureResponse(
      await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session }),
      200,
      AgentListResponse,
      "List Agents visible to the recipient",
    ).data.map((item) => item.id),
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
  const recipientAccess: unknown = (
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
      session,
    })
  ).data;
  assertRecord(recipientAccess, "Recipient native admin access");
  assert.equal(recipientAccess.status, "available");

  const recipient = (await newPage(t, fixture, browserOptions)).page;
  const recipientRequests = apiRequests(recipient, fixture.origin);
  await login(recipient, fixture, detail, person.credentials);
  // Agent sharing does not include version read, so the version pane says so.
  await recipient
    .getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true })
    .waitFor();
  // The policy reads are denied, so the sharing card is hidden instead of showing an error.
  await recipient.locator(".agent-access").waitFor({ state: "hidden" });
  assert.equal(
    await recipient
      .getByText("Sharing policy requires Installation administration.", { exact: false })
      .count(),
    0,
  );
  await recipient.getByRole("link", { name: "Open Agent UI" }).waitFor();
  // A non-administrator never reads sharing policy: each denial would be audited. The link to
  // the Access tab opens Configuration, and the strip has no Access tab.
  assert.equal(
    await recipient.getByRole("region", { name: "Share Agent", exact: true }).count(),
    0,
  );
  assert.equal(await recipient.getByRole("tab", { name: "Access" }).count(), 0);
  await recipient.getByRole("tab", { name: "Configuration", selected: true }).waitFor();
  assert.deepEqual(
    recipientRequests.filter((request) => request.path.includes("/iam/")),
    [],
  );
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
  const operateRoleData = fixtureResponse(
    operateRole,
    201,
    IAMRoleResponse,
    "Create Agent operate Role",
  ).data;
  const operateBinding = await fixture.request("POST", `${policyPath}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: person.principal.id,
      roleId: operateRoleData.id,
      resourceKind: "agent",
      resourceId: agent.id,
    },
  });
  const operateBindingData = fixtureResponse(
    operateBinding,
    201,
    IAMAccessBindingResponse,
    "Grant Agent operate permission",
  ).data;
  // Stop was granted independently; reloading obtains the new advice without granting version read.
  const refreshedAdvice = recipient.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}/permissions`),
  );
  await recipient.reload();
  const advice = await refreshedAdvice;
  assert.equal(advice.status(), 200);
  const adviceBody: unknown = await advice.json();
  assert.ok(
    Check(AgentCallerPermissionsResponse, adviceBody),
    "Refreshed Agent permissions must match the Controller contract",
  );
  assert.equal(adviceBody.data.operate, true);
  await recipient
    .getByRole("heading", { name: VERSION_READ_DENIED_HEADING, exact: true })
    .waitFor();
  await recipient.getByRole("button", { name: "Stop Agent", exact: true }).click();
  await recipient
    .getByRole("dialog")
    .getByRole("button", { name: "Stop Agent", exact: true })
    .click();
  await recipient.getByText(STOP_REQUESTED, { exact: true }).waitFor();

  // The stale administrator list holds the specific sharing binding, not the new operate grant.
  await panel.getByRole("button", { name: "Remove binding", exact: true }).click();
  await panel.getByText("Binding removed.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-removed.png") });
  const after: unknown = await fixture.addedAccessBindings(namespace.id);
  assert.ok(
    Check(IAMAccessBindingListResponse.properties.data, after),
    "Remaining access bindings must match the Controller contract",
  );
  const namespaceBinding = bindings.find(
    (binding) => "resourceKind" in binding && binding.resourceKind === "namespace",
  );
  assert.ok(namespaceBinding, "Sharing must retain the Namespace discovery binding");
  assert.deepEqual(
    after.map((binding) => binding.id).sort(),
    [namespaceBinding.id, operateBindingData.id].sort(),
  );
  assert.deepEqual(
    fixtureResponse(
      await fixture.request("GET", "/namespaces", { session }),
      200,
      NamespaceListResponse,
      "List Namespaces visible to the recipient",
    ).data.map((item) => item.id),
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

registerSharingCredentialsAndChannelsCases(detailApp);

test("Deployment activity keeps keyboard focus when refresh discovers a newer version", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Deployment refresh focus", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Deployment refresh Agent",
    nativeValues("v1"),
  );
  const first = await fixture.deployAgent(namespace.id, agent.id);
  const firstUrl = deploymentRecordUrl(fixture, namespace.id, agent.id, first.id);
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 1440, height: 1000 } },
  });
  // This controller fixture admits revisions but has no deployment worker. Supply
  // its supported queued record only for v1; v2's read and all overview calls use the real API.
  const queued = deploymentStatusResponse(first, { status: "queued" });
  await page.route(firstUrl, (route) => route.fulfill(queued));
  await page.clock.install();
  const initial = page.waitForResponse((response) => response.url() === firstUrl);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, first.id, "deployment"));
  const initialResponse = await initial;
  assert.equal(initialResponse.status(), 200);
  assert.deepEqual(await initialResponse.json(), queued.json);
  const activity = await expectDeploymentOutcome(page, "Queued");
  await activity.getByText("Most recent visible deployment · v1", { exact: true }).waitFor();
  // A quiet update should leave a reader's folded evidence and control in place.
  if ((await activity.locator("details[open]").count()) !== 0) {
    await activity.getByText("Deployment details", { exact: true }).click();
  }
  const refresh = activity.getByRole("button", { name: "Refresh deployment", exact: true });
  await refresh.focus();
  const original = await refresh.elementHandle();
  assert.ok(original);
  const geometry = await refresh.boundingBox();
  assert.ok(geometry);
  const retainsOriginalFocus = () =>
    refresh.evaluate(
      (node, previous) => node === previous && node === document.activeElement,
      original,
    );
  const hasRefreshFocus = () => refresh.evaluate((node) => node === document.activeElement);
  const poll = await holdRequests(t, page, firstUrl, {
    once: true,
    method: "GET",
    fulfill: queued,
  });
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await poll.requested;
  assert.equal(await refresh.isEnabled(), true);
  assert.equal(await retainsOriginalFocus(), true);
  assert.deepEqual(await refresh.boundingBox(), geometry);
  await page.keyboard.press("Enter");
  assert.equal(await refresh.getAttribute("aria-disabled"), "true");
  assert.equal(await retainsOriginalFocus(), true);
  assert.deepEqual(await refresh.boundingBox(), geometry);

  // Admit a later revision while the original poll is held. The queued manual refresh
  // rereads the real version list after the poll settles, then reads that exact new record.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("v2"));
  const second = await fixture.deployAgent(namespace.id, agent.id);
  const secondUrl = deploymentRecordUrl(fixture, namespace.id, agent.id, second.id);
  const next = await holdRequests(t, page, secondUrl, {
    once: true,
    method: "GET",
    afterServer: true,
  });
  const pollResponse = page.waitForResponse((response) => response.url() === firstUrl);
  poll.release();
  const completedPoll = await pollResponse;
  assert.equal(completedPoll.status(), 200);
  assert.deepEqual(await completedPoll.json(), queued.json);
  const nextResponse = await next.requested;
  assert.ok(nextResponse);
  assert.equal(nextResponse.status(), 503);
  const failure: unknown = await nextResponse.json();
  assertRecord(failure, "the controller's deployment read response");
  assertRecord(failure.error, "the controller's deployment read error");
  assert.equal(failure.error.code, "DEPENDENCY_UNAVAILABLE");
  await refresh.waitFor({ state: "visible" });
  assert.equal(await refresh.getAttribute("aria-disabled"), "true");
  const focusDuringReplacement = await hasRefreshFocus();
  assert.deepEqual(await refresh.boundingBox(), geometry);
  next.release();
  await activity
    .getByText("Most recent visible deployment · v2", { exact: true })
    .waitFor({ state: "attached" });
  await activity
    .getByRole("alert")
    .getByText("Service unavailable. The read could not be completed. Try again.", { exact: true })
    .waitFor();
  await waitForEnabled(refresh);
  await refresh.click({ trial: true });
  assert.deepEqual(await refresh.boundingBox(), geometry);
  const focusAfterReplacement = await hasRefreshFocus();
  assert.equal(
    focusDuringReplacement,
    true,
    "the focused Refresh deployment control survives panel replacement",
  );
  assert.equal(
    focusAfterReplacement,
    true,
    "Refresh deployment keeps focus after the newer record appears",
  );
});

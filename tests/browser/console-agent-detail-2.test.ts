import { deriveNativeAdminHost } from "../../apps/controller/src/gateway/native-admin.ts";
import { nativeRolesGateway } from "../helpers/runtime-roles.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import test from "node:test";
import type { Locator, Page } from "playwright";
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

type ControllerUnit = Parameters<Parameters<OpenClawController["transact"]>[0]>[0];
import { createConsoleAppFixture, fileConsoleApp } from "../helpers/console-app.mjs";
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
  settlePageRequests,
  expireSessionsWhenSettled,
} from "./console-agents-browser-helpers.ts";
import { trackSettledFetches } from "./console-fetch-accounting.ts";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
} from "./console-deployment-activity-helpers.ts";

import {
  expectNativeAdminHidden,
  assertRevisionUrl,
  nativeAdminComputeDriver,
  nativeAdminValues,
} from "./console-agents-test-support.ts";
import { waitForLiveControls } from "./console-agents-ui-test-support.ts";
import { STOP_REQUESTED, VERSION_READ_DENIED_HEADING } from "../helpers/refusal-text.mjs";
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
      provisionedPeople: [],
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
    nativeRolesGateway(nativeValues("unsupported-ui"), "https://not-admitted.example.test"),
  );
  const prior = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const entryRole = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: { permissions: [{ action: "use", resourceKind: "agent" }] },
  });
  const root = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(root);
  const retainedAssignment = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: root.id,
        roleId: entryRole.data.id,
        resourceKind: "agent",
        resourceId: agent.id,
        runtimeRole: "administrator",
        runtimeRoleConfiguration: (
          await fixture.request(
            "GET",
            `/namespaces/${namespace.id}/agents/${agent.id}/runtime-roles`,
          )
        ).data.configuration,
      },
    },
  );
  assert.equal(retainedAssignment.status, 201);
  await fixture.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`);
  await fixture.controller.transact((state: ControllerUnit) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, prior.revision.id),
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

  // A retained assignment survives completed stop without suggesting a routing problem.
  const initiallyStopped = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  assert.equal(initiallyStopped.status, 200);
  assert.deepEqual(initiallyStopped.data, { status: "stopped" });
  await page.getByText("Start this Agent before opening OpenClaw.").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );

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
      "OpenClaw is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
    )
    .waitFor({ timeout: 5_000 });
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
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
  await page.getByRole("region", { name: "OpenClaw access" }).waitFor();
  await page
    .getByText(
      "OpenClaw’s UI is disabled or does not allow this Agent’s URL. Someone who can edit its Configuration can enable it and deploy a new version.",
    )
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );

  fixture.policy.restrictions.push({
    id: "deny-native-use",
    namespaceId: namespace.id,
    resourceId: agent.id,
    resourceKind: "agent",
    action: "use",
    effect: "deny",
  });
  const deniedAccess = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
  );
  await page.reload();
  assert.equal((await deniedAccess).status(), 403);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page
    .locator(".native-admin-access")
    .getByText("assign your Principal ID", { exact: false })
    .waitFor();
  assert.equal(await page.getByRole("link", { name: "Open Agent UI" }).isVisible(), false);
  fixture.policy.restrictions.length = 0;
  // The audited denial is settled for this tab; a new tab in the same session asks afresh.
  const deniedTabWrites = nonAuthWriteRequests(requests);
  const browserContext = page.context();
  await page.close();
  page = await browserContext.newPage();
  requests = apiRequests(page, fixture.origin);
  await page.goto(`${fixture.origin}${detail().pathname}${detail().search}`);
  await page.getByRole("region", { name: "OpenClaw access", exact: true }).waitFor();

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
  const cleared = await controller.transact((state: ControllerUnit) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.ok(cleared, "The stopped Agent must have its active revision cleared");
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("region", { name: "OpenClaw access", exact: true }).waitFor();
  await page.getByText("Start this Agent before opening OpenClaw.").waitFor();
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

  // Platform administration restrictions do not revoke a permitted native-use assignment.
  fixture.policy.restrictions.push({
    id: "deny-native-administer",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "administer",
    effect: "deny",
  });
  await page.reload();
  await page.getByRole("region", { name: "OpenClaw access", exact: true }).waitFor();
  await page.getByRole("link", { name: "Open Agent UI" }).waitFor();
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`))
      .data.status,
    "available",
  );
  fixture.policy.restrictions.length = 0;

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
    provisionedPeople: [],
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
    nativeRolesGateway(nativeValues("follow-ui"), "https://not-admitted.example.test"),
  );
  // Assign the person through the API after deploying the catalog, then leave no version
  // selected for service. Deployment polling must recover access without a page reload.
  const prior = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const entryRole = await fixture.request("POST", `/namespaces/${namespace.id}/iam/roles`, {
    body: { permissions: [{ action: "use", resourceKind: "agent" }] },
  });
  const root = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(root);
  const assignment = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/iam/access-bindings`,
    {
      body: {
        subjectKind: "identity",
        subjectId: root.id,
        roleId: entryRole.data.id,
        resourceKind: "agent",
        resourceId: agent.id,
        runtimeRole: "administrator",
        runtimeRoleConfiguration: (
          await fixture.request(
            "GET",
            `/namespaces/${namespace.id}/agents/${agent.id}/runtime-roles`,
          )
        ).data.configuration,
      },
    },
  );
  assert.equal(assignment.status, 201);
  await fixture.request("POST", `/namespaces/${namespace.id}/agents/${agent.id}/stop`);
  await fixture.controller.transact((state: ControllerUnit) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, prior.revision.id),
  );
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
      "OpenClaw is unavailable because no version of this Agent is serving: a deployment is in progress or has failed. Check Deployment activity, then refresh access.",
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
      "OpenClaw’s UI is disabled or does not allow this Agent’s URL. Someone who can edit its Configuration can enable it and deploy a new version.",
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
  let catalogUnavailable = false;
  if (!nativeBrowserSupported(t)) {
    return;
  }
  const { fixture, browserOptions } = await createNativeConsoleFixture(t, {
    provisionedPeople: ["shared-person"],
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    agentGatewayManagedMode: false,
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/shared"),
    async onSend(
      request: { method: string; url: string },
      reply: { code(status: number): unknown; statusCode: number },
      payload: string,
    ) {
      if (
        catalogUnavailable &&
        request.method === "GET" &&
        request.url.endsWith("/runtime-roles")
      ) {
        // The real IAM policy stays available while the separate role catalog fails.
        reply.code(500);
        return JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "Role catalog unavailable" },
        });
      }
      return payload;
    },
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
  const nativeOrigin = new URL(fixture.origin);
  nativeOrigin.hostname = deriveNativeAdminHost(
    fixture.controller.installation.id,
    { namespaceId: namespace.id, id: agent.id },
    new URL(fixture.origin).hostname.replace(/^console\./, "agents."),
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("shared", nativeOrigin.origin),
  );
  const currentAgent = fixtureResponse(
    await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`),
    200,
    AgentReadResponse,
    "Read shared Agent before revision activation",
  ).data;
  assert.ok(currentAgent.activeRevisionId);
  const active = await fixture.seedActiveAgentRevision(
    namespace.id,
    agent.id,
    currentAgent.activeRevisionId,
  );
  const person = fixture.provisionedAccounts[0];
  assert.ok(person);
  assert.ok(person, "The shared person must be provisioned");
  const session = await fixture.signIn(person.credentials);
  assert.deepEqual((await fixture.request("GET", "/namespaces", { session })).data, []);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const useRole = await fixture.request("POST", `${policyPath}/roles`, {
    body: { permissions: [{ action: "use", resourceKind: "agent" }] },
  });
  assert.equal(useRole.status, 201);
  const existingAssignment = await fixture.request("POST", `${policyPath}/access-bindings`, {
    body: {
      subjectKind: "identity",
      subjectId: person.principal.id,
      roleId: useRole.data.id,
      resourceKind: "agent",
      resourceId: agent.id,
      runtimeRole: "researcher",
      runtimeRoleConfiguration: (
        await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/runtime-roles`)
      ).data.configuration,
    },
  });
  assert.equal(existingAssignment.status, 201);
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`, { session }))
      .status,
    403,
    "a use-only assignment does not give Console discovery",
  );
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
  await panel.getByLabel("OpenClaw role", { exact: true }).selectOption("researcher");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-granted.png") });
  const bindings: unknown = await fixture.addedAccessBindings(namespace.id);
  assert.ok(Check(IAMAccessBindingListResponse.properties.data, bindings));
  assert.equal(bindings.length, 3);
  const assignment = bindings.find(
    (binding) => "runtimeRole" in binding && binding.runtimeRole !== undefined,
  );
  assert.ok(assignment);
  assert.deepEqual(
    assignment,
    existingAssignment.data,
    "sharing preserves the use-only assignment",
  );
  const readBinding = bindings.find(
    (binding) =>
      "resourceKind" in binding &&
      binding.resourceKind === "agent" &&
      (!("runtimeRole" in binding) || binding.runtimeRole === undefined),
  );
  assert.ok(readBinding, "sharing adds the missing ordinary Agent-read grant");
  assert.deepEqual(
    (await fixture.request("GET", `${policyPath}/roles/${readBinding.roleId}`)).data.permissions,
    [{ action: "read", resourceKind: "agent" }],
  );
  const assignmentRow = panel.locator(".agent-access-grant").filter({ hasText: assignment.id });
  await assignmentRow.getByRole("combobox").selectOption("reviewer");
  await panel.getByText("OpenClaw role changed.", { exact: false }).waitFor();
  assert.equal(
    (await fixture.request("GET", `${policyPath}/access-bindings/${assignment.id}`)).data
      .runtimeRole,
    "reviewer",
  );
  assert.equal(
    bindings.some((binding) => binding.roleId === misleadingRoleData.id),
    false,
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

  catalogUnavailable = true;
  await panel.getByRole("button", { name: "Refresh sharing", exact: true }).click();
  await panel
    .getByText(
      "The configured OpenClaw role catalog is unavailable. Existing assignments can still be removed.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await panel.getByRole("button", { name: "Share Agent", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await assignmentRow.getByRole("combobox").isDisabled(), true);
  assert.equal(
    await assignmentRow.getByRole("button", { name: "Remove binding", exact: true }).isEnabled(),
    true,
  );
  // Revoke native entry while the independent discovery and operate grants remain usable.
  await assignmentRow.getByRole("button", { name: "Remove binding", exact: true }).click();
  await panel.getByText("OpenClaw access revoked.", { exact: false }).waitFor();
  let after: unknown = await fixture.addedAccessBindings(namespace.id);
  assert.ok(Check(IAMAccessBindingListResponse.properties.data, after));
  assert.deepEqual(
    after.map((binding) => binding.id).sort(),
    bindings
      .filter((binding) => binding.id !== assignment.id)
      .map((binding) => binding.id)
      .concat(operateBinding.data.id)
      .sort(),
  );
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents`, { session })).data.map(
      (item: { id: string }) => item.id,
    ),
    [agent.id],
  );
  assert.equal(
    (
      await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`, {
        session,
      })
    ).status,
    403,
  );
  // Removing the separate read binding subsequently hides the Agent, without changing discovery.
  await panel
    .locator(".agent-access-grant")
    .filter({ hasText: readBinding.id })
    .getByRole("button", { name: "Remove binding", exact: true })
    .click();
  await panel.getByText("Binding removed.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-removed.png") });
  after = await fixture.addedAccessBindings(namespace.id);
  assert.ok(Check(IAMAccessBindingListResponse.properties.data, after));
  const namespaceBinding = bindings.find(
    (binding) => "resourceKind" in binding && binding.resourceKind === "namespace",
  );
  assert.ok(namespaceBinding);
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

test("Agent sharing reconciles a truncated committed response without replaying writes", async (t) => {
  let loseAgentBindingResponse = true;
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["response-recipient"],
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/recovery"),
    async onSend(
      request: { method: string; url: string },
      reply: { code(status: number): unknown; statusCode: number },
      payload: string,
    ) {
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
  const namespace = await fixture.createNamespace("Sharing recovery", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Recovery Agent",
    nativeRolesGateway(nativeValues("recovery"), "https://native.example.test"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const person = fixture.provisionedAccounts[0];
  assert.ok(person);
  const baselineRoles = (await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`))
    .data;
  const { page, artifacts } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
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
      (item: { id: string }) => item.id,
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
  assert.equal(
    (await fixture.request("GET", `${policyPath}/roles`)).data.length - baselineRoles.length,
    2,
  );
  assert.equal((await fixture.addedAccessBindings(namespace.id)).length, 2);
  // A sharing read must preserve global expiry handling, including private panel removal.
  await expireSessionsWhenSettled(page, fixture);
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
});

test("a failed native admin status read keeps the card, its error and Refresh access", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Native admin outage", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Outage Agent", nativeValues("outage"));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const nativeAdminPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  let unavailable = true;
  let failures = 0;
  await page.route(`${fixture.origin}${nativeAdminPath}`, async (route) => {
    if (unavailable) {
      failures += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "A required platform dependency is unavailable.",
          },
          meta: { requestId: `req_00000000-0000-4000-8000-${String(failures).padStart(12, "0")}` },
        }),
      });
      return;
    }
    await route.continue();
  });
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "configuration");
  await login(page, fixture, detail);
  await page.getByRole("heading", { name: "Outage Agent" }).waitFor();

  // An outage is not a denial: the card stays, names the failure and can be retried.
  const card = page.locator(".native-admin-access");
  await card.getByRole("alert").getByText("Service unavailable", { exact: false }).waitFor();
  assert.equal(await card.isVisible(), true);
  const reload = card.getByRole("button", { name: "Refresh access" });
  await waitForEnabled(reload);

  // Back rebuilds failed views and rechecks the outage once, preserving its recovery controls.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(await card.isVisible(), true);
  assert.equal(await reload.isEnabled(), true);
  await card.getByRole("alert").getByText("Service unavailable", { exact: false }).waitFor();
  assert.equal(failures, 2, "Back revalidates the failed read once");

  // Recovery still honors Installation configuration: the feature is disabled.
  unavailable = false;
  const reads = () => requests.filter((request) => request.path === nativeAdminPath).length;
  const before = reads();
  await reload.click();
  await waitForCondition(() => reads() === before + 1, "native admin status reread");
  await card.waitFor({ state: "hidden" });
  await expectNativeAdminHidden(page);
});

test("Agent sharing rejects emails locally and names an unknown Principal ID", async (t) => {
  const fixture = await detailApp(t);
  const namespace = await fixture.createNamespace("Sharing subject checks");
  const agent = await fixture.createAgent(
    namespace.id,
    "Subject Agent",
    nativeRolesGateway(nativeValues("subject"), "https://native.example.test"),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  const principal = panel.getByLabel("Existing person’s Principal ID");
  assert.ok(principal);
  const writes = () =>
    nonAuthWriteRequests(requests).filter((request) => request.path.includes("/iam/"));
  await principal.fill("carol@example.invalid");
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("not an email address", { exact: false }).waitFor();
  assert.equal(writes().length, 0);

  await principal.fill("prn_00000000-0000-4000-8000-000000000000");
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel
    .getByText("No existing person with that Principal ID can be granted access here", {
      exact: false,
    })
    .waitFor();
  assert.equal(await panel.getByText("Resource unavailable", { exact: false }).count(), 0);
  const bindings = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.deepEqual(bindings.data, []);
});

// Commit the narrow role, then return a real, broader role from the same Namespace in its place.
// Both sharing and credential access must stop before sending any binding request.
async function expectBroaderCreatedRoleRefused(
  page: Page,
  requests: ReturnType<typeof apiRequests>,
  rolesPath: string,
  broader: { namespaceId: string; id: string; permissions: unknown[] },
  submit: () => Promise<void>,
) {
  const routePattern = `**${rolesPath}`;
  await page.route(routePattern, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    const body = await response.json();
    assert.deepEqual(body.data.permissions, route.request().postDataJSON().permissions);
    assert.equal(body.data.namespaceId, broader.namespaceId);
    assert.notEqual(body.data.id, broader.id);
    assert.ok(broader.permissions.length > body.data.permissions.length);
    await route.fulfill({ response, json: { ...body, data: broader } });
  });
  const returned = page.waitForResponse(
    (response) => response.url().endsWith(rolesPath) && response.request().method() === "POST",
  );
  await submit();
  assert.equal(await (await returned).finished(), null);
  await settlePageRequests(page);
  const bindingsPath = rolesPath.replace(/\/roles$/, "/access-bindings");
  assert.equal(
    pathRequests(requests, "POST", bindingsPath).length,
    0,
    "never bind the broader role",
  );
  assert.equal(pathRequests(requests, "POST", rolesPath).length, 1, "never repeat role creation");
  await page.unroute(routePattern);
}

test("Agent sharing creates exact Roles instead of reusing strict superset Roles", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    provisionedPeople: ["superset-recipient"],
    computeDriver: nativeAdminComputeDriver("wss://private-gateway.example.invalid/superset"),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Superset sharing", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Superset Agent",
    nativeRolesGateway(nativeValues("superset"), "https://native.example.test"),
  );
  await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const person = fixture.provisionedAccounts[0];
  assert.ok(person);
  const policyPath = `/namespaces/${namespace.id}/iam`;
  const baselineRoles = (await fixture.request("GET", `${policyPath}/roles`)).data;
  // Each superset contains every permission sharing needs, plus one it must not grant.
  const supersets: { namespaceId: string; id: string; permissions: unknown[] }[] = [];
  for (const permissions of [
    [
      { action: "read", resourceKind: "agent" },
      { action: "use", resourceKind: "agent" },
      { action: "delete", resourceKind: "agent" },
    ],
    [
      { action: "read", resourceKind: "namespace" },
      { action: "read", resourceKind: "secret" },
    ],
  ]) {
    const role = await fixture.request("POST", `${policyPath}/roles`, { body: { permissions } });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    supersets.push(role.data);
  }
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  const share = panel.getByRole("button", { name: "Share Agent", exact: true });
  const broaderRole = supersets[1];
  assert.ok(broaderRole);
  await expectBroaderCreatedRoleRefused(page, requests, `${policyPath}/roles`, broaderRole, () =>
    share.click(),
  );
  await panel
    .getByText(/Refresh sharing to inspect current policy before another change/)
    .waitFor();
  assert.equal(await share.isDisabled(), true);
  // An explicit refresh and retry can reuse the narrow role that actually committed.
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await share.click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();

  const roles = (await fixture.request("GET", `${policyPath}/roles`)).data;
  assert.equal(
    roles.length - baselineRoles.length,
    4,
    "sharing must add two exact Roles beside the supersets",
  );
  const bindings: unknown = await fixture.addedAccessBindings(namespace.id);
  assert.ok(Check(IAMAccessBindingListResponse.properties.data, bindings));
  assert.equal(bindings.length, 2);
  const grantPermissions = (resourceKind: string) => {
    const binding = bindings.find(
      (candidate) => "resourceKind" in candidate && candidate.resourceKind === resourceKind,
    );
    assert.ok(binding);
    assert.equal(
      supersets.some((role) => role.id === binding.roleId),
      false,
      `${resourceKind} reused a superset`,
    );
    return roles
      .find((role: { id: string }) => role.id === binding.roleId)
      .permissions.map(
        (permission: { action: string; resourceKind: string }) =>
          `${permission.action}:${permission.resourceKind}`,
      )
      .sort();
  };
  assert.deepEqual(grantPermissions("namespace"), ["read:namespace"]);
  assert.deepEqual(grantPermissions("agent"), ["read:agent", "use:agent"]);
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

test("Agent sharing before deployment rejects stale Configuration and previews saved policy changes", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["draft-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Draft sharing", { ready: true });
  const values = nativeRolesGateway(nativeValues("draft-sharing"), fixture.origin);
  const agent = await fixture.createAgent(namespace.id, "Draft sharing Agent", values);
  const person = fixture.provisionedAccounts[0];
  assert.ok(person);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "access"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("OpenClaw role", { exact: true }).selectOption("researcher");
  await panel.getByText(/Agent stopped. Assignments can be saved now/).waitFor();
  await panel.getByText("Selected role permissions", { exact: true }).click();
  await panel.getByText("This role is not deployed.", { exact: true }).waitFor();
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  // Another administrator saves policy after the preview was read. The real write must reject it.
  values.gateway.roles.definitions.researcher.scopes = ["operator.read"];
  await fixture.updateConfiguration(namespace.id, agent.configurationId, values);
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "The Agent Configuration changed." }).waitFor();
  const policyPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  assert.equal(
    (await fixture.request("GET", policyPath)).data.some(
      (binding: { runtimeRole?: string }) =>
        "runtimeRole" in binding && binding.runtimeRole !== undefined,
    ),
    false,
  );
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await waitForLiveControls(page, ["share-runtime-role"]);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  assert.equal(
    (await fixture.request("GET", policyPath)).data.find(
      (binding: { runtimeRole?: string }) => binding.runtimeRole,
    )?.runtimeRole,
    "researcher",
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  values.gateway.roles.definitions.researcher.scopes = ["operator.read", "operator.write"];
  await fixture.updateConfiguration(namespace.id, agent.configurationId, values);
  await panel.getByRole("button", { name: "Refresh sharing" }).click();
  await panel
    .getByText(/OpenClaw uses the deployed permissions/)
    .first()
    .waitFor();
  const deployed = active.revision.configuration;
  assertRecord(deployed, "Deployed configuration");
  assertRecord(deployed.gateway, "Deployed Gateway");
  assertRecord(deployed.gateway.roles, "Deployed role catalog");
  assertRecord(deployed.gateway.roles.definitions, "Deployed role definitions");
  assertRecord(deployed.gateway.roles.definitions.researcher, "Deployed researcher role");
  assert.deepEqual(deployed.gateway.roles.definitions.researcher.scopes, ["operator.read"]);
  const preview = panel.locator("details pre");
  assert.match(await preview.nth(0).innerText(), /operator.write/);
  assert.doesNotMatch(await preview.nth(1).innerText(), /operator.write/);
});

test("an unassigned Installation administrator can self-assign and explicitly refresh OpenClaw access", async (t) => {
  const auditSink = new InMemoryAuditSink();
  if (!nativeBrowserSupported(t)) {
    return;
  }
  const { fixture, browserOptions } = await createNativeConsoleFixture(t, {
    auditSink,
    provisionedPeople: [],
    nativeAdminGatewayApiKey: async () => "native-admin-gateway-api-key",
    computeDriver: nativeAdminComputeDriver(
      "wss://private-gateway.example.invalid/self-assignment",
    ),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Administrator entry", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Self-assignment Agent",
    nativeValues("self-assignment"),
  );
  const origin = new URL(fixture.origin);
  origin.hostname = deriveNativeAdminHost(
    fixture.controller.installation.id,
    agent,
    new URL(fixture.origin).hostname.replace(/^console\./, "agents."),
  );
  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("self-assignment", origin.origin),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const principal = fixture.policy.identities.find((identity) => identity.kind === "principal");
  assert.ok(principal);
  const { page } = await newPage(t, fixture, browserOptions);
  const requests = apiRequests(page, fixture.origin);
  const statusPath = `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  const reads = () => pathRequests(requests, "GET", statusPath).length;
  const denials = () =>
    auditSink
      .list()
      .filter(
        (event) =>
          event.kind === "authorization_denial" &&
          event.action === "openclaw.agents.native_admin.read",
      ).length;
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration");
  await login(page, fixture, detail);
  const card = page.locator(".native-admin-access");
  await card.getByText("assign your Principal ID", { exact: false }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByRole("link", { name: "Open Agent UI" }).isVisible(), false);
  assert.equal(denials(), 1);

  // Automatic reloads retain the hint and suppress another audited denial.
  await page.reload();
  await card.getByText("assign your Principal ID", { exact: false }).waitFor();
  assert.equal(reads(), 1);
  assert.equal(denials(), 1);
  // An explicit retry still checks current authority; it cannot invent access.
  await card.getByRole("button", { name: "Refresh access" }).click();
  await waitForCondition(() => reads() === 2 && denials() === 2, "explicit denied retry");
  await card.getByText("assign your Principal ID", { exact: false }).waitFor();

  await page.getByRole("tab", { name: "Access", exact: true }).click();
  const sharing = page.getByRole("region", { name: "Share Agent", exact: true });
  await sharing.getByLabel("Existing person’s Principal ID").fill(principal.id);
  await sharing.getByLabel("OpenClaw role", { exact: true }).selectOption("platform-administrator");
  await sharing.getByRole("checkbox").check();
  await sharing.getByRole("button", { name: "Share Agent", exact: true }).click();
  await sharing.getByText("Agent access is shared.", { exact: false }).waitFor();
  const assignedAccess = await fixture.request("GET", statusPath);
  assert.equal(assignedAccess.status, 200);
  assert.equal(assignedAccess.data.status, "available", JSON.stringify(assignedAccess.data));
  // The same tab and session must recover after the real policy write.
  await card.getByRole("button", { name: "Refresh access" }).click();
  const launch = page.getByRole("link", { name: "Open Agent UI" });
  await launch.waitFor({ timeout: 5_000 });
  assert.equal(await launch.getAttribute("href"), origin.href);
  assert.equal(reads(), 3);
  assert.equal(denials(), 2);
  assert.equal(await card.getByText("assign your Principal ID", { exact: false }).count(), 0);
});

test("Back refreshes sharing when a failed role catalog recovers", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Catalog recovery", { ready: true });
  const values = nativeRolesGateway(nativeValues("catalog-recovery"), fixture.origin);
  const agent = await fixture.createAgent(namespace.id, "Catalog recovery Agent", values);
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  // The fixture activates admitted revisions without a worker status record. Supply
  // that unrelated read's contract so an outage there cannot mask catalog retention.
  await page.route(`${fixture.origin}${agentPath}/deployments/${active.revision.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: active.revision.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status: "succeeded",
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000200" },
      }),
    }),
  );
  const catalogPath = `${agentPath}/runtime-roles`;
  let unavailable = true;
  await page.route(`${fixture.origin}${catalogPath}`, async (route) => {
    if (!unavailable) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "Role catalog unavailable." },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  });
  const detail = detailUrl(fixture, namespace.id, agent.id, "draft", "access");
  await login(page, fixture, `${detail.pathname}${detail.search}`);
  const panel = page.locator(".agent-access");
  const roles = panel.locator("#share-runtime-role");
  await panel.getByText(/The configured OpenClaw role catalog is unavailable/).waitFor();
  assert.equal(await roles.isDisabled(), true);
  const retained = await panel.elementHandle();

  // Only the external read failure is simulated. Recovery uses the real authorized
  // catalog route and the named roles in this Agent's admitted configuration.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  unavailable = false;
  await page.goBack();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  await roles.locator('option[value="researcher"]').waitFor({ state: "attached" });
  assert.equal(await roles.isEnabled(), true);
  assert.equal(await retained.evaluate((node) => node.isConnected), true);
  assert.equal(
    await panel.getByText(/The configured OpenClaw role catalog is unavailable/).count(),
    0,
  );
  // A changed policy refreshes only Sharing and requires consent to its new permissions.
  await roles.selectOption("researcher");
  await panel.getByText("Selected role permissions", { exact: true }).click();
  await panel.getByRole("checkbox").check();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  values.gateway.roles.definitions.researcher.scopes = ["operator.read"];
  await fixture.updateConfiguration(namespace.id, agent.configurationId, values);
  await page.goBack();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  await roles.selectOption("researcher");
  const permissions = panel.locator("details").first();
  if (!(await permissions.evaluate((node) => node instanceof HTMLDetailsElement && node.open))) {
    await panel.getByText("Selected role permissions", { exact: true }).click();
  }
  const preview = panel.locator("details pre").first();
  assert.deepEqual(JSON.parse(await preview.innerText()).scopes, ["operator.read"]);
  assert.equal(await panel.getByRole("checkbox").isChecked(), false);

  // Leaving during the first catalog read must not retain a permanently pending panel.
  const pendingCatalog = await holdRequests(t, page, `${fixture.origin}${catalogPath}`, {
    once: true,
  });
  await page.reload();
  await pendingCatalog.requested;
  await page.getByRole("heading", { name: "Catalog recovery Agent", exact: true }).waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  pendingCatalog.release();
  await page.goBack();
  await waitForLiveControls(page, ["share-runtime-role"]);
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

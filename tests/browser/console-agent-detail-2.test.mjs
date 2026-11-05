import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";

import { createConsoleAppFixture, fileConsoleApp } from "../helpers/console-app.mjs";

import {
  apiRequests,
  detailUrl,
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
} from "./console-agents-test-support.mjs";
import { STOP_REQUESTED, VERSION_READ_DENIED_HEADING } from "../helpers/refusal-text.mjs";
import { restrict } from "../helpers/iam-grants.mjs";
import {
  registerDeletionAndNavigationCases,
  registerSettingsRefocusAndTabsCases,
  registerSharingCredentialsAndChannelsCases,
} from "./console-agent-detail-cases.mts";

// The Console Browser lane runs the two Agent detail test files in parallel.

// Tests that need no app of their own share one (fileConsoleApp); each makes its own Namespace.
// Tests that open an Agent link without a Namespace (which reads every Namespace), expire every
// session, register a Driver, use the bootstrap result, or pass fixture options keep an app of
// their own.
const detailApp = fileConsoleApp();

// Keep registration order around the native admin cases.
registerDeletionAndNavigationCases(detailApp);

test("Agent detail opens native admin UI only after real API access checks pass", async (t) => {
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
    agentGatewayManagedMode: false,
    computeDriver: nativeAdminComputeDriver(gatewayEndpoint),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Native admin access", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Native admin Agent",
    nativeValues("unsupported-ui"),
  );
  let { page } = await newPage(t, fixture, {
    args: [
      ...fixture.browserArgs,
      `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1,MAP *.${nativeDomain} 127.0.0.1`,
    ],
  });
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
  assert.equal(initialNativeAccess.data.status, "unsupported");
  assert.equal(new URL(initialNativeAccess.data.origin).protocol, "https:");
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
  const cleared = await fixture.controller.transact((state) =>
    state.agents.compareAndClearActiveRevision(namespace.id, agent.id, active.revision.id),
  );
  assert.equal(cleared.activeRevisionId, undefined);
  await page.reload();
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.locator(".native-admin-access").waitFor();
  await page.getByText("Start this Agent before opening its native admin UI.").waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );

  await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    nativeAdminValues("supported-ui", initialNativeAccess.data.origin),
  );
  active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await page.goto(detail().href);
  await page.getByRole("heading", { name: "Native admin Agent" }).waitFor();
  await page.getByRole("link", { name: "Open Agent UI" }).waitFor();
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
  await page.getByLabel("Viewing version").selectOption(historicalRevisionId);
  await page.getByRole("link", { name: "Open Agent UI" }).waitFor();
  assertRevisionUrl(page, historicalRevisionId);
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI" }).getAttribute("href"),
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
  await page.getByRole("link", { name: "Open Agent UI" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), expectedAccess.data.url);
  assert.equal(await popup.evaluate(() => globalThis.opener === null), true);
  assert.match(nativeRequestCookie, /(?:__Secure-)?openclaw_occ_shared\.session_token=/);
  assert.doesNotMatch(nativeRequestCookie, /legacy-host-only/);

  assert.deepEqual([...deniedTabWrites, ...nonAuthWriteRequests(requests)], []);
});

test("Agent detail rereads native admin access once when a pending deployment activates, and Refresh access keeps keyboard focus", async (t) => {
  const cookieDomain = "oce.example.test";
  const consoleHost = `console.${cookieDomain}`;
  const nativeDomain = `agents.${cookieDomain}`;
  const fixture = await createConsoleAppFixture(t, {
    originHost: consoleHost,
    publicOrigin: true,
    authCookieDomain: cookieDomain,
    development: { enabled: false },
    https: true,
    authSecureCookies: true,
    nativeAdmin: { enabled: true, domain: nativeDomain, sharedCookieDomain: cookieDomain },
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
  const { page } = await newPage(t, fixture, {
    args: [...fixture.browserArgs, `--host-resolver-rules=MAP ${consoleHost} 127.0.0.1`],
  });
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
  const isFocused = (locator) =>
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
    agentGatewayManagedMode: false,
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
  const detail = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "access");
  await login(page, fixture, detail);
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel.getByLabel("Existing person’s Principal ID").fill(person.principal.id);
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await panel.screenshot({ path: join(artifacts, "agent-sharing-granted.png") });
  const bindings = await fixture.addedAccessBindings(namespace.id);
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
  // Stop was granted independently; reloading obtains the new advice without granting version read.
  const refreshedAdvice = recipient.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/agents/${agent.id}/permissions`),
  );
  await recipient.reload();
  const advice = await refreshedAdvice;
  assert.equal(advice.status(), 200);
  assert.equal((await advice.json()).data.operate, true);
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
  const after = await fixture.addedAccessBindings(namespace.id);
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

registerSharingCredentialsAndChannelsCases(detailApp);

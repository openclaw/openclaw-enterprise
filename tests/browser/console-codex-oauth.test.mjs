import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  createDeviceCredentialDrivers,
  DEVICE_ACCESS_TOKEN,
  DEVICE_ACCOUNT_ID,
} from "../helpers/device-credential-gateway.mjs";
import {
  MEMBER_WRITE,
  apiRequests,
  expectNoText,
  login,
  nativeValues,
  newPage,
  revokeAdministratorGrant,
  settlePageRequests,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { submitCreateAgent } from "./console-agents-test-support.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";
import {
  AGENT_DEVICE_LOGIN_CANCEL_DENIED,
  AGENT_DEVICE_LOGIN_POLL_DENIED,
  AGENT_DEVICE_LOGIN_START_DENIED,
  DEVICE_LOGIN_START_DENIED,
  DEVICE_LOGIN_NOT_CONFIGURED,
} from "../helpers/refusal-text.mjs";

// The fixture's login asks the Console to poll every 5 s, and the API refuses an earlier poll.
// Each ready login moves both clocks past that interval instead of waiting it out.
const DEVICE_POLL_MS = 5_000;

async function signInReady(page, advanceApiClock) {
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  // The pending view schedules the poll in the same update that shows this status. A later
  // re-render restarts that timer, and a jump from the current time still covers it.
  await page
    .getByText("Waiting for you to complete sign-in in the other tab…", { exact: true })
    .waitFor();
  advanceApiClock(DEVICE_POLL_MS);
  await page.clock.fastForward(DEVICE_POLL_MS);
  await page
    .getByText(
      "ChatGPT login ready. Clearing this selection leaves the saved credential source available.",
      { exact: true },
    )
    .waitFor();
}

test("Codex OAuth console saves a credential source and reuses it for plugin editing", async (t) => {
  let apiClockAheadMs = 0;
  const advanceApiClock = (ms) => {
    apiClockAheadMs += ms;
  };
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth console", {
    provisionedPeople: [],
    agentProvisioning: true,
    now: () => new Date(Date.now() + apiClockAheadMs),
  });
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(installation.data.capabilities.agentProvisioning.executionModes, ["dedicated"]);
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const originalFetch = globalThis.fetch;
  let approved = false;
  const providerRequests = [];
  const { gateway, refresh } = createDeviceCredentialDrivers({ approve: async () => approved });
  fixture.controller.registerDriver(gateway);
  fixture.controller.selectDriver("credential_gateway", gateway.id);
  fixture.controller.registerDriver(refresh);
  fixture.controller.selectDriver("credential_refresh", refresh.id);
  const plugin = {
    id: "plugin-oauth-fixture",
    name: "calendar",
    scope: "GLOBAL",
    status: "ENABLED",
    installation_policy: "AVAILABLE",
    release: {
      display_name: "Calendar",
      description: "Calendar tools",
      interface: {},
      requires_local_executor: false,
      app_ids: ["connector_calendar"],
      skills: [],
      mcp_servers: [],
    },
  };
  // Only the credential service and hosted catalog HTTP are simulated. Console, Fastify,
  // IAM, OCC source/session persistence and the production Plugin Driver run unchanged.
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://auth.openai.com/") && !url.startsWith("https://chatgpt.com/")) {
      return originalFetch(input, init);
    }
    providerRequests.push(url);
    assert.equal(init.headers.Authorization, `Bearer ${DEVICE_ACCESS_TOKEN}`);
    assert.equal(init.headers["ChatGPT-Account-ID"], DEVICE_ACCOUNT_ID);
    if (url.includes("/ps/plugins/list?") || url.includes("/ps/plugins/search?")) {
      return Response.json({ plugins: [plugin], pagination: { next_page_token: null } });
    }
    if (url.includes("/ps/plugins/plugin-oauth-fixture?")) {
      return Response.json(plugin);
    }
    assert.equal(url, "https://chatgpt.com/backend-api/ps/apps/batch");
    return Response.json({
      apps: [
        {
          id: "connector_calendar",
          status: "ENABLED",
          tools: [
            { name: "search", title: "Search calendar", is_read_only: true, is_enabled: true },
          ],
        },
      ],
    });
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isVisible(), false);
  // The Console polls only after the interval the login asks for, and follows a longer one a
  // poll answer asks for, as a provider's slow_down does (finding 1651). Each poll is held, so
  // one sent early leaves the busy status shown when the clock stops short of the interval.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1_000));
  let polls = 0;
  let nextPoll = Promise.withResolvers();
  await page.route("**/device-authorizations/*/poll", async (route) => {
    polls += 1;
    nextPoll.resolve(route);
  });
  const pollStatus = page.locator(".device-login [role='status']");
  const waiting = "Waiting for you to complete sign-in in the other tab…";
  const checking = "Checking Codex login…";
  async function answerPoll(intervalSeconds) {
    await page.getByText(checking, { exact: true }).waitFor();
    const route = await nextPoll.promise;
    nextPoll = Promise.withResolvers();
    const response = await route.fetch();
    const body = await response.json();
    assert.equal(body.data.status, "pending");
    assert.equal(body.data.intervalSeconds, 5);
    body.data.intervalSeconds = intervalSeconds;
    await route.fulfill({ response, json: body });
    await page.getByText(waiting, { exact: true }).waitFor();
  }
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  await page.getByText("CODE-12345", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("link", { name: "Open Codex sign-in" }).getAttribute("href"),
    "https://auth.openai.com/codex/device",
  );
  await page.getByText(waiting, { exact: true }).waitFor();
  await page.clock.fastForward(DEVICE_POLL_MS - 1);
  assert.equal(await pollStatus.textContent(), waiting);
  advanceApiClock(DEVICE_POLL_MS);
  await page.clock.fastForward(1);
  await answerPoll(10);
  await page.clock.fastForward(10_000 - 1);
  assert.equal(await pollStatus.textContent(), waiting);
  advanceApiClock(10_000);
  await page.clock.fastForward(1);
  await answerPoll(5);
  assert.equal(polls, 2);
  await page.unroute("**/device-authorizations/*/poll");
  await page.clock.resume();
  const cancelled = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/device-authorizations/"),
  );
  await page.getByRole("button", { name: "Cancel login", exact: true }).click();
  assert.equal((await cancelled).status(), 204);
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).waitFor();

  // A ready login provides a source reference; its polling session never becomes Agent auth.
  approved = true;
  await signInReady(page, advanceApiClock);
  const started = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/device-authorizations"),
  );
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].body, { harnessId: "codex" });
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Add Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const discovery = requests.find(
    (request) =>
      request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents/plugins`,
  );
  assert.equal(discovery.body.credentialSource.kind, "credential_source");
  await page.getByLabel("Agent name", { exact: true }).fill("OAuth Agent");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
  await page.getByRole("heading", { name: "OAuth Agent", exact: true }).waitFor();
  const creation = requests.find(
    (request) => request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents`,
  );
  // Even when dedicated provisioning is advertised, source auth uses the supported
  // draft creation path. The durable provisioning API rejects source auth.
  assert.equal(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/agents/provision"),
    ),
    false,
  );
  assert.deepEqual(creation.body.harnessAuth, {
    method: "credential_source",
    sourceId: discovery.body.credentialSource.id,
  });
  assert.deepEqual(creation.body.credentialSources, [
    { sourceId: discovery.body.credentialSource.id },
  ]);
  assert.ok(creation.body.plugins["codex-plugin:calendar@openai-curated-remote"]);
  const agentId = new URL(page.url()).pathname.split("/").at(-1);
  const agentPath = `/namespaces/${namespace.id}/agents/${agentId}`;
  const originalAuth = (await fixture.request("GET", agentPath)).data.harnessAuth;
  assert.deepEqual(originalAuth, creation.body.harnessAuth);

  // A later version uses the same saved source. No second login, Secret grant, or
  // authentication mutation is needed merely to configure plugins.
  const loginsBeforeBrowse = gateway.calls.filter(
    (call) => call.operation === "startDeviceAuthorization",
  ).length;
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const savedDiscovery = requests.find(
    (request) => request.method === "POST" && request.path === `${agentPath}/plugins`,
  );
  assert.equal(savedDiscovery.body.credentialSource, undefined);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.harnessAuth, originalAuth);
  assert.equal(
    gateway.calls.filter((call) => call.operation === "startDeviceAuthorization").length,
    loginsBeforeBrowse,
  );
  const sourceGrants = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
  );
  assert.equal(sourceGrants.length, 1);
  assert.equal(sourceGrants[0].body.resourceKind, "credential_source");
  assert.equal(sourceGrants[0].body.resourceId, originalAuth.sourceId);
  await page.locator(".plugin-json > summary").click();
  await page.locator("#agent-plugins").fill("{}");
  const pluginsSaved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await pluginsSaved).status(), 200);
  const edited = (await fixture.request("GET", agentPath)).data;
  assert.deepEqual(edited.harnessAuth, originalAuth);
  assert.deepEqual(edited.plugins, {});

  // A separate ready source already belongs to this Agent for another purpose.
  // Only the external service is simulated; the replacement must preserve its real API binding.
  const otherSource = await fixture.controller.transact(async (state) => {
    const original = await state.credentialSources.findCredentialSource(
      namespace.id,
      originalAuth.sourceId,
    );
    assert.ok(original);
    return state.credentialSources.createCredentialSource({
      ...original,
      id: `cs_${crypto.randomUUID()}`,
      name: "Other credential source",
    });
  });
  gateway.sources.set(otherSource.id, "ready");
  const withOtherSource = await fixture.request("PATCH", agentPath, {
    body: {
      configurationId: edited.configurationId,
      credentialSources: [{ sourceId: originalAuth.sourceId }, { sourceId: otherSource.id }],
    },
  });
  assert.equal(withOtherSource.status, 200, JSON.stringify(withOtherSource.body));

  // Reconnection is a separate, explicit authentication save with a newly completed login.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "credential_source");
  await signInReady(page, advanceApiClock);
  assert.deepEqual((await fixture.request("GET", agentPath)).data.harnessAuth, originalAuth);
  const saved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  const granted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/access-bindings") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON().resourceId !== originalAuth.sourceId,
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await granted).status(), 201);
  const replacedAgent = (await fixture.request("GET", agentPath)).data;
  const replaced = replacedAgent.harnessAuth;
  assert.equal(replaced.method, "credential_source");
  assert.notEqual(replaced.sourceId, originalAuth.sourceId);
  assert.deepEqual(replacedAgent.credentialSources, [
    { sourceId: otherSource.id },
    { sourceId: replaced.sourceId },
  ]);
  const oldSource = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/credential-sources/${originalAuth.sourceId}`,
  );
  assert.equal(oldSource.status, 200);
  assert.equal(
    gateway.calls.some((call) => call.operation === "removeSource"),
    false,
  );
  const replacementGrants = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
  );
  assert.equal(replacementGrants.length, 2);
  assert.equal(replacementGrants[1].body.resourceKind, "credential_source");
  assert.equal(replacementGrants[1].body.resourceId, replaced.sourceId);
  const replacementBrowse = await fixture.request("POST", `${agentPath}/plugins`, { body: {} });
  assert.equal(replacementBrowse.status, 200, JSON.stringify(replacementBrowse.body));

  // Clearing a staged selection immediately restores the saved source. A concurrent save
  // must not adopt the cleared source while the session close is still pending.
  await signInReady(page, advanceApiClock);
  const releaseDiscard = Promise.withResolvers();
  const slowDiscard = Promise.withResolvers();
  await page.route("**/device-authorizations/*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    await releaseDiscard.promise;
    // The test sends the held request itself. The save reloads the view, which aborts the
    // Console's fetch of it: a response arriving after that abort is never reported to the page,
    // and a request still held at the abort never reaches the server, though a browser that
    // sent it at the click would have delivered it.
    let response;
    try {
      response = await route.fetch();
    } catch (error) {
      slowDiscard.reject(error);
      return;
    }
    slowDiscard.resolve(response.status());
    await route.fulfill({ response });
  });
  const discardSent = page.waitForRequest(
    (request) => request.method() === "DELETE" && request.url().includes("/device-authorizations/"),
  );
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await discardSent;
  const racedSave = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await racedSave).status(), 200);
  releaseDiscard.resolve();
  assert.equal(await slowDiscard.promise, 204);
  const retainedAgent = (await fixture.request("GET", agentPath)).data;
  assert.deepEqual(retainedAgent.harnessAuth, replaced);
  assert.deepEqual(retainedAgent.credentialSources, replacedAgent.credentialSources);
  assert.doesNotMatch(
    JSON.stringify(requests),
    new RegExp(`${DEVICE_ACCESS_TOKEN}|private-device`),
  );
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    new RegExp(`${DEVICE_ACCESS_TOKEN}|private-device`),
  );
  assert.equal(
    providerRequests.some((url) => url.includes("revoke") || url.includes("whoami")),
    false,
  );
});

test("saving ChatGPT OAuth before sign-in names the missing step and sends nothing", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth save guard");
  const agent = await fixture.createAgent(
    namespace.id,
    "OAuth save guard",
    nativeValues("oauth-save-guard", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  const save = page.getByRole("button", { name: "Save authentication source", exact: true });
  await save.waitFor();
  await page.getByLabel("Authentication source").selectOption("credential_source");
  await save.click();
  await page.getByText("Complete ChatGPT sign-in before saving.", { exact: true }).waitFor();
  await expectNoText(page, /Service unavailable/);
  await waitForEnabled(save);
  assert.equal(
    requests.some((request) => request.method === "PATCH" && request.path === agentPath),
    false,
  );
  assert.equal((await fixture.request("GET", agentPath)).data.harnessAuth.method, "api_key");
});

// The Installation's capabilities list its Credential Gateway's source types. Without a Codex
// device-login type every start is refused with 501, so Sign in is unavailable before the click,
// described by why. With the type but no Credential Refresh Driver the real API still answers 501:
// the Console then shows the API's reason and keeps Sign in unavailable. Before finding 2991, Sign
// in was offered in both cases, every click was refused again, and the text dropped the reason.
const DEVICE_LOGIN_NOT_OFFERED =
  "ChatGPT sign-in needs a Credential Gateway that offers ChatGPT device login and a Credential Refresh Driver, and this Installation's Drivers do not offer it. Choose another authentication method.";

for (const savedAgent of [false, true]) {
  for (const drivers of ["none", "Credential Gateway only"]) {
    test(`Codex sign-in on ${savedAgent ? "Agent credentials" : "Create Agent"} with ${drivers === "none" ? "no device-login Drivers" : "a Credential Gateway only"} is unavailable and says why`, async (t) => {
      const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth unavailable");
      if (drivers !== "none") {
        const { gateway } = createDeviceCredentialDrivers();
        fixture.controller.registerDriver(gateway);
        fixture.controller.selectDriver(gateway.capability, gateway.id);
      }
      const agent = savedAgent
        ? await fixture.createAgent(
            namespace.id,
            "OAuth unavailable",
            nativeValues("oauth-unavailable", { harnessId: "codex" }),
            { executionMode: "dedicated" },
          )
        : null;
      const { page } = await newPage(t, fixture);
      const requests = apiRequests(page, fixture.origin);
      await login(
        page,
        fixture,
        agent
          ? `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`
          : `/console/agents/new?namespace=${namespace.id}`,
      );
      if (!agent) {
        await page.getByRole("button", { name: "Start without Preset" }).click();
      }
      await page
        .getByLabel(agent ? "Authentication source" : "Authentication method")
        .selectOption("credential_source");
      const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
      const beginPath = `/namespaces/${namespace.id}/agents${agent ? `/${agent.id}` : ""}/device-authorizations`;
      const starts = () =>
        requests.filter(({ method, path }) => method === "POST" && path === beginPath).length;
      let reason = DEVICE_LOGIN_NOT_OFFERED;
      if (drivers === "none") {
        await page.getByText(reason, { exact: true }).waitFor();
      } else {
        await waitForEnabled(start);
        const refused = page.waitForResponse(
          (response) => new URL(response.url()).pathname === beginPath,
        );
        await start.click();
        const answer = await refused;
        assert.equal(answer.status(), 501);
        assert.equal((await answer.json()).error.message, DEVICE_LOGIN_NOT_CONFIGURED);
        reason = `ChatGPT sign-in is unavailable for this Installation. ${DEVICE_LOGIN_NOT_CONFIGURED} Choose another authentication method.`;
        await page.getByText(reason, { exact: true }).waitFor();
      }
      assert.equal(await page.getByRole("link", { name: "Open Codex sign-in" }).isVisible(), false);
      // Sign in stays in the Tab order, described by the reason, and starts nothing.
      assert.equal(await start.getAttribute("aria-disabled"), "true");
      await start.focus();
      assert.equal(
        await start.evaluate((node) => node === globalThis.document.activeElement),
        true,
      );
      assert.equal(
        await start.evaluate((node) =>
          (node.getAttribute("aria-describedby") ?? "")
            .split(/\s+/)
            .map((id) => globalThis.document.getElementById(id)?.textContent)
            .join(" "),
        ),
        reason,
      );
      await page.keyboard.press("Enter");
      await start.dispatchEvent("click");
      await settlePageRequests(page);
      assert.equal(starts(), drivers === "none" ? 0 : 1);
    });
  }
}

test("Codex sign-in cannot repeat a start with an unreadable confirmation", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth unconfirmed");
  const { gateway, refresh } = createDeviceCredentialDrivers();
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
  await waitForEnabled(start);

  const namespacePath = `/namespaces/${namespace.id}`;
  const beginPath = `${namespacePath}/agents/device-authorizations`;
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**${beginPath}`, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body = await response.json();
    assert.equal(body.data.status, "pending");
    // The real start committed. Lose its session reference only in the reply reaching the page.
    const sessionId = body.data.session.id;
    const session = await fixture.request("GET", `${namespacePath}/secrets/${sessionId}`);
    assert.equal(session.status, 200);
    assert.equal(session.data.id, sessionId);
    delete body.data.session;
    await route.fulfill({ response, json: body });
  });
  await start.click();
  await waitForSettledFetches(page, beginPath, 1);
  assert.equal(await start.isDisabled(), true, "a login may already exist");
  await page
    .getByText(
      /may have started.*until an Installation administrator investigates the pending attempt/i,
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Cancel login" }).isVisible(), false);

  // Changing the method rerenders the controls. Even a delivered click must not repeat Begin.
  const method = page.getByLabel("Authentication method");
  await method.selectOption("api_key");
  await method.selectOption("credential_source");
  assert.equal(await start.isDisabled(), true);
  await start.dispatchEvent("click");
  await settlePageRequests(page);
  assert.deepEqual(
    requests
      .filter(({ path }) => path.includes(beginPath))
      .map(({ method, path }) => [method, path]),
    [["POST", beginPath]],
  );
});

// Hold a real committed start at the browser boundary: navigating away aborts its
// response, but must not erase the attempt from either authentication form's draft.
for (const savedAgent of [false, true]) {
  test(`an interrupted OAuth start stays blocked after returning to ${savedAgent ? "Agent credentials" : "Create Agent"}`, async (t) => {
    const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth navigation");
    const { gateway, refresh } = createDeviceCredentialDrivers({ approve: async () => false });
    for (const driver of [gateway, refresh]) {
      fixture.controller.registerDriver(driver);
      fixture.controller.selectDriver(driver.capability, driver.id);
    }
    const agent = savedAgent
      ? await fixture.createAgent(
          namespace.id,
          "OAuth navigation",
          nativeValues("oauth-navigation", { harnessId: "codex" }),
          { executionMode: "dedicated" },
        )
      : null;
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await trackSettledFetches(page);
    await login(
      page,
      fixture,
      agent
        ? `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`
        : `/console/agents/new?namespace=${namespace.id}`,
    );
    if (!agent) {
      await page.getByRole("button", { name: "Start without Preset" }).click();
    }
    const methodLabel = agent ? "Authentication source" : "Authentication method";
    await page.getByLabel(methodLabel).selectOption("credential_source");
    const committed = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    const beginPath = `/namespaces/${namespace.id}/agents${agent ? `/${agent.id}` : ""}/device-authorizations`;
    await page.route(`**${beginPath}`, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      committed.resolve((await response.json()).data.session.id);
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
    const sessionId = await committed.promise;
    assert.equal(gateway.sources.size, 1);
    assert.equal(
      (await fixture.request("GET", `/namespaces/${namespace.id}/secrets/${sessionId}`)).status,
      200,
    );
    await page.getByRole("link", { name: "Secrets", exact: true }).click();
    await page.waitForURL("**/console/secrets?**");
    release.resolve();
    await waitForSettledFetches(page, beginPath, 1);
    await page.goBack();
    await page.getByLabel(methodLabel).waitFor();
    const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
    assert.equal(await start.isDisabled(), true, "the committed start lost its confirmation");
    await page
      .getByText(
        /may have started.*until an Installation administrator investigates the pending attempt/i,
      )
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Cancel login", exact: true }).isVisible(),
      false,
    );
    // Method changes rerender controls; even a delivered click cannot repeat the write.
    await page.getByLabel(methodLabel).selectOption("api_key");
    await page.getByLabel(methodLabel).selectOption("credential_source");
    await start.dispatchEvent("click");
    await settlePageRequests(page);
    assert.equal(
      requests.filter(({ method, path }) => method === "POST" && path === beginPath).length,
      1,
    );
    assert.equal(gateway.sources.size, 1);
  });
}

const WAITING = "Waiting for you to complete sign-in in the other tab…";

// A saved Agent's Credentials tab with ChatGPT OAuth selected, on fixture Gateway and Refresh
// Drivers whose sign-in stays pending.
async function openAgentOAuth(t, name) {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, name);
  const { gateway, refresh } = createDeviceCredentialDrivers({ approve: async () => false });
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const agent = await fixture.createAgent(
    namespace.id,
    name,
    nativeValues(name.toLowerCase().replaceAll(" ", "-"), { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await trackSettledFetches(page);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source").selectOption("credential_source");
  const beginPath = `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`;
  return {
    fixture,
    gateway,
    page,
    beginPath,
    start: page.getByRole("button", { name: "Sign in with OAuth", exact: true }),
    // Every start the API received; a kept or recorded reply never sends a second one.
    starts: () =>
      requests.filter(({ method, path }) => method === "POST" && path === beginPath).length,
  };
}

// Holds the next start's real API answer at the browser boundary until `release()`.
async function holdNextStart(t, { page, beginPath }) {
  const answered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route(
    `**${beginPath}`,
    async (route) => {
      const response = await route.fetch();
      answered.resolve({ status: response.status(), body: await response.json() });
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    },
    { times: 1 },
  );
  return { answered: answered.promise, release: () => release.resolve() };
}

async function showTab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
  await page.getByRole("tab", { name, exact: true, selected: true }).waitFor();
}

// Saves the draft's Configuration from its tab, which rebuilds every other tab from its draft.
async function saveConfiguration(page, name) {
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill(JSON.stringify(nativeValues(name, { harnessId: "codex" }), null, 2));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
}

// The delivered challenge shows: its code, and Cancel login for this known session.
async function expectChallenge(page, userCode) {
  await page.getByText(WAITING, { exact: true }).waitFor();
  assert.equal(await page.locator(".device-login-code").textContent(), userCode);
  assert.equal(
    await page.getByRole("button", { name: "Cancel login", exact: true }).isEnabled(),
    true,
  );
  await expectNoText(page, /may have started/i);
}

// Sign in and Cancel login replace each other in place, and each is unavailable while its
// request runs. A keyboard reader keeps focus through the start, its reply and the cancel: on Sign
// in while "Checking Codex login…" shows, then on Cancel login, then on Sign in again. Before
// finding 2992, each press dropped focus to the page body.
test("Sign in with OAuth and Cancel login keep keyboard focus", async (t) => {
  const oauth = await openAgentOAuth(t, "OAuth focus");
  const { page, start } = oauth;
  const focused = () =>
    page.evaluate(() =>
      globalThis.document.activeElement === globalThis.document.body
        ? "BODY"
        : globalThis.document.activeElement?.textContent,
    );
  const held = await holdNextStart(t, oauth);
  await waitForIdleFetches(page);
  await start.focus();
  await page.keyboard.press("Enter");
  await held.answered;
  await page.getByText("Checking Codex login…", { exact: true }).waitFor();
  assert.equal(await focused(), "Sign in with OAuth");
  // Enter again while the start runs sends nothing.
  await page.keyboard.press("Enter");
  held.release();
  await page.getByText(WAITING, { exact: true }).waitFor();
  assert.equal(await focused(), "Cancel login");
  await page.keyboard.press("Enter");
  await page.getByText("Sign in to connect your ChatGPT account.", { exact: true }).waitFor();
  assert.equal(await focused(), "Sign in with OAuth");
  await waitForEnabled(start);
  assert.equal(await focused(), "Sign in with OAuth");
  await settlePageRequests(page);
  assert.equal(oauth.starts(), 1);
});

// Focus moves only off the control the reader pressed. A reader who moved on while the start ran
// keeps focus where they put it when the reply replaces Sign in with Cancel login.
test("a start's reply leaves focus where the reader moved it", async (t) => {
  const oauth = await openAgentOAuth(t, "OAuth focus elsewhere");
  const { page, start } = oauth;
  const held = await holdNextStart(t, oauth);
  await waitForIdleFetches(page);
  await start.focus();
  await page.keyboard.press("Enter");
  await held.answered;
  const source = page.getByLabel("Authentication source");
  await source.focus();
  held.release();
  await page.getByText(WAITING, { exact: true }).waitFor();
  await settlePageRequests(page);
  assert.equal(await source.evaluate((node) => node === globalThis.document.activeElement), true);
});

// A start's reply that lands after the reader switched to another tab of the same Agent page
// belongs to the Credentials tab, which is kept while the start is pending (finding 2980). Before
// the fix, the reply was dropped and the return rebuilt the tab from its draft: a usable challenge
// showed as an unconfirmed start that only an administrator could clear, and a confirmed refusal
// as the same, instead of permitting a retry.
for (const refused of [false, true]) {
  test(`an OAuth start ${refused ? "refused" : "answered"} while another Agent tab shows lands in Credentials`, async (t) => {
    const oauth = await openAgentOAuth(t, "OAuth tab switch");
    const { page } = oauth;
    // The real Native IAM Driver refuses the start without Secret create.
    if (refused) {
      revokeAdministratorGrant(oauth.fixture, ["create", "secret"]);
    }
    const held = await holdNextStart(t, oauth);
    await waitForIdleFetches(page);
    await oauth.start.click();
    const { status, body } = await held.answered;
    assert.equal(status, refused ? 403 : 200);
    await showTab(page, "Configuration");
    held.release();
    await waitForSettledFetches(page, oauth.beginPath, 1);

    await showTab(page, "Credentials");
    if (refused) {
      // A confirmed refusal permits a retry, as it does while the tab shows.
      await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
      assert.equal(await oauth.start.isEnabled(), true, "a confirmed refusal blocked a retry");
      await expectNoText(page, /may have started/i);
    } else {
      await expectChallenge(page, body.data.userCode);
      assert.equal(await oauth.start.isVisible(), false);
    }
    await settlePageRequests(page);
    assert.equal(oauth.starts(), 1);
    assert.equal(oauth.gateway.sources.size, refused ? 0 : 1);
  });
}

// A start that is not the tab's first write is kept the same way (findings 2980, 2981): after a
// refused start, or after a poll and Cancel login withdrew an earlier login. The tab shows the
// outcome of its own start, poll and cancel, so those writes alone do not make it stale. Before the
// fix, they did, and the return rebuilt the tab from its draft, which cannot name a refusal.
for (const before of ["a refused start", "Cancel login"]) {
  for (const refused of before === "Cancel login" ? [false, true] : [false]) {
    test(`an OAuth start after ${before} ${refused ? "refused" : "answered"} while another Agent tab shows lands in Credentials`, async (t) => {
      const oauth = await openAgentOAuth(t, "OAuth second start");
      const { page, start } = oauth;
      // Fetches the tab may still have in flight; none may be, or the tab is not kept.
      let idle = {};
      if (before === "Cancel login") {
        const first = page.waitForResponse(
          (response) => new URL(response.url()).pathname === oauth.beginPath,
        );
        await start.click();
        const { session } = (await (await first).json()).data;
        await page.getByText(WAITING, { exact: true }).waitFor();
        // Let the login poll once (the fixture interval is 5 s): the poll is the tab's write too.
        const polled = await page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `${oauth.beginPath}/${session.id}/poll`,
        );
        assert.equal(polled.status(), 200);
        await page.getByText(WAITING, { exact: true }).waitFor();
        await page.getByRole("button", { name: "Cancel login", exact: true }).click();
        await page.getByText("Sign in to connect your ChatGPT account.", { exact: true }).waitFor();
        // The Console never reads the cancel's empty 204 body, so the fetch hook keeps
        // counting it in flight although the tab's request has settled.
        idle = { except: `${oauth.beginPath}/${session.id}` };
      } else {
        // The real Native IAM Driver refuses the first start without Secret create.
        const restoreCreate = revokeAdministratorGrant(oauth.fixture, ["create", "secret"]);
        await start.click();
        await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
        restoreCreate();
      }
      await waitForEnabled(start);
      if (refused) {
        revokeAdministratorGrant(oauth.fixture, ["create", "secret"]);
      }
      const held = await holdNextStart(t, oauth);
      await waitForIdleFetches(page, idle);
      await start.click();
      const { status, body } = await held.answered;
      assert.equal(status, refused ? 403 : 200);
      await showTab(page, "Configuration");
      held.release();
      await waitForSettledFetches(page, oauth.beginPath, 2);

      await showTab(page, "Credentials");
      if (refused) {
        // The kept tab shows the refusal itself; a tab rebuilt from its draft could not name it.
        await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
        assert.equal(await start.isEnabled(), true);
        await expectNoText(page, /may have started/i);
      } else {
        await expectChallenge(page, body.data.userCode);
      }
      await settlePageRequests(page);
      assert.equal(oauth.starts(), 2);
      if (before === "a refused start") {
        assert.equal(oauth.gateway.sources.size, 1);
      }
    });
  }
}

// A Configuration save on another tab rebuilds the Credentials tab from its draft. A start
// answered after the reader left the tab records its outcome in that draft, whether the reply
// lands before the save or after it (finding 2981). Before the fix, the draft still said the
// start was unconfirmed, so a delivered code was lost and a refusal blocked a retry.
for (const replyFirst of [true, false]) {
  for (const refused of [false, true]) {
    test(`an OAuth start ${refused ? "refused" : "answered"} ${replyFirst ? "before" : "after"} a Configuration save on another Agent tab lands in Credentials`, async (t) => {
      const oauth = await openAgentOAuth(t, "OAuth save");
      const { page } = oauth;
      if (refused) {
        revokeAdministratorGrant(oauth.fixture, ["create", "secret"]);
      }
      const held = await holdNextStart(t, oauth);
      await waitForIdleFetches(page);
      await oauth.start.click();
      const { status, body } = await held.answered;
      assert.equal(status, refused ? 403 : 200);
      await showTab(page, "Configuration");
      if (replyFirst) {
        held.release();
        await waitForSettledFetches(page, oauth.beginPath, 1);
      }
      await saveConfiguration(page, "oauth-save-v2");
      if (!replyFirst) {
        held.release();
        await waitForSettledFetches(page, oauth.beginPath, 1);
      }

      await showTab(page, "Credentials");
      if (refused) {
        // The draft records the refusal as no login, so sign-in is offered again.
        await waitForEnabled(oauth.start);
        await expectNoText(page, /may have started/i);
      } else {
        await expectChallenge(page, body.data.userCode);
      }
      await settlePageRequests(page);
      assert.equal(oauth.starts(), 1);
    });
  }
}

// A Credentials tab built before the reply landed owns the draft from then on: the earlier tab
// never records over it, so this tab's later edit survives the next rebuild (finding 2981).
test("an OAuth start answered after a newer Credentials tab was built keeps that tab's draft", async (t) => {
  const oauth = await openAgentOAuth(t, "OAuth newer tab");
  const { page } = oauth;
  const held = await holdNextStart(t, oauth);
  await waitForIdleFetches(page);
  await oauth.start.click();
  await held.answered;
  await showTab(page, "Configuration");
  await saveConfiguration(page, "oauth-newer-tab-v2");
  // The newer tab is built from the draft taken before the reply: the start is unconfirmed.
  await showTab(page, "Credentials");
  await page.getByText(/may have started/i).waitFor();
  await page.getByLabel("Authentication source").selectOption("api_key");
  await showTab(page, "Configuration");
  held.release();
  await waitForSettledFetches(page, oauth.beginPath, 1);
  await saveConfiguration(page, "oauth-newer-tab-v3");

  await showTab(page, "Credentials");
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "api_key");
  await settlePageRequests(page);
  assert.equal(oauth.starts(), 1);
});

// A refused device login names what the API checked for that request (finding 2577). Create
// Agent's start checks Agent create, Secret create and credential source create in the Namespace,
// which only an Installation administrator holds. The real Native IAM Driver refuses each request
// below after the administrator's grant is removed from its Role.
test("a refused device login start on Create Agent names the create grants it checks", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth start refused");
  // Drivers that offer device login, so Sign in is offered and the grants decide.
  const { gateway, refresh } = createDeviceCredentialDrivers();
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  revokeAdministratorGrant(fixture, ["create", "secret"]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  const refused = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/namespaces/${namespace.id}/agents/device-authorizations`,
  );
  await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
  assert.equal((await refused).status(), 403);
  await page.getByText(DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
});

// Only an Installation administrator reads the Installation. A member's refused read says nothing
// about the Drivers, so Sign in stays offered and the API's answer decides (finding 2991): here its
// 403 names the grants, never the Drivers reason.
test("a member's refused Installation read leaves Sign in offered on Create Agent", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth member");
  const { gateway, refresh } = createDeviceCredentialDrivers();
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const member = await fixture.createNamespaceMember("oauth-member", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const installationRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/installation",
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  assert.equal((await installationRead).status(), 403);
  await page.getByText("Sign in to connect your ChatGPT account.", { exact: true }).waitFor();
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
  assert.equal(await start.getAttribute("aria-disabled"), null);
  const refused = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/namespaces/${namespace.id}/agents/device-authorizations`,
  );
  await start.click();
  assert.equal((await refused).status(), 403);
  await page.getByText(DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
});

// From Agent detail, each request checks Agent read and update on that Agent. A start also
// creates a Secret and a credential source; a poll or cancel checks Secret operate on the login's
// Secret, which a Namespace Role can grant, so those name the grants to ask for instead.
test("a refused device login on Agent detail names the grants its start, poll and cancel check", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth Agent refused");
  const { gateway, refresh } = createDeviceCredentialDrivers();
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
  const agent = await fixture.createAgent(
    namespace.id,
    "OAuth Agent refused",
    nativeValues("oauth-agent-refused", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const loginsPath = `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`;
  const answers = [];
  const { page } = await newPage(t, fixture);
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.startsWith(loginsPath)) {
      answers.push(
        `${response.request().method()} ${pathname.slice(loginsPath.length)} ${response.status()}`,
      );
    }
  });
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source").selectOption("credential_source");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });

  // Without Secret create the start is refused before any login exists.
  const restoreCreate = revokeAdministratorGrant(fixture, ["create", "secret"]);
  await start.click();
  await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
  assert.deepEqual(answers, ["POST  403"]);

  // With the grant back the login starts. Removing Secret operate then refuses its poll, which
  // the Console sends after the login's 5 s interval, and its cancel.
  restoreCreate();
  await waitForEnabled(start);
  await start.click();
  await page
    .getByText("Waiting for you to complete sign-in in the other tab…", { exact: true })
    .waitFor();
  revokeAdministratorGrant(fixture, ["operate", "secret"]);
  await page.getByText(AGENT_DEVICE_LOGIN_POLL_DENIED, { exact: true }).waitFor({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Cancel login", exact: true }).click();
  await page.getByText(AGENT_DEVICE_LOGIN_CANCEL_DENIED, { exact: true }).waitFor();
  assert.deepEqual(
    answers.map((answer) => answer.replace(/\/[^/ ]+(\/poll)? /, "/{login}$1 ")),
    ["POST  403", "POST  200", "POST /{login}/poll 403", "DELETE /{login} 403"],
  );
});

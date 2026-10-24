import assert from "node:assert/strict";
import test from "node:test";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  createDeviceCredentialDrivers,
  DEVICE_ACCESS_TOKEN,
  DEVICE_ACCOUNT_ID,
} from "../helpers/device-credential-gateway.mjs";
import {
  apiRequests,
  expectNoText,
  login,
  nativeValues,
  newPage,
  settlePageRequests,
  trackSettledFetches,
  waitForEnabled,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";
import { createReadyConsoleNamespace } from "./console-ready-namespace.mjs";

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
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/namespaces/${namespace.id}/agents`,
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const createResponse = await created;
  assert.equal(createResponse.status(), 201, await createResponse.text());
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

test("Codex sign-in can retry a refused start but cannot repeat one with an unreadable confirmation", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth unavailable");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
  await start.click();
  await page
    .getByText(
      "ChatGPT sign-in is unavailable for this Installation. Choose another authentication method.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("link", { name: "Open Codex sign-in" }).isVisible(), false);
  await waitForEnabled(start);

  const { gateway, refresh } = createDeviceCredentialDrivers();
  for (const driver of [gateway, refresh]) {
    fixture.controller.registerDriver(driver);
    fixture.controller.selectDriver(driver.capability, driver.id);
  }
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
  await waitForSettledFetches(page, beginPath, 2);
  assert.equal(await start.isDisabled(), true, "a login may already exist");
  await page
    .getByText(/may have started.*until an administrator investigates the pending attempt/i)
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

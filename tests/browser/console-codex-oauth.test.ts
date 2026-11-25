import { submitCreateAgent } from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { APIResponse, Page, Route } from "playwright";
import type { Agent, HarnessAuthBinding, Namespace } from "@openclaw-enterprise/contracts";
import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createDeviceCredentialDrivers } from "../helpers/device-credential-gateway.ts";
import {
  controlDeviceIssuer,
  installDeviceTokenService,
  DEVICE_ACCOUNT_ID,
  DEVICE_OAUTH_ACCESS_TOKEN,
  DEVICE_OAUTH_REFRESH_TOKEN,
  type DeviceIssuerOptions,
} from "../helpers/device-token-service.ts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import type { PlatformStateStore } from "../../packages/occ/src/index.ts";
import {
  MEMBER_WRITE,
  apiRequests,
  expectNoText,
  holdRequests,
  login,
  nativeValues,
  newPage,
  revokeAdministratorGrant,
  settlePageRequests,
  waitForEnabled,
} from "./console-agents-browser-helpers.ts";
import {
  trackSettledFetches,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-fetch-accounting.ts";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.ts";
import { within } from "../helpers/wait-for.ts";
import {
  AGENT_DEVICE_LOGIN_CANCEL_DENIED,
  AGENT_DEVICE_LOGIN_START_DENIED,
  DEVICE_LOGIN_START_DENIED,
} from "../helpers/refusal-text.mjs";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  assert.ok(isJsonObject(value));
  return value;
}

function jsonString(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

function responseData(value: unknown): Record<string, unknown> {
  return jsonObject(jsonObject(value).data);
}

function assertSourceAuth(
  value: unknown,
): asserts value is Extract<HarnessAuthBinding, { method: "credential_source" }> {
  const auth = jsonObject(value);
  assert.equal(auth.method, "credential_source");
  assert.ok(typeof auth.sourceId === "string");
}

function sourceAuth(value: unknown): Extract<HarnessAuthBinding, { method: "credential_source" }> {
  assertSourceAuth(value);
  return value;
}

function assertResourceIdentity(value: unknown): asserts value is Pick<Namespace | Agent, "id"> {
  assert.ok(typeof jsonObject(value).id === "string");
}

function agentIdentity(value: unknown): Pick<Agent, "id"> {
  assertResourceIdentity(value);
  return value;
}

async function createOAuthConsoleNamespace(
  t: TestContext,
  name: string,
  options?: Parameters<typeof createReadyConsoleNamespace>[2],
  issuerOptions?: DeviceIssuerOptions,
) {
  const secrets = createTestSecretDriver({ id: "console-oauth-secret" });
  let state: PlatformStateStore | undefined;
  const result = await createReadyConsoleNamespace(t, name, {
    ...options,
    secretDriver: secrets,
    wrapState(current: PlatformStateStore) {
      state = current;
      return current;
    },
  });
  assert.ok(state);
  const { owner } = await installDeviceTokenService(result.fixture.controller, state, secrets);
  const issuer = controlDeviceIssuer(t, issuerOptions);
  return { ...result, issuer, owner };
}

async function sourceCount(
  fixture: Awaited<ReturnType<typeof createReadyConsoleNamespace>>["fixture"],
  namespaceId: string,
) {
  return fixture.controller.transact(
    async (state) => (await state.credentialSources.listCredentialSources(namespaceId)).length,
  );
}

// The fixture's login asks the Console to poll every 5 s, and the API refuses an earlier poll.
// Each ready login moves both clocks past that interval instead of waiting it out.
const DEVICE_POLL_MS = 5_000;

async function signInReady(page: Page, advanceApiClock: (ms: number) => void) {
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

test("Codex OAuth console saves and reuses a Source for Agent creation and plugin editing", async (t) => {
  let apiClockAheadMs = 0;
  const advanceApiClock = (ms: number) => {
    apiClockAheadMs += ms;
  };
  let approved = false;
  const { fixture, namespace, issuer, owner } = await createOAuthConsoleNamespace(
    t,
    "OAuth console",
    {
      provisionedPeople: [],
      agentProvisioning: true,
      now: () => new Date(Date.now() + apiClockAheadMs),
    },
    { approve: async () => approved },
  );
  const installation = await fixture.request("GET", "/installation");
  assert.deepEqual(
    jsonObject(jsonObject(jsonObject(installation.data).capabilities).agentProvisioning)
      .executionModes,
    ["dedicated"],
  );
  const driver = new CodexPluginDriver();
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const issuerFetch = globalThis.fetch;
  const providerRequests: string[] = [];
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
  // Only issuer and hosted catalog HTTP are controlled. Console, Fastify, selected TokenService,
  // IAM, Source/session persistence and the production Plugin Driver run unchanged.
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.ok(typeof input === "string" || input instanceof Request);
      const url = typeof input === "string" ? input : input.url;
      if (!url.startsWith("https://chatgpt.com/")) {
        return issuerFetch(input, init);
      }
      providerRequests.push(url);
      const headers = jsonObject(init?.headers);
      assert.equal(headers.Authorization, `Bearer ${DEVICE_OAUTH_ACCESS_TOKEN}`);
      assert.equal(headers["ChatGPT-Account-ID"], DEVICE_ACCOUNT_ID);
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
    },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).isVisible(), false);
  // The Console polls only after the interval the login asks for, and follows a longer one a
  // poll answer asks for, as a provider's slow_down does (finding 1651). Each poll is held, so
  // one sent early leaves the busy status shown when the clock stops short of the interval.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1_000));
  let polls = 0;
  let nextPoll = Promise.withResolvers<Route>();
  await page.route("**/device-authorizations/*/poll", async (route) => {
    polls += 1;
    nextPoll.resolve(route);
  });
  const pollStatus = page.locator(".device-login [role='status']");
  const waiting = "Waiting for you to complete sign-in in the other tab…";
  const checking = "Checking Codex login…";
  async function answerPoll(intervalSeconds: number) {
    await page.getByText(checking, { exact: true }).waitFor();
    const route = await within(nextPoll.promise, "the Console's next poll");
    nextPoll = Promise.withResolvers<Route>();
    const response = await route.fetch();
    const body: unknown = await response.json();
    const data = responseData(body);
    assert.equal(data.status, "pending");
    assert.equal(data.intervalSeconds, 5);
    data.intervalSeconds = intervalSeconds;
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
  assert.ok(started[1]);
  assert.deepEqual(started[1].body, { harnessId: "codex" });
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Add Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const discovery = requests.find(
    (request) =>
      request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents/plugins`,
  );
  assert.ok(discovery);
  const discoveryBody = jsonObject(discovery.body);
  assert.equal(jsonObject(discoveryBody.credentialSource).kind, "credential_source");
  await page.getByLabel("Agent name", { exact: true }).fill("OAuth Agent");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
  await page.getByRole("heading", { name: "OAuth Agent", exact: true }).waitFor();
  const creation = requests.find(
    (request) => request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents`,
  );
  assert.ok(creation);
  const creationBody = jsonObject(creation.body);
  // Even when dedicated provisioning is advertised, source auth uses the supported
  // draft creation path. The durable provisioning API rejects source auth.
  assert.equal(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/agents/provision"),
    ),
    false,
  );
  assert.deepEqual(creationBody.harnessAuth, {
    method: "credential_source",
    sourceId: jsonObject(discoveryBody.credentialSource).id,
  });
  assert.deepEqual(creationBody.credentialSources, [
    { sourceId: jsonObject(discoveryBody.credentialSource).id },
  ]);
  assert.ok(jsonObject(creationBody.plugins)["codex-plugin:calendar@openai-curated-remote"]);
  const agentId = new URL(page.url()).pathname.split("/").at(-1);
  const agentPath = `/namespaces/${namespace.id}/agents/${agentId}`;
  const originalAuth = sourceAuth(
    jsonObject((await fixture.request("GET", agentPath)).data).harnessAuth,
  );
  assert.deepEqual(originalAuth, creationBody.harnessAuth);

  // A later version uses the same saved source. No second login, Secret grant, or
  // authentication mutation is needed merely to configure plugins.
  const loginsBeforeBrowse = issuer.operations.filter((operation) => operation === "start").length;
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
  assert.ok(savedDiscovery);
  const savedDiscoveryBody = jsonObject(savedDiscovery.body);
  assert.equal(savedDiscoveryBody.credentialSource, undefined);
  assert.deepEqual(
    jsonObject((await fixture.request("GET", agentPath)).data).harnessAuth,
    originalAuth,
  );
  assert.equal(
    issuer.operations.filter((operation) => operation === "start").length,
    loginsBeforeBrowse,
  );
  const sourceGrants = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
  );
  assert.equal(sourceGrants.length, 1);
  assert.ok(sourceGrants[0]);
  assert.equal(jsonObject(sourceGrants[0].body).resourceKind, "credential_source");
  assert.equal(jsonObject(sourceGrants[0].body).resourceId, originalAuth.sourceId);
  await page.locator(".plugin-json > summary").click();
  await page.locator("#agent-plugins").fill("{}");
  const pluginsSaved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save plugin selections", exact: true }).click();
  assert.equal((await pluginsSaved).status(), 200);
  const edited = jsonObject((await fixture.request("GET", agentPath)).data);
  assert.deepEqual(edited.harnessAuth, originalAuth);
  assert.deepEqual(edited.plugins, {});

  // Reconnection is a separate, explicit authentication save with a newly completed login.
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "credential_source");
  await page.getByLabel("Authentication source").selectOption("device_login");
  await signInReady(page, advanceApiClock);
  assert.deepEqual(
    jsonObject((await fixture.request("GET", agentPath)).data).harnessAuth,
    originalAuth,
  );
  const saved = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  const granted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/access-bindings") &&
      response.request().method() === "POST" &&
      jsonObject(response.request().postDataJSON()).resourceId !== originalAuth.sourceId,
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await granted).status(), 201);
  const replacedAgent = jsonObject((await fixture.request("GET", agentPath)).data);
  const replaced = sourceAuth(replacedAgent.harnessAuth);
  assert.equal(replaced.method, "credential_source");
  assert.notEqual(replaced.sourceId, originalAuth.sourceId);
  assert.deepEqual(replacedAgent.credentialSources, [{ sourceId: replaced.sourceId }]);
  // Replacing the Agent selection leaves the previously authorized Source available.
  const oldSource = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/credential-sources/${originalAuth.sourceId}`,
  );
  assert.equal(oldSource.status, 200);
  assert.equal(jsonObject(oldSource.data).type, "oauth2-refresh-token");
  const replacementGrants = requests.filter(
    (request) => request.method === "POST" && request.path.endsWith("/access-bindings"),
  );
  assert.equal(replacementGrants.length, 2);
  assert.ok(replacementGrants[1]);
  assert.equal(jsonObject(replacementGrants[1].body).resourceKind, "credential_source");
  assert.equal(jsonObject(replacementGrants[1].body).resourceId, replaced.sourceId);
  const replacementBrowse = await fixture.request("POST", `${agentPath}/plugins`, { body: {} });
  assert.equal(replacementBrowse.status, 200, JSON.stringify(replacementBrowse.body));

  // Clearing a staged selection immediately restores the saved source. A concurrent save
  // must not adopt the cleared source while the session close is still pending.
  await page.getByLabel("Authentication source").selectOption("device_login");
  await signInReady(page, advanceApiClock);
  const releaseDiscard = Promise.withResolvers<void>();
  const slowDiscard = Promise.withResolvers<number>();
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
    let response: APIResponse;
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
  assert.equal(
    await page
      .getByLabel("Authentication source")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  const racedSave = page.waitForResponse(
    (response) => response.url().endsWith(agentPath) && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.equal((await racedSave).status(), 200);
  releaseDiscard.resolve();
  assert.equal(await within(slowDiscard.promise, "the server's answer to the held discard"), 204);
  // The save rebuilds the draft after its PATCH response. Wait for that rebuild before
  // navigating, so its late completion cannot replace the Credentials inventory.
  await page.getByText("Authentication source saved.", { exact: true }).waitFor();
  const retainedAgent = jsonObject((await fixture.request("GET", agentPath)).data);
  assert.deepEqual(retainedAgent.harnessAuth, replaced);
  assert.deepEqual(retainedAgent.credentialSources, replacedAgent.credentialSources);
  // The Namespace inventory uses the actual filtered collection route for both OAuth Sources
  // created by the controlled issuer flow, including the retained Source from before replacement.
  const collectionPath = `/namespaces/${namespace.id}/credential-sources`;
  const collectionRead = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === collectionPath && response.request().method() === "GET",
  );
  await page.getByRole("link", { name: "Credentials", exact: true }).click();
  const collectionResponse = await collectionRead;
  assert.equal(collectionResponse.status(), 200);
  const collectionBody = await collectionResponse.json();
  const listed = jsonObject(collectionBody).data;
  assert.ok(Array.isArray(listed));
  const sources = page.getByRole("table", { name: "Credential Sources", exact: true });
  for (const sourceId of [originalAuth.sourceId, replaced.sourceId]) {
    assert.ok(listed.some((source) => jsonObject(source).id === sourceId));
    const row = sources.getByRole("row").filter({ hasText: sourceId });
    await row.getByText("OAuth refresh token", { exact: true }).waitFor();
  }
  const serializedRequests = JSON.stringify(requests);
  const serializedCollection = JSON.stringify(collectionBody);
  const bodyText = await page.locator("body").innerText();
  assert.ok(issuer.handles.size > 0, "the issuer must issue a private device handle");
  for (const credential of [
    DEVICE_OAUTH_ACCESS_TOKEN,
    DEVICE_OAUTH_REFRESH_TOKEN,
    ...issuer.handles,
  ]) {
    assert.equal(
      serializedRequests.includes(credential),
      false,
      "browser API requests must not contain credential material",
    );
    assert.equal(
      serializedCollection.includes(credential),
      false,
      "the Source collection must not contain credential material",
    );
    assert.equal(
      bodyText.includes(credential),
      false,
      "visible body text must not contain credential material",
    );
  }
  // A Template OAuth Source is a valid readable OAuth credential, but it does not carry the
  // built-in Codex consent needed to authenticate this model provider.
  const externalIssuer = "https://issuer.example.test";
  const template = await fixture.request("POST", "/connection-templates", {
    body: {
      namespaceId: namespace.id,
      displayName: "External account",
      mode: "manual",
      issuer: externalIssuer,
      authorizationUrl: `${externalIssuer}/authorize`,
      tokenUrl: `${externalIssuer}/token`,
      scopes: ["read"],
      destinations: [{ host: "api.example.test", path: "/v1/**" }],
    },
  });
  assert.equal(template.status, 201);
  const templateData = jsonObject(template.data);
  const client = await fixture.request("POST", "/credential-clients", {
    body: {
      kind: "oauth2",
      namespaceId: namespace.id,
      issuer: externalIssuer,
      tokenUrl: `${externalIssuer}/token`,
      displayName: "External account client",
      clientId: "public-fixture-client",
      tokenEndpointAuthMethod: "none",
    },
  });
  assert.equal(client.status, 201);
  const templateSource = await owner.createSource(
    {
      type: "oauth2-refresh-token",
      namespaceId: namespace.id,
      name: "External OAuth account",
      connectionTemplateId: jsonString(templateData.id),
      consent: {
        kind: "connection_template",
        version: Number(jsonObject(templateData.current).version),
        oauthClientId: jsonString(jsonObject(client.data).id),
        ownerPrincipalId: fixture.principal.id,
      },
      grant: {
        accessToken: "external-access-fixture",
        refreshToken: "external-refresh-fixture",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestedScopes: ["read"],
        grantedScopes: ["read"],
      },
    },
    t.signal,
  );

  // Reuse the already issued built-in Source through the actual Create Agent form. Discovery
  // needs read; saving checks operate on the exact Source and never starts another OAuth login.
  const loginsBeforeReuse = issuer.operations.filter((operation) => operation === "start").length;
  const reuseRequestStart = requests.length;
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method").selectOption("credential_source");
  const existing = page.getByLabel("Model credential", { exact: true });
  await existing.selectOption(originalAuth.sourceId);
  assert.equal(await existing.locator(`option[value="${templateSource.id}"]`).count(), 0);
  // A confirmed Namespace refusal removes previously readable candidates and the staged choice.
  const restoreRead = revokeAdministratorGrant(fixture, ["read", "namespace"]);
  const refusedList = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === collectionPath && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh Source list", exact: true }).click();
  assert.equal((await refusedList).status(), 403);
  await page.getByRole("button", { name: "Retry Source list", exact: true }).waitFor();
  assert.equal(await existing.locator(`option[value="${originalAuth.sourceId}"]`).count(), 0);
  assert.equal(await existing.inputValue(), "");
  await existing.selectOption("new");
  assert.equal(
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).isVisible(),
    true,
  );
  assert.equal(
    issuer.operations.filter((operation) => operation === "start").length,
    loginsBeforeReuse,
  );
  restoreRead();
  await page.getByRole("button", { name: "Retry Source list", exact: true }).click();
  await existing.selectOption(originalAuth.sourceId);
  await page.getByLabel("Agent name", { exact: true }).fill("Reused OAuth Agent");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const restoreOperate = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
  const denial = await submitCreateAgent(page, fixture, namespace.id, { status: 403 });
  const denialMessage = jsonString(jsonObject(jsonObject(await denial.json()).error).message);
  assert.match(denialMessage, /CredentialSource operate/);
  assert.ok(denialMessage.includes(originalAuth.sourceId));
  const agentsAfterDenial = await fixture.request("GET", `/namespaces/${namespace.id}/agents`);
  assert.ok(Array.isArray(agentsAfterDenial.data));
  assert.equal(
    agentsAfterDenial.data.some((agent) => jsonObject(agent).name === "Reused OAuth Agent"),
    false,
  );
  restoreOperate();
  const reused = responseData(
    await (await submitCreateAgent(page, fixture, namespace.id, { status: 201 })).json(),
  );
  assert.deepEqual(reused.harnessAuth, {
    method: "credential_source",
    sourceId: originalAuth.sourceId,
  });
  assert.deepEqual(reused.credentialSources, [{ sourceId: originalAuth.sourceId }]);
  const savedReuse = jsonObject(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${jsonString(reused.id)}`))
      .data,
  );
  assert.deepEqual(savedReuse.harnessAuth, reused.harnessAuth);
  assert.deepEqual(savedReuse.credentialSources, reused.credentialSources);
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const detailSource = page.getByLabel("Existing Credential Source", { exact: true });
  const originalName = jsonString(
    jsonObject(listed.find((source) => jsonObject(source).id === originalAuth.sourceId)).name,
  );
  await detailSource
    .getByRole("option", { name: `${originalName} · ${originalAuth.sourceId}` })
    .waitFor({ state: "attached" });
  assert.equal(await detailSource.inputValue(), originalAuth.sourceId);
  assert.equal(await detailSource.locator(`option[value="${replaced.sourceId}"]`).count(), 1);
  assert.equal(await detailSource.locator(`option[value="${templateSource.id}"]`).count(), 0);
  const reuseRequests = requests.slice(reuseRequestStart);
  assert.equal(
    reuseRequests.some(
      (request) => request.method === "POST" && request.path.endsWith("/device-authorizations"),
    ),
    false,
  );
  assert.equal(
    reuseRequests.some((request) => request.method === "POST" && request.path === collectionPath),
    false,
  );
  assert.equal(
    issuer.operations.filter((operation) => operation === "start").length,
    loginsBeforeReuse,
  );
  assert.equal(
    providerRequests.some((url) => url.includes("revoke") || url.includes("whoami")),
    false,
  );
});

test("saving ChatGPT OAuth before sign-in names the missing step and sends nothing", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "OAuth save guard");
  const agent = agentIdentity(
    await fixture.createAgent(
      namespace.id,
      "OAuth save guard",
      nativeValues("oauth-save-guard", { harnessId: "codex" }),
      { executionMode: "dedicated" },
    ),
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
  await page.getByLabel("Authentication source").selectOption("device_login");
  await save.click();
  await page.getByText("Complete ChatGPT sign-in before saving.", { exact: true }).waitFor();
  await expectNoText(page, /Service unavailable/);
  await waitForEnabled(save);
  assert.equal(
    requests.some((request) => request.method === "PATCH" && request.path === agentPath),
    false,
  );
  assert.equal(
    jsonObject(jsonObject((await fixture.request("GET", agentPath)).data).harnessAuth).method,
    "api_key",
  );
});

// A legacy Gateway does not offer the TokenService-owned device authorization capability.
const DEVICE_LOGIN_NOT_OFFERED =
  "ChatGPT sign-in needs a selected TokenService that supports device authorization. Choose another authentication method.";

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
        ? agentIdentity(
            await fixture.createAgent(
              namespace.id,
              "OAuth unavailable",
              nativeValues("oauth-unavailable", { harnessId: "codex" }),
              { executionMode: "dedicated" },
            ),
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
        .selectOption(agent ? "device_login" : "credential_source");
      if (!agent) {
        await page.getByLabel("Model credential", { exact: true }).selectOption("new");
      }
      const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
      const beginPath = `/namespaces/${namespace.id}/agents${agent ? `/${agent.id}` : ""}/device-authorizations`;
      const starts = () =>
        requests.filter(({ method, path }) => method === "POST" && path === beginPath).length;
      const reason = DEVICE_LOGIN_NOT_OFFERED;
      await page.getByText(reason, { exact: true }).waitFor();
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
      assert.equal(starts(), 0);
    });
  }
}

test("Codex sign-in cannot repeat a start with an unreadable confirmation", async (t) => {
  const { fixture, namespace } = await createOAuthConsoleNamespace(t, "OAuth unconfirmed");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
  await waitForEnabled(start);

  const namespacePath = `/namespaces/${namespace.id}`;
  const beginPath = `${namespacePath}/agents/device-authorizations`;
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**${beginPath}`, async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const body: unknown = await response.json();
    const data = responseData(body);
    assert.equal(data.status, "pending");
    // The real start committed. Lose its session reference only in the reply reaching the page.
    const sessionId = jsonString(jsonObject(data.session).id);
    const stored = await fixture.controller.transact((state) =>
      state.authenticationStates.findDevice(namespace.id, sessionId),
    );
    assert.equal(stored?.phase, "pending");
    delete data.session;
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
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
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
    const { fixture, namespace, issuer } = await createOAuthConsoleNamespace(
      t,
      "OAuth navigation",
      undefined,
      { approve: async () => false },
    );
    const agent = savedAgent
      ? agentIdentity(
          await fixture.createAgent(
            namespace.id,
            "OAuth navigation",
            nativeValues("oauth-navigation", { harnessId: "codex" }),
            { executionMode: "dedicated" },
          ),
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
    await page.getByLabel(methodLabel).selectOption(agent ? "device_login" : "credential_source");
    if (!agent) {
      await page.getByLabel("Model credential", { exact: true }).selectOption("new");
    }
    const beginPath = `/namespaces/${namespace.id}/agents${agent ? `/${agent.id}` : ""}/device-authorizations`;
    const held = await holdRequests(t, page, `**${beginPath}`, {
      once: true,
      method: "POST",
      afterServer: true,
    });
    await page.getByRole("button", { name: "Sign in with OAuth", exact: true }).click();
    const committed = await held.requested;
    assert.ok(committed, "the held start has its server answer");
    assert.equal(committed.status(), 200);
    const sessionId = jsonString(jsonObject(responseData(await committed.json()).session).id);
    assert.equal(await sourceCount(fixture, namespace.id), 0);
    assert.equal(issuer.operations.filter((operation) => operation === "start").length, 1);
    const stored = await fixture.controller.transact((state) =>
      state.authenticationStates.findDevice(namespace.id, sessionId),
    );
    assert.equal(stored?.phase, "pending");
    await page.getByRole("link", { name: "Credentials", exact: true }).click();
    await page.waitForURL("**/console/secrets?**");
    held.release();
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
    await page.getByLabel(methodLabel).selectOption(agent ? "device_login" : "credential_source");
    await start.dispatchEvent("click");
    await settlePageRequests(page);
    assert.equal(
      requests.filter(({ method, path }) => method === "POST" && path === beginPath).length,
      1,
    );
    assert.equal(await sourceCount(fixture, namespace.id), 0);
    assert.equal(issuer.operations.filter((operation) => operation === "start").length, 1);
  });
}

const WAITING = "Waiting for you to complete sign-in in the other tab…";

// A saved Agent's Credentials tab with the selected TokenService and a pending issuer response.
async function openAgentOAuth(t: TestContext, name: string) {
  const { fixture, namespace, issuer } = await createOAuthConsoleNamespace(t, name, undefined, {
    approve: async () => false,
  });
  const agent = agentIdentity(
    await fixture.createAgent(
      namespace.id,
      name,
      nativeValues(name.toLowerCase().replaceAll(" ", "-"), { harnessId: "codex" }),
      { executionMode: "dedicated" },
    ),
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await trackSettledFetches(page);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source").selectOption("device_login");
  const beginPath = `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`;
  return {
    fixture,
    issuer,
    namespace,
    page,
    beginPath,
    start: page.getByRole("button", { name: "Sign in with OAuth", exact: true }),
    // Every start the API received; a kept or recorded reply never sends a second one.
    starts: () =>
      requests.filter(({ method, path }) => method === "POST" && path === beginPath).length,
  };
}

// Holds the next start's real API answer at the browser boundary until `release()`. Awaiting
// `answered` fails within 10 s if no start is held, and at once if its server answer is lost,
// instead of waiting for the file timeout.
async function holdNextStart(
  t: TestContext,
  { page, beginPath }: { page: Page; beginPath: string },
) {
  const held = await holdRequests(t, page, `**${beginPath}`, {
    once: true,
    method: "POST",
    afterServer: true,
  });
  return {
    get answered(): Promise<{ status: number; body: unknown }> {
      return held.requested.then(async (response) => {
        assert.ok(response, "the held start has its server answer");
        const body: unknown = await response.json();
        return { status: response.status(), body };
      });
    },
    release: held.release,
  };
}

async function showTab(page: Page, name: string) {
  await page.getByRole("tab", { name, exact: true }).click();
  await page.getByRole("tab", { name, exact: true, selected: true }).waitFor();
}

// Saves the draft's Configuration from its tab, which rebuilds every other tab from its draft.
async function saveConfiguration(page: Page, name: string) {
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page
    .getByLabel("Configuration JSON", { exact: true })
    .fill(JSON.stringify(nativeValues(name, { harnessId: "codex" }), null, 2));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).waitFor();
}

// The delivered challenge shows: its code, and Cancel login for this known session.
async function expectChallenge(page: Page, userCode: string) {
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
    // The real Native IAM Driver refuses the start without credential source create.
    if (refused) {
      revokeAdministratorGrant(oauth.fixture, ["create", "credential_source"]);
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
      await expectChallenge(page, jsonString(responseData(body).userCode));
      assert.equal(await oauth.start.isVisible(), false);
    }
    await settlePageRequests(page);
    assert.equal(oauth.starts(), 1);
    assert.equal(
      oauth.issuer.operations.filter((operation) => operation === "start").length,
      refused ? 0 : 1,
    );
    assert.equal(await sourceCount(oauth.fixture, oauth.namespace.id), 0);
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
        const session = responseData(await (await first).json()).session;
        assertResourceIdentity(session);
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
        // The real Native IAM Driver refuses the first start without credential source create.
        const restoreCreate = revokeAdministratorGrant(oauth.fixture, [
          "create",
          "credential_source",
        ]);
        await start.click();
        await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
        restoreCreate();
      }
      await waitForEnabled(start);
      if (refused) {
        revokeAdministratorGrant(oauth.fixture, ["create", "credential_source"]);
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
        await expectChallenge(page, jsonString(responseData(body).userCode));
      }
      await settlePageRequests(page);
      assert.equal(oauth.starts(), 2);
      if (before === "a refused start") {
        assert.equal(
          oauth.issuer.operations.filter((operation) => operation === "start").length,
          1,
        );
        assert.equal(await sourceCount(oauth.fixture, oauth.namespace.id), 0);
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
        revokeAdministratorGrant(oauth.fixture, ["create", "credential_source"]);
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
        await expectChallenge(page, jsonString(responseData(body).userCode));
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
// Agent's start checks Agent create and credential source create in the Namespace,
// which only an Installation administrator holds. The real Native IAM Driver refuses each request
// below after the administrator's grant is removed from its Role.
test("a refused device login start on Create Agent names the create grants it checks", async (t) => {
  const { fixture, namespace } = await createOAuthConsoleNamespace(t, "OAuth start refused");
  revokeAdministratorGrant(fixture, ["create", "credential_source"]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
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
  const { fixture, namespace } = await createOAuthConsoleNamespace(t, "OAuth member");
  const member = await fixture.createNamespaceMember("oauth-member", namespace.id, MEMBER_WRITE);
  const { page } = await newPage(t, fixture);
  const installationRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/installation",
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`, member.credentials);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method").selectOption("credential_source");
  await page.getByLabel("Model credential", { exact: true }).selectOption("new");
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

test("a denied pending Source creation requires a new Codex login", async (t) => {
  const { fixture, namespace } = await createOAuthConsoleNamespace(t, "OAuth completion denied");
  const agent = agentIdentity(
    await fixture.createAgent(
      namespace.id,
      "OAuth completion denied",
      nativeValues("oauth-completion-denied", { harnessId: "codex" }),
      { executionMode: "dedicated" },
    ),
  );
  const { page } = await newPage(t, fixture);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByLabel("Authentication source").selectOption("device_login");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });
  await start.click();
  await page.getByText("CODE-12345", { exact: true }).waitFor();
  const restoreCreate = revokeAdministratorGrant(fixture, ["create", "credential_source"]);
  await page
    .getByText(/Cancel this login and start a new login after access is restored/)
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry login check" }).isVisible(), false);
  assert.equal(await sourceCount(fixture, namespace.id), 0);
  await page.getByRole("button", { name: "Cancel login", exact: true }).click();
  restoreCreate();
  await start.click();
  await page.getByText(/ChatGPT login ready/).waitFor();
  assert.equal(await sourceCount(fixture, namespace.id), 1);
});

// From Agent detail, every request checks Agent read and update. Start also checks credential
// source create; finishing creates its Source, and the login itself has no IAM grant.
test("a refused device login on Agent detail allows the same login to finish after access is restored", async (t) => {
  const { fixture, namespace } = await createOAuthConsoleNamespace(t, "OAuth Agent refused");
  const agent = agentIdentity(
    await fixture.createAgent(
      namespace.id,
      "OAuth Agent refused",
      nativeValues("oauth-agent-refused", { harnessId: "codex" }),
      { executionMode: "dedicated" },
    ),
  );
  const loginsPath = `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`;
  const answers: string[] = [];
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
  await page.getByLabel("Authentication source").selectOption("device_login");
  const start = page.getByRole("button", { name: "Sign in with OAuth", exact: true });

  // Without credential source create the start is refused before any login exists.
  const restoreCreate = revokeAdministratorGrant(fixture, ["create", "credential_source"]);
  await start.click();
  await page.getByText(AGENT_DEVICE_LOGIN_START_DENIED, { exact: true }).waitFor();
  assert.deepEqual(answers, ["POST  403"]);

  // A pending login has no Source. Poll and cancel still enforce the saved Agent's update grant.
  restoreCreate();
  await waitForEnabled(start);
  const started = page.waitForResponse(
    (response) => new URL(response.url()).pathname === loginsPath,
  );
  await start.click();
  const pending = responseData(await (await started).json());
  assert.equal(pending.source, undefined);
  assert.equal(await sourceCount(fixture, namespace.id), 0);
  const sessionPath = `${loginsPath}/${jsonString(jsonObject(pending.session).id)}`;
  const nextPoll = () =>
    page.waitForResponse((response) => new URL(response.url()).pathname === `${sessionPath}/poll`);
  const restoreUpdate = revokeAdministratorGrant(fixture, ["update", "agent"]);
  const refused = await nextPoll();
  assert.equal(refused.status(), 403);
  const refusedBody = jsonObject(await refused.json());
  const status = page.locator(".device-login [role='status']");
  await status.waitFor();
  assert.match(await status.innerText(), /Agent update|Agent read and update/);
  assert.ok(
    (await status.innerText()).includes(
      `Request ID: ${jsonString(jsonObject(refusedBody.meta).requestId)}`,
    ),
  );
  assert.equal(await sourceCount(fixture, namespace.id), 0);
  await page.getByRole("button", { name: "Cancel login", exact: true }).click();
  await page.getByText(AGENT_DEVICE_LOGIN_CANCEL_DENIED, { exact: true }).waitFor();
  restoreUpdate();
  const completed = nextPoll();
  await page.getByRole("button", { name: "Retry login check" }).click();
  const ready = responseData(await (await completed).json());
  assert.equal(ready.status, "ready");
  const sourceId = jsonString(jsonObject(ready.source).id);
  assert.equal(await sourceCount(fixture, namespace.id), 1);
  await page.getByText(/ChatGPT login ready/).waitFor();
  // A ready-session replay checks operate on the exact completed Source. Without read,
  // the denial must not reveal the Source identity or the login challenge.
  const restoreOperate = revokeAdministratorGrant(fixture, ["operate", "credential_source"]);
  const restoreRead = revokeAdministratorGrant(fixture, ["read", "credential_source"]);
  const deniedReplay = await fixture.request("POST", `${sessionPath}/poll`, { body: {} });
  assert.equal(deniedReplay.status, 403);
  const deniedReplayText = JSON.stringify(deniedReplay.body);
  assert.equal(deniedReplayText.includes(sourceId), false);
  assert.equal(deniedReplayText.includes("CODE-12345"), false);
  restoreRead();
  restoreOperate();
  const replay = await fixture.request("POST", `${sessionPath}/poll`, { body: {} });
  assert.equal(replay.status, 200);
  assert.equal(jsonObject(jsonObject(replay.data).source).id, sourceId);
  const handle = sessionPath.slice(loginsPath.length);
  assert.deepEqual(answers, [
    "POST  403",
    "POST  200",
    `POST ${handle}/poll 403`,
    `DELETE ${handle} 403`,
    `POST ${handle}/poll 200`,
  ]);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture, providerFixtures } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-agents-browser-"))
      : configured;
  t.diagnostic(`console Agent browser artifacts: ${directory}`);
  return directory;
}

async function launchBrowser() {
  const browserExecutable =
    process.env.OCC_TEST_BROWSER_EXECUTABLE === undefined ||
    process.env.OCC_TEST_BROWSER_EXECUTABLE.length === 0
      ? undefined
      : process.env.OCC_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({
    ...(browserExecutable === undefined ? {} : { executablePath: browserExecutable }),
    headless: true,
  });
  return browser;
}

async function newPage(t, fixture) {
  const artifacts = await artifactDirectory(t);
  const browser = await launchBrowser();
  let context;
  fixture.registerCleanupBeforeAppClose(async () => {
    let cleanupError;
    try {
      await context?.close();
    } catch (error) {
      cleanupError ??= error;
    } finally {
      try {
        await browser.close();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
  });
  context = await browser.newContext();
  return { page: await context.newPage(), artifacts };
}

async function login(page, fixture, path = "/console/agents") {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
}

function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      let body;
      try {
        body = request.postDataJSON();
      } catch {}
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}`, body });
    }
  });
  return requests;
}

function nonAuthWriteRequests(requests) {
  return requests.filter(
    (request) => request.method !== "GET" && !request.path.startsWith("/api/auth/sign-"),
  );
}

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

async function revealNativeConfiguration(page, label) {
  await page.getByText(label).click();
}

function assertRevisionUrl(page, revisionId) {
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("revision"), revisionId);
}

function detailUrl(fixture, namespaceId, agentId, revision, tab) {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  url.searchParams.set("revision", revision);
  url.searchParams.set("tab", tab);
  return url;
}

function pathRequests(requests, method, path) {
  return requests.filter((request) => request.method === method && request.path === path);
}

function configurationPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/configurations`);
}

function agentPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/agents`);
}

async function optionValues(locator) {
  return locator.evaluate((node) =>
    Array.from(node.options).map((option) => ({ value: option.value, text: option.textContent })),
  );
}

async function seedNativeServiceAccount(state, namespaceId, name) {
  return state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId,
      name,
    }),
  );
}

function nativeValues(marker, options = {}) {
  const harnessId = options.harnessId ?? "openclaw";
  const providerModel = options.providerModel ?? (harnessId === "codex" ? "gpt-5.1" : "gpt-4.1");
  const base = createHarnessConfiguration(harnessId, providerModel);
  const basePlugins = base.plugins ?? {};
  const basePluginEntries = basePlugins.entries ?? {};
  return {
    ...base,
    channels: options.channels ?? {},
    plugins: {
      ...basePlugins,
      entries: {
        ...basePluginEntries,
        knowledge: {
          enabled: true,
          config: { marker, thresholds: [1, 2, 3] },
        },
      },
    },
  };
}

test("Agent creation saves native Configuration JSON and a draft Agent without admitting a revision", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent authoring", { ready: true });
  const values = nativeValues("create", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByText("Choose an installed Provider.").waitFor();
  await page.getByLabel("Agent name").fill("Console-created Agent");
  await page.getByLabel("Execution mode").selectOption("dedicated");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));

  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const configuration = await (await configurationResponse).json();
  const created = await (await createResponse).json();
  assert.equal(configuration.data.kind, "agent");
  assert.deepEqual(configuration.data.values, values);
  assert.equal(created.data.namespaceId, namespace.id);
  assert.equal(created.data.configurationId, configuration.data.id);
  assert.equal(created.data.executionMode, "dedicated");
  assert.equal(created.data.providerId, null);
  assert.equal(created.data.serviceAccountId, undefined);
  assert.equal(created.data.activeRevisionId, undefined);

  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${created.data.id}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === "draft"
    );
  });
  await page.getByRole("heading", { name: "Saved draft" }).waitFor();
  await page.getByRole("button", { name: "Configuration" }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "create"').waitFor();

  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${configuration.data.id}`,
  );
  assert.deepEqual(savedConfiguration.data.values, values);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
  assert.deepEqual(
    nonAuthWriteRequests(requests).map((request) => [request.method, request.path]),
    [
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
    ],
  );
  assert.deepEqual(configurationPostRequests(requests, namespace.id)[0].body, {
    kind: "agent",
    values,
  });

  fixture.policy.restrictions.push({
    id: "deny-agent-create",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByText("Choose an installed Provider.").waitFor();
  await page.getByLabel("Agent name").fill("Denied Agent");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  const deniedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await deniedResponse).status(), 403);
  await page.getByText(/Access denied|not authorized|permission/i).waitFor();
  assert.match(page.url(), new RegExp(`/console/agents/new\\?namespace=${namespace.id}$`));
});

test("Agent creation rejects non-object native Configuration JSON before any write request", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Invalid JSON", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  requests.length = 0;

  await page.getByLabel("Agent name").fill("Broken Agent");
  await page.getByLabel("Configuration JSON").fill("[]");
  await page.getByRole("button", { name: "Create Agent" }).click();

  const validation = await page
    .getByLabel("Configuration JSON")
    .evaluate((node) => node.validationMessage);
  assert.equal(validation, "Enter a valid JSON object.");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("Agent creation renders provider and service account choices and saves selected associations", async (t) => {
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Dropdown choices", { ready: true });
  const firstAccount = await seedNativeServiceAccount(
    state,
    namespace.id,
    "Console Primary Account",
  );
  const secondAccount = await seedNativeServiceAccount(
    state,
    namespace.id,
    "Console Secondary Account",
  );
  const values = nativeValues("dropdown", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  const provider = page.getByLabel("Provider (optional)");
  const account = page.getByLabel("Service account (optional)");
  await page.getByText("Choose an installed Provider.").waitFor();
  await page.getByText("Choose an existing account in this Namespace.").waitFor();
  assert.equal(await provider.isDisabled(), false);
  assert.equal(await account.isDisabled(), false);

  const providerOptions = await optionValues(provider);
  assert.ok(providerOptions.some((option) => option.value === ""));
  assert.ok(providerOptions.some((option) => option.value === providerFixtures[0].id));
  const accountOptions = await optionValues(account);
  assert.ok(accountOptions.some((option) => option.value === ""));
  assert.ok(accountOptions.some((option) => option.value === firstAccount.id));
  assert.ok(accountOptions.some((option) => option.value === secondAccount.id));
  assert.equal(JSON.stringify(accountOptions).includes("workspaceId"), false);
  assert.equal(JSON.stringify(accountOptions).includes("providerId"), false);

  await provider.selectOption(providerFixtures[0].id);
  const accountOptionsAfterProviderSelection = await optionValues(account);
  assert.ok(
    accountOptionsAfterProviderSelection.some((option) => option.value === firstAccount.id),
    "provider selection must not hide independently readable service accounts",
  );

  await page.getByLabel("Agent name").fill("Associated Agent");
  await account.selectOption(firstAccount.id);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = await (await createResponse).json();

  assert.equal(created.data.providerId, providerFixtures[0].id);
  assert.equal(created.data.serviceAccountId, firstAccount.id);
  assert.equal(created.data.activeRevisionId, undefined);
  assert.deepEqual(agentPostRequests(requests, namespace.id).at(-1).body, {
    name: "Associated Agent",
    executionMode: "dedicated",
    providerId: providerFixtures[0].id,
    serviceAccountId: firstAccount.id,
    configurationId: created.data.configurationId,
  });
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.data.configurationId}`,
  );
  assert.deepEqual(savedConfiguration.data.values, values);
  const listedAccount = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/service-accounts/${firstAccount.id}`,
  );
  assert.equal(Object.hasOwn(listedAccount.data, "providerId"), false);
});

test("Agent creation leaves optional lists disabled when discovery is inaccessible", async (t) => {
  const fixture = await createConsoleAppFixture(t, { providerSummaries: undefined });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unavailable lists", { ready: true });
  const { page } = await newPage(t, fixture);
  const serviceAccounts = `**/namespaces/${namespace.id}/service-accounts`;
  await page.route(serviceAccounts, async (route) => {
    await route.abort("failed");
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByText(/Providers unavailable\./).waitFor();
  await page.getByText(/Service accounts unavailable\./).waitFor();
  assert.equal(await page.getByLabel("Provider (optional)").isDisabled(), true);
  assert.equal(await page.getByLabel("Service account (optional)").isDisabled(), true);
  assert.equal(await page.getByLabel("Provider (optional)").inputValue(), "");
  assert.equal(await page.getByLabel("Service account (optional)").inputValue(), "");
});

test("Agent creation reuses the saved Configuration after an Agent creation conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial save retry", { ready: true });
  await fixture.createAgent(namespace.id, "Retry Agent");
  const values = nativeValues("partial-save", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByText("Choose an installed Provider.").waitFor();
  requests.length = 0;
  await page.getByLabel("Agent name").fill("Retry Agent");
  await page.getByLabel("Execution mode").selectOption("dedicated");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));

  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const deniedAgentResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const savedConfiguration = await (await configurationResponse).json();
  assert.equal((await deniedAgentResponse).status(), 409);
  await page.getByText(`Configuration saved: ${savedConfiguration.data.id}.`).waitFor();
  await page.getByText(/conflicts with the saved state/i).waitFor();
  assert.equal(await page.getByLabel("Configuration JSON").evaluate((node) => node.readOnly), true);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Reset template" }).isDisabled(), true);
  assert.deepEqual(
    configurationPostRequests(requests, namespace.id).map((request) => request.body),
    [{ kind: "agent", values }],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  await page.getByLabel("Agent name").fill("Retry Agent Corrected");
  const retryResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const retried = await (await retryResponse).json();
  assert.equal(retried.data.name, "Retry Agent Corrected");
  assert.equal(retried.data.configurationId, savedConfiguration.data.id);
  assert.equal(retried.data.activeRevisionId, undefined);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
});

test("Agent creation preserves edited JSON across mode changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  const mode = page.getByLabel("Execution mode");
  const configuration = page.getByLabel("Configuration JSON");
  const dedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(dedicatedTemplate.agents.defaults.model, "codex/gpt-5.1");
  assert.ok(dedicatedTemplate.plugins.entries.codex);

  await mode.selectOption("embedded");
  const embeddedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(embeddedTemplate.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(Object.hasOwn(embeddedTemplate, "plugins"), false);

  const edited = JSON.stringify(nativeValues("manual-edit"), null, 2);
  await configuration.fill(edited);
  await mode.selectOption("dedicated");
  assert.equal(await configuration.inputValue(), edited);

  await page.getByRole("button", { name: "Reset template" }).click();
  const resetTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(resetTemplate.agents.defaults.model, "codex/gpt-5.1");
  assert.ok(resetTemplate.plugins.entries.codex);
});

test("Agent detail preserves admitted revision history while draft edits change current configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revision history", { ready: true });
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

  await page.getByRole("button", { name: "Configuration" }).click();
  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "rev-two"|"marker": "draft-current"/);

  await page.getByRole("button", { name: "Newer revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === second.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-two"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "draft-current"/);
  assertRevisionUrl(page, second.revision.id);

  await page.getByRole("button", { name: "Older revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  assertRevisionUrl(page, first.revision.id);

  await page.getByRole("button", { name: "Saved draft" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-current"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/);
  assertRevisionUrl(page, "draft");

  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("Channel drawer saves channel edits without exposing Secret values or dropping unrelated draft state", async (t) => {
  const secretValue = "super-secret-channel-value";
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel state", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Channel Agent",
    nativeValues("channels", {
      harnessId: "codex",
      providerModel: "gpt-5.1",
      channels: {
        slack: {
          enabled: true,
          mode: "socket",
          appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
          dmPolicy: "allowlist",
          allowFrom: ["UOLD123"],
          channels: {
            COLD123: {
              requireMention: true,
              users: ["UOLD123"],
            },
          },
        },
        msteams: {
          enabled: false,
          appId: "00000000-0000-4000-8000-000000000000",
          tenantId: "11111111-1111-4111-8111-111111111111",
          appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
          requireMention: true,
        },
      },
    }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page, artifacts } = await newPage(t, fixture);

  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "channels").pathname +
      detailUrl(fixture, namespace.id, agent.id, "draft", "channels").search,
  );
  await page.getByRole("heading", { name: "Channel Agent" }).waitFor();
  await page.getByRole("button", { name: "Channels" }).click();
  await expectNoText(page, secretValue);

  await page.getByRole("button", { name: "Edit Slack" }).click();
  await page.getByLabel("Slack channel IDs").fill("COLD123, CNEW123");
  await page.getByLabel("Allowed user IDs").fill("UNEW123");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  await expectNoText(page, secretValue);

  await page.getByRole("button", { name: "Edit Microsoft Teams" }).click();
  await page.getByLabel("Application (client) ID").fill("22222222-2222-4222-8222-222222222222");
  await page.getByLabel("Directory (tenant) ID").fill("33333333-3333-4333-8333-333333333333");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 3/).waitFor();
  await expectNoText(page, secretValue);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(configuration.data.values.channels.slack.appToken, {
    source: "env",
    provider: "default",
    id: "SLACK_APP_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.botToken, {
    source: "env",
    provider: "default",
    id: "SLACK_BOT_TOKEN",
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    COLD123: { requireMention: true, users: ["UOLD123"] },
    CNEW123: { requireMention: true },
  });
  assert.equal(configuration.data.values.channels.slack.dmPolicy, "allowlist");
  assert.deepEqual(configuration.data.values.channels.slack.allowFrom, ["UNEW123"]);
  assert.equal(
    configuration.data.values.channels.msteams.appId,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(
    configuration.data.values.channels.msteams.tenantId,
    "33333333-3333-4333-8333-333333333333",
  );
  assert.deepEqual(configuration.data.values.channels.msteams.appPassword, {
    source: "env",
    provider: "default",
    id: "MSTEAMS_APP_PASSWORD",
  });
  assert.equal(configuration.data.values.plugins.entries.knowledge.config.marker, "channels");
  assert.deepEqual(
    configuration.data.values.plugins.entries.knowledge.config.thresholds,
    [1, 2, 3],
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-5.1");

  await page.screenshot({ path: join(artifacts, "agent-channels.png"), fullPage: true });
});

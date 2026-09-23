import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture, providerFixtures } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";

const STARTER_CONTROL_UI = {
  enabled: true,
  allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
};

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-agents-browser-"))
      : configured;
  t.diagnostic(`console Agent browser artifacts: ${directory}`);
  return directory;
}

async function launchBrowser(options = {}) {
  const browserExecutable =
    process.env.OCC_TEST_BROWSER_EXECUTABLE === undefined ||
    process.env.OCC_TEST_BROWSER_EXECUTABLE.length === 0
      ? undefined
      : process.env.OCC_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({
    ...(browserExecutable === undefined ? {} : { executablePath: browserExecutable }),
    headless: true,
    ...(options.args === undefined ? {} : { args: options.args }),
  });
  return browser;
}

async function newPage(t, fixture, options = {}) {
  const artifacts = await artifactDirectory(t);
  const browser = await launchBrowser(options);
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
    if (cleanupError) {
      throw cleanupError;
    }
  });
  context = await browser.newContext();
  return { page: await context.newPage(), artifacts };
}

async function login(page, fixture, path = "/console/agents", credentials = fixture.credentials) {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
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

async function expectNativeAdminHidden(page) {
  assert.equal(await page.getByRole("heading", { name: "Native admin UI" }).isVisible(), false);
  assert.equal(await page.getByText("Open native admin UI", { exact: true }).isVisible(), false);
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

function agentDeleteRequests(requests, namespaceId, agentId) {
  return pathRequests(
    requests,
    "DELETE",
    `/namespaces/${namespaceId}/agents/${encodeURIComponent(agentId)}`,
  );
}

function agentStopRequests(requests, namespaceId, agentId) {
  return pathRequests(
    requests,
    "POST",
    `/namespaces/${namespaceId}/agents/${encodeURIComponent(agentId)}/stop`,
  );
}

function configurationPatchRequests(requests, namespaceId, configurationId) {
  return pathRequests(
    requests,
    "PATCH",
    `/namespaces/${namespaceId}/configurations/${encodeURIComponent(configurationId)}`,
  );
}

async function createRuntimeAuthFixture(t, namespaceName) {
  const computeDriver = new SshComputeDriver({
    ssh: { identityFile: "/tmp/ssh-test-key", knownHostsFile: "/tmp/ssh-test-hosts" },
    hosts: { runtime: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: "/usr/bin/node",
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/tmp/ssh-runtime-test",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  });
  const state = new InMemoryPlatformState();
  const fixture = await createConsoleAppFixture(t, { computeDriver, state });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(namespaceName);
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  return { fixture, namespace, state };
}

async function optionValues(locator) {
  return locator.evaluate((node) =>
    Array.from(node.options).map((option) => ({ value: option.value, text: option.textContent })),
  );
}

async function seedServiceAccount(state, namespaceId, name, issued = true) {
  return state.transact((unit) =>
    unit.serviceAccounts.createServiceAccount({
      id: `sa_${randomUUID()}`,
      namespaceId,
      name,
      ...(issued
        ? {
            credential: {
              kind: "access_token",
              secretRef: { name: "issued-credential", key: "token" },
            },
          }
        : {}),
    }),
  );
}

function nativeAdminComputeDriver(endpoint) {
  const driver = createTestKubernetesComputeDriver("console-native-admin-compute");

  return Object.assign(driver, {
    implementation: "test-native-admin-endpoint",
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
    getGatewayEndpoint() {
      return endpoint;
    },
  });
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

function nativeAdminValues(marker, origin) {
  const values = nativeValues(marker);
  return {
    ...values,
    gateway: {
      ...(values.gateway ?? {}),
      controlUi: {
        ...(values.gateway?.controlUi ?? {}),
        enabled: true,
        allowedOrigins: [origin],
      },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          userHeader: "x-occ-identity",
          allowUsers: ["occ-workspace-files"],
          deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
        },
        identityScopes: {
          "occ-workspace-files": ["operator.admin"],
        },
      },
    },
  };
}

test("Agent creation saves native Configuration JSON and a draft Agent without admitting a revision", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent authoring", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Existing model credential",
    "never-visible-model-secret",
  );
  // Selecting an exact Secret requires operate, not permission to read its metadata.
  fixture.policy.restrictions.push({
    id: "deny-harness-secret-read",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: secret.id,
    action: "read",
    effect: "deny",
  });
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/secrets/${secret.id}`)).status,
    403,
  );
  const values = nativeValues("create", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Choose an installed Provider.").waitFor();
  await page.getByLabel("Authentication source").selectOption("api_key");
  const secretInput = page.getByLabel("OpenAI API key Secret ID");
  assert.equal(await secretInput.getAttribute("type"), "password");
  await secretInput.fill(secret.id);
  for (const [filename, content] of Object.entries(WORKSPACE_DEFAULTS)) {
    assert.equal(await page.getByLabel(filename, { exact: true }).inputValue(), content);
  }
  // Textareas preserve literal markup as content and normalize browser newlines to LF.
  const customIdentity = "# Identity\r\n<em>Workspace author</em>\r\n";
  await page.getByLabel("IDENTITY.md", { exact: true }).fill(customIdentity);
  await page.getByLabel("USER.md", { exact: true }).fill("");
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
  assert.deepEqual(created.data.harnessAuth, { method: "api_key", source: secret.ref });
  assert.equal(
    (await page.locator("body").textContent()).includes("never-visible-model-secret"),
    false,
  );
  assert.equal(created.data.activeRevisionId, undefined);
  const submittedWorkspace = agentPostRequests(requests, namespace.id)[0].body;
  assert.deepEqual(submittedWorkspace.initialWorkspaceFiles, {
    ...WORKSPACE_DEFAULTS,
    "IDENTITY.md": customIdentity.replaceAll("\r\n", "\n"),
    "USER.md": "",
  });
  assert.equal(submittedWorkspace.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  assert.equal(Object.hasOwn(created.data, "initialWorkspaceFiles"), false);
  assert.equal(Object.hasOwn(created.data, "workspaceDefaultsId"), false);

  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${created.data.id}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === "draft"
    );
  });
  await page.getByRole("heading", { name: "New revision" }).waitFor();
  await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "create"').waitFor();
  // Neither the summary nor expanded native Configuration reveals the credential or its ID.
  const visibleConfiguration = await page.locator("body").textContent();
  assert.equal(visibleConfiguration.includes(secret.id), false);
  assert.equal(visibleConfiguration.includes("never-visible-model-secret"), false);
  await page.getByText("OpenAI API key · Secret configured", { exact: true }).waitFor();

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

  // The server still enforces the exact source grant when the form is saved.
  fixture.policy.restrictions.push({
    id: "deny-harness-secret-operate",
    namespaceId: namespace.id,
    resourceKind: "secret",
    resourceId: secret.id,
    action: "operate",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const savedSecretInput = page.getByLabel("OpenAI API key Secret ID");
  assert.equal(await savedSecretInput.getAttribute("type"), "password");
  assert.equal(await savedSecretInput.inputValue(), secret.id);
  const deniedBinding = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${created.data.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await deniedBinding).status(), 403);
  await page.getByText(/Access denied|not authorized|permission/i).waitFor();
  assert.deepEqual(
    (await fixture.request("GET", `/namespaces/${namespace.id}/agents/${created.data.id}`)).data
      .harnessAuth,
    created.data.harnessAuth,
  );

  fixture.policy.restrictions.push({
    id: "deny-agent-create",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
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
  await page.getByRole("button", { name: "Start without Preset" }).click();
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
  const firstAccount = await seedServiceAccount(state, namespace.id, "Console Primary Account");
  const secondAccount = await seedServiceAccount(
    state,
    namespace.id,
    "Console Unissued Account",
    false,
  );
  const values = nativeValues("dropdown", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const provider = page.getByLabel("Provider (optional)");
  await page.getByLabel("Authentication source").selectOption("chatgpt_service_account");
  const account = page.getByLabel("Issued ChatGPT service account");
  await page.getByText("Choose an installed Provider.").waitFor();
  await page.getByText("Issued accounts in this Namespace are available.").waitFor();
  assert.equal(await provider.isDisabled(), false);
  assert.equal(await account.isDisabled(), false);

  const providerOptions = await optionValues(provider);
  assert.ok(providerOptions.some((option) => option.value === ""));
  assert.ok(providerOptions.some((option) => option.value === providerFixtures[0].id));
  const accountOptions = await optionValues(account);
  assert.ok(accountOptions.some((option) => option.value === ""));
  assert.ok(accountOptions.some((option) => option.value === firstAccount.id));
  assert.equal(
    accountOptions.some((option) => option.value === secondAccount.id),
    false,
  );
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
  assert.deepEqual(created.data.harnessAuth, {
    method: "chatgpt_service_account",
    serviceAccountId: firstAccount.id,
  });
  assert.equal(created.data.activeRevisionId, undefined);
  assert.deepEqual(agentPostRequests(requests, namespace.id).at(-1).body, {
    name: "Associated Agent",
    executionMode: "dedicated",
    initialWorkspaceFiles: WORKSPACE_DEFAULTS,
    workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
    providerId: providerFixtures[0].id,
    harnessAuth: { method: "chatgpt_service_account", serviceAccountId: firstAccount.id },
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
  assert.deepEqual(listedAccount.data.credential, { kind: "access_token" });
  assert.doesNotMatch(
    JSON.stringify(listedAccount.data),
    /issued-credential|secretRef|workspaceId/,
  );
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
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/Providers unavailable\./).waitFor();
  await page.getByText(/Service accounts unavailable\./).waitFor();
  assert.equal(await page.getByLabel("Provider (optional)").isDisabled(), true);
  assert.equal(await page.getByLabel("Issued ChatGPT service account").isDisabled(), true);
  assert.equal(await page.getByLabel("Provider (optional)").inputValue(), "");
  assert.equal(await page.getByLabel("Issued ChatGPT service account").inputValue(), "");
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
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Choose an installed Provider.").waitFor();
  requests.length = 0;
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Keep this draft\n");
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

  assert.equal(
    await page.getByLabel("SOUL.md", { exact: true }).inputValue(),
    "# Keep this draft\n",
  );
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
  for (const request of agentPostRequests(requests, namespace.id)) {
    assert.equal(request.body.initialWorkspaceFiles["SOUL.md"], "# Keep this draft\n");
    assert.equal(request.body.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  }
});

test("Agent creation preserves edited JSON across mode changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const mode = page.getByLabel("Execution mode");
  const configuration = page.getByLabel("Configuration JSON");
  const dedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(dedicatedTemplate.agents.defaults.model, "codex/gpt-6-astra");
  assert.deepEqual(dedicatedTemplate.models.providers.codex.models, [
    { id: "gpt-6-astra", name: "gpt-6-astra" },
  ]);
  assert.ok(dedicatedTemplate.plugins.entries.codex);

  await mode.selectOption("embedded");
  const embeddedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(embeddedTemplate.agents.defaults.model, "openai/gpt-6-astra");
  assert.deepEqual(embeddedTemplate.models.providers.openai.models, [
    { id: "gpt-6-astra", name: "gpt-6-astra" },
  ]);
  assert.equal(Object.hasOwn(embeddedTemplate, "plugins"), false);

  const editedValues = nativeValues("manual-edit");
  editedValues.gateway.controlUi = {
    enabled: false,
    allowedOrigins: ["https://custom-control.example.test"],
  };
  const edited = JSON.stringify(editedValues, null, 2);
  await configuration.fill(edited);
  await mode.selectOption("dedicated");
  assert.equal(await configuration.inputValue(), edited);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  const resetTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(resetTemplate.agents.defaults.model, "codex/gpt-6-astra");
  assert.ok(resetTemplate.plugins.entries.codex);
  await page.getByLabel("Agent name").fill("Discarded draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name").inputValue(), "");
  assert.deepEqual(JSON.parse(await configuration.inputValue()), dedicatedTemplate);
});

test("Agent creation saves the default model for both harnesses without changing an explicit selection", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Starter model", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  for (const [mode, provider, harness, selectedModel] of [
    ["dedicated", "codex", "codex", "gpt-6-astra"],
    ["embedded", "openai", "openclaw", "gpt-6-astra"],
    ["embedded", "openai", "openclaw", "gpt-4.1"],
  ]) {
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill(`${mode}-${selectedModel}`);
    await page.getByLabel("Execution mode").selectOption(mode);
    if (selectedModel !== "gpt-6-astra") {
      const input = page.getByLabel("Configuration JSON");
      const edited = (await input.inputValue()).replaceAll("gpt-6-astra", selectedModel);
      await input.fill(edited);
    }
    const saved = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    const agent = (await response.json()).data;
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Starters leave gateway authentication to the selected Compute Driver while
    // preserving the separate credentials for dedicated Codex execution.
    assert.equal(Object.hasOwn(configuration.data.values.gateway, "auth"), false);
    assert.deepEqual(configuration.data.values.gateway.controlUi, STARTER_CONTROL_UI);
    if (mode === "dedicated") {
      assert.equal(
        configuration.data.values.plugins.entries.codex.config.appServer.authToken,
        "${APP_SERVER_TOKEN}",
      );
    }
    const modelReference = `${provider}/${selectedModel}`;
    assert.equal(configuration.data.values.agents.defaults.model, modelReference);
    assert.deepEqual(configuration.data.values.agents.defaults.models, {
      [modelReference]: { agentRuntime: { id: harness } },
    });
    assert.deepEqual(configuration.data.values.models.providers[provider].models, [
      { id: selectedModel, name: selectedModel },
    ]);
  }
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

  await page.getByRole("button", { name: "New revision" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-current"').waitFor();
  await expectNoText(page, /"marker": "rev-one"|"marker": "rev-two"/);
  assertRevisionUrl(page, "draft");

  await page.getByRole("button", { name: "Edit Configuration" }).click();
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
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByText("The saved Configuration changed while you were editing.").waitFor();
  assert.deepEqual(configurationPatchRequests(requests, namespace.id, agent.configurationId), []);

  await page.reload();
  await page.getByRole("heading", { name: "Revisioned Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  const editedValues = nativeValues("draft-edited");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(editedValues, null, 2));
  await page.getByText("Save or cancel these Configuration edits before deploying.").waitFor();
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Channels" }).isDisabled(), true);
  await page.evaluate(() => {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("tab", "channels");
    globalThis.history.pushState(globalThis.history.state, "", next);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  });
  await page.getByText("Save or cancel Configuration edits before leaving this tab.").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("tab"), "configuration");
  assert.equal(await page.getByLabel("AgentRevision").isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "View current revision" }).isDisabled(),
    true,
  );
  await page.evaluate((revisionId) => {
    const next = new URL(globalThis.location.href);
    next.searchParams.set("revision", revisionId);
    globalThis.history.pushState(globalThis.history.state, "", next);
    globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
  }, second.revision.id);
  await page.getByText("Save or cancel Configuration edits before leaving this tab.").waitFor();
  assertRevisionUrl(page, "draft");
  assert.deepEqual(JSON.parse(await editor.inputValue()), editedValues);
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

  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await revealNativeConfiguration(page, "View admitted native configuration");
  await page.getByText('"marker": "rev-one"').waitFor();
  await expectNoText(page, /"marker": "draft-edited"|"marker": "stale-server"/);
  await page.getByRole("button", { name: "Edit current Configuration" }).click();
  await page.waitForURL((url) => url.searchParams.get("revision") === "draft");
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "draft-edited"').waitFor();

  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Authentication source").selectOption("");
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
  await page.getByLabel("AgentRevision").selectOption(first.revision.id);
  await page.getByText("OpenAI API key · Secret configured", { exact: true }).waitFor();
  assert.equal(
    (await page.locator("body").textContent()).includes(agent.harnessAuth.source.id),
    false,
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
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), false);
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nextValues, null, 2));
  await page.getByText("Save or cancel Configuration edits before deploying.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
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
    .getByText(/Configuration, AgentRevisions, Credentials, and workspace data are retained/i)
    .waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(agentStopRequests(requests, namespace.id, agent.id).length, 0);
  await page.getByRole("button", { name: "Stop Agent" }).click();
  dialog = page.getByRole("dialog", { name: "Stop Stop Candidate?" });
  await dialog
    .getByText(/Configuration, AgentRevisions, Credentials, and workspace data are retained/i)
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
    .getByText(
      `Selected revision ${active.revision.id.slice(0, 12)}…${active.revision.id.slice(-6)}`,
    )
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
    .getByText("No selected revision", { exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "New revision", exact: true }).click();
  await page.getByRole("button", { name: "Deploy new revision" }).click();
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
  await page.getByRole("heading", { name: "Agents" }).waitFor();
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
  await page.getByLabel("AgentRevision").selectOption(historicalRevisionId);
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
  assert.equal(await page.getByRole("button", { name: /Microsoft Teams/ }).count(), 0);

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
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(
    configuration.data.values.channels.msteams.tenantId,
    "11111111-1111-4111-8111-111111111111",
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

test("Presets render variables into independent Agent drafts and keep partial-save retries fixed", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-preset-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use production Configuration admission, including native credential restrictions.
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Preset authoring", { ready: true });
  const secret = await fixture.createSecret(
    namespace.id,
    "Preset channel token",
    "test-channel-token",
  );
  await fixture.createAgent(namespace.id, "Existing Agent");
  const values = nativeValues("{{ vars.marker }}", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  values.plugins.entries.knowledge.config.enabled = "{{ vars.enabled }}";
  values.plugins.entries.knowledge.config.count = "{{ vars.count }}";
  const plugins = { "occ-plugin:diffs": { enabled: true, approvalMode: "always" } };
  const secretBindings = { CHANNEL_TOKEN: { source: secret.ref, delivery: { type: "env" } } };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Reusable Agent",
      template: {
        variables: {
          name: { type: "string" },
          execution: { type: "string", default: "dedicated" },
          marker: { type: "string", default: "initial" },
          enabled: { type: "boolean", default: false },
          count: { type: "number", default: 0 },
        },
        agent: {
          name: "{{ vars.name }}",
          executionMode: "{{ vars.execution }}",
          providerId: providerFixtures[0].id,
          harnessAuth: { method: "api_key", source: secret.ref },
          plugins,
        },
        configuration: { values, secretBindings },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  assert.equal(await save.count(), 0, "choose a starting point before editing the Agent draft");
  const apply = page.getByRole("button", { name: "Use Preset" });
  await apply.click();
  await page.getByRole("alert").filter({ hasText: /name/ }).waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Variable: execution", { exact: true }).fill("invalid");
  await apply.click();
  await page
    .getByText("Rendered Preset contains invalid Agent fields or Secret bindings.")
    .waitFor();
  assert.equal(await save.count(), 0);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  await page.getByLabel("Variable: execution", { exact: true }).fill("dedicated");
  await page.getByLabel("Variable: marker", { exact: true }).fill("changed");
  await apply.click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Preset template").count(), 0);
  assert.equal(await page.getByLabel("Variable: marker", { exact: true }).count(), 0);
  const presetSecretInput = page.getByLabel("OpenAI API key Secret ID");
  assert.equal(await presetSecretInput.getAttribute("type"), "password");
  assert.equal(await presetSecretInput.inputValue(), secret.id);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(
      "test-channel-token",
    ),
    false,
  );
  assert.equal(await save.isEnabled(), true);
  const rendered = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  assert.deepEqual(rendered.plugins.entries.knowledge.config, {
    marker: "changed",
    thresholds: [1, 2, 3],
    enabled: false,
    count: 0,
  });
  assert.deepEqual(rendered.gateway.controlUi, { enabled: false });
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Plugin selections JSON").inputValue()),
    plugins,
  );
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Secret bindings JSON").inputValue()),
    secretBindings,
  );
  // Deletion after selection must not invalidate this independent local copy.
  assert.equal(
    (
      await fixture.rawRequest("DELETE", `/namespaces/${namespace.id}/presets/${preset.data.id}`, {
        headers: authenticatedHeaders(await fixture.signIn()),
      })
    ).response.status,
    204,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Edited name");
  const edited = JSON.parse(
    await page.getByLabel("Configuration JSON", { exact: true }).inputValue(),
  );
  edited.plugins.entries.knowledge.config.thresholds = [5, 6];
  await page.getByLabel("Configuration JSON", { exact: true }).fill(JSON.stringify(edited));
  // Canceling Start over keeps the ordinary draft and its ability to save.
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start over" }).click();
  assert.equal(await save.isEnabled(), true);
  assert.deepEqual(
    JSON.parse(await page.getByLabel("Configuration JSON", { exact: true }).inputValue()),
    edited,
  );
  await page.getByLabel("Agent name", { exact: true }).fill("Existing Agent");
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/conflicts with the saved state/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  assert.equal(
    await page.getByLabel("Secret bindings JSON").evaluate((node) => node.readOnly),
    true,
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.getByLabel("Agent name", { exact: true }).fill("Preset Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await (await createdResponse).json();
  assert.equal(created.data.name, "Preset Agent");
  assert.deepEqual(created.data.plugins, plugins);
  assert.equal(created.data.providerId, providerFixtures[0].id);
  assert.deepEqual(created.data.harnessAuth, { method: "api_key", source: secret.ref });
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.data.configurationId}`,
  );
  assert.deepEqual(saved.data.secretBindings, secretBindings);
  assert.deepEqual(saved.data.values.gateway.controlUi, { enabled: false });
  assert.equal(saved.data.values.plugins.entries.knowledge.config.marker, "changed");
  assert.deepEqual(saved.data.values.plugins.entries.knowledge.config.thresholds, [5, 6]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/presets/${preset.data.id}`).length,
    1,
  );
});

for (const [dmPolicy, groupPolicy] of [
  ["pairing", "allowlist"],
  ["open", "open"],
  ["disabled", "disabled"],
  [undefined, undefined],
]) {
  test(`Slack channel editing preserves ${dmPolicy ?? "omitted"} DM and ${groupPolicy ?? "omitted"} group policies`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Slack policy editing", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
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
    await page.getByLabel("Slack channel IDs").fill("CKEEP123, CNEW123");
    await page.getByLabel("Require a mention", { exact: true }).uncheck();
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
        CNEW123: { requireMention: false },
      },
    });
    assert.equal(
      configuration.data.values.plugins.entries.knowledge.config.marker,
      "policy-preservation",
    );
  });
}

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
  const secret = page.getByLabel("OpenAI API key Secret ID");
  await secret.waitFor();
  const secretElement = await secret.elementHandle();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  await page
    .getByText(
      "Workspace files require a deployed Agent with an active revision and a reachable gateway.",
    )
    .waitFor();
  assert.equal(await secretElement.evaluate((node) => node.value), "");
  assert.equal(await secretElement.evaluate((node) => node.isConnected), false);
  await page.goBack();
  await page.getByLabel("OpenAI API key Secret ID").waitFor();
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
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  assert.equal(
    requests.some((request) => request.path === configurationPath),
    false,
  );
  assert.equal(
    requests.some((request) => request.path.endsWith("/revisions")),
    false,
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
  // Configuration completion may prepare shared controls, but must not replace the active tab.
  await page.getByRole("heading", { name: "New revision", exact: true }).waitFor();
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

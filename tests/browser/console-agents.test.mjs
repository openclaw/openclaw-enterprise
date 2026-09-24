import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { SshComputeDriver } from "../../apps/controller/src/drivers/compute/ssh/index.ts";
import { secretIdForBinding } from "../../apps/controller/src/console/agents/credentials.mjs";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/providers/repository-credentials/control-client.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState, ModelDiscoveryError } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture, providerFixtures } from "../helpers/console-app.mjs";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

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
    (request) =>
      request.method !== "GET" &&
      !request.path.startsWith("/api/auth/sign-") &&
      // Discovery uses POST to keep its write-only key out of URLs, but creates no resource.
      !request.path.endsWith("/agents/models"),
  );
}

async function enterManualModel(page, apiKey, modelId = "gpt-4.1") {
  await page.getByLabel("API key", { exact: true }).fill(apiKey);
  await page.getByLabel("API key", { exact: true }).press("Tab");
  const model = page.getByLabel("Model ID", { exact: true });
  await model.waitFor();
  await model.fill(modelId);
  await model.press("Tab");
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

function agentProvisionPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/agents/provision`);
}

function secretPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/secrets`);
}

async function routeInstallationProvisioning(page, fixture, executionModes = ["dedicated"]) {
  await page.route(`${fixture.origin}/installation`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "ins_00000000-0000-4000-8000-000000000001",
          name: "Console test installation",
          createdAt: new Date().toISOString(),
          capabilities: { agentProvisioning: { executionModes } },
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    });
  });
}

async function routeInstallationWithoutProvisioning(page, fixture) {
  await page.route(`${fixture.origin}/installation`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "ins_00000000-0000-4000-8000-000000000001",
          name: "Console test installation",
          createdAt: new Date().toISOString(),
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    });
  });
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

function accessBindingPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/iam/access-bindings`);
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

const repositoryProviderFixture = Object.freeze({
  id: "console-repositories",
  type: "github",
  configuration: Object.freeze({ registryPath: "/unused/console/repositories.json" }),
  drivers: Object.freeze({ repo: "console-repository-driver" }),
});

async function createRepositoryLaunchFixture(
  t,
  buildRepositories,
  { reloadablePolicy = false } = {},
) {
  const fixture = await createConsoleAppFixture(t, {
    providers: [...providerFixtures, repositoryProviderFixture],
    repositoryCredentials: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Repository launch", { ready: true });
  let currentPolicy = repositoryPolicyDriver(buildRepositories(namespace.id));
  // Simulate replacing mounted policy between requests while keeping all projection and resolution
  // decisions in the actual GitHub Driver. This does not prove production configuration reload.
  const repoDriver = reloadablePolicy
    ? {
        id: currentPolicy.id,
        capability: currentPolicy.capability,
        implementation: "test-reloadable-github-policy",
        maintenanceIntervalMs: currentPolicy.maintenanceIntervalMs,
        listOptions: (input) => currentPolicy.listOptions(input),
        resolve: (input) => currentPolicy.resolve(input),
        open: (input, signal) => currentPolicy.open(input, signal),
        status: (id, signal) => currentPolicy.status(id, signal),
        close: (id, signal) => currentPolicy.close(id, signal),
      }
    : currentPolicy;
  fixture.controller.registerDriver(repoDriver);
  fixture.controller.selectDriver("repo", repoDriver.id);
  return {
    fixture,
    namespace,
    replacePolicy(repositories) {
      assert.equal(reloadablePolicy, true);
      currentPolicy = repositoryPolicyDriver(repositories);
    },
  };
}

function repositoryPolicyDriver(repositories) {
  const provider = repositoryProviderFixture;
  const registry = validateGitHubRepositoryRegistry(
    {
      version: 1,
      providerId: provider.id,
      providerInstanceId: "console-repository-provider",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories,
    },
    provider.id,
  );
  return new GitHubRepoDriver(
    {
      id: provider.id,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: "/unused/console/repository-control.sock",
      }),
      drivers: provider.drivers,
    },
    registry,
    { sessionDurationSeconds: 600 },
  );
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

test("Agent creation stores its API key separately, grants exact access, and saves a draft without a revision", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, { state, secretDriver });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent authoring", { ready: true });
  const key = "at-explicit-api-key-not-auto-detected";
  const existingSlackAppSecret = await fixture.createSecret(
    namespace.id,
    "Existing Slack app token",
    "never-visible-existing-slack-app-token",
  );
  const replacementSlackAppSecret = await fixture.createSecret(
    namespace.id,
    "Replacement Slack app token",
    "never-visible-replacement-slack-app-token",
  );
  const createdSlackBotSecretValue = "never-visible-created-slack-bot-token";
  const values = nativeValues("create", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByRole("link", { name: "Providers", exact: true }).count(), 0);
  assert.deepEqual(await optionValues(page.getByLabel("Provider", { exact: true })), [
    { value: "openai", text: "OpenAI" },
    { value: "anthropic", text: "Anthropic" },
  ]);
  const harness = page.getByLabel("Harness", { exact: true });
  assert.deepEqual(await optionValues(harness), [
    { value: "codex", text: "Codex" },
    { value: "openclaw", text: "OpenClaw" },
  ]);
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.deepEqual(await optionValues(page.getByLabel("Authentication method", { exact: true })), [
    { value: "api_key", text: "OpenAI API key" },
    { value: "codex_pat", text: "Service Accounts" },
  ]);
  const keyInput = page.getByLabel("API key", { exact: true });
  assert.equal(await keyInput.getAttribute("type"), "password");
  assert.equal(await keyInput.getAttribute("placeholder"), "sk-…");
  assert.equal(
    await page.getByRole("link", { name: "Create an API key", exact: true }).getAttribute("href"),
    "https://platform.openai.com/api-keys",
  );
  await keyInput.fill("discarded-api-key");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Service account token", { exact: true }).inputValue(), "");
  assert.equal(
    await page.getByLabel("Service account token", { exact: true }).getAttribute("placeholder"),
    "at-…",
  );
  assert.equal(
    await page.getByRole("link", { name: "OpenAI admin", exact: true }).getAttribute("href"),
    "https://admin.openai.com/",
  );
  await page
    .getByText(
      "choose your workspace, open Service accounts, and create a token with Codex scope.",
      { exact: false },
    )
    .waitFor();
  assert.equal(await page.getByRole("link", { name: "Create an API key", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), false);
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  assert.equal(await keyInput.getAttribute("placeholder"), "sk-…");
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  await enterManualModel(page, key, "gpt-5.1");
  await page
    .getByText(
      "No models were returned. Enter a model ID enabled for this API key, or retry loading.",
      { exact: true },
    )
    .waitFor();
  for (const [filename, content] of Object.entries(WORKSPACE_DEFAULTS)) {
    assert.equal(await page.getByLabel(filename, { exact: true }).inputValue(), content);
  }
  // Textareas preserve literal markup as content and normalize browser newlines to LF.
  const customIdentity = "# Identity\r\n<em>Workspace author</em>\r\n";
  await page.getByLabel("IDENTITY.md", { exact: true }).fill(customIdentity);
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByLabel("Agent name").fill("Console-created Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const createChannelDialog = page.getByRole("dialog", { name: /^(Configure|Edit) Slack$/ });
  await createChannelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await createChannelDialog
    .getByText(
      "Channel settings and selected bindings are not persisted until you create the Agent. Secrets created from the modal are stored immediately in the Namespace.",
    )
    .waitFor();
  assert.equal(await createChannelDialog.getByRole("link").count(), 0);
  await createChannelDialog.getByLabel("Slack app token").selectOption(existingSlackAppSecret.id);
  await createChannelDialog
    .getByText("Secret binding staged. Apply the channel settings to save it.")
    .waitFor();
  // Separate applications must retain grants for every final selected Secret.
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  await createChannelDialog
    .getByLabel("Slack bot token")
    .selectOption({ label: "Create new Secret..." });
  const createSecretDialog = page.getByRole("dialog", {
    name: "Create Slack bot token Secret",
  });
  await createSecretDialog
    .getByRole("heading", { name: "Create Slack bot token Secret" })
    .waitFor();
  assert.equal(await createSecretDialog.getByLabel("Binding key").inputValue(), "SLACK_BOT_TOKEN");
  assert.equal(await createSecretDialog.getByLabel("Binding key").getAttribute("readonly"), "");
  assert.equal(
    await createSecretDialog.getByLabel("Secret value").getAttribute("type"),
    "password",
  );
  await createSecretDialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(
    JSON.parse(await page.getByLabel("Secret bindings JSON").inputValue()).SLACK_BOT_TOKEN,
    undefined,
  );
  await createChannelDialog
    .getByLabel("Slack bot token")
    .selectOption({ label: "Create new Secret..." });
  await page
    .getByRole("dialog", { name: "Create Slack bot token Secret" })
    .getByLabel("Secret value")
    .fill(createdSlackBotSecretValue);
  await page
    .getByRole("dialog", { name: "Create Slack bot token Secret" })
    .getByRole("button", { name: "Create Secret" })
    .click();
  await createChannelDialog
    .getByText("Secret binding staged. Apply the channel settings to save it.")

    .waitFor();
  assert.equal(
    JSON.parse(await page.getByLabel("Secret bindings JSON").inputValue()).SLACK_BOT_TOKEN,
    undefined,
  );
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  // Replacing an earlier selection must not grant the superseded Secret to the Agent.
  await createChannelDialog
    .getByLabel("Slack app token")
    .selectOption(replacementSlackAppSecret.id);
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const stagedSecretBindings = JSON.parse(
    await page.getByLabel("Secret bindings JSON").inputValue(),
  );
  assert.deepEqual(stagedSecretBindings.SLACK_APP_TOKEN, {
    source: replacementSlackAppSecret.ref,
    delivery: { type: "env" },
  });
  const stagedBotSecretId = secretIdForBinding(stagedSecretBindings.SLACK_BOT_TOKEN);
  assert.match(
    stagedBotSecretId,
    /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const stagedValues = JSON.parse(await page.getByLabel("Configuration JSON").inputValue());
  await page.getByLabel("Agent name").fill("A".repeat(200));

  const secretResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
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
  const secret = (await (await secretResponse).json()).data;
  const configuration = await (await configurationResponse).json();
  const created = await (await createResponse).json();
  assert.equal(secretDriver.valueFor(secret), key);
  assert.equal(secretDriver.calls.filter((call) => call.operation === "create").length, 4);
  for (const payload of [secret, configuration, created]) {
    assert.equal(JSON.stringify(payload).includes(key), false);
  }
  assert.equal(configuration.data.kind, "agent");
  assert.deepEqual(configuration.data.values, stagedValues);
  assert.deepEqual(configuration.data.secretBindings, stagedSecretBindings);
  assert.equal(created.data.name, "A".repeat(200));
  assert.equal(created.data.namespaceId, namespace.id);
  assert.equal(created.data.configurationId, configuration.data.id);
  assert.equal(created.data.executionMode, "dedicated");
  assert.deepEqual(agentProvisionPostRequests(requests, namespace.id), []);
  assert.equal(created.data.providerId, null);
  assert.deepEqual(created.data.harnessAuth, { method: "api_key", source: secret.ref });
  assert.equal((await page.locator("body").textContent()).includes(key), false);
  assert.equal(
    (await page.locator("body").textContent()).includes("never-visible-existing-slack-app-token"),
    false,
  );
  assert.equal(
    (await page.locator("body").textContent()).includes(createdSlackBotSecretValue),
    false,
  );
  assert.equal(
    (await page.locator("body").textContent()).includes(
      "never-visible-replacement-slack-app-token",
    ),
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
  assert.equal(visibleConfiguration.includes("never-visible-existing-slack-app-token"), false);
  assert.equal(visibleConfiguration.includes(createdSlackBotSecretValue), false);
  await page.getByText("API key · Secret configured", { exact: true }).waitFor();

  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${configuration.data.id}`,
  );
  assert.deepEqual(savedConfiguration.data.values, stagedValues);
  assert.deepEqual(savedConfiguration.data.secretBindings, stagedSecretBindings);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.data.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
  assert.deepEqual(
    nonAuthWriteRequests(requests).map((request) => [request.method, request.path]),
    [
      ["POST", `/namespaces/${namespace.id}/secrets`],
      ["POST", `/namespaces/${namespace.id}/secrets`],
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
      ["POST", `/namespaces/${namespace.id}/iam/roles`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
    ],
  );
  assert.deepEqual(configurationPostRequests(requests, namespace.id)[0].body, {
    kind: "agent",
    values: stagedValues,
    secretBindings: stagedSecretBindings,
  });

  const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(roles.status, 200);
  assert.equal(access.status, 200);
  assert.equal(roles.data.length, 1);
  assert.deepEqual(roles.data[0].permissions, [{ action: "operate", resourceKind: "secret" }]);
  assert.deepEqual(
    access.data
      .map(({ id, ...binding }) => binding)
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    [secret.id, replacementSlackAppSecret.id, stagedBotSecretId].sort().map((resourceId) => ({
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: created.data.servicePrincipalId,
      roleId: roles.data[0].id,
      resourceKind: "secret",
      resourceId,
    })),
  );
  assert.ok(audit.events.some((event) => event.resource.id === created.data.id));
  assert.equal(JSON.stringify(audit.events).includes(key), false);

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
  const savedSecretInput = page.getByLabel("API key Secret ID");
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
  requests.length = 0;
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/Repository choices are denied/).waitFor();
  await enterManualModel(page, "denied-agent-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Denied Agent");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.match(page.url(), new RegExp(`/console/agents/new\\?namespace=${namespace.id}$`));
});

test("Agent creation selects approved repositories with one common explicit profile", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "789",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
    {
      repositoryRef: "documentation",
      repositoryId: "790",
      repository: "example/documentation",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write"] }],
    },
    {
      repositoryRef: "release",
      repositoryId: "791",
      repository: "example/release",
      namespaces: [{ namespaceId, profiles: ["git-full"] }],
    },
  ]);

  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  const accessDetails = page.locator(".repository-access-details");
  const accessSummary = accessDetails.locator("summary");
  const apiScope = accessDetails.getByText(/GraphQL can also return public information/);
  assert.equal(await apiScope.isVisible(), false);
  await accessSummary.focus();
  await accessSummary.press("Enter");
  assert.equal(await apiScope.isVisible(), true);
  await accessSummary.press("Enter");
  assert.equal(await apiScope.isVisible(), false);
  const application = page.locator("#repository-application");
  await application.focus();
  await application.press("Space");
  assert.equal(await application.isChecked(), true);
  assert.deepEqual(
    await application.evaluate((node) => ({
      id: node.ownerDocument.activeElement?.id,
      connected: node.ownerDocument.activeElement?.isConnected,
    })),
    { id: "repository-application", connected: true },
  );
  assert.equal(await page.getByRole("radio", { name: /^Reader / }).count(), 1);
  assert.equal(await page.getByRole("radio", { name: /^Contributor / }).count(), 1);
  assert.equal(await page.getByRole("radio", { name: /^Collaborator / }).count(), 1);
  assert.equal(await page.locator('[name="repository-profile"]:checked').count(), 0);
  const writeAccess = page.locator(".repository-write-access");
  assert.equal(await writeAccess.isVisible(), false);
  await page.getByRole("radio", { name: /^Reader / }).check();
  assert.equal(await writeAccess.isVisible(), false);
  await page.getByRole("radio", { name: /^Collaborator / }).check();
  assert.equal(await writeAccess.isVisible(), true);
  assert.match(await writeAccess.innerText(), /can permit merges and branch changes/);
  assert.match(await writeAccess.innerText(), /best effort and does not restrict GraphQL/);
  assert.match(await writeAccess.innerText(), /administration and workflow permissions/);
  await page.locator("#repository-documentation").check();
  // Adding a repository that disallows the selected level clears that choice.
  assert.equal(await page.locator('[name="repository-profile"]:checked').count(), 0);
  assert.equal(await writeAccess.isVisible(), false);
  assert.equal(await page.locator("#repository-profile-git-full").count(), 0);
  assert.equal(await page.locator("#repository-profile-git-read").count(), 1);
  assert.equal(await page.locator("#repository-profile-git-write").count(), 1);
  await page.locator("#repository-release").check();
  await page.getByText(/no authorization level in common/i).waitFor();
  assert.equal(await page.locator('[name="repository-profile"]').count(), 0);
  await page.locator("#repository-release").uncheck();
  assert.equal(await page.locator("#repository-profile-git-write").count(), 1);
  await page.locator("#repository-profile-git-write").check();
  assert.equal(await writeAccess.isVisible(), true);
  await page.getByText(/Does not grant ordinary issue management/).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository Agent");

  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
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
  await configurationResponse;
  const created = await (await createResponse).json();
  assert.equal(created.data.executionMode, "embedded");
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-write" },
    { repositoryRef: "documentation", profile: "git-write" },
  ]);
  await page
    .getByText("application · Contributor, documentation · Contributor", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.locator(".repository-write-access").isVisible(), true);
});

test("Agent creation keeps loading and empty repository discovery safe for an ordinary Agent", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, () => [
    {
      repositoryRef: "other-team",
      repositoryId: "801",
      repository: "example/other-team",
      namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read", "git-write"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let releaseOptions;
  const optionsGate = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  t.after(() => releaseOptions());
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, async (route) => {
    await optionsGate;
    await route.continue();
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Loading approved repositories…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  releaseOptions();
  await page.getByText(/No approved repositories are available/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);

  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Ordinary Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = await (await createdResponse).json();
  assert.equal(Object.hasOwn(created.data, "repositoryBindings"), false);
  assert.equal(
    Object.hasOwn(agentPostRequests(requests, namespace.id).at(-1).body, "repositoryBindings"),
    false,
  );
});

test("Dedicated repository Agent keeps its bindings through Slack save and the deployment credential gate", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "807",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const modelSecret = await fixture.createSecret(
    namespace.id,
    "Dedicated model",
    "fixture-model-key",
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Dedicated repository Agent");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-full").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  assert.equal(agent.executionMode, "dedicated");
  assert.deepEqual(agent.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
  ]);
  assert.equal(agent.harnessAuth.method, "api_key");
  assert.equal(agent.harnessAuth.source.namespaceId, namespace.id);
  assert.notEqual(agent.harnessAuth.source.id, modelSecret.id);
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CREPOSITORY123");
  await page.getByLabel("Allow everyone in these channels to mention the agent").check();
  const savedResponse = page.waitForResponse(
    (result) =>
      result.url().endsWith(`/configurations/${agent.configurationId}`) &&
      result.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(saved.data.values.channels.slack.enabled, true);
  assert.deepEqual(saved.data.values.channels.slack.channels.CREPOSITORY123, {
    requireMention: true,
    users: ["*"],
  });
  assert.equal(Object.hasOwn(saved.data.values.channels.slack, "allowFrom"), false);
  assert.equal(saved.data.values.plugins.entries.codex.enabled, true);
  const sameAgent = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(sameAgent.data.repositoryBindings, agent.repositoryBindings);

  // This fixture has no Kubernetes API client: real credential discovery must block deployment.
  const credentialsResponse = page.waitForResponse((result) =>
    result.url().endsWith(`/agents/${agent.id}/runtime-credentials`),
  );
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  assert.equal((await credentialsResponse).status(), 503);
  await page
    .getByText("Credential metadata unavailable. Refresh status before deploying.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new revision" }).isDisabled(), true);
  assert.equal(await page.getByLabel("Slack app token").isDisabled(), true);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/${agent.id}/deploy`).length,
    0,
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent creation distinguishes unavailable repository choices from denied Agent creation", async (t) => {
  const unavailableFixture = await createConsoleAppFixture(t);
  await unavailableFixture.bootstrap();
  const unavailableNamespace = await unavailableFixture.createNamespace("No Repo Driver", {
    ready: true,
  });
  const { page: unavailablePage } = await newPage(t, unavailableFixture);
  await login(
    unavailablePage,
    unavailableFixture,
    `/console/agents/new?namespace=${unavailableNamespace.id}`,
  );
  const optionsResponse = unavailablePage.waitForResponse((response) =>
    response.url().endsWith("/agents/repository-options"),
  );
  await unavailablePage.getByRole("button", { name: "Start without Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
  await unavailablePage.getByText(/Repository choices are unavailable/).waitFor();
  assert.equal(
    await unavailablePage.getByRole("button", { name: "Create Agent" }).isEnabled(),
    true,
  );
  const unavailableRequests = apiRequests(unavailablePage, unavailableFixture.origin);
  await enterManualModel(unavailablePage, "repository-fixture-model-key", "gpt-5.1");
  await unavailablePage.getByLabel("Agent name").fill("Authorized ordinary Agent");
  const ordinaryResponse = unavailablePage.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${unavailableNamespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await unavailablePage.getByRole("button", { name: "Create Agent" }).click();
  const ordinary = await ordinaryResponse;
  assert.equal(ordinary.status(), 201);
  assert.equal(Object.hasOwn((await ordinary.json()).data, "repositoryBindings"), false);
  assert.equal(configurationPostRequests(unavailableRequests, unavailableNamespace.id).length, 1);

  const { fixture: deniedFixture, namespace: deniedNamespace } =
    await createRepositoryLaunchFixture(t, (namespaceId) => [
      {
        repositoryRef: "application",
        repositoryId: "802",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read"] }],
      },
    ]);
  deniedFixture.policy.restrictions.push({
    id: "deny-repository-discovery",
    namespaceId: deniedNamespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const { page: deniedPage } = await newPage(t, deniedFixture);
  const deniedRequests = apiRequests(deniedPage, deniedFixture.origin);
  await login(deniedPage, deniedFixture, `/console/agents/new?namespace=${deniedNamespace.id}`);
  await deniedPage.getByRole("button", { name: "Start without Preset" }).click();
  await deniedPage.getByText(/Repository choices are denied/).waitFor();
  assert.equal(await deniedPage.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await deniedPage.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(deniedRequests, deniedNamespace.id).length, 0);
  assert.equal(agentPostRequests(deniedRequests, deniedNamespace.id).length, 0);
});

test("Agent creation blocks a repository-options Namespace conflict before any write", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Conflicted repository options", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RESOURCE_CONFLICT", message: "Namespace lifecycle conflict" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    }),
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("This Namespace no longer accepts new Agents.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation blocks selective Agent-create IAM unavailability even when Configuration creation is allowed", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "808",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const originalIAM = fixture.controller.selectedDriver("iam");
  const id = "selective-native-state-iam";
  const healthyIAM = new NativeIAMDriver(
    { loadNativeIAMState: async () => fixture.policy },
    { id },
  );
  const unavailableIAM = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => {
        throw new Error("Native IAM state unavailable");
      },
    },
    { id },
  );
  // Fault only the state dependency for Agent-create authorization. Every actual decision and
  // identity lookup still runs Native IAM, so a healthy Configuration write is independently proved.
  fixture.controller.registerDriver({
    id,
    capability: "iam",
    implementation: "test-selective-native-state",
    lookupIdentity: (input) => healthyIAM.lookupIdentity(input),
    authorize: (request) =>
      request.action === "create" && request.resource.kind === "agent"
        ? unavailableIAM.authorize(request)
        : healthyIAM.authorize(request),
  });
  fixture.controller.selectDriver("iam", id);
  const allowed = await fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: nativeValues("independent-configuration") },
  });
  assert.equal(allowed.status, 201);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  const optionsResponse = page.waitForResponse((response) =>
    response.url().endsWith("/agents/repository-options"),
  );
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Authorization unavailable Agent");
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  fixture.controller.selectDriver("iam", originalIAM.id);
  await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
});

for (const failure of [
  { name: "not found", status: 404, code: "NOT_FOUND" },
  { name: "rate limited", status: 429, code: "RATE_LIMITED" },
  { name: "internal error", status: 500, code: "INTERNAL_ERROR" },
  { name: "dependency unavailable", status: 503, code: "DEPENDENCY_UNAVAILABLE" },
  { name: "missing error code", status: 503 },
  { name: "unknown error code", status: 503, code: "UNKNOWN_FAILURE" },
  { name: "optional code with wrong status", status: 500, code: "REPOSITORY_OPTIONS_UNAVAILABLE" },
  { name: "malformed envelope", status: 200, body: {} },
  { name: "malformed options", status: 200, body: { data: {} } },
  { name: "unexpected success status", status: 201, body: { data: [] } },
  {
    name: "malformed option fields",
    status: 200,
    body: { data: [{ repositoryRef: "application" }] },
  },
  { name: "transport failure" },
]) {
  test(`Agent creation blocks ${failure.name} discovery and retries before any write`, async (t) => {
    const { fixture, namespace } = await createRepositoryLaunchFixture(t, () => [
      {
        repositoryRef: "other-team",
        repositoryId: "805",
        repository: "example/other-team",
        namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read"] }],
      },
    ]);
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `**/namespaces/${namespace.id}/agents/repository-options`;
    // These responses exercise the browser's HTTP boundary, not server authorization decisions.
    const failDiscovery = (route) =>
      failure.status === undefined
        ? route.abort("failed")
        : route.fulfill({
            status: failure.status,
            contentType: "application/json",
            body: JSON.stringify(
              failure.body ?? {
                error: { code: failure.code, message: "untrusted-server-detail" },
              },
            ),
          });
    await page.route(path, failDiscovery);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
    await page.getByLabel("Agent name").fill("Discovery retry Agent");
    await page.locator('.repository-options[aria-busy="false"]').waitFor({ state: "attached" });
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-server-detail/);

    await page.unroute(path, failDiscovery);
    await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
    await page.getByText(/No approved repositories are available/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    assert.equal((await createdResponse).status(), 201);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  });
}

test("Agent repository selection enforces the 16-item limit without narrow viewport overflow", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    Array.from({ length: 17 }, (_, index) => ({
      repositoryRef: `repository-${index + 1}`,
      repositoryId: String(900 + index),
      repository: `example/repository-${index + 1}`,
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();

  for (let index = 1; index <= 16; index += 1) {
    await page.locator(`#repository-repository-${index}`).check();
  }
  assert.equal(await page.locator("#repository-repository-17").isDisabled(), true);
  assert.deepEqual(
    await page.locator("html").evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    })),
    { clientWidth: 360, scrollWidth: 360 },
  );
});

test("Agent creation recovers from stale authoritative admission without replacing its Configuration", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "803",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Recovered Repository Agent");

  fixture.policy.restrictions.push({
    id: "stale-agent-create-authorization",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const savedConfigurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const savedConfiguration = await (await savedConfigurationResponse).json();
  assert.equal((await rejected).status(), 403);
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  await page
    .getByText(
      /Repository-scoped Agent creation returned a known rejection.*Configuration .* remains saved/,
    )
    .waitFor();
  assert.equal(await page.locator("#repository-application").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /could not be reloaded because Agent creation is denied/ })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).isVisible(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  fixture.policy.restrictions.pop();
  const repositoryOptionsPath = `**/namespaces/${namespace.id}/agents/repository-options`;
  const failRepositoryReload = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DEPENDENCY_UNAVAILABLE", message: "repository policy unavailable" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
      }),
    });
  await page.route(repositoryOptionsPath, failRepositoryReload);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Repository choices could not be reloaded/ })
    .waitFor();
  await page.unroute(repositoryOptionsPath, failRepositoryReload);
  assert.equal(
    await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).isVisible(),
    true,
  );
  await page
    .getByText(`Configuration saved: ${savedConfiguration.data.id}.`, { exact: false })
    .waitFor();
  assert.equal(await page.locator(".repository-options input").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isEnabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  // Even a post-authorization optional outage cannot satisfy a repository-scoped retry.
  const optionalRepositoryOutage = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "REPOSITORY_OPTIONS_UNAVAILABLE",
          message: "Repository choices are unavailable.",
        },
      }),
    });
  await page.route(repositoryOptionsPath, optionalRepositoryOutage);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Repository choices could not be reloaded/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.unroute(repositoryOptionsPath, optionalRepositoryOutage);

  const conflictRepositoryReload = (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "RESOURCE_CONFLICT", message: "Namespace lifecycle conflict" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  await page.route(repositoryOptionsPath, conflictRepositoryReload);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Namespace no longer accepts new Agents/ })
    .waitFor();
  await page
    .getByRole("status")
    .getByText("This Namespace no longer accepts new Agents.", { exact: true })
    .waitFor();
  await page.unroute(repositoryOptionsPath, conflictRepositoryReload);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await page.locator("#repository-application").isEnabled(), true);
  assert.equal(await page.locator("#repository-application").isChecked(), false);
  // Refreshing policy permits editing; it must not turn this saved attempt into an ordinary Agent.
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isVisible(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.locator("#repository-application").check();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#repository-profile-git-read").check();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
  await page.locator("#repository-application").uncheck();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-read").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = await (await createdResponse).json();
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-read" },
  ]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.equal(created.data.configurationId, savedConfiguration.data.id);
});

test("Agent creation does not expose recovery actions after an unknown admission outcome", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "804",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**/namespaces/${namespace.id}/agents`, async (route) => {
    if (route.request().method() === "POST") {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Unknown Outcome Agent");

  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByText(/Outcome unknown/).waitFor();
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Recover from a rejected Agent save",
        includeHidden: true,
      })
      .isVisible(),
    false,
  );
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Start a new draft", includeHidden: true }).isDisabled(),
    true,
  );
  assert.equal(await page.locator("#repository-application").isDisabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent repository recovery with empty current policy requires an explicit new draft", async (t) => {
  const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
    t,
    (namespaceId) => [
      {
        repositoryRef: "application",
        repositoryId: "806",
        repository: "example/application",
        namespaces: [{ namespaceId, profiles: ["git-read"] }],
      },
    ],
    { reloadablePolicy: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository policy removed");
  fixture.policy.restrictions.push({
    id: "reject-before-policy-refresh",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "create",
    effect: "deny",
  });
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/configurations`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const saved = (await (await savedResponse).json()).data;
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  fixture.policy.restrictions.pop();
  // The real registry policy now approves only another Namespace.
  replacePolicy([
    {
      repositoryRef: "application",
      repositoryId: "806",
      repository: "example/application",
      namespaces: [{ namespaceId: `ns_${randomUUID()}`, profiles: ["git-read"] }],
    },
  ]);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await page.locator(".repository-options input").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await page.waitForTimeout(100);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start a new draft" }).click();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/No approved repositories are available/).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Explicit ordinary draft");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const created = (await (await createdResponse).json()).data;
  assert.equal(Object.hasOwn(created, "repositoryBindings"), false);
  assert.notEqual(created.configurationId, saved.id);
  assert.equal(
    (await fixture.request("GET", `/namespaces/${namespace.id}/configurations/${saved.id}`)).status,
    200,
  );
});

test("Dedicated Agent creation provisions inline Configuration and masked new Secrets", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provisioned create", { ready: true });
  const values = nativeValues("provision", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const agentId = "agt_00000000-0000-4000-8000-00000000feed";
  const revisionId = "rev_00000000-0000-4000-8000-00000000feed";
  let allowProvisioningSuccess = false;
  let provisioningReads = 0;
  let deploymentReads = 0;
  let provisionBody;
  const savedSecrets = new Map();
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            repositoryRef: "application",
            displayName: "example/application",
            allowedProfiles: ["git-write"],
          },
        ],
        meta: { requestId: "req_repository_choices" },
      }),
    }),
  );

  const agent = {
    id: agentId,
    namespaceId: namespace.id,
    name: "Provisioned Agent",
    status: "active",
    desiredRuntimeState: "running",
    configurationId: "cfg_00000000-0000-4000-8000-00000000feed",
    executionMode: "dedicated",
    harnessAuth: {
      method: "api_key",
      source: null,
    },
    servicePrincipalId: "identity_provisioned_agent",
    createdAt: new Date().toISOString(),
    activeRevisionId: revisionId,
  };
  const revision = {
    id: revisionId,
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    providerId: null,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 2,
    createdAt: agent.createdAt,
    configuration: values,
    harnessAuth: agent.harnessAuth,
    harness: { id: "codex", version: "test", mode: "dedicated" },
    compute: { id: "kubernetes-test", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
  };
  const json = (data, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON();
    // Secrets use the real API; only provisioning and deployment progression are simulated.
    const response = await route.fetch();
    const saved = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    provisionBody = request.postDataJSON();
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: "work_create",
            status: "queued",
            phase: "admitted",
            attemptCount: 1,
            updatedAt: agent.createdAt,
            url: `/namespaces/${namespace.id}/agents/provision/work_create`,
          },
        },
        202,
      ),
    );
  });
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}`, async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill(json(agent));
      return;
    }
    await route.fallback();
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_create`, async (route) => {
    provisioningReads += 1;
    await route.fulfill(
      json({
        provisioning: {
          workId: "work_create",
          status: allowProvisioningSuccess ? "succeeded" : "running",
          phase: allowProvisioningSuccess ? "handoff" : "configuration",
          attemptCount: 1,
          updatedAt: agent.createdAt,
          url: `/namespaces/${namespace.id}/agents/provision/work_create`,
          ...(allowProvisioningSuccess
            ? { configurationId: agent.configurationId, agentId, revisionId }
            : {}),
        },
      }),
    );
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    async (route) => {
      deploymentReads += 1;
      await route.fulfill(
        json({
          deploymentId: `dep_${revisionId}`,
          revisionId,
          status: deploymentReads > 1 ? "succeeded" : "queued",
          error: null,
        }),
      );
    },
  );
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}/revisions`, async (route) => {
    await route.fulfill(json([revision]));
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/revisions/${revisionId}`,
    async (route) => {
      await route.fulfill(json(revision));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/native-admin`,
    async (route) => {
      await route.fulfill(json({ status: "unsupported" }));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/workspace/files/*`,
    async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      await route.fulfill(json({ name, content: `# ${name}\n` }));
    },
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill(agent.name);
  await page.locator("#repository-application").check();
  await page.locator("#repository-profile-git-write").check();
  await page.getByLabel("API key", { exact: true }).fill("model-secret-value");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await channelDialog.getByLabel("Slack app token").selectOption("__openclaw_create_secret__");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Secret value").fill("slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack bot token").selectOption("__openclaw_create_secret__");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Secret value").fill("slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Enter at least one Slack channel ID for these access settings.")
    .waitFor();
  await channelDialog.getByLabel("Slack channel IDs").fill("C0123456789");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").uncheck();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Enter allowed channel user IDs or allow everyone in these channels.")
    .waitFor();
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();

  const provisionResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await provisionResponse).status(), 202);
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  allowProvisioningSuccess = true;
  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${agentId}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === revisionId &&
      url.searchParams.get("tab") === "workspace"
    );
  });

  assert.match(provisionBody.requestId, /^req_[0-9a-f-]{36}$/);
  assert.equal(provisionBody.name, agent.name);
  assert.deepEqual(provisionBody.repositoryBindings, [
    { repositoryRef: "application", profile: "git-write" },
  ]);
  assert.equal(provisionBody.executionMode, "dedicated");
  assert.deepEqual(provisionBody.harnessAuth, agent.harnessAuth);
  assert.deepEqual(provisionBody.configuration.values.channels.slack, {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { C0123456789: { requireMention: true, users: ["*"] } },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
  });
  assert.deepEqual(provisionBody.configuration, {
    kind: "agent",
    values: provisionBody.configuration.values,
    secretBindings: {
      SLACK_APP_TOKEN: {
        source: savedSecrets.get("Provisioned Agent Slack app token").ref,
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: savedSecrets.get("Provisioned Agent Slack bot token").ref,
        delivery: { type: "env" },
      },
    },
  });
  assert.equal(Object.hasOwn(provisionBody, "secrets"), false);
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [
      { name: "Provisioned Agent Slack app token", value: "slack-app-secret" },
      { name: "Provisioned Agent Slack bot token", value: "slack-bot-secret" },
      { name: "Provisioned Agent", value: "model-secret-value" },
    ],
  );
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.ok(provisioningReads >= 1);
  assert.ok(deploymentReads >= 2);
});

test("Dedicated Agent creation uses regular create when provisioning is unsupported", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unsupported provision", { ready: true });
  const values = nativeValues("unsupported-provision", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeInstallationWithoutProvisioning(page, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("This installation creates draft Agents for later deployment.").waitFor();
  await assert.rejects(
    page.getByRole("heading", { name: "Secrets" }).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );

  await page.getByLabel("Agent name").fill("Unsupported Dedicated Agent");
  await page.getByLabel("API key", { exact: true }).fill("unsupported-model-key");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Slack channel IDs").fill("CUNSUPPORTED123");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await createdResponse).status(), 201);
  // Navigation follows the model Secret grant; the Agent POST alone does not finish creation.
  await page.waitForURL((url) => url.pathname.startsWith("/console/agents/agt_"));

  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
  const configurationWrites = configurationPostRequests(requests, namespace.id);
  assert.equal(configurationWrites.length, 1);
  assert.deepEqual(configurationWrites[0].body.values.channels.slack.channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["*"] },
  });
  assert.equal(Object.hasOwn(configurationWrites[0].body, "secretBindings"), false);
  assert.equal(accessBindingPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(
    agentPostRequests(requests, namespace.id).map((request) => request.body),
    [
      {
        name: "Unsupported Dedicated Agent",
        executionMode: "dedicated",
        initialWorkspaceFiles: WORKSPACE_DEFAULTS,
        workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
        harnessAuth: agentPostRequests(requests, namespace.id)[0].body.harnessAuth,
        configurationId: requests.find(
          (request) =>
            request.method === "POST" && request.path === `/namespaces/${namespace.id}/agents`,
        )?.body.configurationId,
      },
    ],
  );
  // Read the created draft through the real API, then verify both access choices
  // survive a new page load rather than only remaining in the create form.
  const createdAgent = (await (await createdResponse).json()).data;
  await page.goto(detailUrl(fixture, namespace.id, createdAgent.id, "draft", "channels").href);
  await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
  let savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
  const everyone = savedDialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await everyone.isChecked(), true);
  assert.equal(await savedDialog.getByLabel("Allowed channel user IDs").isDisabled(), true);
  await everyone.uncheck();
  await savedDialog.getByLabel("Allowed channel user IDs").fill("USENDER123");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(`/configurations/${createdAgent.configurationId}`),
  );
  await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page.reload();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
  savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(await savedDialog.getByLabel("Allowed channel user IDs").inputValue(), "USENDER123");
  assert.equal(
    await savedDialog
      .getByLabel("Allow everyone in these channels to mention the agent")
      .isDisabled(),
    true,
  );
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${createdAgent.configurationId}`,
  );
  assert.deepEqual(savedConfiguration.data.values.channels.slack.channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["USENDER123"] },
  });
  assert.equal(savedConfiguration.data.values.channels.slack.groupPolicy, "allowlist");
  assert.equal(savedConfiguration.data.values.channels.slack.dmPolicy, "allowlist");
  assert.equal(Object.hasOwn(savedConfiguration.data.values.channels.slack, "allowFrom"), false);
});

test("Dedicated Agent creation reuses separately saved Secret references after provisioning failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision retry", { ready: true });
  const values = nativeValues("provision-retry", {
    harnessId: "codex",
    providerModel: "gpt-5.1",
  });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const agentId = "agt_00000000-0000-4000-8000-00000000babe";
  const revisionId = "rev_00000000-0000-4000-8000-00000000babe";
  const createdAt = new Date().toISOString();
  const bodies = [];
  const savedSecrets = new Map();
  const agent = {
    id: agentId,
    namespaceId: namespace.id,
    name: "Retried Agent",
    status: "active",
    desiredRuntimeState: "running",
    configurationId: "cfg_00000000-0000-4000-8000-00000000babe",
    executionMode: "dedicated",
    harnessAuth: {
      method: "codex_pat",
      source: null,
    },
    servicePrincipalId: "identity_retried_agent",
    createdAt,
    activeRevisionId: revisionId,
  };
  const revision = {
    id: revisionId,
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    providerId: null,
    configurationId: agent.configurationId,
    configurationKind: "agent",
    configurationGeneration: 1,
    createdAt,
    configuration: values,
    harnessAuth: agent.harnessAuth,
    harness: { id: "codex", version: "test", mode: "dedicated" },
    compute: { id: "kubernetes-test", implementation: "kubernetes" },
    servicePrincipalId: agent.servicePrincipalId,
  };
  const json = (data, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });

  await page.route(`**/namespaces/${namespace.id}/secrets`, async (route, request) => {
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = request.postDataJSON();
    // Keep Secret persistence real while simulating an uncertain provisioning response.
    const response = await route.fetch();
    const saved = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    bodies.push(request.postDataJSON());
    if (bodies.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "masked provisioning response",
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
        }),
      });
      return;
    }
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: "work_retry",
            status: "succeeded",
            phase: "handoff",
            attemptCount: 1,
            updatedAt: createdAt,
            configurationId: agent.configurationId,
            agentId,
            revisionId,
            url: `/namespaces/${namespace.id}/agents/provision/work_retry`,
          },
        },
        202,
      ),
    );
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/deployments/${revisionId}`,
    async (route) => {
      await route.fulfill(
        json({ deploymentId: `dep_${revisionId}`, revisionId, status: "succeeded" }),
      );
    },
  );
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}`, async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill(json(agent));
      return;
    }
    await route.fallback();
  });
  await page.route(`**/namespaces/${namespace.id}/agents/${agentId}/revisions`, async (route) => {
    await route.fulfill(json([revision]));
  });
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/revisions/${revisionId}`,
    async (route) => {
      await route.fulfill(json(revision));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/native-admin`,
    async (route) => {
      await route.fulfill(json({ status: "unsupported" }));
    },
  );
  await page.route(
    `**/namespaces/${namespace.id}/agents/${agentId}/workspace/files/*`,
    async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1));
      await route.fulfill(json({ name, content: `# ${name}\n` }));
    },
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill(agent.name);
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await page.getByLabel("Service account token", { exact: true }).fill("model-secret-value");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Slack app token").selectOption("__openclaw_create_secret__");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Secret value").fill("retry-slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack bot token").selectOption("__openclaw_create_secret__");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Secret value").fill("retry-slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await channelDialog.getByLabel("Slack channel IDs").fill("CRETRY123");
  await channelDialog.getByLabel("Allow everyone in these channels to mention the agent").check();
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const firstProvisionResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/provision` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await firstProvisionResponse).status(), 503);
  await page
    .getByText("Outcome unknown. Retry resubmits the same request ID and saved references")
    .waitFor();
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(await page.getByLabel("Configuration JSON").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Retry provisioning request" }).click();

  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${agentId}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === revisionId &&
      url.searchParams.get("tab") === "workspace"
    );
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1], bodies[0]);
  assert.equal(bodies[0].requestId, bodies[1].requestId);
  assert.equal(bodies[0].name, agent.name);
  assert.deepEqual(bodies[0].configuration.values.channels.slack.channels, {
    CRETRY123: { requireMention: true, users: ["*"] },
  });
  assert.deepEqual(bodies[0].harnessAuth, agent.harnessAuth);
  assert.equal(Object.hasOwn(bodies[0], "secrets"), false);
  assert.deepEqual(bodies[0].configuration.secretBindings, {
    SLACK_APP_TOKEN: {
      source: savedSecrets.get("Retried Agent Slack app token").ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: savedSecrets.get("Retried Agent Slack bot token").ref,
      delivery: { type: "env" },
    },
  });
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [
      { name: "Retried Agent Slack app token", value: "retry-slack-app-secret" },
      { name: "Retried Agent Slack bot token", value: "retry-slack-bot-secret" },
      { name: "Retried Agent", value: "model-secret-value" },
    ],
  );
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

  await enterManualModel(page, "unused-invalid-config-key", "gpt-4.1");
  await page.getByLabel("Agent name").fill("Broken Agent");
  await page.getByLabel("Configuration JSON").fill("[]");
  await page.getByRole("button", { name: "Create Agent" }).click();

  const validation = await page
    .getByLabel("Configuration JSON")
    .evaluate((node) => node.validationMessage);
  assert.equal(validation, "Enter a valid JSON object.");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
});

test("Agent creation discovers available Anthropic models without saving the key before explicit selection", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    state,
    secretDriver,
    providerSummaries: undefined,
    discoverHarnessModels: async () => [
      { id: "claude-account-alpha", name: "Account Alpha" },
      { id: "claude-account/beta", name: "Account Beta" },
    ],
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Anthropic authoring", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page
    .getByLabel("Service account token", { exact: true })
    .fill("at-discarded-before-anthropic");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.deepEqual(
    await page
      .getByLabel("Harness", { exact: true })
      .locator("option:not([disabled])")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["openclaw"],
  );
  assert.equal(
    await page.getByLabel("API key", { exact: true }).getAttribute("placeholder"),
    "sk-ant-…",
  );
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication source").count(), 0);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents?.defaults?.model,
    undefined,
  );
  await page.getByLabel("Agent name").fill("Anthropic Agent");
  await page.getByLabel("API key", { exact: true }).fill("test-anthropic-api-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  const choice = page.getByLabel("Model", { exact: true });
  await choice.locator('option[value="claude-account/beta"]').waitFor({ state: "attached" });
  assert.deepEqual(await optionValues(choice), [
    { value: "", text: "Choose a model" },
    { value: "claude-account-alpha", text: "Account Alpha" },
    { value: "claude-account/beta", text: "Account Beta" },
  ]);
  assert.equal(await choice.inputValue(), "");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.equal(secretDriver.calls.length, 0);
  assert.equal(JSON.stringify(audit.events).includes("test-anthropic-api-key"), false);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).map(
      ({ body }) => body,
    ),
    [{ provider: "anthropic", authMethod: "api_key", apiKey: "test-anthropic-api-key" }],
  );
  await choice.selectOption("claude-account/beta");
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  assert.equal(agent.executionMode, "embedded");
  assert.equal(agent.providerId, null);
  assert.equal(agent.harnessAuth.method, "api_key");
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "anthropic/claude-account/beta");
  assert.deepEqual(configuration.data.values.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-account/beta", name: "claude-account/beta" }],
  });
  assert.equal(
    configuration.data.values.agents.defaults.models["anthropic/claude-account/beta"].agentRuntime
      .id,
    "openclaw",
  );
  assert.equal(pathRequests(requests, "GET", "/providers").length, 0);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/service-accounts`).length,
    0,
  );
  assert.equal(JSON.stringify(configuration.data).includes("test-anthropic-api-key"), false);
});

test(
  "Model discovery discards stale responses after key, auth method, and provider changes",
  { timeout: 30_000 },
  async (t) => {
    let releaseFirst;
    let firstRequested;
    let methodRefresh = false;
    let releaseMethod;
    let methodRequested;
    const methodRequest = new Promise((resolve) => {
      methodRequested = resolve;
    });
    let refresh = false;
    let releaseRefresh;
    let refreshRequested;
    const refreshRequest = new Promise((resolve) => {
      refreshRequested = resolve;
    });
    const firstRequest = new Promise((resolve) => {
      firstRequested = resolve;
    });
    const fixture = await createConsoleAppFixture(t, {
      discoverHarnessModels: async ({ provider, apiKey }) => {
        if (apiKey === "first-openai-key") {
          firstRequested();
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        }
        if (apiKey === "second-openai-key" && methodRefresh) {
          methodRequested();
          return new Promise((resolve) => {
            releaseMethod = resolve;
          });
        }
        if (apiKey === "second-openai-key" && refresh) {
          refreshRequested();
          return new Promise((resolve) => {
            releaseRefresh = resolve;
          });
        }
        return [{ id: `${provider}-current-model`, name: `${provider} current model` }];
      },
    });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Model response ordering", { ready: true });
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    const key = page.getByLabel("API key", { exact: true });
    const choice = page.getByLabel("Model", { exact: true });
    try {
      await key.fill("first-openai-key");
      await key.press("Tab");
      await firstRequest;
      await key.fill("second-openai-key");
      await key.press("Tab");
      await choice.selectOption("openai-current-model");
      assert.equal(
        JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
        "codex/openai-current-model",
      );

      const staleKeyResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/namespaces/${namespace.id}/agents/models`) &&
          response.request().postDataJSON()?.apiKey === "first-openai-key",
      );
      releaseFirst([{ id: "stale-key-model", name: "Stale key model" }]);
      await (await staleKeyResponse).finished();
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await key.inputValue(), "second-openai-key");
      assert.equal(await choice.inputValue(), "openai-current-model");
      assert.equal(
        (await optionValues(choice)).some(({ value }) => value === "stale-key-model"),
        false,
      );

      // A response from the previous auth method must not repopulate the cleared form.
      methodRefresh = true;
      await page.getByRole("button", { name: "Load models", exact: true }).click();
      await methodRequest;
      await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
      const staleMethodResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/namespaces/${namespace.id}/agents/models`) &&
          response.request().postDataJSON()?.apiKey === "second-openai-key",
      );
      releaseMethod([{ id: "stale-method-model", name: "Stale API-key model" }]);
      await (await staleMethodResponse).finished();
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "openai");
      assert.equal(
        await page.getByLabel("Service account token", { exact: true }).inputValue(),
        "",
      );
      assert.equal(await choice.isVisible(), false);
      assert.equal(
        (await optionValues(choice)).some(({ value }) => value === "stale-method-model"),
        false,
      );
      assert.equal(
        JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
        undefined,
      );
      methodRefresh = false;
      await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
      await key.fill("second-openai-key");
      await key.press("Tab");
      await choice.selectOption("openai-current-model");

      // Hold a refresh across a provider switch independently of the key-change fence above.
      refresh = true;
      await page.getByRole("button", { name: "Load models", exact: true }).click();
      await refreshRequest;
      await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
      assert.equal(await key.inputValue(), "");
      assert.equal(await choice.isVisible(), false);
      assert.equal(
        JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
        undefined,
      );
      await key.fill("current-anthropic-key");
      await key.press("Tab");
      await choice.selectOption("anthropic-current-model");
      const staleResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/namespaces/${namespace.id}/agents/models`) &&
          response.request().postDataJSON()?.apiKey === "second-openai-key",
      );
      releaseRefresh([{ id: "stale-openai-model", name: "Stale OpenAI model" }]);
      await (await staleResponse).finished();
      // Observe after the next render, once the delivered response could update the controls.
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame));
      assert.equal(await key.inputValue(), "current-anthropic-key");
      assert.equal(await choice.inputValue(), "anthropic-current-model");
      assert.deepEqual(await optionValues(choice), [
        { value: "", text: "Choose a model" },
        { value: "anthropic-current-model", text: "anthropic current model" },
      ]);
      assert.equal(
        JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
        "anthropic/anthropic-current-model",
      );
      assert.deepEqual(nonAuthWriteRequests(requests), []);
      assert.deepEqual(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).map(
          ({ body }) => body,
        ),
        [
          { provider: "openai", authMethod: "api_key", apiKey: "first-openai-key" },
          { provider: "openai", authMethod: "api_key", apiKey: "second-openai-key" },
          { provider: "openai", authMethod: "api_key", apiKey: "second-openai-key" },
          { provider: "openai", authMethod: "api_key", apiKey: "second-openai-key" },
          { provider: "openai", authMethod: "api_key", apiKey: "second-openai-key" },
          { provider: "anthropic", authMethod: "api_key", apiKey: "current-anthropic-key" },
        ],
      );
    } finally {
      releaseFirst?.([]);
      releaseMethod?.([]);
      releaseRefresh?.([]);
    }
  },
);

test("Model discovery failure permits an explicit manual model and still saves through the real Agent API", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    discoverHarnessModels: async () => {
      throw new ModelDiscoveryError("credentials_rejected");
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Manual model recovery", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Manual recovery Agent");
  await enterManualModel(page, "model-discovery-unavailable-key", "gpt-manual-account-model");
  await page
    .getByText("The provider rejected this API key or its permission to list models.")
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-manual-account-model");
  assert.equal(
    JSON.stringify(configuration.data).includes("model-discovery-unavailable-key"),
    false,
  );
});

test("Agent creation reports unavailable Secret storage before creating Configuration or Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t, { secretDriver: null });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing Secret storage", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Unavailable Agent");
  await enterManualModel(page, "unused-no-driver-key", "gpt-4.1");
  const failed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await failed).status(), 503);
  await page
    .getByRole("alert")
    .filter({ hasText: /unavailable|unknown|configured/i })
    .waitFor();
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation reuses its saved Secret and Configuration after an Agent creation conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial save retry", { ready: true });
  await fixture.createAgent(namespace.id, "Retry Agent");
  const values = nativeValues("partial-save", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page.getByLabel("Service account token", { exact: true }).fill("at-discarded-pat");
  await page.getByLabel("Service account token", { exact: true }).press("Tab");
  await page.getByLabel("Model ID", { exact: true }).fill("discarded-pat-model");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  // OpenClaw requires a new API key, never the previous service account token.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
    undefined,
  );
  assert.equal(
    await page
      .getByLabel("Authentication method", { exact: true })
      .locator('[value="codex_pat"]')
      .isDisabled(),
    true,
  );
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).map(
      ({ body }) => body,
    ),
    [{ provider: "openai", authMethod: "codex_pat", apiKey: "at-discarded-pat" }],
  );
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  const credential = page.getByLabel("Service account token", { exact: true });
  await credential.fill("at-browser-pat");
  await credential.press("Tab");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).at(-1).body,
    { provider: "openai", authMethod: "codex_pat", apiKey: "at-browser-pat" },
  );
  requests.length = 0;
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Keep this draft\n");
  await page.getByLabel("Agent name").fill("Retry Agent");
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
  await page
    .getByText(`Configuration saved: ${savedConfiguration.data.id}.`, { exact: false })
    .waitFor();
  await page.getByText(/conflicts with the saved state/i).waitFor();
  assert.equal(
    await page
      .getByRole("heading", {
        name: "Recover from a rejected Agent save",
        includeHidden: true,
      })
      .isVisible(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Reload repository choices", includeHidden: true })
      .isVisible(),
    false,
  );
  assert.equal(await page.getByLabel("Configuration JSON").isDisabled(), true);
  assert.equal(await page.getByLabel("Service account token", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Service account token", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
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
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel("Plugin selections JSON").isEnabled(), true);
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Corrected draft\n");
  await page.getByLabel("Plugin selections JSON").fill(
    JSON.stringify({
      "occ-plugin:diffs": { enabled: true, approvalMode: "always" },
    }),
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
  assert.equal(retried.data.harnessAuth.method, "codex_pat");
  assert.equal(retried.data.configurationId, savedConfiguration.data.id);
  assert.equal(retried.data.activeRevisionId, undefined);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.deepEqual(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).map(
      ({ body }) => body.value,
    ),
    ["at-browser-pat"],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.deepEqual(
    agentPostRequests(requests, namespace.id)[0].body.harnessAuth,
    retried.data.harnessAuth,
  );
  const attempts = agentPostRequests(requests, namespace.id);
  assert.equal(attempts[0].body.initialWorkspaceFiles["SOUL.md"], "# Keep this draft\n");
  assert.equal(attempts[1].body.initialWorkspaceFiles["SOUL.md"], "# Corrected draft\n");
  assert.deepEqual(retried.data.plugins, {
    "occ-plugin:diffs": { enabled: true, approvalMode: "always" },
  });
  for (const request of attempts) {
    assert.equal(request.body.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  }
});

test("Agent creation retries a denied credential grant without duplicating its saved resources", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const installation = await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Credential grant retry", { ready: true });
  fixture.policy.restrictions.push({
    id: "deny-credential-grant",
    resourceKind: "installation",
    resourceId: installation.id,
    action: "administer",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Grant retry Agent");
  await enterManualModel(page, "grant-retry-key", "gpt-4.1");
  const created = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await created;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page
    .getByRole("alert")
    .filter({ hasText: /Agent was created, but credential access is not confirmed/ })
    .waitFor();
  assert.match(
    await page.getByRole("link", { name: "Open saved Agent" }).getAttribute("href"),
    new RegExp(agent.id),
  );
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  const bindingPath = `/namespaces/${namespace.id}/iam/access-bindings`;
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 0);
  fixture.policy.restrictions.splice(
    fixture.policy.restrictions.findIndex((item) => item.id === "deny-credential-grant"),
    1,
  );

  // The binding is really committed; only its response is lost before the browser sees it.
  await page.route(`**${bindingPath}`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /credential access is not confirmed.*interrupted/ })
    .waitFor();
  await page.unroute(`**${bindingPath}`);
  await page.getByRole("button", { name: "Retry credential access" }).click();
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const bindings = await fixture.request("GET", bindingPath);
  assert.equal(bindings.status, 200);
  assert.equal(bindings.data.length, 1);
  assert.equal(bindings.data[0].subjectId, agent.servicePrincipalId);
  assert.equal(bindings.data[0].resourceId, agent.harnessAuth.source.id);
  assert.equal(pathRequests(requests, "POST", bindingPath).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/iam/roles`).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

for (const collection of ["secrets", "configurations", "agents"]) {
  test(`Agent creation blocks duplicate writes after losing the committed ${collection} response`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace(`Uncertain ${collection}`, { ready: true });
    const { page } = await newPage(t, fixture);
    // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
    await routeInstallationWithoutProvisioning(page, fixture);
    const requests = apiRequests(page, fixture.origin);
    const path = `/namespaces/${namespace.id}/${collection}`;
    let committed;
    await page.route(`**${path}`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committed = (await response.json()).data;
      await route.abort("failed");
    });
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Agent name").fill(`Uncertain ${collection} Agent`);
    await enterManualModel(page, "uncertain-artifact-key", "gpt-4.1");
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: /Outcome unknown/ })
      .waitFor();
    assert.ok(committed?.id);
    assert.equal((await fixture.request("GET", `${path}/${committed.id}`)).status, 200);
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
    // Even programmatic form resubmission must respect the unknown-commit boundary.
    await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
    assert.equal(pathRequests(requests, "POST", path).length, 1);
    const sequence = ["secrets", "configurations", "agents"];
    for (const later of sequence.slice(sequence.indexOf(collection) + 1)) {
      assert.equal(
        pathRequests(requests, "POST", `/namespaces/${namespace.id}/${later}`).length,
        0,
      );
    }
  });
}

test("Agent creation preserves unrelated edited JSON across model changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const harness = page.getByLabel("Harness", { exact: true });
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await enterManualModel(page, "template-edit-key", "gpt-5.1");
  const dedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(dedicatedTemplate.agents.defaults.model, "codex/gpt-5.1");
  assert.deepEqual(dedicatedTemplate.models.providers.codex.models, [
    { id: "gpt-5.1", name: "gpt-5.1" },
  ]);
  assert.ok(dedicatedTemplate.plugins.entries.codex);

  await harness.selectOption("openclaw");
  const embeddedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(embeddedTemplate.agents.defaults.model, "openai/gpt-5.1");
  assert.deepEqual(embeddedTemplate.models.providers.openai.models, [
    { id: "gpt-5.1", name: "gpt-5.1" },
  ]);
  assert.equal(embeddedTemplate.plugins?.entries?.codex, undefined);

  const custom = nativeValues("manual-edit");
  custom.agents.defaults.models["openai/gpt-4.1"].alias = "Primary assistant";
  custom.agents.defaults.models["openai/gpt-4.1"].params = { temperature: 0.4 };
  const extraModel = { id: "additional-model", name: "Additional model", contextWindow: 64000 };
  Object.assign(custom.models.providers.openai, {
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    headers: { "X-Custom-Transport": "enterprise-route" },
    models: [...custom.models.providers.openai.models, extraModel],
  });
  custom.gateway.controlUi = {
    enabled: false,
    allowedOrigins: ["https://custom-control.example.test"],
  };
  const edited = JSON.stringify(custom, null, 2);
  await configuration.fill(edited);
  const modelInput = page.getByLabel("Model ID", { exact: true });
  await modelInput.fill("gpt-4.1-updated");
  await modelInput.press("Tab");
  const assertCustomTransport = async () => {
    const provider = JSON.parse(await configuration.inputValue()).models.providers.openai;
    assert.equal(provider.baseUrl, custom.models.providers.openai.baseUrl);
    assert.equal(provider.api, custom.models.providers.openai.api);
    assert.deepEqual(provider.headers, custom.models.providers.openai.headers);
    assert.deepEqual(
      provider.models.find((entry) => entry.id === extraModel.id),
      extraModel,
    );
  };
  await assertCustomTransport();
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "openai/gpt-4.1-updated",
  );

  await page.getByLabel("API key", { exact: true }).fill("same-provider-replacement-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  await modelInput.waitFor();
  assert.equal(await modelInput.inputValue(), "");
  await assertCustomTransport();
  await modelInput.fill("gpt-4.1");
  await modelInput.press("Tab");
  await assertCustomTransport();
  assert.equal(await harness.inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.models["openai/gpt-4.1"]
      .agentRuntime.id,
    "openclaw",
  );

  await harness.selectOption("codex");
  const retained = JSON.parse(await configuration.inputValue());
  assert.equal(retained.agents.defaults.model, "codex/gpt-4.1");
  assert.deepEqual(retained.models.providers.codex, {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-responses",
    models: [{ id: "gpt-4.1", name: "gpt-4.1" }],
  });
  assert.equal(retained.models.providers.openai, undefined);
  assert.equal(retained.plugins.entries.knowledge.config.marker, "manual-edit");
  assert.deepEqual(retained.agents.defaults.models["codex/gpt-4.1"], {
    alias: "Primary assistant",
    params: { temperature: 0.4 },
    agentRuntime: { id: "codex" },
  });

  // Model and key edits must preserve the operator's existing Codex execution policy.
  const customCodex = structuredClone(retained.plugins.entries.codex);
  Object.assign(customCodex.config.appServer, {
    sandbox: "workspace-write",
    approvalPolicy: "never",
    remoteWorkspaceRoot: "/workspace/custom-agent",
  });
  retained.plugins.entries.codex = customCodex;
  await configuration.fill(JSON.stringify(retained));
  await modelInput.fill("gpt-4.1-codex-updated");
  await modelInput.press("Tab");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).plugins.entries.codex, customCodex);

  // Changing the key temporarily retains model settings while the operator chooses again.
  await page.getByLabel("API key", { exact: true }).fill("replacement-template-key");
  await page.getByLabel("API key", { exact: true }).press("Tab");
  const nextModel = page.getByLabel("Model ID", { exact: true });
  await nextModel.waitFor();
  assert.equal(await nextModel.inputValue(), "");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).plugins.entries.codex, customCodex);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  const resetTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(resetTemplate.agents?.defaults?.model, undefined);
  assert.ok(resetTemplate.plugins.entries.codex);
  await nextModel.fill("gpt-reset-model");
  await nextModel.press("Tab");
  assert.deepEqual(
    JSON.parse(await configuration.inputValue()).agents.defaults.models["codex/gpt-reset-model"],
    {
      agentRuntime: { id: "codex" },
    },
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await enterManualModel(page, "anthropic-template-key", "claude-template-model");
  const anthropicTemplate = JSON.parse(await configuration.inputValue());
  assert.deepEqual(anthropicTemplate.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-template-model", name: "claude-template-model" }],
  });
  assert.equal(anthropicTemplate.models.providers.codex, undefined);
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await harness.inputValue(), "codex");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await enterManualModel(page, "returned-openai-key", "gpt-returned-model");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-returned-model",
  );
  await page.getByLabel("Agent name").fill("Discarded draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  assert.equal(await page.getByLabel("Agent name").inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
});

test("Agent creation blocks an incompatible fallback after changing provider until the configuration is corrected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provider fallback change", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await enterManualModel(page, "fallback-openai-key", "gpt-5.1");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  const configuration = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await configuration.inputValue());
  values.agents.defaults.model = {
    primary: "openai/gpt-5.1",
    fallbacks: ["openai/gpt-4.1"],
  };
  await configuration.fill(JSON.stringify(values));
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  await enterManualModel(page, "test-fallback-anthropic-key", "claude-sonnet-4-6");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).agents.defaults.model, {
    primary: "anthropic/claude-sonnet-4-6",
    fallbacks: ["openai/gpt-4.1"],
  });
  await page.getByLabel("Agent name").fill("Corrected fallback Agent");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /fallback.*provider|provider.*fallback/i })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);

  // A provider change preserves edited fallbacks; resetting is an explicit correction.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-sonnet-4-6",
  );
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  assert.equal(agent.executionMode, "embedded");
  const persisted = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(persisted.data.values.agents.defaults.model, "anthropic/claude-sonnet-4-6");
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent creation saves explicitly selected models for both harnesses", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Starter model", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  for (const [mode, provider, harness, selectedModel] of [
    ["dedicated", "codex", "codex", "gpt-5.1"],
    ["embedded", "openai", "openclaw", "gpt-5.1"],
    ["embedded", "openai", "openclaw", "gpt-4.1"],
  ]) {
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await page.getByLabel("Harness", { exact: true }).selectOption(harness);
    await enterManualModel(page, `test-${mode}-${selectedModel}-key`, selectedModel);
    await page.getByLabel("Agent name").fill(`${mode}-${selectedModel}`);
    const saved = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    const agent = (await response.json()).data;
    assert.equal(agent.executionMode, mode);
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
  await page.getByText("API key · Secret configured", { exact: true }).waitFor();
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
  const slackAppSecretValue = "super-secret-slack-app-value";
  const slackBotSecretValue = "super-secret-slack-bot-value";
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel state", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI API key", secretValue);
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Slack bot token",
    slackBotSecretValue,
  );
  const secretBindings = {
    EXTERNAL_API_TOKEN: {
      source: secret.ref,
      delivery: { type: "env" },
    },
    SLACK_APP_TOKEN: {
      source: slackAppSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: slackBotSecret.ref,
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
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }

  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const appSecretPath = `/namespaces/${namespace.id}/secrets/${slackAppSecret.id}`;
  const botSecretPath = `/namespaces/${namespace.id}/secrets/${slackBotSecret.id}`;
  const appSecretLink = dialog.getByRole("link", {
    name: "View app token Secret metadata (opens in new tab)",
  });
  const botSecretLink = dialog.getByRole("link", {
    name: "View bot token Secret metadata (opens in new tab)",
  });
  assert.equal(await appSecretLink.getAttribute("href"), appSecretPath);
  assert.equal(await appSecretLink.getAttribute("target"), "_blank");
  assert.equal(await appSecretLink.getAttribute("rel"), "noopener");
  assert.equal(await botSecretLink.getAttribute("href"), botSecretPath);
  await dialog.getByText("Secret menu changes are saved with these channel settings.").waitFor();

  const channelIds = page.getByLabel("Slack channel IDs");
  const allowedUsers = page.getByLabel("Allowed channel user IDs");
  const allowEveryone = page.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowedUsers.inputValue(), "UOLD123");
  assert.equal(await allowedUsers.isDisabled(), false);
  assert.equal(await allowEveryone.isDisabled(), true);
  await channelIds.fill("COLD123, CNEW123");
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  await allowedUsers.fill("");
  assert.equal(await allowEveryone.isEnabled(), true);
  await allowEveryone.check();
  assert.equal(await allowedUsers.isDisabled(), true);
  await allowEveryone.uncheck();
  assert.equal(await allowedUsers.isEnabled(), true);
  await allowedUsers.fill("UNEW123");
  assert.equal(await allowEveryone.isDisabled(), true);
  await dialog
    .getByRole("link", { name: "Open Agent Credentials (opens in new tab)" })
    .scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: join(artifacts, "agent-channel-drawer-links.png"),
  });

  const appSecretPopupPromise = page.waitForEvent("popup");
  await appSecretLink.click();
  const appSecretPopup = await appSecretPopupPromise;
  await appSecretPopup.waitForLoadState("domcontentloaded");
  assert.equal(new URL(appSecretPopup.url()).pathname, appSecretPath);
  await appSecretPopup.getByText("Slack app token").waitFor();
  const secretMetadataText = await appSecretPopup.locator("body").textContent();
  assert.match(secretMetadataText, new RegExp(slackAppSecret.id));
  assert.doesNotMatch(secretMetadataText, new RegExp(slackAppSecretValue));
  await appSecretPopup.close();

  const credentialsPopupPromise = page.waitForEvent("popup");
  await dialog.getByRole("link", { name: "Open Agent Credentials (opens in new tab)" }).click();
  const credentialsPopup = await credentialsPopupPromise;
  await credentialsPopup.waitForURL(/\/console\/agents\/agt_/);
  const credentialsUrl = new URL(credentialsPopup.url());
  assert.equal(credentialsUrl.pathname, `/console/agents/${agent.id}`);
  assert.equal(credentialsUrl.searchParams.get("namespace"), namespace.id);
  assert.equal(credentialsUrl.searchParams.get("revision"), "draft");
  assert.equal(credentialsUrl.searchParams.get("tab"), "credentials");
  await credentialsPopup.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await credentialsPopup.close();
  assert.equal(await channelIds.inputValue(), "COLD123, CNEW123");
  assert.equal(await allowedUsers.inputValue(), "UNEW123");

  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  for (const value of [secretValue, slackAppSecretValue, slackBotSecretValue]) {
    await expectNoText(page, value);
  }
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
    COLD123: { requireMention: true, users: ["UNEW123"] },
    CNEW123: { requireMention: true, users: ["UNEW123"] },
  });
  assert.equal(configuration.data.values.channels.slack.dmPolicy, "allowlist");
  assert.deepEqual(configuration.data.values.channels.slack.allowFrom, ["UOLD123"]);
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

for (const [name, channels, reason] of [
  [
    "wildcard channel map",
    { "*": { requireMention: true, users: ["*"] } },
    "Slack wildcard channels must be edited in native Configuration JSON.",
  ],
  [
    "mixed channel sender lists",
    {
      CMIXED123: { requireMention: true, users: ["UONE123"] },
      CMIXED456: { requireMention: true, users: ["UTWO456"] },
    },
    "Existing Slack channels use different allowed channel users. Edit native Configuration JSON to preserve those restrictions.",
  ],
  [
    "comma channel sender ID",
    { CCOMMA123: { requireMention: true, users: ["UONE123,UTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
  [
    "newline channel sender ID",
    { CNEWLINE123: { requireMention: true, users: ["UONE123\nUTWO456"] } },
    "Slack channel users or Require mention values use an unsupported native shape.",
  ],
]) {
  test(`Channel drawer keeps Slack ${name} in native JSON`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Unsupported Slack native", { ready: true });
    const slack = {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      channels,
    };
    const agent = await fixture.createAgent(
      namespace.id,
      `Unsupported Slack ${name}`,
      nativeValues(`unsupported-slack-${name}`, { harnessId: "codex", channels: { slack } }),
      { executionMode: "dedicated" },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

    await login(page, fixture, url.pathname + url.search);
    await page.getByRole("heading", { name: `Unsupported Slack ${name}` }).waitFor();
    await page.getByText(reason).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);
    await revealNativeConfiguration(page, "Slack native configuration");
    const nativeJson = JSON.parse(await page.locator(".channel-native pre").textContent());
    assert.deepEqual(nativeJson, slack);
    assert.deepEqual(nonAuthWriteRequests(requests), []);
  });
}

test("Channel drawer binds existing Slack Secrets without dropping unsaved channel edits", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unbound Slack credentials", { ready: true });
  const slackAppSecretValue = "never-visible-menu-app-token";
  const slackBotSecretValue = "never-visible-menu-bot-token";
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack app token",
    slackAppSecretValue,
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Existing menu Slack bot token",
    slackBotSecretValue,
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CUNBOUND123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Unbound Slack Agent",
    nativeValues("unbound-slack", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Unbound Slack Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(await dialog.getByRole("link", { name: /Secret metadata/ }).count(), 0);
  const channelIds = dialog.getByLabel("Slack channel IDs");
  await channelIds.fill("CUNBOUND123, CBOUND456");
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await dialog.getByText("Secret binding staged. Apply the channel settings to save it.").waitFor();
  await dialog.getByLabel("Slack bot token").selectOption(slackBotSecret.id);
  await dialog
    .getByText("Secret binding staged. Apply the channel settings to save it.")
    .nth(1)
    .waitFor();
  assert.equal(await channelIds.inputValue(), "CUNBOUND123, CBOUND456");
  assert.equal(
    await dialog
      .getByRole("link", { name: "Open Agent Credentials (opens in new tab)" })
      .getAttribute("href"),
    `/console/agents/${agent.id}?revision=draft&tab=credentials&namespace=${namespace.id}`,
  );
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, {
    SLACK_APP_TOKEN: { source: slackAppSecret.ref, delivery: { type: "env" } },
    SLACK_BOT_TOKEN: { source: slackBotSecret.ref, delivery: { type: "env" } },
  });
  assert.deepEqual(configuration.data.values.channels.slack.channels, {
    CUNBOUND123: { requireMention: true, users: ["*"] },
    CBOUND456: { requireMention: true, users: ["*"] },
  });
  const pageText = await page.locator("body").textContent();
  assert.equal(pageText.includes(slackAppSecretValue), false);
  assert.equal(pageText.includes(slackBotSecretValue), false);
});

test("Channel drawer grants only the final selected Slack Secret", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Final Slack grant", { ready: true });
  const firstSecret = await fixture.createSecret(namespace.id, "First Slack app token", "hidden-a");
  const finalSecret = await fixture.createSecret(namespace.id, "Final Slack app token", "hidden-b");
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CFINAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Final Slack Grant Agent",
    nativeValues("final-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Final Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(firstSecret.id);
  await dialog.getByLabel("Slack app token").selectOption(finalSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: finalSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [finalSecret.id],
  );
});

test("Channel drawer does not grant when Slack Secret selection returns to original", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Original Slack grant", { ready: true });
  const originalSecret = await fixture.createSecret(
    namespace.id,
    "Original Slack app token",
    "hidden-original",
  );
  const temporarySecret = await fixture.createSecret(
    namespace.id,
    "Temporary Slack app token",
    "hidden-temporary",
  );
  const secretBindings = {
    SLACK_APP_TOKEN: { source: originalSecret.ref, delivery: { type: "env" } },
  };
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CORIG123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Original Slack Grant Agent",
    nativeValues("original-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated", secretBindings },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Original Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(temporarySecret.id);
  await dialog.getByLabel("Slack app token").selectOption(originalSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page.getByText(/Configuration .*generation 2/).waitFor();

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.deepEqual(configuration.data.secretBindings, secretBindings);
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer does not grant Slack Secret access when Configuration save is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Rejected Slack save", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Rejected save Slack app token",
    "hidden-rejected-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CREJECT123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Rejected Slack Save Agent",
    nativeValues("rejected-slack-save", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const configurationPath = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await page.route(`**${configurationPath}`, async (route, request) => {
    if (request.method() !== "PATCH") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "ACCESS_DENIED", message: "masked Configuration denial" },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000403" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Rejected Slack Save Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await dialog.getByText(/Access denied|permission/i).waitFor();
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowEveryone.isEnabled(), true);
  assert.equal(await allowedUsers.isDisabled(), true);

  const configuration = await fixture.request("GET", configurationPath);
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.data.secretBindings ?? {}, {});
  assert.deepEqual(accessBindingPostRequests(requests, namespace.id), []);
});

test("Channel drawer round trips existing Slack everyone channel access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack everyone access", { ready: true });
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom: ["UDM123"],
    channels: { CEVERY123: { requireMention: true, users: ["*"], allowBots: "mentions" } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Everyone Agent",
    nativeValues("slack-everyone", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Slack Everyone Agent" }).waitFor();
  await page.getByRole("button", { name: "Edit Slack" }).click();
  let dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack channel IDs").fill("CEVERY123, CSECOND123");
  const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
  const allowEveryone = dialog.getByLabel("Allow everyone in these channels to mention the agent");
  assert.equal(await allowEveryone.isChecked(), true);
  assert.equal(await allowedUsers.isDisabled(), true);
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
  assert.deepEqual(configuration.data.values.channels.slack, {
    ...slack,
    channels: {
      CEVERY123: { requireMention: false, users: ["*"], allowBots: "mentions" },
      CSECOND123: { requireMention: false, users: ["*"] },
    },
  });

  await page.getByRole("button", { name: "Edit Slack" }).click();
  dialog = page.getByRole("dialog", { name: "Edit Slack" });
  assert.equal(
    await dialog.getByLabel("Allow everyone in these channels to mention the agent").isChecked(),
    true,
  );
  assert.equal(await dialog.getByLabel("Allowed channel user IDs").isDisabled(), true);
  assert.equal(await dialog.getByLabel("Require a mention", { exact: true }).isChecked(), false);
});

test("Channel drawer reports partial save when post-PATCH Secret grant is rejected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Partial Slack grant", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Partial save Slack app token",
    "hidden-partial-save",
  );
  const slack = {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { CPARTIAL123: { requireMention: true } },
  };
  const agent = await fixture.createAgent(
    namespace.id,
    "Partial Slack Grant Agent",
    nativeValues("partial-slack-grant", { harnessId: "codex", channels: { slack } }),
    { executionMode: "dedicated" },
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
        meta: { requestId: "req_00000000-0000-4000-8000-000000000433" },
      }),
    });
  });
  const url = detailUrl(fixture, namespace.id, agent.id, "draft", "channels");

  await login(page, fixture, url.pathname + url.search);
  await page.getByRole("heading", { name: "Partial Slack Grant Agent" }).waitFor();
  requests.length = 0;
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Slack" });
  await dialog.getByLabel("Slack app token").selectOption(slackAppSecret.id);
  await page.getByRole("button", { name: "Save configuration" }).click();
  await page
    .getByText(
      "Configuration saved, but Secret access grants could not be confirmed. Open Agent Credentials to inspect saved bindings, then ask a Namespace administrator to grant this Agent access to the saved Secret.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Edit Slack" }).isDisabled(), true);

  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.status, 200);
  assert.equal(configuration.data.generation, 2);
  assert.deepEqual(configuration.data.secretBindings.SLACK_APP_TOKEN, {
    source: slackAppSecret.ref,
    delivery: { type: "env" },
  });
  assert.deepEqual(
    accessBindingPostRequests(requests, namespace.id).map((request) => request.body.resourceId),
    [slackAppSecret.id],
  );

  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  const appToken = page.getByLabel("Slack app token");
  await appToken.waitFor();
  assert.equal(await appToken.getAttribute("type"), "password");
  assert.equal(await appToken.inputValue(), "••••••••");
  assert.equal(await page.getByRole("button", { name: "Save channel Secrets" }).isDisabled(), true);
});

test("Runtime-auth Presets retain OpenClaw when changing from Anthropic to OpenAI", async (t) => {
  const { fixture, namespace } = await createRuntimeAuthFixture(t, "Runtime Preset providers");
  const root = await mkdtemp(join(tmpdir(), "occ-runtime-provider-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const primary = "anthropic/claude-runtime-model";
  const values = nativeValues("runtime-preset");
  values.agents.defaults.model = primary;
  values.agents.defaults.models = { [primary]: { agentRuntime: { id: "openclaw" } } };
  values.models.providers = {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [{ id: "claude-runtime-model", name: "claude-runtime-model" }],
    },
  };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Operator-managed credentials",
      template: {
        agent: {
          name: "Runtime provider Agent",
          executionMode: "embedded",
          harnessAuth: { method: "runtime" },
        },
        configuration: { values },
      },
    },
  });
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  // SSH's fixed runtime credential binding requires embedded OpenClaw for either provider.
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-4.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.equal(created.executionMode, "embedded");
  assert.deepEqual(created.harnessAuth, { method: "runtime" });
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-4.1");
  assert.deepEqual(saved.data.values.agents.defaults.models["openai/gpt-4.1"].agentRuntime, {
    id: "openclaw",
  });
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("API-key Presets keep their credential provider fixed while allowing model and runtime changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-bound-provider-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Bound provider Preset", { ready: true });
  const secret = await fixture.createSecret(namespace.id, "OpenAI model key", "preset-model-key");
  const harnessAuth = { method: "api_key", source: secret.ref };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Saved OpenAI credential",
      template: {
        agent: { name: "Bound provider Agent", executionMode: "embedded", harnessAuth },
        configuration: { values: nativeValues("bound-provider") },
      },
    },
  });
  assert.equal(preset.status, 201);
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const configuration = page.getByLabel("Configuration JSON", { exact: true });
  const original = JSON.parse(await configuration.inputValue());
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  // Editing JSON must not silently retarget the saved OpenAI Secret to Anthropic.
  const changed = structuredClone(original);
  changed.agents.defaults.model = "anthropic/claude-account-model";
  await configuration.fill(JSON.stringify(changed));
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration must use the selected provider" })
    .waitFor();
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const provider = page.getByLabel("Provider", { exact: true });
  assert.equal(await provider.inputValue(), "openai");
  assert.equal(await provider.isDisabled(), true);

  // Same-provider model and embedded-to-dedicated edits retain the original credential binding.
  await configuration.fill(JSON.stringify(original));
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  const dedicated = JSON.parse(await configuration.inputValue());
  assert.equal(dedicated.agents.defaults.model, "codex/gpt-5.1");
  // Existing dedicated Presets may also use the supported OpenAI model prefix.
  dedicated.agents.defaults.model = "openai/gpt-5.1";
  await configuration.fill(JSON.stringify(dedicated));
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.harnessAuth, harnessAuth);
  assert.equal(created.executionMode, "dedicated");
  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${created.configurationId}`,
  );
  assert.equal(saved.data.values.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
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
          harnessAuth: { method: "codex_pat", source: secret.ref },
          plugins,
        },
        configuration: { values, secretBindings },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
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
  await page
    .getByText("Preset authentication: Service Accounts · Secret configured", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Service account token", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "codex");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
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
  assert.equal(await page.getByLabel("Secret bindings JSON").isVisible(), false);
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
  assert.equal(await page.getByLabel("Secret bindings JSON").isDisabled(), true);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.getByLabel("Agent name", { exact: true }).fill("Preset Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await (await createdResponse).json();
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
  assert.equal(created.data.name, "Preset Agent");
  assert.deepEqual(created.data.plugins, plugins);
  assert.equal(created.data.providerId, providerFixtures[0].id);
  assert.deepEqual(created.data.harnessAuth, { method: "codex_pat", source: secret.ref });
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

  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page.getByLabel("Service account token Secret ID").waitFor();
  assert.equal(await page.getByLabel("Authentication source").inputValue(), "codex_pat");
  assert.equal(await page.getByLabel("Service account token Secret ID").inputValue(), secret.id);
  const patched = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source", exact: true }).click();
  assert.deepEqual((await (await patched).json()).data.harnessAuth, {
    method: "codex_pat",
    source: secret.ref,
  });

  // A Preset can supply an explicit model while requiring the operator to enter its key.
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  const keyEntryPreset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Preset requiring an API key",
      template: {
        agent: { name: "Preset key entry", executionMode: "embedded" },
        configuration: { values: nativeValues("preset-key-entry") },
      },
    },
  });
  assert.equal(keyEntryPreset.status, 201);
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(keyEntryPreset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const presetKey = page.getByLabel("API key", { exact: true });
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "gpt-4.1");
  await presetKey.fill("preset-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await presetKey.inputValue(), "");
  await presetKey.fill("preset-anthropic-key");
  const native = page.getByLabel("Configuration JSON");
  const changedProvider = JSON.parse(await native.inputValue());
  changedProvider.agents.defaults.model = "openai/gpt-4.1";
  await native.fill(JSON.stringify(changedProvider));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "openai");
  assert.equal(await presetKey.inputValue(), "");
  const mode = page.getByLabel("Execution mode");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await presetKey.fill("preset-dedicated-openai-key");
  const anthropicConfiguration = JSON.parse(await native.inputValue());
  anthropicConfiguration.agents.defaults.model = "anthropic/claude-account-model";
  await native.fill(JSON.stringify(anthropicConfiguration));
  assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "anthropic");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.isDisabled(), true);
  assert.equal(await presetKey.inputValue(), "");
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
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
    const dialog = page.getByRole("dialog", { name: "Edit Slack" });
    const allowedUsers = dialog.getByLabel("Allowed channel user IDs");
    const allowEveryone = dialog.getByLabel(
      "Allow everyone in these channels to mention the agent",
    );
    assert.equal(await allowedUsers.inputValue(), "UKEEP123");
    assert.equal(await allowEveryone.isDisabled(), true);
    await dialog.getByLabel("Slack channel IDs").fill("CKEEP123, CNEW123");
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
  const secret = page.getByLabel("API key Secret ID");
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
  await page.getByLabel("API key Secret ID").waitFor();
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

test("standard Codex password Preset creates one scoped Secret and reuses it after an Agent conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const root = await mkdtemp(join(tmpdir(), "occ-password-preset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configurationDriver = new FilesystemConfigurationDriver(root);
  fixture.controller.registerDriver(configurationDriver);
  fixture.controller.selectDriver("configuration", configurationDriver.id);
  const namespace = await fixture.createNamespace("Password Preset", { ready: true });
  await fixture.createAgent(namespace.id, "Existing Agent");
  const artifact = JSON.parse(
    await readFile(new URL("../../deploy/presets/standard-codex.json", import.meta.url), "utf8"),
  );
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: artifact,
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByLabel("Variable: name", { exact: true }).fill("Existing Agent");
  await page.getByLabel("Variable: model", { exact: true }).fill("gpt-5.1");
  const password = page.getByLabel("Variable: modelSecret", { exact: true });
  assert.equal(await password.getAttribute("type"), "password");
  await page.getByRole("button", { name: "Use Preset" }).click();
  assert.equal(await password.evaluate((input) => input.validity.valueMissing), true);
  const key = "synthetic-password-key-{{ vars.name }}";
  await password.fill(key);
  await page.getByRole("button", { name: "Use Preset" }).click();
  const apiKey = page.getByLabel("API key", { exact: true });
  assert.equal(await apiKey.getAttribute("type"), "password");
  assert.equal(await apiKey.inputValue(), key);
  assert.equal(
    (await page.getByLabel("Configuration JSON", { exact: true }).inputValue()).includes(key),
    false,
  );
  assert.equal(nonAuthWriteRequests(requests).length, 0);
  const save = page.getByRole("button", { name: "Create Agent", exact: true });
  const conflict = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  assert.equal((await conflict).status(), 409);
  await page.getByText(/conflicts with the saved state/).waitFor();
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), true);
  await page.getByLabel("Agent name", { exact: true }).fill("Password Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents`) &&
      response.request().method() === "POST",
  );
  await save.click();
  const created = await (await createdResponse).json();
  await page.waitForURL((url) => url.pathname === `/console/agents/${created.data.id}`);
  const secretWrites = pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`);
  assert.equal(secretWrites.length, 1);
  assert.equal(secretWrites[0].body.value, key);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(
    JSON.stringify(requests.filter((request) => !request.path.endsWith("/secrets"))).includes(key),
    false,
  );
  assert.equal(created.data.executionMode, "dedicated");
  assert.equal(created.data.harnessAuth.source.namespaceId, namespace.id);
  const secrets = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
  assert.ok(secrets.data.some((secret) => secret.id === created.data.harnessAuth.source.id));
  assert.equal(JSON.stringify(secrets.body).includes(key), false);
  const retained = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/presets/${preset.data.id}`,
  );
  assert.deepEqual(retained.data.template, artifact.template);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.ok(
    access.data.some(
      (binding) =>
        binding.subjectId === created.data.servicePrincipalId &&
        binding.resourceId === created.data.harnessAuth.source.id,
    ),
  );
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  login,
  setSlackSelection,
  slackSelectionValue,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  secretOptionLabel,
  secretPostRequests,
  selectSecret,
  settlePageRequests,
  repositoryCheckbox,
  waitForInputValue,
} from "./console-agents-browser-helpers.mjs";
import {
  STARTER_CONTROL_UI,
  openCreateSecretDialog,
  createModelCredentialSecret,
  enterManualModel,
  openAdvancedSettings,
  configurationPostRequests,
  agentProvisionPostRequests,
  routeInstallationProvisioning,
  routeInstallationWithoutProvisioning,
  agentPostRequests,
  optionValues,
  createRepositoryLaunchFixture,
  waitForCreateFormReads,
} from "./console-agents-test-support.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  assert.equal(await page.getByRole("link", { name: "Backends", exact: true }).count(), 0);
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
    { value: "oauth", text: "ChatGPT OAuth (Experimental)" },
  ]);
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.waitFor();
  assert.equal(await apiKeySecret.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await apiKeySecret.evaluate((node) => node.required), true);
  assert.equal(await page.locator("#plugin-discovery-token").isVisible(), false);
  assert.equal(await page.getByRole("link", { name: "Create an API key", exact: true }).count(), 0);
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await page.getByLabel("Service account token Secret", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    "",
  );
  await page.locator("#plugin-discovery-token > summary").click();
  const discoveryToken = page.getByLabel("Token for plugin discovery", { exact: true });
  assert.equal(await discoveryToken.inputValue(), "");
  assert.equal(await discoveryToken.getAttribute("placeholder"), "at-…");
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
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), true);
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await page.getByLabel("Harness", { exact: true }).isEnabled(), true);
  await apiKeySecret.waitFor();
  assert.equal(await apiKeySecret.inputValue(), "");
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  await page.getByLabel("Agent name").fill("Console-created Agent");
  const secret = await enterManualModel(page, key, "gpt-5.1");
  for (const [filename, content] of Object.entries(WORKSPACE_DEFAULTS)) {
    assert.equal(await page.getByLabel(filename, { exact: true }).inputValue(), content);
  }
  // Textareas preserve literal markup as content and normalize browser newlines to LF.
  const customIdentity = "# Identity\r\n<em>Workspace author</em>\r\n";
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("IDENTITY.md", { exact: true }).fill(customIdentity);
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page.getByLabel("Agent name").fill("Console-created Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const createChannelDialog = page.getByRole("dialog", { name: /^(Configure|Edit) Slack$/ });
  await createChannelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await createChannelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await createChannelDialog
    .getByText(
      "Channel settings and selected bindings are not persisted until you create the Agent. Secrets created from the modal are stored immediately in the Namespace.",
    )
    .waitFor();
  assert.equal(await createChannelDialog.getByRole("link").count(), 0);
  await selectSecret(createChannelDialog, "Slack app token", existingSlackAppSecret);
  await createChannelDialog
    .getByText("Secret selected. Apply channel settings, then Create Agent binds it.")
    .waitFor();
  // Separate applications must retain grants for every final selected Secret.
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  const nestedChannelIds = createChannelDialog.getByRole("combobox", {
    name: "Channels",
    exact: true,
  });
  await setSlackSelection(nestedChannelIds, "CNESTED123");
  await openCreateSecretDialog(createChannelDialog, "Slack bot token");
  const createSecretDialog = page.getByRole("dialog", {
    name: "Create Slack bot token Secret",
  });
  await createSecretDialog
    .getByRole("heading", { name: "Create Slack bot token Secret" })
    .waitFor();
  assert.equal(await createSecretDialog.getByLabel("Binding key").inputValue(), "SLACK_BOT_TOKEN");
  assert.equal(await createSecretDialog.getByLabel("Binding key").getAttribute("readonly"), "");
  assert.equal(
    await createSecretDialog.getByLabel("Name", { exact: true }).inputValue(),
    "Console-created Agent Slack bot token",
  );
  assert.equal(
    await createSecretDialog.getByLabel("Value", { exact: true }).getAttribute("type"),
    "password",
  );
  // Dismissing the topmost dialog discards its token, not the underlying Slack edits.
  await createSecretDialog.getByLabel("Value", { exact: true }).fill("discarded-secret-value");
  const secretWritesBeforeDismissal = secretPostRequests(requests, namespace.id).length;
  const secretBounds = await createSecretDialog.boundingBox();
  assert.ok(secretBounds);
  await page.mouse.click(secretBounds.x / 2, secretBounds.y + 8);
  await createSecretDialog.waitFor({ state: "hidden" });
  assert.equal(await createChannelDialog.isVisible(), true);
  assert.equal(await slackSelectionValue(nestedChannelIds), "CNESTED123");
  assert.equal(await createChannelDialog.getByLabel("Slack bot token").inputValue(), "");
  assert.equal(secretPostRequests(requests, namespace.id).length, secretWritesBeforeDismissal);
  await setSlackSelection(nestedChannelIds, "");
  await openCreateSecretDialog(createChannelDialog, "Slack bot token");
  assert.equal(await createSecretDialog.getByLabel("Value", { exact: true }).inputValue(), "");
  await createSecretDialog.getByLabel("Value", { exact: true }).fill(createdSlackBotSecretValue);
  const secretReached = Promise.withResolvers();
  const secretRelease = Promise.withResolvers();
  t.after(() => secretRelease.resolve());
  // The real Secret write must finish before its dialog can be dismissed.
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/secrets`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    secretReached.resolve();
    await secretRelease.promise;
    await route.fulfill({ response });
  });
  const botSecretResponse = page.waitForResponse((response) => {
    if (
      response.url() !== `${fixture.origin}/namespaces/${namespace.id}/secrets` ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    return response.request().postDataJSON()?.name === "Console-created Agent Slack bot token";
  });
  await createSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await secretReached.promise;
  await page.mouse.click(secretBounds.x / 2, secretBounds.y + 8);
  assert.equal(await createSecretDialog.isVisible(), true);
  assert.equal(
    await createSecretDialog.getByRole("button", { name: "Create Secret" }).isDisabled(),
    true,
  );
  secretRelease.resolve();
  const createdSlackBotSecret = (await (await botSecretResponse).json()).data;
  await createChannelDialog
    .getByText("Secret selected. Apply channel settings, then Create Agent binds it.")
    .waitFor();
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await createChannelDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Edit Slack" }).click();
  // Replacing an earlier selection must not grant the superseded Secret to the Agent.
  await selectSecret(createChannelDialog, "Slack app token", replacementSlackAppSecret);
  await createChannelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const stagedSecretBindings = {
    SLACK_APP_TOKEN: {
      source: replacementSlackAppSecret.ref,
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: createdSlackBotSecret.ref,
      delivery: { type: "env" },
    },
  };
  await openAdvancedSettings(page);
  const stagedValues = JSON.parse(await page.getByLabel("Configuration JSON").inputValue());
  await page.getByLabel("Agent name").fill("A".repeat(200));

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
  assert.equal(created.data.backendId, null);
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
  await page.getByRole("button", { name: "Create new version" }).waitFor();
  await page.getByRole("heading", { name: "Create new version" }).waitFor();
  await page.getByText("No version is currently selected for service.").waitFor();
  await page
    .getByText("No version is selected. Deploy a new version to start this Agent.")
    .waitFor();
  assert.equal(await page.getByText(/Stop requested\./).count(), 0);
  await page.getByRole("button", { name: "Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "create"').waitFor();
  // The summary identifies its Secret, while credential values remain private.
  const boundSecret = page.getByRole("link", {
    name: secret.name,
    exact: true,
  });
  await boundSecret.waitFor();
  assert.equal(
    await boundSecret.getAttribute("href"),
    `/namespaces/${namespace.id}/secrets/${secret.id}`,
  );
  const visibleConfiguration = await page.locator("body").textContent();
  assert.equal(visibleConfiguration.includes(key), false);
  assert.equal(visibleConfiguration.includes("never-visible-existing-slack-app-token"), false);
  assert.equal(visibleConfiguration.includes(createdSlackBotSecretValue), false);

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
    [secret.id, replacementSlackAppSecret.id, createdSlackBotSecret.id]
      .sort()
      .map((resourceId) => ({
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
  const savedSecretInput = page.getByLabel("API key Secret");
  assert.equal(await savedSecretInput.evaluate((node) => node.tagName), "INPUT");
  await waitForInputValue(savedSecretInput, secret.name);
  const deniedBinding = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents/${created.data.id}` &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save authentication source" }).click();
  assert.equal((await deniedBinding).status(), 403);
  await page
    .locator('.agent-version-detail form.agent-card > [role="status"]')
    .filter({ hasText: /Access denied|not authorized|permission/i })
    .waitFor();
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText(/Repository choices are denied/).waitFor();
  await enterManualModel(page, "denied-agent-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Denied Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.match(page.url(), new RegExp(`/console/agents/new\\?namespace=${namespace.id}$`));
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("Loading approved repositories…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  releaseOptions();
  await page.getByText(/No approved repositories are available/).waitFor();
  await waitForCreateFormReads(page);
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

test("Dedicated repository Agent keeps its bindings through Slack save and the channel credential gate", async (t) => {
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Dedicated repository Agent");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-full").check();
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
  await page.getByLabel("Direct-message policy").selectOption("disabled");
  await setSlackSelection(
    page.getByRole("combobox", { name: "Channels", exact: true }),
    "CREPOSITORY123",
  );
  await page.getByLabel("Who can use the agent in these channels?").selectOption("everyone");
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

  // Channel Secrets remain user-supplied; runtime credentials are generated by deployment.
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await page
    .getByText("Complete these in Credentials before deploying: Slack Secret bindings.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy new version" }).isDisabled(), true);
  assert.equal(await page.getByLabel("Slack app token").isEnabled(), true);
  assert.equal(
    pathRequests(
      requests,
      "GET",
      `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`,
    ).length,
    0,
  );
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
  await unavailablePage.getByRole("button", { name: "Start with default Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "REPOSITORY_OPTIONS_UNAVAILABLE");
  await unavailablePage.getByText(/Repository choices are unavailable/).waitFor();
  assert.match(
    await unavailablePage
      .getByRole("status")
      .filter({ hasText: "Repository choices are unavailable" })
      .innerText(),
    /You can continue without repository access/,
  );
  const setupGuide = unavailablePage.getByRole("link", { name: "Set up repository access" });
  assert.equal(
    await setupGuide.getAttribute("href"),
    "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md",
  );
  await waitForCreateFormReads(unavailablePage);
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
  await deniedPage.getByRole("button", { name: "Start with default Preset" }).click();
  await deniedPage.getByText(/Repository choices are denied/).waitFor();
  // The disabled state must reflect both reads' outcome, not a read still pending.
  await waitForCreateFormReads(deniedPage);
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  const options = await optionsResponse;
  assert.equal(options.status(), 503);
  assert.equal((await options.json()).error.code, "DEPENDENCY_UNAVAILABLE");
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Authorization unavailable Agent");
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await settlePageRequests(page);
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
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
    await page.getByLabel("Agent name").fill("Discovery retry Agent");
    await page.locator('.repository-options[aria-busy="false"]').waitFor({ state: "attached" });
    assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
    await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
    await settlePageRequests(page);
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();

  await page.locator("#repository-default-git-read").check();
  for (let index = 1; index <= 16; index += 1) {
    await page.getByLabel("Find a repository").fill(`example/repository-${index}`);
    await repositoryCheckbox(page, `example/repository-${index}`).check();
  }
  await page.getByLabel("Find a repository").fill("example/repository-17");
  assert.equal(await page.locator(".repository-card").count(), 5);
  await page.getByRole("button", { name: "Show all 16 selected" }).click();
  assert.equal(await page.locator(".repository-card").count(), 16);
  assert.equal(await repositoryCheckbox(page, "example/repository-17").isDisabled(), true);
  await page.getByLabel("Find a repository").fill("example/repository-1");
  const selected = repositoryCheckbox(page, "example/repository-1");
  assert.equal(await selected.isEnabled(), true);
  await selected.uncheck();
  assert.equal(await selected.isChecked(), false);
  await page.getByLabel("Find a repository").fill("example/repository-17");
  await repositoryCheckbox(page, "example/repository-17").check();
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
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
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
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
  await settlePageRequests(page);
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
  assert.equal(await repositoryCheckbox(page, "example/application").isEnabled(), true);
  assert.equal(await page.locator(".repository-card").count(), 0);
  // Refreshing policy permits editing; it must not turn this saved attempt into an ordinary Agent.
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isVisible(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#repository-default-git-read").check();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
  await page.getByRole("button", { name: "Remove example/application" }).click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
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
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.locator("#create-agent-form").evaluate((form) => form.requestSubmit());
  await settlePageRequests(page);
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  const modelSecret = await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
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
  await settlePageRequests(page);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start a new draft" }).click();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText(/No approved repositories are available/).waitFor();
  await selectSecret(page, "API key Secret", modelSecret);
  // The Create Agent form has no Save changes control; Create Agent applies the binding.
  await page.getByText("Secret selected. Create Agent binds it.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Save changes to apply it.").count(), 0);
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill("gpt-5.1");
  await model.press("Tab");
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

test("Dedicated Agent creation opens deployment details after provisioning with masked new Secrets", async (t) => {
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
  let deploymentStatus = "queued";
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
    activeRevisionId: null,
  };
  const revision = {
    id: revisionId,
    namespaceId: namespace.id,
    agentId,
    revision: 1,
    backendId: null,
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
  const workspacePreset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Provision workspace preset",
      template: {
        agent: {
          name: agent.name,
          executionMode: "dedicated",
          initialWorkspaceFiles: {
            "AGENTS.md": "# Provision preset\n",
            "USER.md": "Provision user",
          },
        },
      },
    },
  });
  assert.equal(workspacePreset.status, 201, JSON.stringify(workspacePreset.body));

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
      await route.fulfill(
        json({
          deploymentId: `dep_${revisionId}`,
          revisionId,
          status: deploymentStatus,
          error:
            deploymentStatus === "failed"
              ? { code: "DEPENDENCY_UNAVAILABLE", message: "Deployment reconciliation failed." }
              : null,
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
  await page.getByLabel("Preset template").selectOption(workspacePreset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByLabel("Agent name", { exact: true }).waitFor();
  await repositoryCheckbox(page, "example/application").click();
  await page.locator(".repository-profile-group .repository-customize summary").click();
  await page.locator("#repository-default-issues").uncheck();
  await createModelCredentialSecret(page, "model-secret-value");
  await openAdvancedSettings(page);
  assert.equal(
    await page.getByLabel("AGENTS.md", { exact: true }).inputValue(),
    "# Provision preset\n",
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "Provision user");
  await page.getByLabel("AGENTS.md", { exact: true }).fill("# Provision edited\n");
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await channelDialog
    .getByText("Choose existing Slack token Secrets or create them here before creating the Agent.")
    .waitFor();
  await openCreateSecretDialog(channelDialog, "Slack app token");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Value", { exact: true }).fill("slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await openCreateSecretDialog(channelDialog, "Slack bot token");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Value", { exact: true }).fill("slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Enter at least one Slack channel ID for these access settings.")
    .waitFor();
  await setSlackSelection(
    channelDialog.getByRole("combobox", { name: "Channels", exact: true }),
    "C0123456789",
  );
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("selected");
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  await channelDialog
    .getByText("Choose specific people or select Everyone in these channels.")
    .waitFor();
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
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
      url.searchParams.get("tab") === "configuration"
    );
  });
  // Creation must hand off to the detail page while deployment is still queued.
  const deploymentPanel = page.locator(".deployment-status");
  await deploymentPanel.getByText("Recorded status: queued", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Create Agent", exact: true }).count(), 0);
  deploymentStatus = "failed";
  await deploymentPanel.getByRole("button", { name: "Refresh deployment", exact: true }).click();
  await deploymentPanel.getByText("Recorded status: failed", { exact: true }).waitFor();
  await deploymentPanel
    .getByText("DEPENDENCY_UNAVAILABLE: Deployment reconciliation failed.", { exact: true })
    .waitFor();

  assert.match(provisionBody.requestId, /^req_[0-9a-f-]{36}$/);
  assert.equal(provisionBody.name, agent.name);
  assert.deepEqual(provisionBody.repositoryAccess, {
    defaultProfile: "git-write",
    repositories: [{ repositoryRef: "application" }],
  });
  assert.equal(provisionBody.executionMode, "dedicated");
  assert.deepEqual(provisionBody.initialWorkspaceFiles, {
    ...WORKSPACE_DEFAULTS,
    "AGENTS.md": "# Provision edited\n",
    "USER.md": "Provision user",
  });
  assert.equal(provisionBody.workspaceDefaultsId, WORKSPACE_DEFAULTS_ID);
  assert.deepEqual(provisionBody.harnessAuth, agent.harnessAuth);
  assert.deepEqual(provisionBody.configuration.values.channels.slack, {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    channels: { C0123456789: { requireMention: true, users: ["*"] } },
    dmPolicy: "disabled",
    groupPolicy: "allowlist",
    replyToModeByChatType: { channel: "all" },
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
      { name: "Provisioned Agent model credential", value: "model-secret-value" },
      { name: "Provisioned Agent Slack app token", value: "slack-app-secret" },
      { name: "Provisioned Agent Slack bot token", value: "slack-bot-secret" },
    ],
  );
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.ok(provisioningReads >= 1);
});

test("Dedicated Agent creation keeps provisioning when optional repository discovery is unavailable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Model-only provision", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await routeInstallationProvisioning(page, fixture);
  // The real discovery endpoint reports the fixture's missing optional Repo Driver.
  // Admission can still reject creation; the browser must not silently save a draft.
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "Agent creation permission changed." },
      }),
    }),
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText(/Repository choices are unavailable/).waitFor();
  await page.getByLabel("Agent name", { exact: true }).fill("Model-only Agent");
  await enterManualModel(page, "model-only-test-key", "gpt-5.1");
  const admission = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/provision`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await admission).status(), 403);
  await page.getByText("Access denied. You do not have permission for this operation.").waitFor();
  const submitted = agentProvisionPostRequests(requests, namespace.id);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].body.executionMode, "dedicated");
  assert.equal(Object.hasOwn(submitted[0].body, "repositoryBindings"), false);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("This installation creates draft Agents for later deployment.").waitFor();
  await assert.rejects(
    page.getByRole("heading", { name: "Secrets" }).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );

  await page.getByLabel("Agent name").fill("Unsupported Dedicated Agent");
  await createModelCredentialSecret(page, "unsupported-model-key");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await setSlackSelection(
    channelDialog.getByRole("combobox", { name: "Channels", exact: true }),
    "CUNSUPPORTED123",
  );
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
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
        repositoryAccess: { defaultProfile: "git-full", repositories: [] },
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
  const everyone = savedDialog.getByLabel("Who can use the agent in these channels?");
  assert.equal(await everyone.inputValue(), "everyone");
  assert.equal(
    await savedDialog
      .getByRole("combobox", { name: "Allowed people in these channels", exact: true })
      .isVisible(),
    false,
  );
  await everyone.selectOption("selected");
  await setSlackSelection(
    savedDialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
    "USENDER123",
  );
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
  assert.equal(
    await slackSelectionValue(
      savedDialog.getByRole("combobox", { name: "Allowed people in these channels", exact: true }),
    ),
    "USENDER123",
  );
  assert.equal(
    await savedDialog.getByLabel("Who can use the agent in these channels?").inputValue(),
    "selected",
  );
  const savedConfiguration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${createdAgent.configurationId}`,
  );
  assert.deepEqual(savedConfiguration.data.values.channels.slack.channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["USENDER123"] },
  });
  assert.equal(savedConfiguration.data.values.channels.slack.replyToMode, undefined);
  assert.deepEqual(savedConfiguration.data.values.channels.slack.replyToModeByChatType, {
    channel: "all",
  });
  assert.equal(savedConfiguration.data.values.channels.slack.groupPolicy, "allowlist");
  assert.equal(savedConfiguration.data.values.channels.slack.dmPolicy, "disabled");
  assert.equal(Object.hasOwn(savedConfiguration.data.values.channels.slack, "allowFrom"), false);

  // Exercise DM policy changes through the normal Agent editor and real Configuration API.
  // An empty or wildcard allowlist must not produce a write or broaden channel access.
  await savedDialog.getByLabel("Direct-message policy").selectOption("allowlist");
  for (const invalid of ["", "*"]) {
    await setSlackSelection(
      savedDialog.getByRole("combobox", { name: "Allowed people in direct messages", exact: true }),
      invalid,
    );
    requests.length = 0;
    await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    await savedDialog
      .getByText("Enter specific allowed DM user IDs, or choose a different direct-message policy.")
      .waitFor();
    assert.equal(nonAuthWriteRequests(requests).length, 0);
  }
  for (const [policy, senders] of [
    ["allowlist", ["UDIRECT123"]],
    ["open", ["*"]],
    ["disabled", ["*"]],
    ["pairing", ["UPREAPPROVED123"]],
  ]) {
    await savedDialog.getByLabel("Direct-message policy").selectOption(policy);
    if (policy === "allowlist" || policy === "pairing") {
      if (policy === "pairing") {
        assert.equal(
          await slackSelectionValue(
            savedDialog.getByRole("combobox", {
              name: "Allowed people in direct messages",
              exact: true,
            }),
          ),
          "",
        );
      }
      await setSlackSelection(
        savedDialog.getByRole("combobox", {
          name: "Allowed people in direct messages",
          exact: true,
        }),
        senders.join(", "),
      );
    }
    const policySaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/configurations/${createdAgent.configurationId}`),
    );
    await savedDialog.getByRole("button", { name: "Save configuration", exact: true }).click();
    assert.equal((await policySaved).status(), 200);
    await page.reload();
    await page.getByRole("button", { name: "Edit Slack", exact: true }).click();
    savedDialog = page.getByRole("dialog", { name: "Edit Slack" });
    assert.equal(await savedDialog.getByLabel("Direct-message policy").inputValue(), policy);
    const persisted = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${createdAgent.configurationId}`,
    );
    assert.deepEqual(persisted.data.values.channels.slack, {
      ...savedConfiguration.data.values.channels.slack,
      dmPolicy: policy,
      allowFrom: senders,
    });
  }
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
    backendId: null,
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill(agent.name);
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Configure Slack" }).click();
  const channelDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await channelDialog.getByLabel("Direct-message policy").selectOption("disabled");
  await openCreateSecretDialog(channelDialog, "Slack app token");
  const appSecretDialog = page.getByRole("dialog", { name: "Create Slack app token Secret" });
  await appSecretDialog.getByLabel("Value", { exact: true }).fill("retry-slack-app-secret");
  await appSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await appSecretDialog.waitFor({ state: "hidden" });
  await openCreateSecretDialog(channelDialog, "Slack bot token");
  const botSecretDialog = page.getByRole("dialog", { name: "Create Slack bot token Secret" });
  await botSecretDialog.getByLabel("Value", { exact: true }).fill("retry-slack-bot-secret");
  await botSecretDialog.getByRole("button", { name: "Create Secret" }).click();
  await botSecretDialog.waitFor({ state: "hidden" });
  await setSlackSelection(
    channelDialog.getByRole("combobox", { name: "Channels", exact: true }),
    "CRETRY123",
  );
  await channelDialog
    .getByLabel("Who can use the agent in these channels?")
    .selectOption("everyone");
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
      url.searchParams.get("tab") === "configuration"
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
      { name: "Retried Agent model credential", value: "model-secret-value" },
      { name: "Retried Agent Slack app token", value: "retry-slack-app-secret" },
      { name: "Retried Agent Slack bot token", value: "retry-slack-bot-secret" },
    ],
  );
});

test("Dedicated Agent creation offers Retry only for a transient provisioning failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision outcomes", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const updatedAt = new Date().toISOString();
  const json = (data, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({
      data,
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    }),
  });
  // Each accepted request fails in the worker: first a taken name (permanent), then an
  // unavailable dependency (transient). Its retry is then rejected after the job created
  // the Agent, which only the job's retry can finish, and the next retry is refused
  // because the Agent's lifecycle changed. The third job is cancelled by Stop after it
  // created its Agent (permanent). The fourth job's status is first unreadable, then it
  // has succeeded.
  // Each job that gets far enough creates its own Agent.
  const agentIds = [2, 3, 4].map((job) => `agt_00000000-0000-4000-8000-00000000c0d${job}`);
  const failures = [
    {
      code: "PROVISIONING_REJECTED",
      message: "An Agent with this name already exists in this Namespace. Choose a different name.",
    },
    {
      code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
      message: "Agent provisioning could not complete.",
    },
    {
      code: "PROVISIONING_CANCELLED",
      message: "Provisioning was cancelled. Create a new Agent to provision again.",
      agentId: agentIds[1],
    },
  ];
  const bodies = [];
  let provisionPosts = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    provisionPosts += 1;
    // The first request is lost in transit and its resend is rejected at admission, so
    // the API never admitted that request ID.
    if (provisionPosts === 1) {
      await route.abort("failed");
      return;
    }
    if (provisionPosts === 2) {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_REQUEST",
            message: "The request does not match the operation contract: /name is too long.",
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000400" },
        }),
      });
      return;
    }
    const body = request.postDataJSON();
    // Like the API, a known request ID returns its existing job.
    const work =
      bodies.findIndex((earlier) => earlier.requestId === body.requestId) + 1 || bodies.length + 1;
    bodies.push(body);
    const url = `/namespaces/${namespace.id}/agents/provision/work_${work}`;
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: `work_${bodies.length}`,
            status: "queued",
            phase: "accepted",
            attemptCount: 0,
            updatedAt,
            url,
          },
        },
        202,
      ),
    );
  });
  let retries = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_2/retry`, async (route) => {
    retries += 1;
    if (retries > 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "RESOURCE_CONFLICT",
            message: "The requested platform resource already exists.",
          },
          meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
        }),
      });
      return;
    }
    await route.fulfill(
      json(
        {
          provisioning: {
            workId: "work_2",
            status: "failed",
            phase: "transport",
            attemptCount: 2,
            updatedAt,
            agentId: agentIds[0],
            url: `/namespaces/${namespace.id}/agents/provision/work_2`,
            error: {
              code: "PROVISIONING_REJECTED",
              message: "Agent provisioning could not complete.",
            },
          },
        },
        202,
      ),
    );
  });
  // The job succeeded while its status was unreadable, so the API refuses its retry.
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_4/retry`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RESOURCE_CONFLICT",
          message: "Provisioning cannot retry after cancellation or deployment handoff.",
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    }),
  );
  let work4Reads = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*`, async (route) => {
    const index = Number(new URL(route.request().url()).pathname.split("_").at(-1));
    const url = `/namespaces/${namespace.id}/agents/provision/work_${index}`;
    if (index === 4) {
      work4Reads += 1;
      await route.fulfill(
        work4Reads === 1
          ? {
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." },
                meta: { requestId: "req_00000000-0000-4000-8000-000000000503" },
              }),
            }
          : json({
              workId: "work_4",
              status: "succeeded",
              phase: "handoff",
              attemptCount: 1,
              updatedAt,
              agentId: agentIds[2],
              revisionId: "rev_00000000-0000-4000-8000-00000000c0de",
              url,
            }),
      );
      return;
    }
    const { agentId: createdAgentId, ...error } = failures[index - 1];
    await route.fulfill(
      json({
        workId: `work_${index}`,
        status: "failed",
        phase: "accepted",
        attemptCount: 1,
        updatedAt,
        ...(createdAgentId === undefined ? {} : { agentId: createdAgentId }),
        url,
        error,
      }),
    );
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken name");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const retry = page.getByRole("button", { name: "Retry provisioning request" });
  // Longer than the API's 200-character limit, so a resend that reaches validation fails.
  await page.getByLabel("Agent name").fill("n".repeat(201));
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(/^Outcome unknown\. Retry resubmits the same request ID and saved references\./)
    .waitFor();
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  // A 400 to the resend shows the request was never admitted, so the form unlocks.
  await retry.click();
  await page
    .getByText(/^The request does not match the operation contract: \/name is too long\./)
    .waitFor();
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), false);
  await page.getByLabel("Agent name").fill("Taken name");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "An Agent with this name already exists in this Namespace. Choose a different name. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), false);

  await page.getByLabel("Agent name").fill("Free name");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText("Agent provisioning could not complete. Retry uses the accepted provisioning job.")
    .waitFor();
  assert.equal(await retry.isVisible(), true);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].name, "Free name");
  // The failed job keeps its request ID, so the edited form submits a new one with the
  // same saved credential.
  assert.notEqual(bodies[1].requestId, bodies[0].requestId);
  assert.deepEqual(bodies[1].harnessAuth, bodies[0].harnessAuth);

  const retried = page.waitForResponse((response) => response.url().endsWith("/work_2/retry"));
  await retry.click();
  await retried;
  await page.getByRole("button", { name: "Retry provisioning request", disabled: false }).waitFor();
  assert.equal(retries, 1);
  assert.equal(await retry.isVisible(), true);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);

  // A refused retry ends that job: Create Agent submits a new request ID instead of
  // replaying the failed job.
  await retry.click();
  await page
    .getByText(
      "The provisioning job can no longer be retried. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(retries, 2);
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), false);
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(
      "Provisioning was cancelled. Create a new Agent to provision again. Select Create Agent to submit a new request.",
    )
    .waitFor();
  assert.equal(bodies.length, 3);
  assert.notEqual(bodies[2].requestId, bodies[1].requestId);
  // A cancelled job cannot be retried either; the next submit uses a new request ID.
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), false);
  await page.getByRole("button", { name: "Create Agent" }).click();
  // Retry calls the job's retry endpoint, which cannot recover a finished job; the text
  // must point at Create Agent for that case.
  await page
    .getByText(
      /^Outcome unknown after provisioning admission\. Retry resumes the accepted provisioning job, or retries it if it failed\. If the API refuses because the job finished, select Create Agent to resend the same request ID\./,
    )
    .waitFor();
  assert.equal(bodies.length, 4);
  assert.notEqual(bodies[3].requestId, bodies[2].requestId);
  // After an unknown outcome a refused retry may mean the job succeeded, so the request
  // ID is kept and Create Agent recovers the job instead of starting a new one.
  await retry.click();
  await page
    .getByText(
      /^The provisioning job can no longer be retried; it may have finished\. Select Create Agent to resend the same request ID and open its result\./,
    )
    .waitFor();
  // The kept request ID names the admitted job, so the plan stays locked: an edited
  // form would get 409 "different plan" from the API on every Create Agent.
  assert.equal(await retry.isVisible(), false);
  assert.equal(await page.getByLabel("Agent name").isDisabled(), true);
  assert.equal(await page.getByLabel("Service account token Secret").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), false);
  assert.equal(await page.getByRole("button", { name: "Start over" }).isDisabled(), false);
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.waitForURL(new RegExp(`/agents/${agentIds[2]}\\?`));
  assert.equal(bodies.length, 5);
  assert.equal(bodies[4].requestId, bodies[3].requestId);
});

test("Dedicated Agent creation shows the API's named reason when a provisioning retry is refused", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provision retry refusals", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationProvisioning(page, fixture);
  await page.route(`**/namespaces/${namespace.id}/agents/repository-options`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], meta: { requestId: "req_repository_choices" } }),
    }),
  );
  const updatedAt = new Date().toISOString();
  const meta = { requestId: "req_00000000-0000-4000-8000-000000000001" };
  const jobUrl = (work) => `/namespaces/${namespace.id}/agents/provision/work_${work}`;
  // Each job fails transiently, then the API refuses its retry: first with the generic
  // conflict text (a store race; controller refusals name a reason), then naming the
  // Secret that was deleted.
  const refusals = [
    "The requested platform resource already exists.",
    "Secret sec_00000000-0000-4000-8000-00000000dead, which this provisioning request uses, was deleted. Submit a new Agent provisioning request.",
  ];
  let jobs = 0;
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route) => {
    jobs += 1;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          provisioning: {
            workId: `work_${jobs}`,
            status: "queued",
            phase: "accepted",
            attemptCount: 0,
            updatedAt,
            url: jobUrl(jobs),
          },
        },
        meta,
      }),
    });
  });
  const routeJob = async (route) => {
    const work = Number(new URL(route.request().url()).pathname.split("/")[5].split("_")[1]);
    await route.fulfill(
      route.request().method() === "POST"
        ? {
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "RESOURCE_CONFLICT", message: refusals[work - 1] },
              meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
            }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: {
                workId: `work_${work}`,
                status: "failed",
                phase: "accepted",
                attemptCount: 1,
                updatedAt,
                url: jobUrl(work),
                error: {
                  code: "PROVISIONING_DEPENDENCY_UNAVAILABLE",
                  message: "Agent provisioning could not complete.",
                },
              },
              meta,
            }),
          },
    );
  };
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*`, routeJob);
  await page.route(`**/namespaces/${namespace.id}/agents/provision/work_*/retry`, routeJob);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Refused retry");
  await page.getByLabel("Authentication method").selectOption("codex_pat");
  await createModelCredentialSecret(page, "model-secret-value");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const retry = page.getByRole("button", { name: "Retry provisioning request" });
  for (const expected of ["The provisioning job can no longer be retried.", refusals[1]]) {
    await page.getByRole("button", { name: "Create Agent" }).click();
    await page
      .getByText("Agent provisioning could not complete. Retry uses the accepted provisioning job.")
      .waitFor();
    await retry.click();
    await page
      .getByText(
        `${expected} Select Create Agent to submit a new request. Request ID: req_00000000-0000-4000-8000-000000000409`,
        { exact: true },
      )
      .waitFor();
    assert.equal(await retry.isVisible(), false);
    assert.equal(await page.getByLabel("Agent name").isDisabled(), false);
  }
  assert.equal(jobs, 2);
});

test("Agent creation rejects non-object native Configuration JSON before Configuration or Agent writes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Invalid JSON", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  requests.length = 0;

  await enterManualModel(page, "unused-invalid-config-key", "gpt-4.1");
  await page.getByLabel("Agent name").fill("Broken Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill("[]");
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByRole("button", { name: "Create Agent" }).click();

  const validation = await page
    .getByLabel("Configuration JSON")
    .evaluate((node) => node.validationMessage);
  assert.equal(validation, "Enter a valid JSON object.");
  assert.equal(await page.getByLabel("Configuration JSON").isVisible(), true);
  assert.equal(secretPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation offers mainline Anthropic models before credentials and saves an explicit selection", async (t) => {
  const audit = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink: audit });
  const secretDriver = createTestSecretDriver();
  const fixture = await createConsoleAppFixture(t, {
    state,
    secretDriver,
    backendSummaries: undefined,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Anthropic authoring", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const serviceAccountSecret = page.getByLabel("Service account token Secret", { exact: true });
  await serviceAccountSecret.waitFor();
  assert.equal(await serviceAccountSecret.inputValue(), "");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.deepEqual(
    await page
      .getByLabel("Harness", { exact: true })
      .locator("option:not([disabled])")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["openclaw"],
  );
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.waitFor();
  assert.equal(await apiKeySecret.inputValue(), "");
  assert.equal(await page.getByRole("link", { name: "OpenAI admin", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("Authentication method", { exact: true }).isDisabled(), true);
  assert.equal(await apiKeySecret.inputValue(), "");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  assert.equal(await page.getByLabel("Authentication source").count(), 0);
  assert.equal(await page.getByLabel("Model", { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel("Model ID", { exact: true }).isVisible(), false);
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents?.defaults?.model,
    undefined,
  );
  const choice = page.getByLabel("Model", { exact: true });
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    [
      "",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-mythos-5-1",
      "claude-opus-5",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-mythos-preview",
    ],
  );
  assert.equal(await choice.inputValue(), "");
  await choice.selectOption("claude-fable-5-1");
  const selectedConfiguration = await page.getByLabel("Configuration JSON").inputValue();
  await page.getByLabel("Agent name").fill("Anthropic Agent");
  const credentialSecret = await createModelCredentialSecret(page, "test-anthropic-api-key");
  assert.equal(await choice.inputValue(), "claude-fable-5-1");
  assert.equal(await page.getByLabel("Configuration JSON").inputValue(), selectedConfiguration);
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [{ name: "Anthropic Agent model credential", value: "test-anthropic-api-key" }],
  );
  assert.equal(secretDriver.calls.filter((call) => call.operation === "create").length, 1);
  assert.equal(JSON.stringify(audit.events).includes("test-anthropic-api-key"), false);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
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
  assert.equal(agent.backendId, null);
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: credentialSecret.ref });
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "anthropic/claude-fable-5-1");
  assert.deepEqual(configuration.data.values.models.providers.anthropic, {
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [{ id: "claude-fable-5-1", name: "claude-fable-5-1" }],
  });
  assert.equal(
    configuration.data.values.agents.defaults.models["anthropic/claude-fable-5-1"].agentRuntime.id,
    "openclaw",
  );
  assert.equal(pathRequests(requests, "GET", "/backends").length, 0);
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/service-accounts`).length,
    0,
  );
  assert.equal(JSON.stringify(configuration.data).includes("test-anthropic-api-key"), false);
});

test("Static model selection survives credential edits and resets for provider or authentication changes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Static model choices", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  const key = page.getByLabel("API key Secret", { exact: true });
  const choice = page.getByLabel("Model", { exact: true });
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.isEnabled(), true);
  assert.deepEqual(
    (await optionValues(choice)).map(({ value }) => value),
    ["", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.equal(await choice.locator('option[value=""]').textContent(), "Choose a model");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await choice.selectOption("gpt-6-astra");
  const selectedConfiguration = await configuration.inputValue();
  assert.equal(JSON.parse(selectedConfiguration).agents.defaults.model, "codex/gpt-6-astra");
  for (const credential of ["first-openai-key", "replacement-openai-key"]) {
    await page.getByLabel("Agent name").fill(`Static model ${credential}`);
    await createModelCredentialSecret(page, credential);
    assert.equal(await choice.inputValue(), "gpt-6-astra");
    assert.equal(await configuration.inputValue(), selectedConfiguration);
  }

  // Switching compatible harnesses changes the native transport without clearing the model.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "openai/gpt-6-astra",
  );
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await choice.inputValue(), "gpt-6-astra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-6-astra",
  );

  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  const patSecret = page.getByLabel("Service account token Secret", { exact: true });
  assert.equal(await patSecret.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-terra");
  await page.getByLabel("Agent name").fill("Static model service account token");
  await createModelCredentialSecret(page, "at-static-model-token");
  assert.equal(await choice.inputValue(), "gpt-5.6-terra");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-terra",
  );
  await page.getByLabel("Authentication method", { exact: true }).selectOption("api_key");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);

  await choice.selectOption("gpt-5.6-luna");
  await page.getByLabel("Agent name").fill("Static model discarded OpenAI key");
  await createModelCredentialSecret(page, "discarded-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await key.inputValue(), "");
  assert.equal(await choice.isVisible(), true);
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("claude-opus-5-5");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "anthropic/claude-opus-5-5",
  );
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  assert.equal(await choice.inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await choice.selectOption("gpt-5.6-luna");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-5.6-luna",
  );
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map(({ body }) => body.value),
    ["first-openai-key", "replacement-openai-key", "at-static-model-token", "discarded-openai-key"],
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(
    pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`).length,
    0,
  );
});

test("Agent creation accepts a manual model outside the static list and saves through the real Agent API", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Manual model override", { ready: true });
  const presets = await fixture.request("GET", `/namespaces/${namespace.id}/presets`);
  const starter = presets.data.find((preset) => preset.name === "default-codex");
  const template = structuredClone(starter.template);
  template.configuration.values.browser = { enabled: false };
  assert.equal(
    (
      await fixture.request("PATCH", `/namespaces/${namespace.id}/presets/${starter.id}`, {
        body: { template },
      })
    ).status,
    200,
  );
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Manual model Agent");
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).browser.enabled,
    false,
  );
  // Later Preset updates must not change the draft or the Configuration saved from it.
  template.configuration.values.browser.enabled = true;
  assert.equal(
    (
      await fixture.request("PATCH", `/namespaces/${namespace.id}/presets/${starter.id}`, {
        body: { template },
      })
    ).status,
    200,
  );
  const selectedSecret = await enterManualModel(
    page,
    "manual-model-key",
    "gpt-manual-account-model",
  );
  assert.deepEqual(
    secretPostRequests(requests, namespace.id).map((request) => request.body),
    [{ name: "Manual model Agent model credential", value: "manual-model-key" }],
  );
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  assert.deepEqual(agent.harnessAuth, { method: "api_key", source: selectedSecret.ref });
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
  const configuration = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
  );
  assert.equal(configuration.data.values.agents.defaults.model, "codex/gpt-manual-account-model");
  assert.equal(JSON.stringify(configuration.data).includes("manual-model-key"), false);
  assert.equal(configuration.data.values.browser.enabled, false);
  assert.equal(
    configuration.data.values.plugins.entries.codex.config.appServer.sandbox,
    "read-only",
  );
  assert.equal(
    configuration.data.values.plugins.entries.codex.config.appServer.approvalPolicy,
    "on-request",
  );
  assert.equal(
    pathRequests(requests, "GET", `/namespaces/${namespace.id}/presets/${starter.id}`).length,
    1,
  );
});

test("Agent creation names the Configuration field that holds an inline model credential without showing it", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    filesystemConfiguration: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create inline credential", { ready: true });
  const { page } = await newPage(t, fixture);
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Inline credential Agent");
  await enterManualModel(page, "inline-credential-model-key", "gpt-inline-credential");
  await openAdvancedSettings(page);
  // A pasted provider key is a value, not the Secret reference the field requires.
  const sentinel = `synthetic-inline-key-${randomUUID()}`;
  const configuration = page.getByLabel("Configuration JSON");
  const edited = JSON.parse(await configuration.inputValue());
  edited.models = {
    ...edited.models,
    providers: { ...edited.models?.providers, openai: { apiKey: sentinel } },
  };
  await configuration.fill(JSON.stringify(edited, null, 2));
  const rejected = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 400);
  const feedback = page.getByRole("alert").filter({
    hasText:
      "Configuration field /models/providers/openai/apiKey holds a credential value inline, where a reference is required. Store the key as a Secret and select it as the Agent's model credential instead.",
  });
  await feedback.waitFor();
  // Only the editor holds the key; the explanation never repeats it.
  assert.equal((await feedback.textContent()).includes(sentinel), false);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  assert.equal(await configuration.isDisabled(), false);
});

test("Agent creation reports unavailable Secret storage before creating Configuration or Agent", async (t) => {
  const fixture = await createConsoleAppFixture(t, { secretDriver: null });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing Secret storage", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Agent name").fill("Unavailable Agent");
  await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
  const failed = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/secrets` &&
      response.request().method() === "POST",
  );
  await openCreateSecretDialog(page, "API key Secret");
  const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
  await dialog.getByLabel("Value", { exact: true }).fill("unused-no-driver-key");
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  assert.equal((await failed).status(), 503);
  await dialog
    .getByRole("alert")
    .filter({ hasText: /outcome could not be confirmed/i })
    .waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation shows the API's duplicate-name conflict, generic text for other conflicts, and keeps the form usable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Duplicate Agent name", { ready: true });
  await fixture.createAgent(namespace.id, "Taken Agent");
  const { page } = await newPage(t, fixture);
  // The regular create path, which skips the provisioning job.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByLabel("Agent name").fill("Taken Agent");
  await enterManualModel(page, "duplicate-name-model-key", "gpt-duplicate-name");
  const agentsUrl = `${fixture.origin}/namespaces/${namespace.id}/agents`;
  const agentPost = (response) =>
    response.url() === agentsUrl && response.request().method() === "POST";

  // Any other conflict keeps the generic text: plain conflicts reach the client as "The
  // requested platform resource already exists.", which would mislead on this form.
  const otherConflict = async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "RESOURCE_CONFLICT",
          message: "The requested platform resource already exists.",
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000409" },
      }),
    });
  };
  await page.route(agentsUrl, otherConflict);
  const conflicted = page.waitForResponse(agentPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await conflicted).status(), 409);
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again. Request ID: req_00000000-0000-4000-8000-000000000409",
    })
    .waitFor();
  assert.equal(await page.getByText("The requested platform resource already exists.").count(), 0);
  await page.unroute(agentsUrl, otherConflict);
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();

  const rejected = page.waitForResponse(agentPost);
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await rejected).status(), 409);
  const sentence =
    "An Agent with this name already exists in this Namespace. Choose a different name.";
  const feedback = page.getByRole("alert").filter({ hasText: sentence });
  await feedback.waitFor();
  assert.match(
    await feedback.textContent(),
    /^An Agent with this name already exists in this Namespace\. Choose a different name\.( Request ID: req_[0-9a-f-]+)?$/,
  );
  const name = page.getByLabel("Agent name");
  const create = page.getByRole("button", { name: "Create Agent" });
  await page.getByRole("button", { name: "Create Agent", disabled: false }).waitFor();
  assert.equal(await name.isDisabled(), false);
  assert.equal(await create.isDisabled(), false);

  // A new name saves through the same Configuration.
  await name.fill("Free Agent");
  const saved = page.waitForResponse(agentPost);
  await create.click();
  const response = await saved;
  assert.equal(response.status(), 201);
  const agent = (await response.json()).data;
  assert.equal(agent.name, "Free Agent");
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await page.waitForURL((url) => url.pathname === `/console/agents/${agent.id}`);
});

test("Agent creation reuses its saved Secret and Configuration after an Agent creation conflict", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  const namespace = await fixture.createNamespace("Partial save retry", { ready: true });
  await fixture.createAgent(namespace.id, "Retry Agent");
  const discardedPatSecret = await fixture.createSecret(
    namespace.id,
    "Discarded service account token",
    "at-discarded-pat",
  );
  const values = nativeValues("partial-save", { harnessId: "codex", providerModel: "gpt-5.1" });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture);
  const requests = apiRequests(page, fixture.origin);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", discardedPatSecret);
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("discarded-pat-model");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  // OpenClaw requires a new API key, never the previous service account token.
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "embedded");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
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
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  await selectSecret(page, "Service account token Secret", discardedPatSecret);
  await openAdvancedSettings(page);
  await page
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(createHarnessConfiguration("openclaw", "gpt-5.1")));
  // Manual Configuration changes obey the same credential boundary while keeping their model.
  assert.equal(await page.getByLabel("Harness", { exact: true }).inputValue(), "openclaw");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(
    await page.getByLabel("Authentication method", { exact: true }).inputValue(),
    "api_key",
  );
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "gpt-5.1");
  assert.equal(
    JSON.parse(await page.getByLabel("Configuration JSON").inputValue()).agents.defaults.model,
    "openai/gpt-5.1",
  );
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("Authentication method", { exact: true }).selectOption("codex_pat");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  assert.equal(await page.getByLabel("Execution mode").isDisabled(), true);
  requests.length = 0;
  await page.getByLabel("Agent name").fill("Retry Agent");
  const selectedSecret = await createModelCredentialSecret(page, "at-browser-pat");
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    secretOptionLabel(selectedSecret),
  );
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  assert.deepEqual(pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/models`), []);
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("SOUL.md", { exact: true }).fill("# Keep this draft\n");
  await openAdvancedSettings(page);
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
  await page
    .getByText("An Agent with this name already exists in this Namespace. Choose a different name.")
    .waitFor();
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
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).inputValue(),
    secretOptionLabel(selectedSecret),
  );
  assert.equal(
    await page.getByLabel("Service account token Secret", { exact: true }).isDisabled(),
    true,
  );
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
  await openAdvancedSettings(page);
  await page.locator("summary").filter({ hasText: "Plugin selections JSON" }).click();
  await page.getByLabel("Plugin selections JSON").fill(
    JSON.stringify({
      "codex-plugin:linear@openai-curated-remote": {
        enabled: true,
        toolDefaults: { approval: "none" },
      },
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
    secretPostRequests(requests, namespace.id).map(({ body }) => body),
    [{ name: "Retry Agent model credential", value: "at-browser-pat" }],
  );
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  const attempts = agentPostRequests(requests, namespace.id);
  assert.deepEqual(attempts[0].body.harnessAuth, {
    method: "codex_pat",
    source: selectedSecret.ref,
  });
  assert.deepEqual(attempts[1].body.harnessAuth, {
    method: "codex_pat",
    source: selectedSecret.ref,
  });
  assert.deepEqual(retried.data.harnessAuth, { method: "codex_pat", source: selectedSecret.ref });
  assert.equal(attempts[0].body.initialWorkspaceFiles["SOUL.md"], "# Keep this draft\n");
  assert.equal(attempts[1].body.initialWorkspaceFiles["SOUL.md"], "# Corrected draft\n");
  assert.deepEqual(retried.data.plugins, {
    "codex-plugin:linear@openai-curated-remote": {
      enabled: true,
      toolDefaults: { approval: "none" },
    },
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
  await page.getByRole("button", { name: "Start with default Preset" }).click();
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
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await page.getByLabel("Agent name").fill(`Uncertain ${collection} Agent`);
    if (collection === "secrets") {
      await page.getByLabel("Model", { exact: true }).selectOption("gpt-6-sol");
      await openCreateSecretDialog(page, "API key Secret");
      const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
      await dialog.getByLabel("Value", { exact: true }).fill("uncertain-artifact-key");
      await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
      await dialog
        .getByRole("alert")
        .filter({ hasText: /outcome could not be confirmed/i })
        .waitFor();
      assert.ok(committed?.id);
      assert.equal((await fixture.request("GET", `${path}/${committed.id}`)).status, 200);
      assert.equal(pathRequests(requests, "POST", path).length, 1);
      assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
      assert.equal(agentPostRequests(requests, namespace.id).length, 0);
      return;
    }
    const selectedSecret = await enterManualModel(page, "uncertain-artifact-key", "gpt-4.1");
    assert.equal(
      await page.getByLabel("API key Secret", { exact: true }).inputValue(),
      secretOptionLabel(selectedSecret),
    );
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

test("Agent creation withholds Dedicated OpenClaw unless the Installation reports native worker support", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pinned runtime", { ready: true });
  const installation = await fixture.request("GET", "/installation");
  assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  const mode = page.getByLabel("Execution mode");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  // The disabled option explains itself instead of claiming Dedicated is supported.
  const harnessHint = page.locator("#agent-harness-hint");
  assert.match(await harnessHint.textContent(), /Embedded execution only; choose Codex/);
  assert.doesNotMatch(await harnessHint.textContent(), /supports Dedicated/);
  const modeHint = page.locator("#execution-mode-hint");
  assert.match(await modeHint.textContent(), /Dedicated OpenClaw is unavailable/);
  assert.doesNotMatch(await modeHint.textContent(), /supports Dedicated/);
  // The blocking alert is reserved for a Dedicated selection; Embedded remains creatable.
  assert.equal(
    await page.getByText(/Dedicated OpenClaw is unavailable: this installation/).isHidden(),
    true,
  );
  // Status and the collapsed Runtime details name the Embedded draft path.
  await page
    .getByText(
      "Embedded Agents are saved as drafts. Deploy them from the Agent page after creation.",
    )
    .waitFor();
  assert.equal(
    await page.locator(".launch-runtime > summary").textContent(),
    "Runtime details · Embedded",
  );
  // Slack is simply unavailable for Embedded Agents, not an error.
  const embeddedChannelNote = page.getByText(
    "Channels require Dedicated execution. Embedded Agents can only keep channels disabled.",
  );
  await embeddedChannelNote.waitFor();
  assert.equal(await embeddedChannelNote.getAttribute("class"), "hint");
  // Codex keeps Dedicated execution; only native OpenClaw depends on the runtime.
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  assert.match(await modeHint.textContent(), /OpenClaw supports Dedicated or Embedded/);
  assert.match(await modeHint.textContent(), /Slack requires Dedicated execution/);
  assert.equal(
    await page.locator(".launch-runtime > summary").textContent(),
    "Runtime details · Dedicated",
  );

  // The API refuses the same choice at deploy admission, naming the missing support. The
  // operator declaration is startup-only: an Agent Configuration cannot carry it in.
  const agent = await fixture.createAgent(
    namespace.id,
    "Refused native",
    { ...nativeValues("refused"), runtime: { nativeWorkerSupport: "custom-image" } },
    { executionMode: "dedicated" },
  );
  const deployed = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
  );
  assert.equal(deployed.status, 400, JSON.stringify(deployed.body));
  assert.equal(deployed.body.error.code, "INVALID_REQUEST");
  assert.match(
    deployed.body.error.message,
    /required worker placement \(cloudWorkers\.requiredProfile\).*docs-enterprise\.openclaw\.org\/reference\/harness-execution\/#native-worker-support/,
  );
  assert.equal(
    (await fixture.request("GET", "/installation")).data.capabilities?.nativeWorkers,
    undefined,
  );

  // Bootstrap, the only Installation write, cannot declare the capability either.
  const other = await createConsoleAppFixture(t);
  const declared = await other.request("POST", "/installation/bootstrap", {
    body: {
      name: "Declared runtime",
      capabilities: { nativeWorkers: { support: "custom-image" } },
    },
  });
  assert.equal(declared.status, 400, JSON.stringify(declared.body));
  await other.bootstrap();
  assert.equal(
    (await other.request("GET", "/installation")).data.capabilities?.nativeWorkers,
    undefined,
  );
});

test("Agent creation preserves unrelated edited JSON across model changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t, { nativeWorkerSupport: "custom-image" });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page, artifacts } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  const mode = page.getByLabel("Execution mode");
  const harness = page.getByLabel("Harness", { exact: true });
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  await page.getByLabel("Agent name").fill("Template initial credential");
  await createModelCredentialSecret(page, "template-edit-key");
  await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-5.1");
  await page.getByLabel("Model ID", { exact: true }).press("Tab");
  const dedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(dedicatedTemplate.agents.defaults.model, "codex/gpt-5.1");
  assert.deepEqual(dedicatedTemplate.models.providers.codex.models, [
    { id: "gpt-5.1", name: "gpt-5.1" },
  ]);
  assert.ok(dedicatedTemplate.plugins.entries.codex);

  // Switching to OpenClaw defaults to Embedded; Dedicated is an explicit opt-in.
  await harness.selectOption("openclaw");
  assert.equal(await mode.inputValue(), "embedded");
  const nativeHarnessWarning = page.getByText(
    "Experimental: Dedicated OpenClaw requires a runtime build with native worker-inference support. Released OpenClaw images may not include it yet.",
    { exact: true },
  );
  assert.equal(await nativeHarnessWarning.isHidden(), true);
  await page.locator(".launch-runtime:not([open]) > summary").click();
  await mode.selectOption("dedicated");
  assert.equal(await harness.inputValue(), "openclaw");
  assert.equal(await nativeHarnessWarning.isVisible(), true);

  const nativeDedicatedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(nativeDedicatedTemplate.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(nativeDedicatedTemplate.plugins?.entries?.codex, undefined);
  assert.equal(nativeDedicatedTemplate.models.providers.openai.models[0].cost.input, 0);
  await page.screenshot({
    path: join(artifacts, "agent-create-native-harness.png"),
    fullPage: true,
  });

  await mode.selectOption("embedded");
  assert.equal(await harness.inputValue(), "openclaw");
  assert.equal(await nativeHarnessWarning.isHidden(), true);

  const embeddedTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(embeddedTemplate.agents.defaults.model, "openai/gpt-5.1");
  assert.equal(embeddedTemplate.models.providers.openai.models[0].id, "gpt-5.1");
  assert.equal(embeddedTemplate.models.providers.openai.models[0].name, "gpt-5.1");
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
  await openAdvancedSettings(page);
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

  await page.getByLabel("Agent name").fill("Template same provider credential");
  await createModelCredentialSecret(page, "same-provider-replacement-key");
  await modelInput.waitFor();
  assert.equal(await modelInput.inputValue(), "gpt-4.1-updated");
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

  // Replacing the credential preserves the selected model and custom execution policy.
  await page.getByLabel("Agent name").fill("Template codex replacement credential");
  await createModelCredentialSecret(page, "replacement-template-key");
  const nextModel = page.getByLabel("Model ID", { exact: true });
  await nextModel.waitFor();
  assert.equal(await nextModel.inputValue(), "gpt-4.1-codex-updated");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).plugins.entries.codex, customCodex);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset template" }).click();
  const resetTemplate = JSON.parse(await configuration.inputValue());
  assert.equal(resetTemplate.agents.defaults.model, "codex/gpt-4.1-codex-updated");
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
  await page.getByLabel("Agent name").fill("Template Anthropic credential");
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
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents.defaults.model, undefined);
  await page.getByLabel("Agent name").fill("Template returned OpenAI credential");
  await enterManualModel(page, "returned-openai-key", "gpt-returned-model");
  assert.equal(
    JSON.parse(await configuration.inputValue()).agents.defaults.model,
    "codex/gpt-returned-model",
  );
  await page.getByLabel("Agent name").fill("Discarded draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  assert.equal(await page.getByLabel("Agent name").inputValue(), "");
  assert.equal(JSON.parse(await configuration.inputValue()).agents?.defaults?.model, undefined);
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
});

test("Agent creation blocks an incompatible fallback after changing provider until the configuration is corrected", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Provider fallback change", { ready: true });
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await enterManualModel(page, "fallback-openai-key", "gpt-5.1");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await openAdvancedSettings(page);
  const configuration = page.getByLabel("Configuration JSON");
  const values = JSON.parse(await configuration.inputValue());
  values.agents.defaults.model = {
    primary: "openai/gpt-5.1",
    fallbacks: ["openai/gpt-4.1"],
  };
  await configuration.fill(JSON.stringify(values));
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  assert.equal(await page.getByLabel("API key Secret", { exact: true }).inputValue(), "");
  await page.getByLabel("Agent name").fill("Anthropic fallback credential");
  await enterManualModel(page, "test-fallback-anthropic-key", "claude-sonnet-4-6");
  assert.deepEqual(JSON.parse(await configuration.inputValue()).agents.defaults.model, {
    primary: "anthropic/claude-sonnet-4-6",
    fallbacks: ["openai/gpt-4.1"],
  });
  await page.getByLabel("Agent name").fill("Corrected fallback Agent");
  const writesBeforeInvalidCreate = nonAuthWriteRequests(requests).length;
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /fallback.*provider|provider.*fallback/i })
    .waitFor();
  assert.equal(nonAuthWriteRequests(requests).length, writesBeforeInvalidCreate);

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
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 2);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent creation saves native models for dedicated and embedded harnesses", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Starter model", { ready: true });
  const { page } = await newPage(t, fixture);
  // Exercise the supported draft path; dedicated provisioning has separate workflow coverage.
  await routeInstallationWithoutProvisioning(page, fixture, {
    nativeWorkers: { support: "custom-image" },
  });
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);

  for (const [mode, provider, harness, selectedModel] of [
    ["dedicated", "codex", "codex", "gpt-6-astra"],
    ["dedicated", "openai", "openclaw", "gpt-5.6-sol"],
    ["embedded", "openai", "openclaw", "gpt-5.6-luna"],
  ]) {
    await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("heading", { name: "Create Agent" }).waitFor();
    await page.getByRole("button", { name: "Start with default Preset" }).click();
    await page.getByLabel("Harness", { exact: true }).selectOption(harness);
    if (harness === "openclaw" && mode === "dedicated") {
      await page.locator(".launch-runtime:not([open]) > summary").click();
      await page.getByLabel("Execution mode").selectOption(mode);
    }
    await page.getByLabel("Model", { exact: true }).selectOption(selectedModel);
    await page.getByLabel("Agent name").fill(`${mode}-${selectedModel}`);
    const selectedSecret = await createModelCredentialSecret(
      page,
      `test-${mode}-${selectedModel}-key`,
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
    assert.equal(agent.executionMode, mode);
    assert.deepEqual(agent.harnessAuth, { method: "api_key", source: selectedSecret.ref });
    const configuration = await fixture.request(
      "GET",
      `/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
    );
    // Starters leave the gateway authentication mode to the selected Compute Driver
    // (no mode or token, #314) and reference only its generated password, which the
    // in-Pod gateway CLI needs (D381), while preserving the separate credentials for
    // dedicated Codex execution.
    assert.deepEqual(configuration.data.values.gateway.auth, {
      password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
    });
    assert.deepEqual(configuration.data.values.gateway.controlUi, STARTER_CONTROL_UI);
    if (harness === "codex") {
      assert.equal(
        configuration.data.values.plugins.entries.codex.config.appServer.authToken,
        "${APP_SERVER_TOKEN}",
      );
    } else {
      assert.equal(configuration.data.values.plugins?.entries?.codex, undefined);
      assert.equal(configuration.data.values.models.providers.codex, undefined);
    }
    const modelReference = `${provider}/${selectedModel}`;
    assert.equal(configuration.data.values.agents.defaults.model, modelReference);
    assert.deepEqual(configuration.data.values.agents.defaults.models, {
      [modelReference]: { agentRuntime: { id: harness } },
    });
    const [savedModel] = configuration.data.values.models.providers[provider].models;
    assert.equal(configuration.data.values.models.providers[provider].models.length, 1);
    assert.equal(savedModel.id, selectedModel);
    assert.equal(savedModel.name, selectedModel);
  }
});

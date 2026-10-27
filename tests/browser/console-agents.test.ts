/// <reference lib="es2024.promise" />

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Route } from "playwright";

import type {
  CreateAgentBody,
  CreateConfigurationBody,
  CreateSecretBody,
  ProvisionAgentBody,
} from "../../packages/contracts/src/api/common.ts";
import type {
  AgentWire,
  IAMAccessBindingWire,
  IAMRoleWire,
  SecretWire,
} from "../../packages/contracts/src/api/resources.ts";
import type { IAMDriver } from "../../packages/contracts/src/index.ts";

import {
  WORKSPACE_DEFAULTS,
  WORKSPACE_DEFAULTS_ID,
} from "../../packages/contracts/src/workspace-defaults.mjs";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import {
  accessBindingPostRequests,
  apiRequests,
  detailUrl,
  holdRequests,
  login,
  setSlackSelection,
  slackSelectionValue,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  revealNativeConfiguration,
  secretPostRequests,
  selectSecret,
  settlePageRequests,
  repositoryCheckbox,
  waitForEnabled,
  waitForInputValue,
  statusTone,
  isMaskedSecretValue,
  trackSettledFetches,
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
  nativeSandboxDriver,
  agentPostRequests,
  optionValues,
  createRepositoryLaunchFixture,
  runProvisioningPolls,
  waitForCreateFormReads,
  submitCreateAgent,
  createAgentThroughForm,
} from "./console-agents-test-support.mjs";
import {
  expectDeploymentOutcome,
  openFailureDetails,
} from "./console-deployment-activity-helpers.mjs";
import {
  ADMINISTRATOR_ACCESS_DENIED,
  AGENT_SAVE_DENIED,
  createDenied,
  DEPENDENCY_UNAVAILABLE,
  GENERIC_DENIAL,
  AGENT_CREATE_INSTALLATION_DENIED,
  CHANNELS_NEED_DEDICATED,
  REPOSITORY_ACCESS_NOT_CONFIGURED,
  REPOSITORY_CHOICES_CREATE_DENIED,
} from "../helpers/refusal-text.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t: TestContext, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

function submittedBody<Body>(request: { body: unknown } | undefined): Body {
  assert.ok(request?.body, "expected a submitted request body");
  return request.body as Body;
}

// Native Configuration values are open-ended. Check the Slack branch these scenarios exercise.
function slackConfiguration(values: object) {
  assert.ok("channels" in values);
  const { channels } = values;
  assert.ok(channels && typeof channels === "object" && "slack" in channels);
  const { slack } = channels;
  assert.ok(slack && typeof slack === "object" && "channels" in slack);
  return slack;
}

function savedSecretReference(secrets: ReadonlyMap<string, SecretWire>, name: string) {
  const secret = secrets.get(name);
  assert.ok(secret, `expected the saved Secret ${name}`);
  return secret.ref;
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
    { value: "credential_source", text: "ChatGPT OAuth (Experimental)" },
  ]);
  const apiKeySecret = page.getByLabel("API key Secret", { exact: true });
  await apiKeySecret.waitFor();
  assert.equal(await apiKeySecret.evaluate((node) => node.tagName), "INPUT");
  assert.equal(await apiKeySecret.evaluate((node: HTMLInputElement) => node.required), true);
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
  // The fixed key reads as text, not as a field like Name (finding 2370).
  const fieldChrome = (label: string, exact = false) =>
    createSecretDialog.getByLabel(label, { exact }).evaluate((node) => {
      const style = getComputedStyle(node);
      return { border: style.borderTopColor, background: style.backgroundColor };
    });
  const [fixedKey, nameField] = [await fieldChrome("Binding key"), await fieldChrome("Name", true)];
  assert.equal(fixedKey.border, "rgba(0, 0, 0, 0)");
  assert.equal(fixedKey.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(nameField.border, fixedKey.border);
  assert.equal(
    await createSecretDialog.getByLabel("Name", { exact: true }).inputValue(),
    "Console-created Agent Slack bot token",
  );
  assert.equal(
    await isMaskedSecretValue(createSecretDialog.getByLabel("Value", { exact: true })),
    true,
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
  // The real Secret write must finish before its dialog can be dismissed.
  const secretWrite = await holdRequests(
    t,
    page,
    `${fixture.origin}/namespaces/${namespace.id}/secrets`,
    { method: "POST", afterServer: true, timeout: 0 },
  );
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
  await secretWrite.requested;
  await page.mouse.click(secretBounds.x / 2, secretBounds.y + 8);
  assert.equal(await createSecretDialog.isVisible(), true);
  assert.equal(
    await createSecretDialog.getByRole("button", { name: "Create Secret" }).isDisabled(),
    true,
  );
  secretWrite.release();
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
  const createResponse = await submitCreateAgent(page, fixture, namespace.id);
  const configuration = await (await configurationResponse).json();
  const created = await createResponse.json();
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
  const createdPageText = await page.locator("body").textContent();
  assert.ok(createdPageText !== null);
  assert.equal(createdPageText.includes(key), false);
  assert.equal(createdPageText.includes("never-visible-existing-slack-app-token"), false);
  assert.equal(createdPageText.includes(createdSlackBotSecretValue), false);
  assert.equal(createdPageText.includes("never-visible-replacement-slack-app-token"), false);
  assert.equal(created.data.activeRevisionId, undefined);
  const submittedWorkspace = submittedBody<CreateAgentBody>(
    agentPostRequests(requests, namespace.id)[0],
  );
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
  await page
    .getByRole("button", { name: "View new version, editable Configuration", exact: true })
    .waitFor();
  await page.getByRole("heading", { name: "Prepare this version" }).waitFor();
  await page.getByText("No version is currently selected for service.").waitFor();
  // A never-deployed Agent has no Stop card and reports no stop request (finding 1899). The
  // card is hidden while versions load too, so wait for the empty version list first.
  await page.getByText(/^No readable versions\. Creating an Agent alone does not create/).waitFor();
  await page.locator("section.stop-note").waitFor({ state: "hidden" });
  assert.equal(await page.getByText(/Stop requested/).count(), 0);
  await page.getByRole("tab", { name: "Configuration", exact: true }).waitFor();
  await revealNativeConfiguration(page, "View native Configuration");
  await page.getByText('"marker": "create"').waitFor();
  // The summary identifies its Secret, while credential values remain private.
  const boundSecret = page.getByRole("link", {
    name: secret.name,
    exact: true,
  });
  await boundSecret.waitFor();
  // It opens the console Secrets page on that Secret, not the API path (finding D757).
  assert.equal(
    await boundSecret.getAttribute("href"),
    `/console/secrets?namespace=${namespace.id}&secret=${secret.id}`,
  );
  const visibleConfiguration = await page.locator("body").textContent();
  assert.ok(visibleConfiguration !== null);
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
      // The preflight checks the pair before the form saves its Configuration.
      ["POST", `/namespaces/${namespace.id}/agents/validate`],
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
      ["POST", `/namespaces/${namespace.id}/iam/roles`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
      ["POST", `/namespaces/${namespace.id}/iam/access-bindings`],
    ],
  );
  assert.deepEqual(configurationPostRequests(requests, namespace.id)[0]?.body, {
    kind: "agent",
    values: stagedValues,
    secretBindings: stagedSecretBindings,
  });

  const roles = await fixture.request("GET", `/namespaces/${namespace.id}/iam/roles`);
  const access = await fixture.request("GET", `/namespaces/${namespace.id}/iam/access-bindings`);
  assert.equal(roles.status, 200);
  assert.equal(access.status, 200);
  const [role]: IAMRoleWire[] = roles.data;
  const bindings: IAMAccessBindingWire[] = access.data;
  assert.equal(roles.data.length, 1);
  assert.ok(role);
  assert.deepEqual(role.permissions, [{ action: "operate", resourceKind: "secret" }]);
  assert.deepEqual(
    bindings
      .map(({ id, ...binding }) => {
        assert.ok("resourceId" in binding, "the Secret grant must be scoped to one resource");
        return binding;
      })
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    [secret.id, replacementSlackAppSecret.id, createdSlackBotSecret.id]
      .sort()
      .map((resourceId) => ({
        namespaceId: namespace.id,
        subjectKind: "identity",
        subjectId: created.data.servicePrincipalId,
        roleId: role.id,
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
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
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
  await page.getByText(AGENT_SAVE_DENIED, { exact: true }).waitFor();
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
  // With the permission answer the start page refuses at once (finding 1521). Without one the
  // form opens, and the API still refuses the creation itself.
  await page.route(`**/namespaces/${namespace.id}/permissions`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText(REPOSITORY_CHOICES_CREATE_DENIED, { exact: true }).waitFor();
  await enterManualModel(page, "denied-agent-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Denied Agent");
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
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
  const options = await holdRequests(
    t,
    page,
    `**/namespaces/${namespace.id}/agents/repository-options`,
  );

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await page.getByText("Loading approved repositories…").waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  options.release();
  await page.getByText(/No approved repositories are available/).waitFor();
  await waitForCreateFormReads(page);
  await waitForEnabled(page.getByRole("button", { name: "Create Agent" }));

  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Ordinary Agent");
  const createdResponse = await submitCreateAgent(page, fixture, namespace.id);
  const created = await createdResponse.json();
  assert.equal(Object.hasOwn(created.data, "repositoryBindings"), false);
  assert.equal(
    Object.hasOwn(
      submittedBody<CreateAgentBody>(agentPostRequests(requests, namespace.id).at(-1)),
      "repositoryBindings",
    ),
    false,
  );
});

test("Dedicated repository Agent keeps its bindings through a Slack save that binds both tokens", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
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
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Repository Slack app",
    "xapp-repository-fixture",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Repository Slack bot",
    "xoxb-repository-fixture",
  );
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset" }).click();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Dedicated repository Agent");
  assert.equal(await page.getByLabel("Execution mode").inputValue(), "dedicated");
  await repositoryCheckbox(page, "example/application").click();
  // The intro names repository access where the Installation offers it (finding 2423).
  await page
    .getByText(
      "Choose a model and repository access. Add Slack when you want this Agent to work with your team.",
      { exact: true },
    )
    .waitFor();
  await page.locator("#repository-default-git-full").check();
  const agent = await createAgentThroughForm(page, fixture, namespace.id);
  assert.equal(agent.executionMode, "dedicated");
  assert.deepEqual(agent.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
  ]);
  assert.equal(agent.harnessAuth.method, "api_key");
  assert.equal(agent.harnessAuth.source.namespaceId, namespace.id);
  assert.notEqual(agent.harnessAuth.source.id, modelSecret.id);
  await page.getByRole("tab", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Direct-message policy").selectOption("disabled");
  await setSlackSelection(
    page.getByRole("combobox", { name: "Channels", exact: true }),
    "CREPOSITORY123",
  );
  await page.getByLabel("Who can use the agent in these channels?").selectOption("everyone");
  // Configuration save refuses Slack token references without Secret bindings (finding 2319).
  const slackDialog = page.getByRole("dialog", { name: "Configure Slack" });
  await selectSecret(slackDialog, "Slack app token", slackAppSecret);
  await selectSecret(slackDialog, "Slack bot token", slackBotSecret);
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
  assert.deepEqual(
    [
      saved.data.secretBindings.SLACK_APP_TOKEN.source,
      saved.data.secretBindings.SLACK_BOT_TOKEN.source,
    ],
    [slackAppSecret.ref, slackBotSecret.ref],
  );
  const sameAgent = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.deepEqual(sameAgent.data.repositoryBindings, agent.repositoryBindings);

  // Runtime credentials are generated by deployment, never by a Slack save.
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
  // No Repo Driver is a fixed state: discovery answers no options and says why (finding 2387).
  const options = await optionsResponse;
  assert.equal(options.status(), 200);
  const optionsBody = await options.json();
  assert.deepEqual([optionsBody.data, optionsBody.meta.notConfigured], [[], true]);
  await unavailablePage.getByText(REPOSITORY_ACCESS_NOT_CONFIGURED, { exact: false }).waitFor();
  assert.match(
    await unavailablePage
      .getByRole("status")
      .filter({
        hasText: REPOSITORY_ACCESS_NOT_CONFIGURED,
      })
      .innerText(),
    /You can continue without repository access/,
  );
  // Without repository access the intro offers only what the form has (finding 2423).
  await unavailablePage
    .getByText("Choose a model. Add Slack when you want this Agent to work with your team.", {
      exact: true,
    })
    .waitFor();
  const setupGuide = unavailablePage.getByRole("link", { name: "Set up repository access" });
  assert.equal(
    await setupGuide.getAttribute("href"),
    "https://github.com/openclaw/openclaw-enterprise/blob/main/docs/guides/repository-credentials/team-runbook.md",
  );
  await waitForCreateFormReads(unavailablePage);
  await waitForEnabled(unavailablePage.getByRole("button", { name: "Create Agent" }));
  // A missing repository composition cannot recover by retrying, so no Retry is offered.
  assert.equal(
    await unavailablePage.getByRole("button", { name: "Retry repository choices" }).isVisible(),
    false,
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
    await createRepositoryLaunchFixture(t, (namespaceId: string) => [
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
  // Without a permission answer the form opens (with one it refuses at once, finding 1521), so
  // the repository and creation reads show their own denials.
  await deniedPage.route(`**/namespaces/${deniedNamespace.id}/permissions`, (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await login(deniedPage, deniedFixture, `/console/agents/new?namespace=${deniedNamespace.id}`);
  await deniedPage.getByRole("button", { name: "Start with default Preset" }).click();
  const repositoryDenial = deniedPage.getByText(REPOSITORY_CHOICES_CREATE_DENIED, { exact: true });
  await repositoryDenial.waitFor();
  // A refusal is a danger alert, not a quiet hint (finding 2006).
  assert.deepEqual(await statusTone(repositoryDenial), {
    className: "status",
    tone: "danger",
    role: "alert",
  });
  // The disabled state must reflect both reads' outcome, not a read still pending.
  await waitForCreateFormReads(deniedPage);
  assert.equal(await deniedPage.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await deniedPage
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
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
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
});

test("Agent creation blocks selective Agent-create IAM unavailability even when Configuration creation is allowed", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
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
  } satisfies IAMDriver);
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
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  fixture.controller.selectDriver("iam", originalIAM.id);
  await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
  await page.getByText("Select repositories for this Agent.", { exact: false }).waitFor();
  await waitForEnabled(page.getByRole("button", { name: "Create Agent" }));
});

for (const failure of [
  { name: "not found", status: 404, code: "NOT_FOUND" },
  // A rate limit in front of the API: the route itself sends no 429.
  { name: "proxy rate limited", status: 429, proxy: true },
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
    const failDiscovery = (route: Route) =>
      failure.status === undefined
        ? route.abort("failed")
        : failure.proxy
          ? route.fulfill(proxyErrorResponse(failure.status))
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
    await page
      .locator("#create-agent-form")
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    await settlePageRequests(page);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
    assert.equal(agentPostRequests(requests, namespace.id).length, 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-server-detail/);

    await page.unroute(path, failDiscovery);
    await page.getByRole("button", { name: "Retry repository choices", exact: true }).click();
    await page.getByText(/No approved repositories are available/).waitFor();
    await waitForEnabled(page.getByRole("button", { name: "Create Agent" }));
    await submitCreateAgent(page, fixture, namespace.id, { status: 201 });
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  });
}

test("Agent repository selection enforces the 16-item limit without narrow viewport overflow", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) =>
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
  // The page keeps a stable scrollbar gutter, so its content may be narrower than the viewport;
  // it must not overflow it.
  const width = await page.locator("html").evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  assert.equal(width.clientWidth, 360);
  assert.ok(width.scrollWidth <= width.clientWidth, JSON.stringify(width));
});

test("Agent creation recovers from stale authoritative admission without replacing its Configuration", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
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

  // Agent create is denied once the form's preflight passes, so the save is refused after the
  // Configuration is saved.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/validate`,
    async (route) => {
      const response = await route.fetch();
      fixture.policy.restrictions.push({
        id: "stale-agent-create-authorization",
        namespaceId: namespace.id,
        resourceKind: "agent",
        action: "create",
        effect: "deny",
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  const savedConfigurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  await submitCreateAgent(page, fixture, namespace.id, { status: 403 });
  const savedConfiguration = await (await savedConfigurationResponse).json();
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
  await waitForEnabled(page.getByRole("button", { name: "Start a new draft" }));

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
  await waitForEnabled(page.getByRole("button", { name: "Start a new draft" }));
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  fixture.policy.restrictions.pop();
  const repositoryOptionsPath = `**/namespaces/${namespace.id}/agents/repository-options`;
  const failRepositoryReload = (route: Route) =>
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
    .filter({ hasText: /^Repository choices could not be reloaded\. Configuration / })
    .waitFor();
  // The repository picker's own line is a danger block, so an alert too (finding 2005).
  await page
    .getByRole("alert")
    .filter({ hasText: /^Repository choices could not be reloaded\. Service unavailable\./ })
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
  await waitForEnabled(page.getByRole("button", { name: "Start a new draft" }));
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  // Even a post-authorization optional outage cannot satisfy a repository-scoped retry.
  const optionalRepositoryOutage = (route: Route) =>
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
    .filter({ hasText: /^Repository choices could not be reloaded\. Configuration / })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await page.unroute(repositoryOptionsPath, optionalRepositoryOutage);

  const conflictRepositoryReload = (route: Route) =>
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
    .filter({
      hasText:
        /^Repository choices could not be reloaded because this Namespace no longer accepts new Agents\. /,
    })
    .waitFor();
  await page
    .getByRole("alert")
    .getByText("This Namespace no longer accepts new Agents.", { exact: true })
    .waitFor();
  await page.unroute(repositoryOptionsPath, conflictRepositoryReload);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);

  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  await waitForEnabled(repositoryCheckbox(page, "example/application"));
  assert.equal(await page.locator(".repository-card").count(), 0);
  // Refreshing policy permits editing; it must not turn this saved attempt into an ordinary Agent.
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start a new draft" }).isVisible(), true);
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.locator("#repository-default-git-read").check();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isEnabled(), true);
  await page.getByRole("button", { name: "Remove example/application" }).click();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
  await repositoryCheckbox(page, "example/application").click();
  await page.locator("#repository-default-git-read").check();
  const createdResponse = await submitCreateAgent(page, fixture, namespace.id);
  const created = await createdResponse.json();
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-read" },
  ]);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(agentPostRequests(requests, namespace.id).length, 2);
  assert.equal(created.data.configurationId, savedConfiguration.data.id);
});

test("Agent creation does not expose recovery actions after an unknown admission outcome", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
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
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  await settlePageRequests(page);
  assert.equal(agentPostRequests(requests, namespace.id).length, 1);
});

test("Agent repository recovery with empty current policy requires an explicit new draft", async (t) => {
  const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
    t,
    (namespaceId: string) => [
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
  // Agent create is denied once the form's preflight passes, so the save is refused after the
  // Configuration is saved.
  await page.route(
    `${fixture.origin}/namespaces/${namespace.id}/agents/validate`,
    async (route) => {
      const response = await route.fetch();
      fixture.policy.restrictions.push({
        id: "reject-before-policy-refresh",
        namespaceId: namespace.id,
        resourceKind: "agent",
        action: "create",
        effect: "deny",
      });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
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
  await page
    .locator("#create-agent-form")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
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
  const created = await createAgentThroughForm(page, fixture, namespace.id);
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
  let provisionBody: ProvisionAgentBody | undefined;
  const savedSecrets = new Map<string, SecretWire>();
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
      source: null as SecretWire["ref"] | null,
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

  const json = (data: unknown, status = 200) => ({
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
    const body: CreateSecretBody = request.postDataJSON();
    // Secrets use the real API; only provisioning and deployment progression are simulated.
    const response = await route.fetch();
    const saved: SecretWire = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    provisionBody = request.postDataJSON() as ProvisionAgentBody;
    await route.fulfill(
      json(
        {
          provisioning: {
            requestId: provisionBody.requestId,
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
    assert.ok(provisionBody, "the provisioning request was submitted before polling");
    await route.fulfill(
      json({
        provisioning: {
          requestId: provisionBody.requestId,
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
      const { pathname } = new URL(route.request().url());
      const name = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
      await route.fulfill(json({ name, content: `# ${name}\n` }));
    },
  );

  await trackSettledFetches(page);
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
  await runProvisioningPolls(
    page,
    async () => {
      await page.getByRole("button", { name: "Create Agent" }).click();
      assert.equal((await provisionResponse).status(), 202);
      assert.equal(await page.getByLabel("Harness", { exact: true }).isDisabled(), true);
      allowProvisioningSuccess = true;
    },
    `/namespaces/${namespace.id}/agents/provision/work_create`,
    1,
  );
  await page.waitForURL((url) => {
    return (
      url.pathname === `/console/agents/${agentId}` &&
      url.searchParams.get("namespace") === namespace.id &&
      url.searchParams.get("revision") === revisionId &&
      url.searchParams.get("tab") === "configuration"
    );
  });
  // Creation must hand off to the detail page while deployment is still queued.
  const deploymentPanel = await expectDeploymentOutcome(page, "Queued");
  assert.equal(await page.getByRole("heading", { name: "Create Agent", exact: true }).count(), 0);
  deploymentStatus = "failed";
  await deploymentPanel.getByRole("button", { name: "Refresh deployment", exact: true }).click();
  await openFailureDetails(page);
  await expectDeploymentOutcome(page, "Failed", { folded: false });
  await deploymentPanel
    .getByText("DEPENDENCY_UNAVAILABLE: Deployment reconciliation failed.", { exact: true })
    .waitFor();

  assert.ok(provisionBody);
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
  assert.deepEqual(slackConfiguration(provisionBody.configuration.values), {
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
        source: savedSecretReference(savedSecrets, "Provisioned Agent Slack app token"),
        delivery: { type: "env" },
      },
      SLACK_BOT_TOKEN: {
        source: savedSecretReference(savedSecrets, "Provisioned Agent Slack bot token"),
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
  await page.getByText(REPOSITORY_ACCESS_NOT_CONFIGURED, { exact: false }).waitFor();
  await page.getByLabel("Agent name", { exact: true }).fill("Model-only Agent");
  await enterManualModel(page, "model-only-test-key", "gpt-5.1");
  const admission = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/namespaces/${namespace.id}/agents/provision`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  assert.equal((await admission).status(), 403);
  // This viewer read the Installation, which only an Installation administrator can, so the
  // denial does not send them to one.
  await page.getByText(ADMINISTRATOR_ACCESS_DENIED, { exact: true }).waitFor();
  const submitted = agentProvisionPostRequests(requests, namespace.id);
  assert.equal(submitted.length, 1);
  const body = submittedBody<ProvisionAgentBody>(submitted[0]);
  assert.equal(body.executionMode, "dedicated");
  assert.equal(Object.hasOwn(body, "repositoryBindings"), false);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);

  // A named denial (finding 2534) asks an Installation administrator, which this caller is, so
  // the form keeps the plain text (finding 2113).
  const requestId = `req_${randomUUID()}`;
  await page.unroute(`**/namespaces/${namespace.id}/agents/provision`);
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, (route) =>
    route.fulfill(
      apiErrorResponse(403, "FORBIDDEN", createDenied("Agent", namespace.id), { requestId }),
    ),
  );
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page
    .getByText(`${ADMINISTRATOR_ACCESS_DENIED} Request ID: ${requestId}`, { exact: true })
    .waitFor();
  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 2);
});

test("Dedicated Agent creation uses regular create when provisioning is unsupported", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Unsupported provision", { ready: true });
  const slackAppSecret = await fixture.createSecret(
    namespace.id,
    "Unsupported Slack app",
    "xapp-unsupported-fixture",
  );
  const slackBotSecret = await fixture.createSecret(
    namespace.id,
    "Unsupported Slack bot",
    "xoxb-unsupported-fixture",
  );
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
  // Create Agent refuses Slack token references without Secret bindings (finding 2319).
  await selectSecret(channelDialog, "Slack app token", slackAppSecret);
  await selectSecret(channelDialog, "Slack bot token", slackBotSecret);
  await channelDialog.getByRole("button", { name: "Apply channel settings" }).click();
  const createdAgent: AgentWire = await createAgentThroughForm(page, fixture, namespace.id);
  // Navigation follows the model Secret grant; the Agent POST alone does not finish creation.
  await page.waitForURL((url) => url.pathname.startsWith("/console/agents/agt_"));

  assert.equal(agentProvisionPostRequests(requests, namespace.id).length, 0);
  const configurationWrites = configurationPostRequests(requests, namespace.id);
  assert.equal(configurationWrites.length, 1);
  const configuration = submittedBody<CreateConfigurationBody>(configurationWrites[0]);
  assert.deepEqual(slackConfiguration(configuration.values).channels, {
    CUNSUPPORTED123: { requireMention: true, users: ["*"] },
  });
  assert.deepEqual(
    [
      configuration.secretBindings?.SLACK_APP_TOKEN?.source,
      configuration.secretBindings?.SLACK_BOT_TOKEN?.source,
    ],
    [slackAppSecret.ref, slackBotSecret.ref],
  );
  // The model Secret and both Slack Secrets.
  assert.equal(accessBindingPostRequests(requests, namespace.id).length, 3);
  // The preflight checked the same bindings, so an unbound token is refused before any save.
  const [preflight] = pathRequests(requests, "POST", `/namespaces/${namespace.id}/agents/validate`);
  assert.deepEqual(
    (preflight?.body as { configuration?: { secretBindings?: unknown } })?.configuration
      ?.secretBindings,
    configuration.secretBindings,
  );
  assert.deepEqual(
    agentPostRequests(requests, namespace.id).map((request) => request.body),
    [
      {
        name: "Unsupported Dedicated Agent",
        executionMode: "dedicated",
        initialWorkspaceFiles: WORKSPACE_DEFAULTS,
        workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
        repositoryAccess: { defaultProfile: "git-full", repositories: [] },
        harnessAuth: createdAgent.harnessAuth,
        configurationId: createdAgent.configurationId,
      },
    ],
  );
  // Read the created draft through the real API, then verify both access choices
  // survive a new page load rather than only remaining in the create form.
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
  ] as const) {
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
  const bodies: ProvisionAgentBody[] = [];
  const savedSecrets = new Map<string, SecretWire>();
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
      source: null as SecretWire["ref"] | null,
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
  const json = (data: unknown, status = 200) => ({
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
    const body: CreateSecretBody = request.postDataJSON();
    // Keep Secret persistence real while simulating an uncertain provisioning response.
    const response = await route.fetch();
    const saved: SecretWire = (await response.json()).data;
    savedSecrets.set(body.name, saved);
    if (!body.name.endsWith("Slack app token") && !body.name.endsWith("Slack bot token")) {
      agent.harnessAuth.source = saved.ref;
    }
    await route.fulfill({ response });
  });
  await page.route(`**/namespaces/${namespace.id}/agents/provision`, async (route, request) => {
    const body: ProvisionAgentBody = request.postDataJSON();
    bodies.push(body);
    if (bodies.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            // The catch-all outage text names no reason, so the outcome stays unknown.
            message: DEPENDENCY_UNAVAILABLE,
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
            requestId: body.requestId,
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
      const { pathname } = new URL(route.request().url());
      const name = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
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
  const [first, retry] = bodies;
  assert.ok(first && retry);
  assert.equal(retry.requestId, first.requestId);
  assert.deepEqual(retry, first);
  assert.equal(first.name, agent.name);
  assert.deepEqual(slackConfiguration(first.configuration.values).channels, {
    CRETRY123: { requireMention: true, users: ["*"] },
  });
  assert.deepEqual(first.harnessAuth, agent.harnessAuth);
  assert.equal(Object.hasOwn(first, "secrets"), false);
  assert.deepEqual(first.configuration.secretBindings, {
    SLACK_APP_TOKEN: {
      source: savedSecretReference(savedSecrets, "Retried Agent Slack app token"),
      delivery: { type: "env" },
    },
    SLACK_BOT_TOKEN: {
      source: savedSecretReference(savedSecrets, "Retried Agent Slack bot token"),
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

test("Agent creation explains a denied capability check instead of offering a retry", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Capability denial", { ready: true });
  const { page } = await newPage(t, fixture);
  // Without a permission answer that grants Agent create, a denied Installation read keeps the
  // refusal; a member with permission to create Agents in the Namespace can continue.
  let permissions: { agents: { create: boolean } } | null = null;
  await page.route(`**/namespaces/${namespace.id}/permissions`, (route) =>
    permissions
      ? route.fulfill({ json: { data: permissions } })
      : route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  let status = 403;
  await page.route(`${fixture.origin}/installation`, async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: status === 403 ? "FORBIDDEN" : "DEPENDENCY_UNAVAILABLE",
          message: status === 403 ? GENERIC_DENIAL : DEPENDENCY_UNAVAILABLE,
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000002" },
      }),
    });
  });

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  // A failed permission read is not a denial: the form says so and offers that check again
  // (finding 2110); a known denial then keeps the refusal, with no retry.
  await page.getByText(/^Your permissions in this Namespace could not be checked/).waitFor();
  permissions = { agents: { create: false } };
  await page.getByRole("button", { name: "Retry permission check" }).click();
  await page.getByText(AGENT_CREATE_INSTALLATION_DENIED).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry permission check" }).count(), 0);
  const retry = page.getByRole("button", { name: "Retry capability check" });
  assert.equal(
    await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
    true,
  );
  // Without capabilities the harness hint states the requirement, not an outcome.
  const harnessHint = page.locator("#agent-harness-hint");
  assert.equal(await harnessHint.textContent(), "Codex requires OpenAI and Dedicated execution.");

  // A transient failure still offers the retry.
  status = 503;
  permissions = null;
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText(/^Installation capabilities unavailable\. /).waitFor();
  await retry.waitFor();
  assert.equal(await harnessHint.textContent(), "Codex requires OpenAI and Dedicated execution.");
});

test("Agent creation withholds Dedicated OpenClaw unless the Installation reports native worker support", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Pinned runtime", { ready: true });
  // The pinned runtime supports native workers, but no Sandbox Driver can provision them, so
  // the Installation cannot admit dedicated OpenClaw and does not report it (finding 1608).
  const installation = await fixture.request("GET", "/installation");
  assert.equal(installation.data.capabilities?.nativeWorkers, undefined);
  const { page } = await newPage(t, fixture);
  // An older server without the capability still disables Dedicated in the client.
  await routeInstallationWithoutProvisioning(page, fixture);

  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("heading", { name: "Create Agent" }).waitFor();
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await page.getByText("Checking installation capabilities…").waitFor({ state: "detached" });
  const mode = page.getByLabel("Execution mode");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  assert.equal(await mode.inputValue(), "embedded");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), true);
  // The disabled option explains itself instead of claiming Dedicated is supported.
  const harnessHint = await page.locator("#agent-harness-hint").textContent();
  assert.ok(harnessHint);
  assert.equal(
    harnessHint,
    "This Agent will run OpenClaw with Embedded execution. Choose Codex for Dedicated execution.",
  );
  assert.doesNotMatch(harnessHint, /supports Dedicated/);
  const modeHint = page.locator("#execution-mode-hint");
  const embeddedHint = await modeHint.textContent();
  assert.ok(embeddedHint);
  assert.match(embeddedHint, /Dedicated OpenClaw is unavailable/);
  assert.doesNotMatch(embeddedHint, /supports Dedicated/);
  // The blocking alert is reserved for a Dedicated selection; Embedded remains creatable.
  assert.equal(
    await page
      .getByText(/Dedicated OpenClaw is unavailable: this installation has no Sandbox/)
      .isHidden(),
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
  const embeddedChannelNote = page.getByText(CHANNELS_NEED_DEDICATED);
  await embeddedChannelNote.waitFor();
  assert.equal(await embeddedChannelNote.getAttribute("class"), "hint");
  // Codex keeps Dedicated execution; only native OpenClaw depends on the runtime.
  await page.getByLabel("Harness", { exact: true }).selectOption("codex");
  assert.equal(await mode.locator('option[value="dedicated"]').isDisabled(), false);
  const dedicatedHint = await modeHint.textContent();
  assert.ok(dedicatedHint);
  assert.match(
    dedicatedHint,
    /OpenClaw uses Dedicated execution with a Sandbox Driver that provisions it, and Embedded execution without a Sandbox Driver/,
  );
  assert.match(dedicatedHint, /Slack requires Dedicated execution/);
  assert.equal(
    await page.locator(".launch-runtime > summary").textContent(),
    "Runtime details · Dedicated",
  );

  // Bootstrap, the only Installation write, cannot declare the capability either.
  const other = await createConsoleAppFixture(t, { sandboxDriver: nativeSandboxDriver() });
  const declared = await other.request("POST", "/installation/bootstrap", {
    body: {
      name: "Declared runtime",
      capabilities: { nativeWorkers: { support: "custom-image" } },
    },
  });
  assert.equal(declared.status, 400, JSON.stringify(declared.body));
  await other.bootstrap();
  assert.deepEqual((await other.request("GET", "/installation")).data.capabilities?.nativeWorkers, {
    support: "pinned-runtime",
  });
});

test("Agent creation preserves unrelated edited JSON across model changes and resets to the selected template", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    nativeWorkerSupport: "custom-image",
    sandboxDriver: nativeSandboxDriver(),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Template edits", { ready: true });
  const { page, artifacts } = await newPage(t, fixture);
  // This Installation admits only Dedicated OpenClaw (#2670). A server that reports native worker
  // support but not the OpenClaw execution modes leaves both modes selectable, which is how this
  // test reaches both templates.
  await routeInstallationWithoutProvisioning(page, fixture, {
    nativeWorkers: { support: "custom-image" },
  });

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
  const customModel = custom.agents.defaults.models["openai/gpt-4.1"];
  assert.ok(customModel);
  Object.assign(customModel, { alias: "Primary assistant", params: { temperature: 0.4 } });
  const openai = custom.models.providers.openai;
  assert.ok(openai);
  const extraModel = { id: "additional-model", name: "Additional model", contextWindow: 64000 };
  const customProvider = Object.assign(openai, {
    baseUrl: "https://models.example.test/v1",
    api: "openai-completions",
    headers: { "X-Custom-Transport": "enterprise-route" },
    models: [...openai.models, extraModel],
  });
  Object.assign(custom.gateway.controlUi, {
    allowedOrigins: ["https://custom-control.example.test"],
  });
  const edited = JSON.stringify(custom, null, 2);
  await openAdvancedSettings(page);
  await configuration.fill(edited);
  const modelInput = page.getByLabel("Model ID", { exact: true });
  await modelInput.fill("gpt-4.1-updated");
  await modelInput.press("Tab");
  const assertCustomTransport = async () => {
    const provider: typeof customProvider = JSON.parse(await configuration.inputValue()).models
      .providers.openai;
    assert.equal(provider.baseUrl, customProvider.baseUrl);
    assert.equal(provider.api, customProvider.api);
    assert.deepEqual(provider.headers, customProvider.headers);
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
  const agent = await createAgentThroughForm(page, fixture, namespace.id);
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
  ] as const) {
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
    const agent = await createAgentThroughForm(page, fixture, namespace.id);
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

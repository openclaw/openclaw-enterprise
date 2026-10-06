import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexPluginDriver,
  OCCPluginDriver,
} from "../../apps/controller/src/drivers/plugin/index.ts";
import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { startRegistryCredentialServiceFixture } from "../fixtures/repository-credentials/registry.mjs";
import {
  apiRequests,
  login,
  nativeValues,
  newPage,
  pathRequests,
  repositoryCheckbox,
  waitForCondition,
} from "./console-agents-browser-helpers.mjs";
import {
  agentPostRequests,
  configurationPostRequests,
  createRepositoryLaunchFixture,
  enterManualModel,
  repositoryBackendFixture,
} from "./console-agents-test-support.mjs";

test("Agent repository access labels target the right repository when references overlap", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    ["app", "inherit-app"].map((repositoryRef, index) => ({
      repositoryRef,
      repositoryId: String(1700 + index),
      repository: `example/${repositoryRef}`,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  await repositoryCheckbox(page, "example/app").click();
  await page.getByRole("button", { name: "Access for example/app", exact: true }).click();
  const settings = page.getByRole("group", { name: "Access for example/app", exact: true });
  assert.equal(await settings.locator('input[type="checkbox"]').isChecked(), true);
  // The label must change this repository, not add another whose reference shares its ID.
  await settings.getByText("Use Agent default", { exact: true }).click();
  assert.equal(await settings.locator('input[type="checkbox"]').first().isChecked(), false);
  assert.equal(await repositoryCheckbox(page, "example/inherit-app").isEnabled(), true);
  await page.locator("#repository-default-git-read").check();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository label Agent");
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await (await createResponse).json();
  assert.deepEqual(created.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [{ repositoryRef: "app", profile: "git-full" }],
  });
});

test("Agent repository access preserves inheritance, custom overrides, and explicit repair through create and edit", async (t) => {
  const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
    t,
    (namespaceId) => [
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
    ],
    { reloadablePolicy: true },
  );
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
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
  const defaultAccess = page.locator(".repository-profile-group");
  const writeAccess = defaultAccess.locator(".repository-write-access");
  assert.equal(await writeAccess.isVisible(), false);
  await defaultAccess.getByText("Customize access", { exact: true }).click();
  assert.equal(await writeAccess.isVisible(), true);
  assert.match(await writeAccess.innerText(), /can permit merges and branch changes/);
  assert.match(await writeAccess.innerText(), /best effort and does not restrict GraphQL/);
  assert.match(await writeAccess.innerText(), /administration and workflow permissions/);
  await defaultAccess.getByText("Customize access", { exact: true }).click();
  assert.equal(await page.getByLabel("Find a repository").count(), 0);
  await repositoryCheckbox(page, "example/application").focus();
  await page.keyboard.press("Space");
  assert.equal(
    await repositoryCheckbox(page, "example/application").evaluate(
      (node) => node === node.ownerDocument.activeElement,
    ),
    true,
  );
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for example/application" }).click();
  await page.locator("#repository-inherit-application").uncheck();
  await page.locator("#repository-default-git-read").check();
  await page.getByText(/1 custom repository keeps broader access/).waitFor();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await repositoryCheckbox(page, "example/documentation").click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-full").check();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-inherit-documentation").isVisible(), true);
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository Agent");
  await page.getByLabel("Harness", { exact: true }).selectOption("openclaw");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Choose approved access for each selected repository." })
    .waitFor();
  // Only the model credential Secret was created; no Configuration or Agent write started.
  assert.equal(configurationPostRequests(requests, namespace.id).length, 0);
  assert.equal(agentPostRequests(requests, namespace.id).length, 0);
  await page.locator("#repository-inherit-documentation").uncheck();
  await page.locator("#repository-override-documentation-git-read").check();
  await page.locator("#repository-default-git-read").check();
  // A checkbox round trip restores the original position and explicit access.
  const applicationChoice = repositoryCheckbox(page, "example/application");
  await applicationChoice.focus();
  await applicationChoice.press("Space");
  assert.equal(await applicationChoice.isChecked(), false);
  assert.equal(
    await applicationChoice.evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await applicationChoice.press("Space");
  assert.equal(await applicationChoice.isChecked(), true);
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  assert.deepEqual(
    await page.locator(".repository-card .repository-identity strong").allTextContents(),
    ["example/application", "example/documentation"],
  );
  await page.getByRole("button", { name: "Access for example/documentation" }).click();
  await page.getByRole("button", { name: "Remove example/documentation" }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  const createResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const created = await (await createResponse).json();
  assert.deepEqual(created.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [
      { repositoryRef: "application", profile: "git-full" },
      { repositoryRef: "documentation", profile: "git-read" },
    ],
  });
  assert.deepEqual(created.data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
    { repositoryRef: "documentation", profile: "git-read" },
  ]);
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  await page.getByText("Contributor · Custom", { exact: true }).waitFor();
  // Reversing an edit restores the saved intent, including explicit overrides.
  await page.getByRole("button", { name: "Remove example/documentation" }).click();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isEnabled(),
    true,
  );
  await page
    .getByText("Save or cancel repository access edits before deploying.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
  await page.locator("#repository-default-git-full").check();
  await page.locator("#repository-default-git-read").check();
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Access for example/application" }).click();
  await page.locator("#repository-inherit-application").check();
  assert.equal(
    await page.getByRole("button", { name: "Channels", exact: true }).isDisabled(),
    true,
  );
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save repository access" }).click();
  const saved = await (await savedResponse).json();
  assert.deepEqual(saved.data.repositoryAccess, {
    defaultProfile: "git-read",
    repositories: [
      { repositoryRef: "application" },
      { repositoryRef: "documentation", profile: "git-read" },
    ],
  });
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-full").check();
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  replacePolicy([
    {
      repositoryRef: "application",
      repositoryId: "789",
      repository: "example/application",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-read", "git-write", "git-full"] }],
    },
    {
      repositoryRef: "documentation",
      repositoryId: "790",
      repository: "example/documentation",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-write"] }],
    },
  ]);
  await page.reload();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(await page.locator("#repository-inherit-documentation").isVisible(), true);
  await page.locator("#repository-override-documentation-git-full").check();
  const issues = page.locator("#repository-access-documentation .repository-customize summary");
  await issues.click();
  assert.equal(await page.locator("#repository-override-documentation-issues").isDisabled(), true);
  assert.equal(await page.locator("#repository-override-documentation-issues").isChecked(), false);
  const repairedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/agents/${created.data.id}`) &&
      response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save repository access" }).click();
  assert.equal((await repairedResponse).status(), 200);
  const legacy = await fixture.request("POST", `/namespaces/${namespace.id}/agents`, {
    body: {
      name: "Legacy explicit repository access",
      configurationId: created.data.configurationId,
      repositoryBindings: [{ repositoryRef: "application", profile: "git-read" }],
    },
  });
  assert.equal(legacy.status, 201);
  await page.goto(
    `${fixture.origin}/console/agents/${legacy.data.id}?namespace=${namespace.id}&revision=draft&tab=repositories`,
  );
  await page.getByText("Read-only · Custom", { exact: true }).waitFor();
  const optionsPath = `**/namespaces/${namespace.id}/agents/${legacy.data.id}/repository-options`;
  await page.route(optionsPath, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "REPOSITORY_OPTIONS_UNAVAILABLE", message: "Discovery unavailable" },
      }),
    }),
  );
  await page.reload();
  await page.getByText(/Retry repository choices before saving repository access/).waitFor();
  await page.getByText("Access awaiting verification", { exact: true }).waitFor();
  assert.equal(await page.getByText(/This repository is no longer available/).count(), 0);
  assert.equal(
    await page
      .getByText("Repository availability cannot be verified. Retry repository choices.")
      .count(),
    1,
  );
  assert.equal(await page.getByText(/You can save a draft without repository access/).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Save repository access" }).isDisabled(),
    true,
  );
  await page.unroute(optionsPath);
  replacePolicy([
    {
      repositoryRef: "documentation",
      repositoryId: "790",
      repository: "example/documentation",
      namespaces: [{ namespaceId: namespace.id, profiles: ["git-write"] }],
    },
  ]);
  await page.getByRole("button", { name: "Retry repository choices" }).click();
  await page
    .getByText("This repository is no longer available. Remove it or retry discovery.")
    .waitFor();
});

test("Preset repository access and plugin policies remain independent during Agent creation", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "project",
      repositoryId: "789",
      repository: "example/project",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-full"] }],
    },
  ]);
  const pluginDriver = new OCCPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  // The launch fixture seeds default-codex through a filesystem Configuration Driver.
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "occ-plugin:diffs";
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Repository and plugin",
      template: {
        agent: {
          name: "Repository and plugin Agent",
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryAccess: {
            defaultProfile: "git-read",
            repositories: [{ repositoryRef: "project" }],
          },
          plugins: { [pluginId]: { enabled: false } },
        },
        configuration: { values: nativeValues("repository-plugin") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`Enable ${pluginId}`, { exact: true }).check();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("#repository-default-git-full").check();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), {
    [pluginId]: { enabled: true },
  });

  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.plugins, { [pluginId]: { enabled: true } });
  assert.deepEqual(created.repositoryAccess, {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "project" }],
  });
  assert.deepEqual(created.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);
});

test("Repository recovery preserves and updates hosted plugin policy before retry", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "project",
      repositoryId: "790",
      repository: "example/project",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-full"] }],
    },
  ]);
  const pluginDriver = new CodexPluginDriver();
  fixture.controller.registerDriver(pluginDriver);
  fixture.controller.selectDriver("plugin", pluginDriver.id);
  // The launch fixture seeds default-codex through a filesystem Configuration Driver.
  const secret = await fixture.createSecret(namespace.id, "Model key", "preset-plugin-model-key");
  const pluginId = "codex-plugin:knowledge@openai-curated-remote";
  const initialPlugins = {
    [pluginId]: { enabled: true, toolDefaults: { approval: "provider_default" } },
  };
  const preset = await fixture.request("POST", `/namespaces/${namespace.id}/presets`, {
    body: {
      name: "Repository and hosted plugin recovery",
      template: {
        agent: {
          name: "Recovered repository and plugin Agent",
          executionMode: "embedded",
          harnessAuth: { method: "api_key", source: secret.ref },
          repositoryAccess: {
            defaultProfile: "git-read",
            repositories: [{ repositoryRef: "project" }],
          },
          plugins: initialPlugins,
        },
        configuration: { values: nativeValues("repository-plugin-recovery") },
      },
    },
  });
  assert.equal(preset.status, 201, JSON.stringify(preset.body));
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByLabel("Preset template").selectOption(preset.data.id);
  await page.getByRole("button", { name: "Use Preset" }).click();
  await page.getByText("Read-only · Agent default", { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), initialPlugins);

  fixture.policy.restrictions.push({
    id: "deny-repository-plugin-create",
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
  const rejectedResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const savedConfiguration = (await (await savedConfigurationResponse).json()).data;
  assert.equal((await rejectedResponse).status(), 403);
  await page.getByRole("heading", { name: "Recover from a rejected Agent save" }).waitFor();
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), initialPlugins);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /could not be reloaded because Agent creation is denied/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  fixture.policy.restrictions.pop();
  await page.getByRole("button", { name: "Reload repository choices" }).click();
  await page.getByText(/Repository choices reloaded/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);
  await page.getByRole("button", { name: "Configure plugins", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Configure plugins", exact: true });
  await dialog.getByRole("button", { name: "Configured plugins", exact: true }).click();
  await dialog.getByRole("button", { name: pluginId, exact: true }).click();
  await dialog.getByLabel(`${pluginId} require approval for`, { exact: true }).selectOption("none");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const updatedPlugins = { [pluginId]: { enabled: true, toolDefaults: { approval: "none" } } };
  assert.deepEqual(JSON.parse(await page.locator("#agent-plugins").inputValue()), updatedPlugins);
  assert.equal(await page.getByRole("button", { name: "Create Agent" }).isDisabled(), true);

  await repositoryCheckbox(page, "example/project").click();
  await page.locator("#repository-default-git-full").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const created = (await response.json()).data;
  assert.deepEqual(created.plugins, updatedPlugins);
  assert.deepEqual(created.repositoryAccess, {
    defaultProfile: "git-full",
    repositories: [{ repositoryRef: "project" }],
  });
  assert.deepEqual(created.repositoryBindings, [{ repositoryRef: "project", profile: "git-full" }]);
  assert.equal(created.configurationId, savedConfiguration.id);
  assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
  assert.equal(pathRequests(requests, "POST", `/namespaces/${namespace.id}/secrets`).length, 0);
  const agentRequests = agentPostRequests(requests, namespace.id);
  assert.equal(agentRequests.length, 2);
  assert.deepEqual(agentRequests[0].body.plugins, initialPlugins);
  assert.deepEqual(agentRequests[1].body.plugins, updatedPlugins);
  assert.deepEqual(agentRequests[1].body.repositoryAccess, created.repositoryAccess);
  assert.equal(agentRequests[1].body.configurationId, savedConfiguration.id);
});

test("Agent repository editor distinguishes stale, rejected, and uncertain saves", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(
    namespace.id,
    "Repository save lifecycle",
    nativeValues("repository-save"),
  );
  const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const access = (defaultProfile) => ({
    defaultProfile,
    repositories: [{ repositoryRef: "application" }],
  });
  const initial = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-full") },
  });
  assert.equal(initial.status, 200);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(
    page,
    fixture,
    `/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=repositories`,
  );
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  await page.locator("#repository-default-git-read").check();

  // A changed saved baseline must be detected before this browser sends a PATCH.
  const concurrent = await fixture.request("PATCH", path, {
    body: { configurationId: agent.configurationId, repositoryAccess: access("git-write") },
  });
  assert.equal(concurrent.status, 200);
  const save = page.getByRole("button", { name: "Save repository access" });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await save.click();
  await page
    .getByText("Repository access changed while you were editing. Reload this draft before saving.")
    .waitFor();
  assert.equal(pathRequests(requests, "PATCH", path).length, 0);
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isDisabled(), true);
  await page.getByRole("button", { name: "Reload draft", exact: true }).click();
  await page
    .getByText("Contributor · no issue management · Agent default", { exact: true })
    .waitFor();
  assert.equal(await save.isDisabled(), true);

  // A known denial preserves edits and allows correction; it is not an uncertain write.
  await page.locator(".repository-profile-group .repository-customize summary").click();
  await page.locator("#repository-default-issues").check();
  fixture.policy.restrictions.push({
    id: "deny-repository-update",
    namespaceId: namespace.id,
    resourceKind: "agent",
    action: "update",
    effect: "deny",
  });
  await save.click();
  await page
    .getByText("Access denied. You do not have permission for this operation.", { exact: true })
    .waitFor();
  assert.equal(await save.isEnabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.locator("#repository-default-issues").isChecked(), true);
  fixture.policy.restrictions.pop();

  // Commit through the real API, then lose its response. Hold completion long enough
  // to verify pending controls before proving that readback is required after loss.
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route(`${fixture.origin}${path}`, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    committed.resolve(response.status());
    await release.promise;
    await route.abort("failed");
  });
  await save.click();
  assert.equal(await committed.promise, 200);
  assert.equal(await save.isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Remove example/application" }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Channels", exact: true }).isDisabled(),
    true,
  );
  release.resolve();
  await page
    .getByText(
      "Outcome unknown. The result could not be confirmed. Refresh and inspect the saved state before trying again.",
    )
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isDisabled(), true);
  const persisted = await fixture.request("GET", path);
  assert.deepEqual(persisted.data.repositoryAccess, access("git-full"));
  assert.equal(pathRequests(requests, "PATCH", path).length, 2);
  const reload = page.getByRole("button", { name: "Reload draft", exact: true });
  await reload.click();
  await reload.waitFor({ state: "hidden" });
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Channels", exact: true }).isEnabled(), true);
  assert.equal(pathRequests(requests, "PATCH", path).length, 2);
});

for (const count of [1, 5, 25, 140]) {
  test(`Agent repository discovery adapts to ${count} choices with bounded, keyboard-accessible results`, async (t) => {
    const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
      Array.from({ length: count }, (_, index) => ({
        repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
        repositoryId: String(1100 + index),
        repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
        namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
      })),
    );
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    await repositoryCheckbox(page, "example/repository-001").waitFor();
    await page.getByRole("heading", { name: "Approved repositories" }).waitFor();
    assert.equal(await page.getByText("Reference: repository-001", { exact: true }).count(), 0);
    assert.equal(
      await page.locator('#repository-results input[type="checkbox"]').count(),
      Math.min(count, 6),
    );
    const search = page.getByLabel("Find a repository");
    assert.equal(await search.count(), count > 5 ? 1 : 0);
    if (count > 5) {
      await page.getByRole("button", { name: "Browse all repositories" }).click();
      assert.equal(await page.locator('#repository-results input[type="checkbox"]').count(), 20);
      await page.getByRole("button", { name: "Next repositories" }).click();
      assert.equal(
        await page.locator('#repository-results input[type="checkbox"]').count(),
        Math.min(count - 20, 20),
      );
      await search.fill("repository-025");
      await search.press("Escape");
      assert.equal(await search.inputValue(), "repository-025");
      assert.equal(await page.locator("#repository-results").isVisible(), false);
      await search.press("ArrowDown");
      assert.equal(
        await repositoryCheckbox(page, "example/repository-025").evaluate(
          (node) => node === node.ownerDocument.activeElement,
        ),
        true,
      );
      await page.keyboard.press("Space");
      assert.equal(await search.inputValue(), "repository-025");
      assert.equal(
        await repositoryCheckbox(page, "example/repository-025").evaluate(
          (node) => node === node.ownerDocument.activeElement,
        ),
        true,
      );
      assert.equal(await repositoryCheckbox(page, "example/repository-025").isChecked(), true);
      await page.getByRole("button", { name: "Remove example/repository-025" }).click();
      await search.fill("");
    }
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(
      await page.locator("html").evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
    if (count === 140) {
      await search.fill("repository-140");
      await search.press("Enter");
      await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
      await page.getByLabel("Agent name").fill("Recent repository Agent");
      const saved = page.waitForResponse(
        (response) =>
          response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create Agent", exact: true }).click();
      assert.equal((await saved).status(), 201);
      await page.getByRole("heading", { name: "Create new version" }).waitFor();
      await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespace.id}`);
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await page.getByText(/Recently used/).waitFor();
      assert.equal(
        await page.locator("#repository-results .repository-result-row strong").first().innerText(),
        "example/repository-140",
      );
      await search.fill("repository-139");
      await search.press("Enter");
      await page.reload();
      await page.getByRole("button", { name: "Start without Preset" }).click();
      await page.getByText(/Recently used/).waitFor();
      assert.equal(
        await page.locator("#repository-results .repository-result-row strong").first().innerText(),
        "example/repository-140",
      );
    }
  });
}

test("Repository descriptions arrive without interrupting a selection", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    backends: [...backendFixtures, repositoryBackendFixture],
    repositoryCredentials: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Repository metadata", { ready: true });
  const metadataRequested = Promise.withResolvers();
  const releaseMetadata = Promise.withResolvers();
  t.after(() => releaseMetadata.resolve());
  const description = 'Application <img src=x onerror="alert(1)"> & services';
  // The actual credential service talks to a controlled GitHub TLS endpoint.
  // Delay the provider response to verify that discovery and selection do not block.
  const credentials = await startRegistryCredentialServiceFixture(t, {
    namespaceId: namespace.id,
    backendId: repositoryBackendFixture.id,
    autoOpen: false,
    gateway: { listen: "127.0.0.1:0" },
    repositories: [
      {
        repositoryRef: "application",
        repository: "example/application",
        repositoryId: "789",
        description,
        async beforeMetadataResponse() {
          metadataRequested.resolve();
          await releaseMetadata.promise;
        },
      },
      { repositoryRef: "documentation", repository: "example/documentation", repositoryId: "790" },
      { repositoryRef: "examples", repository: "example/examples", repositoryId: "791" },
      {
        repositoryRef: "infrastructure",
        repository: "example/infrastructure",
        repositoryId: "792",
      },
      { repositoryRef: "libraries", repository: "example/libraries", repositoryId: "793" },
      { repositoryRef: "tools", repository: "example/tools", repositoryId: "794" },
    ],
  });
  const driver = new GitHubRepoDriver(
    {
      id: repositoryBackendFixture.id,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: credentials.config.gateway.controlSocket,
      }),
      drivers: repositoryBackendFixture.drivers,
    },
    credentials.registry,
    { sessionDurationSeconds: 600 },
  );
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("repo", driver.id);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("application");
  const choice = repositoryCheckbox(page, "example/application");
  await choice.check();
  await choice.focus();
  await Promise.race([
    metadataRequested.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("GitHub metadata request was not started")),
        10000,
      );
      timer.unref();
    }),
  ]);
  releaseMetadata.resolve();
  await page.getByText(description, { exact: true }).waitFor();
  assert.equal(await choice.isChecked(), true);
  assert.equal(await choice.evaluate((node) => node === node.ownerDocument.activeElement), true);
  assert.equal(await search.inputValue(), "application");
  const result = page.locator(".repository-result-row").filter({ hasText: "example/application" });
  assert.equal(await result.locator("img").count(), 0);
  // Clearing the filter starts optional metadata lookups for the full page. Let
  // those lookups and their credential revocations finish before fixture teardown.
  const metadataSettled = page.waitForResponse(async (response) => {
    const url = new URL(response.url());
    const refs = url.searchParams.get("descriptionRefs")?.split(",") ?? [];
    if (response.status() !== 200 || refs.length !== 6 || !refs.includes("documentation")) {
      return false;
    }
    return (await response.json()).meta?.descriptionsPending === false;
  });
  await search.fill("");
  assert.equal(
    await page
      .locator(".repository-result-row")
      .filter({ hasText: "example/documentation" })
      .locator(".repository-description")
      .count(),
    0,
  );
  await metadataSettled;
  await waitForCondition(
    () =>
      credentials.repositories.every((entry) =>
        entry.github.tokenState().every((token) => token.revoked),
      ),
    "metadata credentials were not revoked",
    10_000,
  );
  await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
  await page.getByLabel("Agent name").fill("Repository metadata Agent");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  assert.deepEqual((await response.json()).data.repositoryBindings, [
    { repositoryRef: "application", profile: "git-full" },
  ]);
});

test("Repository choices distinguish names, references, and restricted access", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1900",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
    {
      repositoryRef: "handbook-alias",
      repositoryId: "1901",
      repository: "example/handbook",
      namespaces: [{ namespaceId, profiles: ["git-read"] }],
    },
  ]);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const application = page
    .locator(".repository-result-row")
    .filter({ hasText: "example/application" });
  const handbook = page.locator(".repository-result-row").filter({ hasText: "example/handbook" });
  await application.getByRole("checkbox").waitFor();
  assert.equal(await application.getByText(/Reference:/).count(), 0);
  await application.getByText("example/application", { exact: true }).click();
  await page.getByRole("button", { name: "Access for example/application" }).waitFor();
  await handbook.getByText("Reference: handbook-alias", { exact: true }).waitFor();
  await handbook.getByText("Read-only approved", { exact: true }).waitFor();
  const addHandbook = handbook.getByRole("checkbox", { name: /Read-only approved/ });
  await addHandbook.click();
  await page.getByText("Choose approved access", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Access for example/handbook" })
      .getAttribute("aria-expanded"),
    "true",
  );
});

test("Agent repository pagination keeps focus when every result on a page is selected", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    Array.from({ length: 21 }, (_, index) => ({
      repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
      repositoryId: String(1800 + index),
      repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("repository-021");
  await repositoryCheckbox(page, "example/repository-021").click();
  await search.fill("");
  await page.getByRole("button", { name: "Browse all repositories" }).click();
  // Selected choices remain interactive, including when they are alone on a page.
  await page.getByRole("button", { name: "Next repositories" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await repositoryCheckbox(page, "example/repository-021").isChecked(), true);
  assert.equal(await repositoryCheckbox(page, "example/repository-021").isEnabled(), true);
  assert.equal(
    await repositoryCheckbox(page, "example/repository-021").evaluate(
      (node) => node === node.ownerDocument.activeElement,
    ),
    true,
  );
});

test("Agent repository search prioritizes exact names before prefix matches", async (t) => {
  const repositories = [
    "alpha/application-api",
    "beta/my-application",
    "omega/application",
    "zeta/application",
    "tools/cli",
    "docs/handbook",
    "ops/infrastructure",
  ];
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) =>
    repositories.map((repository, index) => ({
      repositoryRef: `catalog-${index}`,
      repositoryId: String(1400 + index),
      repository,
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    })),
  );
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset" }).click();
  const search = page.getByLabel("Find a repository");
  await search.fill("ApPlIcAtIoN");
  // Enter adds the first match, so exact short names must outrank a different owner's prefix.
  assert.deepEqual(
    await page.locator("#repository-results .repository-identity strong").allTextContents(),
    ["omega/application", "zeta/application", "alpha/application-api", "beta/my-application"],
  );
  await search.press("Enter");
  assert.equal(await repositoryCheckbox(page, "omega/application").isChecked(), true);
  assert.equal(
    await page.locator(".repository-card .repository-identity strong").innerText(),
    "omega/application",
  );
  assert.equal(await search.inputValue(), "ApPlIcAtIoN");
  // Repeated Enter skips the already checked choice and selects the next match.
  await search.press("Enter");
  assert.equal(await repositoryCheckbox(page, "omega/application").isChecked(), true);
  assert.equal(await repositoryCheckbox(page, "zeta/application").isChecked(), true);
});

for (const discoveryState of ["later page", "search filter", "dismissed results"]) {
  test(`Agent repository recovery clears ${discoveryState} when the catalog shrinks`, async (t) => {
    const { fixture, namespace, replacePolicy } = await createRepositoryLaunchFixture(
      t,
      (namespaceId) =>
        Array.from({ length: 25 }, (_, index) => ({
          repositoryRef: `repository-${String(index + 1).padStart(3, "0")}`,
          repositoryId: String(1500 + index),
          repository: `example/repository-${String(index + 1).padStart(3, "0")}`,
          namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
        })),
      { reloadablePolicy: true },
    );
    const { page } = await newPage(t, fixture);
    const requests = apiRequests(page, fixture.origin);
    await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
    await page.getByRole("button", { name: "Start without Preset" }).click();
    const search = page.getByLabel("Find a repository");
    await search.fill("repository-025");
    await search.press("Enter");
    if (discoveryState === "later page") {
      await search.fill("");
      await page.getByRole("button", { name: "Browse all repositories" }).click();
      await page.getByRole("button", { name: "Next repositories" }).click();
    } else if (discoveryState === "dismissed results") {
      await search.fill("");
      await search.press("Escape");
    }
    await enterManualModel(page, "repository-fixture-model-key", "gpt-5.1");
    await page.getByLabel("Agent name").fill("Recovered repository selection");

    // Admission sees the new policy after discovery. Recovery must reuse the saved
    // Configuration and expose the smaller catalog without an inaccessible filter.
    replacePolicy([
      {
        repositoryRef: "repository-001",
        repositoryId: "1500",
        repository: "example/repository-001",
        namespaces: [
          { namespaceId: namespace.id, profiles: ["git-read", "git-write", "git-full"] },
        ],
      },
    ]);
    const rejected = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    assert.equal((await rejected).status(), 404);
    await page.getByRole("button", { name: "Reload repository choices" }).click();
    await page.getByText(/Repository choices reloaded/).waitFor();
    assert.equal(await search.count(), 0);
    assert.equal(await page.locator(".repository-card").count(), 0);
    assert.equal(await page.locator("#repository-results").isVisible(), true);
    const add = repositoryCheckbox(page, "example/repository-001");
    assert.equal(await add.count(), 1);
    assert.equal(await add.isEnabled(), true);
    assert.equal(
      await page.getByRole("button", { name: "Create Agent", exact: true }).isDisabled(),
      true,
    );
    await add.click();
    const saved = page.waitForResponse(
      (response) =>
        response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create Agent", exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 201);
    const agent = (await response.json()).data;
    assert.deepEqual(agent.repositoryAccess, {
      defaultProfile: "git-full",
      repositories: [{ repositoryRef: "repository-001" }],
    });
    assert.deepEqual(agent.repositoryBindings, [
      { repositoryRef: "repository-001", profile: "git-full" },
    ]);
    assert.equal(configurationPostRequests(requests, namespace.id).length, 1);
    const attempts = agentPostRequests(requests, namespace.id);
    assert.equal(attempts.length, 2);
    assert.equal(agent.configurationId, attempts[0].body.configurationId);
  });
}

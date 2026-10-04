import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { GitHubRepoDriver } from "../../apps/controller/src/drivers/repo/github/driver.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { nativeRolesGateway } from "../helpers/runtime-roles.mjs";
import { nativeValues, pathRequests } from "./console-agents-browser-helpers.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

export const STARTER_CONTROL_UI = {
  enabled: true,
  allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
};

export async function openCreateSecretDialog(scope, label, options = {}) {
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(options.query ?? "Create a new Secret");
  await scope.getByRole("option", { name: "Create new Secret...", exact: true }).click();
}

export async function createModelCredentialSecret(page, secretValue) {
  // Preset quick-start reads the installed template before rendering its credential fields.
  await page.locator("#create-agent-form").waitFor();
  const picker = page.locator("#provider-credential-secret");
  if ((await picker.count()) === 0 || !(await picker.isVisible())) {
    const legacyCredential = page.getByLabel("API key", { exact: true });
    await legacyCredential.fill(secretValue);
    await legacyCredential.press("Tab");
    return null;
  }
  const created = page.waitForResponse((response) => {
    if (response.request().method() !== "POST" || !response.url().includes("/secrets")) {
      return false;
    }
    return response.request().postDataJSON()?.value === secretValue;
  });
  await picker.fill("Create a new Secret");
  await page.getByRole("option", { name: "Create new Secret...", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create model credential Secret" });
  await dialog.getByLabel("Value", { exact: true }).fill(secretValue);
  await dialog.getByRole("button", { name: "Create Secret", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  return (await (await created).json()).data;
}

export async function enterManualModel(page, apiKey, modelId = "gpt-4.1") {
  const secret = await createModelCredentialSecret(page, apiKey);
  const model = page.getByLabel("Model ID", { exact: true });
  if (!(await model.isVisible())) {
    await page.getByRole("button", { name: "Enter model ID manually", exact: true }).click();
  }
  await model.fill(modelId);
  await model.press("Tab");
  return secret;
}

export async function openAdvancedSettings(page) {
  const summary = page.locator(".launch-advanced:not([open]) > summary");
  if (await summary.count()) {
    await summary.click();
  }
}

// Create Agent stays disabled while the form reads Installation capabilities and repository
// choices. Waits until the live form has both; a retained preview of an earlier form is inert
// and shows that form's settled reads. A capability retry keeps the failure text until it ends.
export async function waitForCreateFormReads(page) {
  await page.waitForFunction(() => {
    const form = globalThis.document.querySelector("#create-agent-form");
    return (
      form !== null &&
      form.closest("[inert]") === null &&
      form.querySelector('.repository-options[aria-busy="false"]') !== null &&
      ![...form.querySelectorAll('[role="status"]')].some(
        (node) => node.textContent === "Checking installation capabilities…",
      )
    );
  });
}

export async function expectNativeAdminHidden(page) {
  assert.equal(
    await page.getByRole("heading", { name: "OpenClaw", exact: true }).isVisible(),
    false,
  );
  assert.equal(await page.getByText("Open OpenClaw", { exact: true }).isVisible(), false);
}

export function assertRevisionUrl(page, revisionId) {
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("revision"), revisionId);
}

export function configurationPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/configurations`);
}

export function agentProvisionPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/agents/provision`);
}

export async function routeInstallationProvisioning(page, fixture, executionModes = ["dedicated"]) {
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

export async function routeInstallationWithoutProvisioning(page, fixture, capabilities) {
  await page.route(`${fixture.origin}/installation`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "ins_00000000-0000-4000-8000-000000000001",
          name: "Console test installation",
          createdAt: new Date().toISOString(),
          ...(capabilities === undefined ? {} : { capabilities }),
        },
        meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
      }),
    });
  });
}

export function agentPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/agents`);
}

export function agentDeleteRequests(requests, namespaceId, agentId) {
  return pathRequests(
    requests,
    "DELETE",
    `/namespaces/${namespaceId}/agents/${encodeURIComponent(agentId)}`,
  );
}

export function agentStopRequests(requests, namespaceId, agentId) {
  return pathRequests(
    requests,
    "POST",
    `/namespaces/${namespaceId}/agents/${encodeURIComponent(agentId)}/stop`,
  );
}

export function configurationPatchRequests(requests, namespaceId, configurationId) {
  return pathRequests(
    requests,
    "PATCH",
    `/namespaces/${namespaceId}/configurations/${encodeURIComponent(configurationId)}`,
  );
}

export async function optionValues(locator) {
  return locator.evaluate((node) =>
    Array.from(node.options).map((option) => ({ value: option.value, text: option.textContent })),
  );
}

export function nativeAdminComputeDriver(endpoint) {
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

export const repositoryBackendFixture = Object.freeze({
  id: "console-repositories",
  type: "github",
  configuration: Object.freeze({ registryPath: "/unused/console/repositories.json" }),
  drivers: Object.freeze({ repo: "console-repository-driver" }),
});

export async function createRepositoryLaunchFixture(
  t,
  buildRepositories,
  { reloadablePolicy = false } = {},
) {
  const fixture = await createConsoleAppFixture(t, {
    defaultPresets: [defaultCodexPreset],
    backends: [...backendFixtures, repositoryBackendFixture],
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
  const backend = repositoryBackendFixture;
  const registry = validateGitHubRepositoryRegistry(
    {
      version: 1,
      backendId: backend.id,
      providerInstanceId: "console-repository-provider",
      appId: "123",
      githubInstallationId: "456",
      maximumDurationSeconds: 3600,
      repositories,
    },
    backend.id,
  );
  return new GitHubRepoDriver(
    {
      id: backend.id,
      client: new UnixRepositoryCredentialControlClient({
        controlSocket: "/unused/console/repository-control.sock",
      }),
      drivers: backend.drivers,
    },
    registry,
    { sessionDurationSeconds: 600 },
  );
}

export function nativeAdminValues(marker, origin) {
  return nativeRolesGateway(nativeValues(marker), origin);
}

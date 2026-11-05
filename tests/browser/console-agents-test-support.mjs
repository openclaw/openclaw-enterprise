import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { withNativeAdminGateway } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { nativeValues, pathRequests } from "./console-agents-browser-helpers.ts";

/** @import { GitHubRepositoryRegistration } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts" */

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);

export const STARTER_CONTROL_UI = {
  enabled: true,
  allowedOrigins: ["http://127.0.0.1:18789", "http://localhost:18789"],
};

// Let the real operation finish, then change only the returned Agent ID. This tests a
// plausible success that cannot settle the selected Agent's Stop or Delete request.
export async function replyWithDifferentAgentId(route, agentId, expectedStatus) {
  const response = await route.fetch();
  assert.equal(response.status(), expectedStatus);
  const { data, meta } = await response.json();
  assert.equal(data.id, agentId);
  await route.fulfill({ response, json: { data: { ...data, id: `agt_${randomUUID()}` }, meta } });
}

export async function expectNativeAdminHidden(page) {
  assert.equal(await page.locator(".native-admin-access").isVisible(), false);
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );
}

// Unavailable native admin access keeps an "Open Agent UI" button in the Tab order, marked
// aria-disabled and described by its reason, so a keyboard user reaches why it cannot open
// (finding 2714). A natively disabled button takes no focus.
export async function expectNativeAdminUnavailable(page, reason) {
  const control = page.getByRole("button", { name: "Open Agent UI", exact: true });
  await control.focus();
  assert.deepEqual(
    await control.evaluate((node) => {
      const document = node.ownerDocument;
      const description = (node.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      return {
        focused: document.activeElement === node,
        ariaDisabled: node.getAttribute("aria-disabled"),
        description,
      };
    }),
    { focused: true, ariaDisabled: "true", description: reason },
  );
  assert.equal(
    await page.getByRole("link", { name: "Open Agent UI", exact: true }).isVisible(),
    false,
  );
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

// A Sandbox Driver that can provision dedicated OpenClaw. Without one, the Installation does not
// report native worker support and the Console withholds Dedicated OpenClaw (finding 1608).
export function nativeSandboxDriver(facets = ["networking", "filesystem", "process"]) {
  return {
    id: "console-native-sandbox",
    capability: "sandbox",
    implementation: "console-native",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets,
    async provisionHarness() {
      assert.fail("provisioning admission must leave effects to the worker");
    },
    async cleanup() {},
  };
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

/**
 * Another create takes `name` after Create Agent's preflight found it free: the form's next
 * Agent create first creates that Agent, then reaches the real API, which refuses the name with
 * 409. The preflight refuses a name that is already taken (finding 2420), so only this race
 * reaches a refusal after the form saved its Secret or Configuration.
 */
export async function raceAgentName(page, fixture, namespaceId, name) {
  const url = `${fixture.origin}/namespaces/${namespaceId}/agents`;
  const handler = async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await page.unroute(url, handler);
    await fixture.createAgent(namespaceId, name);
    await route.continue();
  };
  await page.route(url, handler);
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

/**
 * @param {import("node:test").TestContext} t
 * @param {(namespaceId: string) => readonly GitHubRepositoryRegistration[]} buildRepositories
 * @param {{ reloadablePolicy?: boolean, includeInstallationAccess?: boolean }} [options]
 */
export async function createRepositoryLaunchFixture(
  t,
  buildRepositories,
  { reloadablePolicy = false, includeInstallationAccess = false } = {},
) {
  const fixture = await createConsoleAppFixture(t, {
    defaultPresets: [defaultCodexPreset],
    backends: [...backendFixtures, repositoryBackendFixture],
    repositoryCredentials: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Repository launch", { ready: true });
  const installationNamespaceId = includeInstallationAccess ? namespace.id : undefined;
  let currentPolicy = repositoryPolicyDriver(
    buildRepositories(namespace.id),
    installationNamespaceId,
  );
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
    /** @param {readonly GitHubRepositoryRegistration[]} repositories */
    replacePolicy(repositories) {
      assert.equal(reloadablePolicy, true);
      currentPolicy = repositoryPolicyDriver(repositories, installationNamespaceId);
    },
  };
}

function repositoryPolicyDriver(repositories, installationNamespaceId) {
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
      ...(installationNamespaceId === undefined
        ? {}
        : {
            installationAccess: {
              repositoryRef: "test-installation",
              namespaces: [{ namespaceId: installationNamespaceId, accessMode: "installation" }],
            },
          }),
    },
    backend.id,
  );
  return new GitHubRepositoryPolicy(
    {
      driverId: backend.drivers.repo,
      backendId: backend.id,
    },
    registry,
    { sessionDurationSeconds: 600 },
  );
}

export function nativeAdminValues(marker, origin) {
  return withNativeAdminGateway(nativeValues(marker), origin);
}

// Without a caller-permission summary the console keeps controls enabled, so the API's own
// denial is what the reader sees.
export async function withholdPermissionSummary(page, fixture, namespaceId, agentId) {
  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/agents/${agentId}/permissions`,
    async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "DEPENDENCY_UNAVAILABLE", message: "Unavailable." },
          meta: { requestId: "req_test_permissions" },
        }),
      });
    },
  );
}

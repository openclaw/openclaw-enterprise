import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { GitHubRepositoryPolicy } from "../../apps/controller/src/drivers/repo/github/policy.ts";
import { validateGitHubRepositoryRegistry } from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createConsoleAppFixture, backendFixtures } from "../helpers/console-app.mjs";
import { withNativeAdminGateway } from "../helpers/harness-configuration.mjs";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";
import {
  nativeValues,
  pathRequests,
  settledFetches,
  waitForIdleFetches,
} from "./console-agents-browser-helpers.mjs";

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

// Selects Create Agent and returns the API's answer to the form's POST to `path` in the
// Namespace: "agents" (an embedded Agent) by default, or "agents/provision" or
// "agents/validate". With `status`, that answer must have it.
/**
 * @param {import("playwright").Page} page
 * @param {{ origin: string }} fixture
 * @param {string} namespaceId
 * @param {{ path?: string, status?: number }} [options]
 */
export async function submitCreateAgent(
  page,
  fixture,
  namespaceId,
  { path = "agents", status } = {},
) {
  const url = `${fixture.origin}/namespaces/${namespaceId}/${path}`;
  const answer = page.waitForResponse(
    (response) => response.url() === url && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await answer;
  if (status !== undefined) {
    assert.equal(response.status(), status, `POST ${path}: ${await response.text()}`);
  }
  return response;
}

// Selects Create Agent, which must create the Agent (201), and returns the created Agent.
export async function createAgentThroughForm(page, fixture, namespaceId) {
  const response = await submitCreateAgent(page, fixture, namespaceId, { status: 201 });
  return (await response.json()).data;
}

export async function openAdvancedSettings(page) {
  const summary = page.locator(".launch-advanced:not([open]) > summary");
  if (await summary.count()) {
    await summary.click();
  }
}

// Create Agent's access slot above the form. A refused Installation read's answer is one status
// block there, never the grey hint under the fields (finding 2092): its text appears once on the
// page. `retry` says whether the block offers Retry permission check as its action.
export async function expectCreateAccess(page, { tone, body, retry = false }) {
  const access = page.locator("#create-agent-access");
  await access.locator(".status-body").getByText(body, { exact: true }).waitFor();
  assert.deepEqual(
    await access.evaluate((node) => ({
      role: node.getAttribute("role"),
      tone: node.getAttribute("data-tone"),
      label: node.querySelector(".status-label")?.textContent,
      body: [...node.querySelectorAll(".status-body")].map((line) => line.textContent),
      next: node.nextElementSibling?.id,
    })),
    {
      role: tone === "info" ? "status" : "alert",
      tone,
      label: "Your access",
      body: [body],
      next: "create-agent-form",
    },
  );
  assert.equal(await page.getByText(body, { exact: true }).count(), 1);
  assert.equal(
    await access.getByRole("button", { name: "Retry permission check", exact: true }).isVisible(),
    retry,
  );
  // The capability retry under the fields never stands in for the permission retry.
  assert.equal(
    await page.getByRole("button", { name: "Retry capability check", exact: true }).count(),
    0,
  );
  return access;
}

// Create Agent with a permission answer that refuses Agent create: the refusal takes the form's
// place, with no start choices and no access block, whether the page loaded with that answer or a
// permission retry brought it (findings 1521, 2908). Returns the refusal.
export async function expectCreateRefused(page, body) {
  const refusal = page.locator(".state-panel").filter({
    has: page.getByRole("heading", { name: "Creating Agents is not available", exact: true }),
  });
  await refusal.waitFor();
  assert.deepEqual(
    await refusal.evaluate((node) => ({
      status: [...node.querySelectorAll('[role="status"]')].map((line) => line.textContent),
      form: node.ownerDocument.querySelectorAll("#create-agent-form").length,
      access: node.ownerDocument.querySelectorAll("#create-agent-access").length,
    })),
    { status: [body], form: 0, access: 0 },
  );
  assert.equal(await page.getByRole("button", { name: /^Start (with|without) / }).count(), 0);
  return refusal;
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

// A failed provisioning job's reason is the form's one error line; the status line under it
// does not repeat that provisioning failed (finding 2423).
export async function waitForProvisioningFailure(page) {
  await page.locator("#create-agent-form ~ p[role=alert]").filter({ hasText: /\S/ }).waitFor();
  assert.equal(await page.getByText("Provisioning failed.", { exact: true }).count(), 0);
  // The error line is as wide as the form above it, not the page.
  const [form, error] = await page.evaluate(() =>
    ["#create-agent-form", "#create-agent-form ~ p[role=alert]"].map(
      (selector) => globalThis.document.querySelector(selector).getBoundingClientRect().width,
    ),
  );
  assert.ok(error <= form + 0.5, `error line ${error}px, form ${form}px`);
}

// Create Agent rereads an accepted provisioning job once a second (waitForProvisioning in
// create.mts). This runs `submit` (the click that sends or retries the job) with the page clock
// paused, then runs that clock one second at a time, each step only once no fetch is in flight,
// until the page has read `jobPath` `reads` times in all. The clock then runs in real time again.
// So the test skips each one-second wait, and the page still handles each answer, and the
// optional deployment read between polls, before the next poll. Call trackSettledFetches before
// the page loads.
const pollClocks = new WeakSet();

export async function runProvisioningPolls(page, submit, jobPath, reads) {
  if (!pollClocks.has(page)) {
    await page.clock.install();
    pollClocks.add(page);
  }
  // The clock runs between calls, so pause it a little ahead of the page's time. On a loaded host
  // it can pass that time before pauseAt arrives, which pauseAt refuses: read the time again.
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 100);
      break;
    } catch (error) {
      if (attempt === 5 || !String(error).includes("Cannot fast-forward to the past")) {
        throw error;
      }
    }
  }
  await submit();
  for (let polls = 0; ; polls += 1) {
    await waitForIdleFetches(page);
    if ((await settledFetches(page, jobPath)) >= reads) {
      break;
    }
    assert.ok(polls < 10, `the page read ${jobPath} ${reads} times`);
    await page.clock.runFor(1_000);
  }
  await page.clock.resume();
}

const provisioningMeta = { requestId: "req_00000000-0000-4000-8000-000000000001" };

// One provisioning job, `workId`, in `namespaceId`. `job(status, extra)` is one status read of
// it; `failed(extra)` is the read that ends it after its retries (a dependency outage).
/**
 * @param {string} namespaceId
 * @param {string} workId
 */
export function provisioningJob(namespaceId, workId) {
  const updatedAt = new Date().toISOString();
  const url = `/namespaces/${namespaceId}/agents/provision/${workId}`;
  /** @type {(status: string, extra?: object) => Record<string, unknown>} */
  const job = (status, extra = {}) => ({
    workId,
    status,
    phase: "configuration",
    attemptCount: 1,
    updatedAt,
    url,
    ...extra,
  });
  /** @type {(extra?: object) => Record<string, unknown>} */
  const failed = (extra = {}) =>
    job("failed", {
      ...extra,
      error: { code: "PROVISIONING_DEPENDENCY_UNAVAILABLE", message: PROVISIONING_NOT_COMPLETED },
    });
  return { namespaceId, workId, url, updatedAt, job, failed };
}

// Accepts each Create Agent provisioning request in the job's Namespace as that one queued job,
// as the API does, and answers each status read of the job with the next of `reads` (the last
// one repeats), or with `reads(index)` when it is a function. With `reads` null the caller
// routes the job's reads itself. Returns live counts of the requests and reads.
/**
 * @param {import("playwright").Page} page
 * @param {ReturnType<typeof provisioningJob>} work
 * @param {readonly object[] | ((index: number) => object) | null} reads
 */
export async function routeProvisioningJob(page, work, reads) {
  /** @type {{ submitted: number, reads: number, requestId: string | undefined }} */
  const state = { submitted: 0, reads: 0, requestId: undefined };
  await page.route(`**/namespaces/${work.namespaceId}/agents/provision`, (route) => {
    state.submitted += 1;
    state.requestId = route.request().postDataJSON().requestId;
    const accepted = work.job("queued", { phase: "accepted", attemptCount: 0 });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        data: { provisioning: { ...accepted, requestId: state.requestId } },
        meta: provisioningMeta,
      }),
    });
  });
  if (reads !== null) {
    await page.route(`**${work.url}`, (route) => {
      const index = state.reads++;
      const read =
        typeof reads === "function" ? reads(index) : reads[Math.min(index, reads.length - 1)];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ...read, requestId: state.requestId },
          meta: provisioningMeta,
        }),
      });
    });
  }
  return state;
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

/**
 * Asserts that the Agent name field shows the API's duplicate-name refusal under it and holds
 * focus (finding 2420).
 */
export async function assertAgentNameTaken(page) {
  const name = page.getByLabel("Agent name", { exact: true });
  await page.waitForFunction(() => {
    const input = globalThis.document.querySelector("#agent-name");
    return (
      input?.getAttribute("aria-invalid") === "true" && globalThis.document.activeElement === input
    );
  });
  const describedBy = (await name.getAttribute("aria-describedby")) ?? "";
  const errors = await Promise.all(
    describedBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => page.locator(`[id="${id}"]`).textContent()),
  );
  assert.ok(
    errors.includes("Another Agent in this Namespace has this name."),
    `expected the duplicate-name error under the field, got ${JSON.stringify(errors)}`,
  );
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

/** @param {import("playwright").Locator} locator */
export async function optionValues(locator) {
  return locator.evaluate((element) =>
    Array.from(/** @type {HTMLSelectElement} */ (element).options).map((option) => ({
      value: option.value,
      text: option.textContent,
    })),
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
 * @param {{ reloadablePolicy?: boolean }} [options]
 */
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
    /** @param {readonly GitHubRepositoryRegistration[]} repositories */
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
  return new GitHubRepositoryPolicy(
    {
      driverId: backend.drivers.repo,
      backendId: backend.id,
    },
    registry,
    { sessionDurationSeconds: 600 },
  );
}

// A button the reader can press: an unavailable one is natively disabled, or aria-disabled
// while a visible reason says why (finding 2878).
export const LIVE_BUTTON = 'button:not([disabled], [aria-disabled="true"])';

// Back, in-app navigation and reloads can first restore an inert copy of the old view with its
// controls disabled, until revalidation re-enables it or replaces it with a rebuilt view. Only a
// live control shows the current view, including any draft it restored.
export async function waitForLiveControls(page, ids) {
  await page.waitForFunction(
    (controlIds) =>
      controlIds.every((id) => {
        const control = globalThis.document.getElementById(id);
        return (
          control &&
          !control.disabled &&
          control.getAttribute("aria-disabled") !== "true" &&
          !control.closest("[inert]")
        );
      }),
    ids,
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

// Marks the rendered Agent page and records any loading state it shows again, so a test can
// tell an in-place update from a page reload.
export async function watchForReload(page) {
  await page.evaluate(() => {
    const doc = globalThis.document;
    doc.querySelector(".agent-current-summary").dataset.saveMarker = "kept";
    globalThis.reloadedText = [];
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (/Loading (version details|configuration)/.test(node.textContent ?? "")) {
            globalThis.reloadedText.push(node.textContent);
          }
        }
      }
    }).observe(doc.body, { childList: true, subtree: true });
  });
  return () =>
    page.evaluate(() => ({
      marker: globalThis.document.querySelector(".agent-current-summary")?.dataset.saveMarker,
      reloadedText: globalThis.reloadedText,
    }));
}

export const focusedText = (page) =>
  page.evaluate(() => globalThis.document.activeElement?.textContent ?? null);

// The saved status a focused control is described by, so a screen reader names it.
export const focusedDescription = (page) =>
  page.evaluate(() => {
    const id = globalThis.document.activeElement?.getAttribute("aria-describedby");
    return id ? globalThis.document.getElementById(id)?.textContent : null;
  });

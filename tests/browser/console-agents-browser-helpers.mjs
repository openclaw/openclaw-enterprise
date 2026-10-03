import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.mjs";
import { keepRequestInterceptionEnabled } from "../helpers/browser-request-interception.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

export function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        // Some request bodies are not JSON.
      }
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}`, body });
    }
  });
  return requests;
}

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

export async function newPage(t, fixture, options = {}) {
  const artifacts = await artifactDirectory(t);
  const browser = await launchBrowser(options);
  let context;
  let diagnostics;
  fixture.registerCleanupBeforeAppClose(async () => {
    let cleanupError;
    try {
      await diagnostics?.capture();
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
  diagnostics = await watchBrowserContext(t, context);
  await keepRequestInterceptionEnabled(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return { page, artifacts };
}

export async function login(
  page,
  fixture,
  path = "/console/agents",
  credentials = fixture.credentials,
) {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|backends|namespaces|settings)/);
}

export async function routeRuntimeCredentials(page, fixture, namespaceId, agentId, data) {
  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/agents/${agentId}/runtime-credentials`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data, meta: { requestId: "req_test_runtime_credentials" } }),
      });
    },
  );
}

// Browser storage the console wrote, except the tab-scoped Installation-access probe answer
// (session owner key, admin flag and observability URL), which never holds drafts or
// credentials.
export async function consoleStorage(page) {
  return page.evaluate(() => {
    const session = { ...sessionStorage };
    delete session["occ.console.installationAccess"];
    return { local: { ...localStorage }, session };
  });
}

export function nonAuthWriteRequests(requests) {
  return requests.filter(
    (request) => request.method !== "GET" && !request.path.startsWith("/api/auth/sign-"),
  );
}

export function secretOptionLabel(secret) {
  return secret.name;
}

export async function selectSecret(scope, label, secret, options = {}) {
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(options.query ?? secret.name);
  await scope.getByRole("option", { name: secretOptionLabel(secret), exact: true }).click();
}

export async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

export async function revealNativeConfiguration(page, label) {
  const summary = page.getByText(label, { exact: true });
  if ((await summary.locator("..").getAttribute("open")) === null) {
    await summary.click();
  }
}

export function detailUrl(fixture, namespaceId, agentId, revision, tab) {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  url.searchParams.set("revision", revision);
  url.searchParams.set("tab", tab);
  return url;
}

export function pathRequests(requests, method, path) {
  return requests.filter((request) => request.method === method && request.path === path);
}

export function secretPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/secrets`);
}

export function accessBindingPostRequests(requests, namespaceId) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/iam/access-bindings`);
}

// A bound Secret picker reads "Bound Secret" until its Namespace Secret list loads, and every
// render (page load, save, reload) starts that load again. Read such a picker only through this.
export async function waitForInputValue(locator, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await locator.inputValue();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await locator.inputValue();
  }
  assert.equal(
    value,
    expected,
    `input value was ${JSON.stringify(value)}, not ${JSON.stringify(expected)}, after ${timeoutMs} ms`,
  );
}

export async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

export function nativeValues(marker, options = {}) {
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

// Exercise the visible chip control rather than writing its hidden serialized value.
export async function setSlackSelection(input, value) {
  const field = input.locator("..").locator("..");
  const remove = field.locator(".slack-directory-chip button");
  while (await remove.count()) {
    await remove.first().click();
  }
  await input.fill(value);
  if (value) {
    await input.press("Enter");
  }
  if ((await input.getAttribute("aria-expanded")) === "true") {
    await input.press("Escape");
  }
}

export async function slackSelectionValue(input) {
  return input
    .locator("..")
    .locator("..")
    .locator(".slack-directory-chip")
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("title")).join(", "));
}

export function repositoryCheckbox(page, name) {
  return page
    .locator("#repository-results .repository-result-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByRole("checkbox");
}

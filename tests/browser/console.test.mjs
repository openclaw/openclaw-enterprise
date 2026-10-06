import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  describePendingBrowserRequests,
  noteBrowserEvent,
} from "../helpers/browser-failure-diagnostics.mjs";
import { createConsoleAppFixture as createBaseConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  apiRequests,
  expectNoText,
  login,
  newPage,
  settledFetches,
  trackSettledFetches,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-agents-browser-helpers.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });

const routeHoldTimeoutMs = 30_000;
const mobile = {
  context: { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
};

async function openShellMenu(page) {
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
}

async function chooseNamespace(page, name, options) {
  await page
    .getByRole("combobox", { name: "Namespace", exact: true })
    .selectOption({ label: name }, options);
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForRoutePhase(promise, description, release, signal, describeState) {
  let timeout;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    function fail(reason) {
      // Read the hold's state before release() changes it.
      const state = describeState?.();
      release();
      const error = new Error(
        `${description} did not finish within ${routeHoldTimeoutMs}ms${state ? ` (${state})` : ""}`,
      );
      if (reason !== undefined) {
        error.cause = reason;
      }
      reject(error);
    }

    if (signal?.aborted) {
      fail(signal.reason);
      return;
    }

    timeout = setTimeout(() => fail(), routeHoldTimeoutMs);
    onAbort = () => fail(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeout);
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function holdRoute(t, page, pattern, continueRoute, { fetchBeforeHold = true } = {}) {
  const releaseGate = deferred();
  const captured = deferred();
  const completed = deferred();
  let released = false;
  let releaseWatchdog;
  let intercepted = 0;

  function release() {
    if (released) {
      return;
    }
    released = true;
    noteBrowserEvent(page, `held route ${pattern} released`);
    clearTimeout(releaseWatchdog);
    releaseGate.resolve();
  }

  function describeState() {
    try {
      return `intercepted ${intercepted}, released ${released}, page ${page.url()}, pending requests: ${describePendingBrowserRequests(page)}`;
    } catch (error) {
      return `state unavailable: ${error.message}`;
    }
  }

  t.signal?.addEventListener("abort", release, { once: true });
  await page.route(pattern, async (route) => {
    intercepted += 1;
    let response;
    if (fetchBeforeHold) {
      try {
        response = await route.fetch();
        noteBrowserEvent(page, `held route ${pattern} upstream status ${response.status()}`);
      } catch (error) {
        response = undefined;
        noteBrowserEvent(page, `held route ${pattern} upstream fetch failed: ${error.message}`);
      }
    }
    captured.resolve();
    if (!released && releaseWatchdog === undefined) {
      releaseWatchdog = setTimeout(release, routeHoldTimeoutMs);
      releaseWatchdog.unref?.();
    }
    await releaseGate.promise;
    try {
      await continueRoute(route, response);
      noteBrowserEvent(page, `held route ${pattern} continued`);
    } catch (error) {
      /* The page may already have aborted the obsolete read. */
      noteBrowserEvent(page, `held route ${pattern} continue failed: ${error.message}`);
    } finally {
      completed.resolve();
    }
  });

  return {
    release,
    waitForRelease: () =>
      waitForRoutePhase(
        captured.promise,
        `route ${pattern} capture`,
        release,
        t.signal,
        describeState,
      ),
    waitForCompletion: () =>
      waitForRoutePhase(
        completed.promise,
        `route ${pattern} completion`,
        release,
        t.signal,
        describeState,
      ),
  };
}

test("console debug flag is opt-in and follows Namespace navigation without leaking prior Agent reads", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Debug Alpha", { ready: true });
  const beta = await fixture.createNamespace("Debug Beta", { ready: true });
  await fixture.createAgent(alpha.id, "Alpha runtime");
  await fixture.createAgent(beta.id, "Beta runtime");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${alpha.id}&debug=false`);
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  assert.equal(await page.locator(".runtime-debug").count(), 0);
  assert.ok(!requests.some(({ path }) => path.endsWith("/runtime-images")));

  await page.goto(`${fixture.origin}/console/agents?namespace=${alpha.id}&debug=true`);
  const panel = page.getByRole("region", { name: "Build and runtime images" });
  await panel.getByText("No deployed runtime images observed.").waitFor({ state: "attached" });
  assert.match(await panel.textContent(), /OCE commit.*Unavailable/s);
  await chooseNamespace(page, "Debug Beta");
  await panel.getByText("Beta runtime", { exact: true }).waitFor();
  assert.doesNotMatch(await panel.textContent(), /Alpha runtime/);
  assert.equal(new URL(page.url()).searchParams.get("debug"), "true");
  await panel.getByText("No deployed runtime images observed.").waitFor({ state: "attached" });
  const runtimeRow = await panel.locator(".runtime-debug-images details").elementHandle();
  await runtimeRow.evaluate((node) => {
    node.open = true;
  });
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("debug"), "true");
  await page.goBack();
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(
    await runtimeRow.evaluate((node) => node.isConnected && node.open),
    true,
    "Returning preserves expanded runtime image diagnostics",
  );
  await page.goto(`${fixture.origin}/console/agents?namespace=${beta.id}`);
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  assert.equal(await page.locator(".runtime-debug").count(), 0);
});

test("console browser flow keeps Namespace URL state across global pages and logout", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  await fixture.createAgent(alpha.id, "Alpha <script>alert(1)</script>");
  await fixture.createAgent(beta.id, "Beta agent");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  page.on("dialog", (dialog) => assert.fail(`Unexpected browser dialog: ${dialog.message()}`));

  await login(page, fixture, `/console/?namespace=${beta.id}`);
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page.getByText("Beta agent").waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).isVisible(),
    true,
  );
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  // Resource content must remain text; the shared shell includes the OCE mascot.
  assert.equal(await page.locator(".content img").count(), 0);
  assert.equal(await page.locator(".sidebar .brand").textContent(), "OCE");
  assert.equal(await page.locator(".occ-version").count(), 0);
  assert.equal(await page.locator(".runtime-debug").count(), 0);

  // The Namespace collection is Installation-wide and has no selectable scope.
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Namespace", exact: true }).count(), 0);
  assert.equal(new URL(page.url()).searchParams.get("namespace"), beta.id);

  assert.equal(await page.getByRole("link", { name: "Backends", exact: true }).count(), 0);
  await page.goto(`${fixture.origin}/console/backends?namespace=${beta.id}`);
  await page.getByRole("heading", { name: "Backends" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/backends\\?namespace=${beta.id}$`));
  await page.getByText("openai-primary").waitFor();
  await expectNoText(page, /apiKeyPath|workspaceId|credentialTtlSeconds/);

  // Changing scope on an Installation-wide page preserves the page and browser history.
  await chooseNamespace(page, "Alpha");
  await page.getByText("openai-primary").waitFor();
  assert.match(page.url(), new RegExp(`/console/backends\\?namespace=${alpha.id}$`));
  await page.goBack();
  await page.getByText("openai-primary").waitFor();
  // Retained text appears before the selector has fresh session and Namespace admission.
  await page.locator("#namespace-selector:not(:disabled)").waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    beta.id,
  );

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/settings\\?namespace=${beta.id}$`));
  await page.reload();
  await page.getByText(fixture.credentials.email.toLowerCase()).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Backends" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/backends\\?namespace=${beta.id}$`));

  await page.getByRole("link", { name: "Agents" }).click();
  await chooseNamespace(page, "Alpha");
  await page.getByText("Alpha <script>alert(1)</script>").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${alpha.id}$`));

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.waitForURL(/\/console\/login$/);
  await page.getByRole("button", { name: "Login" }).waitFor();
  await expectNoText(page, /Alpha|Beta|openai-primary/);
  assert.deepEqual(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    { local: {}, session: {} },
  );

  const writeRequests = requests.filter(
    (request) => request.method !== "GET" && !request.path.startsWith("/api/auth/sign-"),
  );
  assert.deepEqual(writeRequests, []);
  assert.equal(
    requests.some((request) => /\/deploy|\/agents\/agt_/.test(request.path)),
    false,
  );
});

test("console shows the external observability link only to Installation administrators", async (t) => {
  const url = "https://metrics.example.test/d/operations";
  const fixture = await createConsoleAppFixture(t, { observabilityUrl: url });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Observability access", { ready: true });
  // The second account can open the console but has no Installation grant.
  const limited = await fixture.createAccountWithPolicy("observability-limited", (principal) => {
    fixture.policy.roles.push({
      id: "role-browser-observability-reader",
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "binding-browser-observability-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-browser-observability-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  let probes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/observability") {
      probes += 1;
    }
  });
  await login(page, fixture, "/console/");
  const link = page.getByRole("link", { name: "Observability" });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), url);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await link.locator("svg.external-link-icon[aria-hidden='true']").count(), 1);
  // Navigation reuses the settled read and keeps the link.
  await page.getByRole("link", { name: "Namespaces" }).click();
  await page.getByRole("list", { name: "Namespaces" }).getByText("Observability access").waitFor();
  await link.waitFor();
  assert.equal(probes, 1);
  await page.reload();
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), url);
  assert.equal(probes, 1);

  // An expired session leaves this tab's settled answer behind; logout clears it.
  const adminAnswer = await page.evaluate(() =>
    globalThis.sessionStorage.getItem("occ.console.installationAccess"),
  );
  assert.ok(adminAnswer);
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Logout" }).click();
  // Navigating away before the sign-out request is answered aborts it, and the old session
  // then opens the Console again instead of the login form.
  await page.waitForURL(/\/console\/login$/);
  // Restore the administrator's answer as an expiry would leave it: it belongs to another
  // session owner, so the next sign-in must probe (a reused answer sends no probe below).
  await page.evaluate((answer) => {
    globalThis.sessionStorage.setItem("occ.console.installationAccess", answer);
  }, adminAnswer);
  // The shell renders before the probe is answered, so wait for the denial itself.
  const limitedProbe = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/observability",
  );
  await login(page, fixture, "/console/", limited.credentials);
  assert.equal((await limitedProbe).status(), 403);
  // The limited user reads no Agents. The empty list renders only after the page applied the
  // denied probe, so the link checks below see the settled shell, not the loading one.
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Observability" }).count(), 0);
  // A denied read is audited, so navigation must not repeat it.
  await page.getByRole("link", { name: "Namespaces" }).click();
  await page.getByRole("list", { name: "Namespaces" }).getByText("Observability access").waitFor();
  const namespacesRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/namespaces",
  );
  await page.getByRole("link", { name: "Agents" }).click();
  await namespacesRead;
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Observability" }).count(), 0);
  assert.equal(probes, 2);
  // A reload in the same tab reuses the settled answer for this session owner.
  await page.reload();
  await page.getByRole("heading", { name: "No Agents yet", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Observability" }).count(), 0);
  assert.equal(probes, 2);
});

test("a navigation while the Installation-access probe is answered does not ask again", async (t) => {
  // The API audits every denied probe, so the Console must not repeat one it already sent.
  let answered = 0;
  const fixture = await createConsoleAppFixture(t, {
    observabilityUrl: "https://metrics.example.test/d/operations",
    async onSend(request, _reply, payload) {
      if (request.url === "/observability") {
        answered += 1;
      }
      return payload;
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Probe access", { ready: true });
  const limited = await fixture.createAccountWithPolicy("probe-limited", (principal) => {
    fixture.policy.roles.push({
      id: "role-browser-probe-reader",
      namespaceId: namespace.id,
      permissions: [{ action: "read", resourceKind: "namespace" }],
    });
    fixture.policy.bindings.push({
      id: "binding-browser-probe-reader",
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: "role-browser-probe-reader",
    });
  });
  const { page } = await newPage(t, fixture);
  // The API has answered (and audited) the probe; its response reaches the page only later.
  const probe = await holdRoute(t, page, "**/observability", (route, response) =>
    route.fulfill({ response }),
  );
  await login(page, fixture, "/console/agents", limited.credentials);
  await probe.waitForRelease();
  await page.getByRole("link", { name: "Namespaces" }).click();
  await page.waitForURL(/\/console\/namespaces/);
  probe.release();
  await page.getByRole("list", { name: "Namespaces" }).getByText("Probe access").waitFor();
  assert.equal(await page.getByRole("link", { name: "Observability" }).count(), 0);
  assert.equal(answered, 1);
});

test("console ignores stale collection successes and errors while switching Namespaces", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const slow = await fixture.createNamespace("Slow", { ready: true });
  const current = await fixture.createNamespace("Current", { ready: true });
  await fixture.createAgent(slow.id, "Slow agent");
  await fixture.createAgent(current.id, "Current agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const slowAgents = `**/namespaces/${slow.id}/agents`;
  const slowAgentsPath = `/namespaces/${slow.id}/agents`;
  await login(page, fixture, `/console/agents?namespace=${slow.id}`);
  await page.getByText("Slow agent").waitFor();
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  const slowSuccess = await holdRoute(t, page, slowAgents, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => slowSuccess.release());
  // Changed data makes the held read rebuild the view if the console still treats it as current.
  await fixture.createAgent(slow.id, "Slow new agent");

  await chooseNamespace(page, "Slow");
  await slowSuccess.waitForRelease();
  const slowSuccessRead = (await settledFetches(page, slowAgentsPath)) + 1;
  await expectRetainedPreview(page, "Slow agent");
  // Namespace admission has finished, so switching away does not wait for the held read.
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowSuccess.release();
  await slowSuccess.waitForCompletion();
  // The page has settled the stale read (aborted or answered) and run its handler.
  await waitForSettledFetches(page, slowAgentsPath, slowSuccessRead);
  await expectNoText(page, /Slow (new )?agent|unavailable|failed|interrupted/i);
  assert.equal(await page.getByText("Current agent").isVisible(), true);
  assert.equal(new URL(page.url()).searchParams.get("namespace"), current.id);

  await page.unroute(slowAgents);
  const slowError = await holdRoute(t, page, slowAgents, (route) => route.abort("failed"));
  t.after(() => slowError.release());
  await chooseNamespace(page, "Slow");
  await slowError.waitForRelease();
  const slowErrorRead = (await settledFetches(page, slowAgentsPath)) + 1;
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowError.release();
  await slowError.waitForCompletion();
  await waitForSettledFetches(page, slowAgentsPath, slowErrorRead);
  // A failed read the console still treated as current would show "Request interrupted".
  await expectNoText(page, /Slow (new )?agent|unavailable|failed|interrupted/i);
  assert.equal(await page.getByText("Current agent").isVisible(), true);
});

test("an unchanged retained view without a Namespace selection selects the default once one is readable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("Granted later", { ready: true });
  const denyAll = {
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  };
  fixture.policy.restrictions.push(denyAll);
  const { page } = await newPage(t, fixture);
  await login(page, fixture, "/console/backends");
  await page.getByText("openai-primary", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), null);
  // A settled view is retained reusable, so returning to it takes the unchanged fast path.
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByText(fixture.credentials.email.toLowerCase(), { exact: true }).waitFor();
  fixture.policy.restrictions.splice(fixture.policy.restrictions.indexOf(denyAll), 1);
  // The retained Backends view revalidates unchanged, but its shell was built without a selection.
  await page.goBack();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('.content [aria-live="polite"]:not([inert])') &&
      globalThis.document.querySelector("#namespace-selector")?.disabled === false,
  );
  await page.getByText("openai-primary", { exact: true }).waitFor();
  const selection = new URL(page.url()).searchParams.get("namespace");
  assert.notEqual(selection, null);
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    selection,
  );
  await expectNoText(page, /No readable Namespaces/);
});

async function releaseHeldRoute(page, pattern, hold) {
  hold.release();
  await hold.waitForCompletion();
  await page.unroute(pattern);
}

// The console retains a view for Back and in-app returns only if it finished its reads before
// the reader left; otherwise the return rebuilds it. Wait for this before leaving a view whose
// DOM a test later expects to be reused. The page must run trackSettledFetches().
async function waitForSettledView(page) {
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  await waitForIdleFetches(page);
}

async function expectRetainedPreview(page, visibleText) {
  if (visibleText) {
    await page.getByText(visibleText, { exact: true }).waitFor();
  }
  assert.equal(await page.locator('.content [aria-live="polite"][inert]').count(), 1);
  assert.equal(await page.locator(".shell[inert]").count(), 0);
  await expectNoText(page, /Checking your session|Checking your session and Namespace access/);
}

test("console keeps loaded route families visible while return reads refresh", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Retained routes", { ready: true });
  await fixture.createNamespace("A second Namespace", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Retained route Agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);

  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Retained route Agent", { exact: true }).waitFor();
  await waitForSettledView(page);
  const originalAgentRow = await page
    .getByRole("link", { name: "Retained route Agent", exact: true })
    .elementHandle();

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await waitForSettledView(page);
  const originalNamespaceList = await page
    .getByRole("list", { name: "Namespaces", exact: true })
    .elementHandle();
  const agentsPattern = "**/namespaces/" + namespace.id + "/agents";
  const agentsHold = await holdRoute(t, page, agentsPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => agentsHold.release());
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await agentsHold.waitForRelease();
  await expectRetainedPreview(page, "Retained route Agent");
  await releaseHeldRoute(page, agentsPattern, agentsHold);
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(
    await originalAgentRow.evaluate((node) => node.isConnected),
    true,
    "Unchanged Agent rows retain their DOM and handlers on return",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await waitForSettledView(page);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Retained route Agent", { exact: true }).waitFor();
  const namespacesPattern = "**/namespaces";
  const namespacesHold = await holdRoute(t, page, namespacesPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => namespacesHold.release());
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await namespacesHold.waitForRelease();
  await expectRetainedPreview(page, "Retained routes");
  await releaseHeldRoute(page, namespacesPattern, namespacesHold);
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(
    await originalNamespaceList.evaluate((node) => node.isConnected),
    true,
    "Namespace ordering does not force unchanged rows to rebuild",
  );
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

  await page.goto(fixture.origin + "/console/backends?namespace=" + namespace.id);
  await page.getByText("openai-primary", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Retained route Agent", { exact: true }).waitFor();
  const backendsPattern = "**/backends";
  const backendsHold = await holdRoute(t, page, backendsPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => backendsHold.release());
  await page.goBack();
  await backendsHold.waitForRelease();
  await expectRetainedPreview(page, "openai-primary");
  await releaseHeldRoute(page, backendsPattern, backendsHold);
  await page.getByRole("heading", { name: "Backends", exact: true }).waitFor();

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByText(fixture.credentials.email.toLowerCase(), { exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Retained route Agent", { exact: true }).waitFor();
  const sessionPattern = "**/api/auth/session";
  const sessionHold = await holdRoute(t, page, sessionPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => sessionHold.release());
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await sessionHold.waitForRelease();
  await expectRetainedPreview(page, fixture.credentials.email.toLowerCase());
  await releaseHeldRoute(page, sessionPattern, sessionHold);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();

  const nativeStatusUrl = `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}/native-admin`;
  let nativeStatusReads = 0;
  page.on("request", (request) => {
    if (request.url() === nativeStatusUrl) {
      nativeStatusReads += 1;
    }
  });
  const deniedNativeStatus = page.waitForResponse((response) => response.url() === nativeStatusUrl);
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "Retained route Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Retained route Agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  const workspaceNotice =
    "Workspace files require a deployed Agent with a current version and a reachable gateway.";
  await page.getByText(workspaceNotice, { exact: true }).waitFor();
  assert.equal((await deniedNativeStatus).status(), 403);
  await page.locator(".native-admin-access").waitFor({ state: "hidden" });
  await waitForSettledView(page);
  const originalNativePanel = await page.locator(".native-admin-access").elementHandle();
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByText("Retained route Agent", { exact: true }).waitFor();
  const detailPattern = "**/namespaces/" + namespace.id + "/agents/" + agent.id;
  const detailHold = await holdRoute(t, page, detailPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => detailHold.release());
  await page.goBack();
  await detailHold.waitForRelease();
  await expectRetainedPreview(page, workspaceNotice);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "workspace");
  await releaseHeldRoute(page, detailPattern, detailHold);
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  await page.locator(".native-admin-access").waitFor({ state: "attached" });
  assert.equal(
    await page.locator(".native-admin-access").isHidden(),
    true,
    "Denied OpenClaw access remains hidden after route admission",
  );
  assert.equal(
    await originalNativePanel.evaluate((node) => node.isConnected),
    true,
    "an unchanged denied OpenClaw panel stays in the retained view",
  );
  assert.equal(nativeStatusReads, 1, "return navigation does not repeat the audited denial");
  await page.getByRole("heading", { name: "Retained route Agent", exact: true }).waitFor();

  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Retained draft Agent");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  const createSessionHold = await holdRoute(t, page, sessionPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => createSessionHold.release());
  await page.goBack();
  await createSessionHold.waitForRelease();
  // The abandoned default starter form must not appear as an inert cached preview.
  assert.equal(await page.locator("#agent-name").count(), 0);
  createSessionHold.release();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  await createSessionHold.waitForCompletion();
  await page.unroute(sessionPattern);
  await page.getByLabel("Preset template").waitFor();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).count(), 0);
});

test("an Agent tab chosen while the detail is still loading is the one Back restores", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Early tab", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Early tab Agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Early tab Agent", { exact: true }).waitFor();

  // Hold the detail's Configuration read so the first tab is still loading when the reader
  // switches tabs; the switch updates the URL in place.
  const configurationPattern =
    "**/namespaces/" + namespace.id + "/configurations/" + agent.configurationId;
  const configurationHold = await holdRoute(t, page, configurationPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => configurationHold.release());
  await page.getByRole("link", { name: "Early tab Agent", exact: true }).click();
  await configurationHold.waitForRelease();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  const workspaceNotice = page.getByText(
    "Workspace files require a deployed Agent with a current version and a reachable gateway.",
    { exact: true },
  );
  await workspaceNotice.waitFor();
  await releaseHeldRoute(page, configurationPattern, configurationHold);
  await waitForSettledView(page);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "workspace");
  const notice = await workspaceNotice.elementHandle();

  // The view is retained under the URL it shows, so Back reuses it instead of rebuilding it.
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  await page.goBack();
  await workspaceNotice.waitFor();
  await waitForSettledView(page);
  assert.equal(new URL(page.url()).searchParams.get("tab"), "workspace");
  assert.equal(
    await notice.evaluate((node) => node.isConnected),
    true,
    "Back restores the retained workspace tab",
  );
});

test("Refresh and focus restoration retain rows until fresh data arrives", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Background reads", { ready: true });
  await fixture.createAgent(namespace.id, "Existing background Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Existing background Agent").waitFor();
  for (const trigger of ["Refresh", "focus", "visibilitychange"]) {
    const pending = await holdRoute(t, page, "**/api/auth/session", (route) => route.continue(), {
      fetchBeforeHold: false,
    });
    t.after(() => pending.release());
    await fixture.createAgent(namespace.id, `Added during ${trigger}`);
    if (trigger === "Refresh") {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else {
      // Invoke the production event handlers without relying on window-manager focus timing.
      await page.evaluate((name) => {
        const target = name === "focus" ? globalThis : globalThis.document;
        target.dispatchEvent(new Event(name));
      }, trigger);
    }
    await pending.waitForRelease();
    await expectRetainedPreview(page, "Existing background Agent");
    await releaseHeldRoute(page, "**/api/auth/session", pending);
    await page.getByText(`Added during ${trigger}`, { exact: true }).waitFor();
  }
});

test("console retained views clear after session expiry and exact Agent denial", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Retained invalidation", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Denied retained Agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);

  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Denied retained Agent", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  const sessionPattern = "**/api/auth/session";
  const expiredSession = await holdRoute(t, page, sessionPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => expiredSession.release());
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expiredSession.waitForRelease();
  await expectRetainedPreview(page, "Denied retained Agent");
  await releaseHeldRoute(page, sessionPattern, expiredSession);
  await page.getByText("Your session has expired").waitFor();
  await expectNoText(page, /Denied retained Agent/);

  fixture.memoryDatabase.session.length = 0;
  await login(page, fixture, "/console/agents/" + agent.id + "?namespace=" + namespace.id);
  await page.getByRole("heading", { name: "Denied retained Agent", exact: true }).waitFor();
  // The heading shows before the detail finishes loading; leaving earlier keeps no preview.
  await waitForSettledView(page);
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByText("Denied retained Agent", { exact: true }).waitFor();
  fixture.policy.restrictions.push({
    id: "deny-retained-agent-read",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "read",
    effect: "deny",
  });
  const detailPattern = "**/namespaces/" + namespace.id + "/agents/" + agent.id;
  const deniedAgent = await holdRoute(t, page, detailPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => deniedAgent.release());
  await page.goBack();
  await deniedAgent.waitForRelease();
  await expectRetainedPreview(page, "Denied retained Agent");
  await releaseHeldRoute(page, detailPattern, deniedAgent);
  await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
  // Someone else's Agent link says what the reader can do, not that a collection is unreadable.
  await page
    .getByText(
      "You do not have access to this Agent or its settings, or it was deleted. Ask its owner to share it with you.",
    )
    .waitFor();
  await expectNoText(page, /Configuration draft|Selected revision/);
});

// Both shared admission reads must revoke every preview when their outcome is unknown.
for (const gate of ["/api/auth/session", "/namespaces"]) {
  test(`console clears all retained pages after ${gate} fails`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Admission failure", { ready: true });
    await fixture.createAgent(namespace.id, "Private cached Agent");
    const { page } = await newPage(t, fixture);
    await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
    await page.getByText("Private cached Agent").waitFor();
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

    await page.route(`**${gate}`, (route) => route.abort("failed"));
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page
      .getByRole("heading", {
        name: gate === "/api/auth/session" ? "Session unavailable" : "Namespace access unavailable",
        exact: true,
      })
      .waitFor();
    await expectNoText(page, /Private cached Agent|Admission failure/);
    await page.unroute(`**${gate}`);

    // Returning to the other cached route cannot resurrect it while admission is pending.
    const pending = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    t.after(() => pending.release());
    await page.goBack();
    await pending.waitForRelease();
    assert.equal(await page.locator(".content [inert]").count(), 0);
    await expectNoText(page, /Private cached Agent|Admission failure/);
    await releaseHeldRoute(page, "**/api/auth/session", pending);
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  });
}

test("a session replaced by another tab signs this tab out instead of being adopted", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Session replacement", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Old session draft");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

  // APIRequestContext shares the browser cookie jar: this models a login in another tab.
  const response = await page.context().request.post(`${fixture.origin}/api/auth/sign-in/email`, {
    headers: { origin: fixture.origin },
    data: { email: fixture.credentials.email, password: fixture.credentials.password },
  });
  assert.equal(response.status(), 200);
  const refused = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/api/auth/session",
  );
  await page.goBack();
  // This tab pinned the key of its own session. The controller refuses the
  // replaced cookie for it, so the tab signs out rather than acting as another session.
  const refusedSession = await refused;
  assert.equal(refusedSession.status(), 401);
  assert.ok(refusedSession.request().headers()["x-occ-session-key"]);
  await page.getByText("Your session has expired").waitFor();
  assert.equal(await page.locator("#agent-name").count(), 0);
  assert.equal(await page.locator(".content [inert]").count(), 0);

  // Signing in again adopts the current session without the old session's draft.
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
});

test("an abandoned GitHub attempt does not turn password sign-in into a GitHub failure", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByLabel("Username").waitFor();
  // Models returning from github.com without completing the callback.
  await page.evaluate(() => sessionStorage.setItem("occ.console.githubAttempt", "a".repeat(43)));
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/agents/);
  assert.equal(requests.includes("/api/auth/providers/github/result"), false);
  await expectNoText(page, /Could not sign in with GitHub/);
});

test("Google sign-in accepts only a Google authorization URL and confirms through its own result", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const envelope = (data) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "browser-google" } }),
  });
  // This controller has no Google configuration; discovery and start are modelled here.
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill(envelope({ github: false, google: true, sessionBinding: true })),
  );
  const attemptId = "b".repeat(43);
  const starts = [
    "https://accounts.google.com.example.test/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture",
  ];
  await page.route("**/api/auth/providers/google/start", (route) =>
    route.fulfill(envelope({ url: starts.shift(), attemptId })),
  );
  // Models Google redirecting back to Console after the callback set its cookies.
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 302, headers: { location: `${fixture.origin}/console/` } }),
  );
  await page.goto(`${fixture.origin}/console/login`);
  const google = page.getByRole("button", { name: "Continue with Google" });
  await google.click();
  await page.getByText("Google sign-in is unavailable. Try again or use your password.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue with GitHub" }).count(), 0);

  const result = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/api/auth/providers/google/result",
  );
  await google.click();
  const refused = await result;
  assert.equal(refused.request().postDataJSON().attemptId, attemptId);
  // The unconfigured controller refuses the result, so this tab adopts no session.
  assert.equal(refused.status(), 403);
  await page.getByText("Could not sign in with Google. Try again or use your password.").waitFor();
  assert.equal(requests.includes("/api/auth/providers/github/result"), false);

  await page.goto(`${fixture.origin}/console/?authError=google`);
  await page.getByText("Could not sign in with Google. Try again or use your password.").waitFor();
});

test("OIDC sign-in uses the discovered label and accepts only the discovered endpoint", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  const envelope = (data) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "browser-oidc" } }),
  });
  const endpoint = "https://sso.example.test/realms/acme/protocol/openid-connect/auth";
  let discovery = {
    github: false,
    google: false,
    oidc: true,
    oidcSignIn: { label: "Acme SSO", authorizationUrl: endpoint },
    sessionBinding: true,
  };
  // This controller has no OIDC configuration; discovery and start are modelled here.
  await page.route("**/api/auth/providers", (route) => route.fulfill(envelope(discovery)));
  const attemptId = "c".repeat(43);
  const starts = [
    "https://sso.example.test/realms/other/protocol/openid-connect/auth",
    `${endpoint}?client_id=fixture&state=s`,
  ];
  await page.route("**/api/auth/providers/oidc/start", (route) =>
    route.fulfill(envelope({ url: starts.shift(), attemptId })),
  );
  // Models the IdP redirecting back to Console after the callback set its cookies.
  await page.route("https://sso.example.test/**", (route) =>
    route.fulfill({ status: 302, headers: { location: `${fixture.origin}/console/` } }),
  );
  await page.goto(`${fixture.origin}/console/login`);
  const oidc = page.getByRole("button", { name: "Continue with Acme SSO" });
  await oidc.click();
  await page
    .getByText("Acme SSO sign-in is unavailable. Try again or use your password.")
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 0);

  const result = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/api/auth/providers/oidc/result",
  );
  await oidc.click();
  const refused = await result;
  assert.equal(refused.request().postDataJSON().attemptId, attemptId);
  assert.equal(refused.status(), 403);
  await page
    .getByText("Could not sign in with Acme SSO. Try again or use your password.")
    .waitFor();
  assert.equal(requests.includes("/api/auth/providers/google/result"), false);

  // A non-HTTPS discovered endpoint offers no OIDC button at all.
  discovery = {
    ...discovery,
    oidcSignIn: { label: "Acme SSO", authorizationUrl: "http://sso.example.test/auth" },
  };
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByLabel("Username").waitFor();
  await expectNoText(page, /Continue with Acme SSO/);
});

test("GitHub allowlist refusals tell the person why, and other reasons stay generic", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  let password = true;
  // Discovery models GitHub sign-in with password sign-in for everyone, then recovery-only.
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { github: true, google: false, password, sessionBinding: true },
        meta: { requestId: "browser-github-allowlist" },
      }),
    }),
  );
  const cases = [
    [
      "membership",
      "Your GitHub account is not a member of an organization or team allowed to sign in here. If you were invited, accept the invitation on GitHub and try again; otherwise ask an administrator for access or use your password.",
      "Your GitHub account is not a member of an organization or team allowed to sign in here. If you were invited, accept the invitation on GitHub and try again; otherwise ask an administrator for access.",
    ],
    [
      "membership-unavailable",
      "Could not check your GitHub organization membership. Try again later or use your password.",
      "Could not check your GitHub organization membership. Try again later; if this keeps happening, ask an administrator.",
    ],
    [
      "toString",
      "Could not sign in with GitHub. Try again or use your password.",
      "Could not sign in with GitHub. Try again, or ask an administrator to attach your GitHub identity to your account.",
    ],
  ];
  for (const [reason, withPassword, recoveryOnly] of cases) {
    for (const [available, message] of [
      [true, withPassword],
      [false, recoveryOnly],
    ]) {
      password = available;
      await page.goto(`${fixture.origin}/console/?authError=github&authReason=${reason}`);
      await page.getByText(message, { exact: true }).waitFor();
    }
  }
  // The reason applies only to GitHub's own error.
  password = true;
  await page.goto(`${fixture.origin}/console/?authError=google&authReason=membership`);
  await page.getByRole("button", { name: "Login" }).waitFor();
  await expectNoText(page, /organization/);
});

test("recovery-only password sign-in keeps the form behind Recovery sign-in", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  // This controller admits every password; discovery models OCC_AUTH_PASSWORD_SIGN_IN.
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { github: true, google: false, password: false, sessionBinding: true },
        meta: { requestId: "browser-recovery-only" },
      }),
    }),
  );
  await page.route("**/api/auth/providers/github/start", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto(`${fixture.origin}/console/?authError=github`);
  const recovery = page.getByRole("button", { name: "Recovery sign-in" });
  await recovery.waitFor();
  // Without a password to fall back on, the provider error points to an administrator.
  await page
    .getByText(
      "Could not sign in with GitHub. Try again, or ask an administrator to attach your GitHub identity to your account.",
    )
    .waitFor();
  assert.equal(await page.getByLabel("Password").isVisible(), false);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.getByText("GitHub sign-in is unavailable. Try again later.").waitFor();

  await recovery.click();
  assert.equal(await recovery.isVisible(), false);
  await page.getByText("Use the recovery account's email").waitFor();
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill("not-the-recovery-password");
  await page.getByRole("button", { name: "Login" }).click();
  await page
    .getByText(
      "Could not sign in. Only the recovery account can use a password; other accounts continue with their external sign-in.",
    )
    .waitFor();
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/agents/);
});

test("password sign-in stays visible unless discovery reports it recovery-only", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { github: true, google: false, sessionBinding: true },
        meta: { requestId: "browser-password-default" },
      }),
    }),
  );
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByRole("button", { name: "Continue with GitHub" }).waitFor();
  assert.equal(await page.getByLabel("Password").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Recovery sign-in" }).isVisible(), false);
});

test("known Namespace revocation invalidates a cached global collection with another selection", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const allowed = await fixture.createNamespace("Still readable", { ready: true });
  const revoked = await fixture.createNamespace("Removed from access", { ready: true });
  await fixture.createAgent(allowed.id, "Allowed Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/namespaces?namespace=${allowed.id}`);
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Allowed Agent", { exact: true }).waitFor();
  fixture.policy.restrictions.push({
    id: "deny-cached-namespace",
    namespaceId: revoked.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  // Refresh learns the revocation while the selected Namespace remains readable.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
  const pending = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => pending.release());
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await pending.waitForRelease();
  await expectNoText(page, /Removed from access/);
  await releaseHeldRoute(page, "**/api/auth/session", pending);
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await expectNoText(page, /Removed from access/);
});

test("known Backend denial invalidates previews across Namespace selections", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Backend Alpha", { ready: true });
  await fixture.createNamespace("Backend Beta", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/backends?namespace=${alpha.id}`);
  await page.getByText("openai-primary", { exact: true }).waitFor();
  await chooseNamespace(page, "Backend Beta");
  await page.getByText("openai-primary", { exact: true }).waitFor();
  fixture.policy.restrictions.push({
    id: "deny-backend-administration",
    resourceKind: "installation",
    action: "administer",
    effect: "deny",
  });
  // Backend authorization is global even though the two cached URLs select different Namespaces.
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
  const pending = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => pending.release());
  await page.goBack();
  await pending.waitForRelease();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), alpha.id);
  await expectNoText(page, /openai-primary/);
  await releaseHeldRoute(page, "**/api/auth/session", pending);
  await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
});

test("pagehide clears private content before persisted pageshow revalidates", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Page lifecycle", { ready: true });
  await fixture.createAgent(namespace.id, "Before pagehide Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Before pagehide Agent").waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  // Exercise the actual registered lifecycle handlers; this does not prove browser BFCache eligibility.
  await page.evaluate(() =>
    globalThis.dispatchEvent(new globalThis.PageTransitionEvent("pagehide", { persisted: true })),
  );
  assert.equal(await page.locator("#app").textContent(), "");
  const pending = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => pending.release());
  await page.evaluate(() =>
    globalThis.dispatchEvent(new globalThis.PageTransitionEvent("pageshow", { persisted: true })),
  );
  await pending.waitForRelease();
  await expectNoText(page, /Before pagehide Agent|Page lifecycle/);
  await releaseHeldRoute(page, "**/api/auth/session", pending);
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await page.goBack();
  await page.getByText("Before pagehide Agent").waitFor();
});

test("mobile header switches Namespace without opening the navigation drawer", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  await fixture.createAgent(alpha.id, "Alpha mobile agent");
  await fixture.createAgent(beta.id, "Beta mobile agent");
  const { page } = await newPage(t, fixture, mobile);

  await login(page, fixture, `/console/agents?namespace=${alpha.id}`);
  await page.getByText("Alpha mobile agent").waitFor();

  await chooseNamespace(page, "Beta");

  await page.getByText("Beta mobile agent").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  await expectNoText(page, /Welcome back|Your session has expired|Could not confirm logout/);
});

test("header Namespace selection leaves Agent detail and creation for the selected collection", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  const agent = await fixture.createAgent(alpha.id, "Alpha agent");
  await fixture.createAgent(beta.id, "Beta agent");
  const { page } = await newPage(t, fixture);

  await login(page, fixture, `/console/agents/${agent.id}?namespace=${alpha.id}`);
  await page.getByRole("heading", { name: "Alpha agent", exact: true }).waitFor();
  await chooseNamespace(page, "Beta");
  await page.getByText("Beta agent").waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/agents");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), beta.id);

  // A draft form belongs to its original Namespace; switching opens a fresh collection.
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  await chooseNamespace(page, "Alpha");
  await page.getByText("Alpha agent").waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/agents");
  await page.reload();
  await page.getByText("Alpha agent").waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    alpha.id,
  );
});

for (const trigger of ["Refresh", "Back with a replacement session"]) {
  test(`inline Namespace recovery waits for current admission during ${trigger}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const alpha = await fixture.createNamespace("Previously readable", { ready: true });
    const beta = await fixture.createNamespace("Still readable", { ready: true });
    const missingId = "ns_00000000-0000-4000-8000-000000000099";
    const { page } = await newPage(t, fixture, mobile);
    await login(page, fixture, `/console/namespaces?namespace=${missingId}`);
    const selector = page.getByRole("combobox", { name: "Choose a valid Namespace", exact: true });
    await page.locator("#namespace-selector:not(:disabled)").waitFor();
    assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 1);

    if (trigger !== "Refresh") {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("link", { name: "Agents", exact: true }).click();
      await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await page.locator(".page-actions button:not(:disabled)").waitFor();
      // A real login in another tab changes the session while sharing the cookie jar.
      const response = await page
        .context()
        .request.post(`${fixture.origin}/api/auth/sign-in/email`, {
          headers: { origin: fixture.origin },
          data: { email: fixture.credentials.email, password: fixture.credentials.password },
        });
      assert.equal(response.status(), 200);
    }

    // Revoke through the actual IAM Driver before capturing the fresh Namespace read.
    fixture.policy.restrictions.push({
      id: "deny-previously-readable-namespace",
      namespaceId: alpha.id,
      resourceKind: "namespace",
      action: "read",
      effect: "deny",
    });
    const sessionHold = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    const namespaceHold = await holdRoute(t, page, "**/namespaces", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    t.after(() => {
      sessionHold.release();
      namespaceHold.release();
    });
    if (trigger === "Refresh") {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else {
      await page.goBack();
    }
    await sessionHold.waitForRelease();
    assert.equal(await selector.isDisabled(), true);
    assert.equal(await selector.locator('option:not([value=""])').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get("namespace"), missingId);

    await releaseHeldRoute(page, "**/api/auth/session", sessionHold);
    if (trigger !== "Refresh") {
      // Another tab's login expires this tab; only explicit sign-in may adopt a new session.
      await page.getByText("Your session has expired").waitFor();
      assert.equal(await page.locator("#namespace-selector").count(), 0);
      await page.getByLabel("Username").fill(fixture.credentials.email);
      await page.getByLabel("Password").fill(fixture.credentials.password);
      await page.getByRole("button", { name: "Login" }).click();
    }
    await namespaceHold.waitForRelease();
    // A changed session can discard a retained shell or leave the first-load shell.
    // Any remaining selector must still await the fresh readable-Namespace response.
    if (await selector.count()) {
      assert.equal(await selector.isDisabled(), true);
      assert.equal(await selector.locator('option:not([value=""])').count(), 0);
    }
    assert.equal(new URL(page.url()).searchParams.get("namespace"), missingId);
    await releaseHeldRoute(page, "**/namespaces", namespaceHold);
    await page.locator("#namespace-selector:not(:disabled)").waitFor();
    assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 0);
    await selector.selectOption(beta.id);
    await page.waitForURL(`**/console/namespaces?namespace=${beta.id}`);
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    assert.equal(await page.locator(".namespace-recovery").count(), 0);
  });
}

for (const trigger of ["Refresh", "Back with a replacement session"]) {
  test(`header Namespace selection waits for current admission during ${trigger}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const alpha = await fixture.createNamespace("Previously readable", { ready: true });
    const beta = await fixture.createNamespace("Still readable", { ready: true });
    const missingId = "ns_00000000-0000-4000-8000-000000000099";
    const { page } = await newPage(t, fixture, mobile);
    await login(page, fixture, `/console/agents?namespace=${missingId}`);
    const selector = page.locator(".page-header #namespace-selector");
    await page.locator(".page-header #namespace-selector:not(:disabled)").waitFor();
    assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 1);

    async function assertPendingHeader() {
      await selector.waitFor();
      assert.equal(await selector.isDisabled(), true);
      assert.equal(await selector.locator('option:not([value=""])').count(), 0);
      // Disabled controls can still receive programmatic events; admission must reject them.
      const navigation = await selector.evaluate((element, staleNamespaceId) => {
        const before = globalThis.location.href;
        const staleOption = element.ownerDocument.createElement("option");
        staleOption.value = staleNamespaceId;
        element.append(staleOption);
        element.value = staleNamespaceId;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        staleOption.remove();
        return { before, after: globalThis.location.href };
      }, alpha.id);
      assert.equal(navigation.after, navigation.before);
    }

    if (trigger !== "Refresh") {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("link", { name: "Namespaces", exact: true }).click();
      await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
      await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await page.locator(".page-actions button:not(:disabled)").waitFor();
      // A real login in another tab changes the session while sharing the cookie jar.
      const response = await page
        .context()
        .request.post(`${fixture.origin}/api/auth/sign-in/email`, {
          headers: { origin: fixture.origin },
          data: { email: fixture.credentials.email, password: fixture.credentials.password },
        });
      assert.equal(response.status(), 200);
    }

    // Revoke through the actual IAM Driver before capturing the fresh Namespace read.
    fixture.policy.restrictions.push({
      id: "deny-previously-readable-namespace",
      namespaceId: alpha.id,
      resourceKind: "namespace",
      action: "read",
      effect: "deny",
    });
    const sessionHold = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    const namespaceHold = await holdRoute(t, page, "**/namespaces", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    t.after(() => {
      sessionHold.release();
      namespaceHold.release();
    });
    if (trigger === "Refresh") {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
    } else {
      await page.goBack();
    }
    await sessionHold.waitForRelease();
    await assertPendingHeader();
    assert.equal(new URL(page.url()).searchParams.get("namespace"), missingId);

    await releaseHeldRoute(page, "**/api/auth/session", sessionHold);
    if (trigger !== "Refresh") {
      // Another tab's login expires this tab; only explicit sign-in may adopt a new session.
      await page.getByText("Your session has expired").waitFor();
      assert.equal(await page.locator("#namespace-selector").count(), 0);
      await page.getByLabel("Username").fill(fixture.credentials.email);
      await page.getByLabel("Password").fill(fixture.credentials.password);
      await page.getByRole("button", { name: "Login" }).click();
    }
    await namespaceHold.waitForRelease();
    await assertPendingHeader();
    assert.equal(new URL(page.url()).searchParams.get("namespace"), missingId);
    await releaseHeldRoute(page, "**/namespaces", namespaceHold);
    await page.locator(".page-header #namespace-selector:not(:disabled)").waitFor();
    assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 0);
    assert.equal(await selector.locator(`option[value="${beta.id}"]`).count(), 1);
    await selector.selectOption(beta.id);
    await page.waitForURL(`**/console/agents?namespace=${beta.id}`);
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  });
}

test("Namespaces recovers stale selection inline and handles losing all readable scopes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  const missingId = "ns_00000000-0000-4000-8000-000000000099";
  const { page } = await newPage(t, fixture, mobile);
  await login(page, fixture, `/console/namespaces?namespace=${missingId}`);
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

  // A stale bookmark must offer recovery on this page without opening the drawer.
  const selector = page.getByRole("combobox", { name: "Choose a valid Namespace", exact: true });
  assert.equal(await selector.isVisible(), true);
  assert.equal(await page.locator(".page-header select").count(), 0);
  await selector.selectOption({ label: "Alpha" });
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), alpha.id);
  assert.equal(
    await page.getByRole("heading", { name: "Namespace unavailable", exact: true }).count(),
    0,
  );
  assert.equal(await page.getByRole("combobox").count(), 0);

  await page.goBack();
  await selector.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), missingId);
  await selector.selectOption({ label: "Alpha" });
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

  // Revocation comes from the real IAM Driver; the recovery must never offer that scope.
  fixture.policy.restrictions.push({
    id: "deny-alpha-read",
    namespaceId: alpha.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await selector.waitFor();
  assert.equal(await page.getByRole("option", { name: "Alpha", exact: true }).count(), 0);
  await selector.selectOption({ label: "Beta" });
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), beta.id);

  // Include the bootstrapped default Namespace when revoking every remaining scope.
  // With no alternatives, recovery must explain the access requirement.
  fixture.policy.restrictions.push({
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  await page
    .getByText("Ask an administrator to provision resources or grant access, then refresh.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByRole("combobox").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Switch Namespace", exact: true }).count(),
    0,
  );
});

test("console clears private content after session expiry, access revocation, and failed logout", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked", { ready: true });
  await fixture.createAgent(namespace.id, "Revoked agent");
  const { page, artifacts } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Revoked agent").waitFor();

  await page.route("**/api/auth/sign-out", async (route) => {
    await route.abort("failed");
  });
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.getByText("Could not confirm logout").waitFor();
  await expectNoText(page, /Revoked agent/);
  await page.unroute("**/api/auth/sign-out");
  await page.getByRole("button", { name: "Retry" }).click();
  await page.waitForURL(/\/console\/login$/);

  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Revoked agent").waitFor();
  fixture.policy.restrictions.push({
    id: "deny-console-namespace-read",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("heading", { name: "Namespace unavailable", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    "",
  );
  assert.equal(await page.getByRole("option", { name: "Revoked", exact: true }).count(), 0);
  await expectNoText(page, /Revoked agent/);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
  const revokedReturn = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => revokedReturn.release());
  await page.goBack();
  await revokedReturn.waitForRelease();
  await expectNoText(page, /Revoked agent/);
  await releaseHeldRoute(page, "**/api/auth/session", revokedReturn);
  await page.getByRole("heading", { name: "Namespace unavailable", exact: true }).waitFor();
  fixture.policy.restrictions.length = 0;

  await page.reload();
  await page.getByText("Revoked agent").waitFor();
  // Better Auth's memory adapter stores session expiry as Date values.
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  await page.reload();
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Login" }).waitFor();
  await expectNoText(page, /Revoked agent/);

  await page.screenshot({ path: join(artifacts, "session-isolation.png"), fullPage: true });
});

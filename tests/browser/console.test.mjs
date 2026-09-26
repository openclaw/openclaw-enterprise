import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const routeHoldTimeoutMs = 30_000;

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-browser-"))
      : configured;
  t.diagnostic(`console browser artifacts: ${directory}`);
  return directory;
}

async function launchBrowser() {
  const browserExecutable =
    process.env.OCC_TEST_BROWSER_EXECUTABLE === undefined ||
    process.env.OCC_TEST_BROWSER_EXECUTABLE.length === 0
      ? undefined
      : process.env.OCC_TEST_BROWSER_EXECUTABLE;
  const browser = await chromium.launch({
    ...(browserExecutable === undefined ? {} : { executablePath: browserExecutable }),
    headless: true,
  });
  return browser;
}

async function newPage(t, fixture) {
  const artifacts = await artifactDirectory(t);
  const browser = await launchBrowser();
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

async function newMobilePage(t, fixture) {
  const browser = await launchBrowser();
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
  context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  return { page: await context.newPage() };
}

async function login(page, fixture, path = "/console/") {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|backends|namespaces|settings)/);
}

async function openShellMenu(page) {
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
}

async function chooseNamespace(page, name) {
  await page
    .getByRole("combobox", { name: "Namespace", exact: true })
    .selectOption({ label: name });
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForRoutePhase(promise, description, release, signal) {
  let timeout;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    function fail(reason) {
      release();
      const error = new Error(`${description} did not finish within ${routeHoldTimeoutMs}ms`);
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

async function holdRoute(t, page, pattern, continueRoute) {
  const releaseGate = deferred();
  const captured = deferred();
  const completed = deferred();
  let released = false;
  let releaseWatchdog;

  function release() {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(releaseWatchdog);
    releaseGate.resolve();
  }

  t.signal?.addEventListener("abort", release, { once: true });
  await page.route(pattern, async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch {
      response = undefined;
    }
    captured.resolve();
    if (!released && releaseWatchdog === undefined) {
      releaseWatchdog = setTimeout(release, routeHoldTimeoutMs);
      releaseWatchdog.unref?.();
    }
    await releaseGate.promise;
    try {
      await continueRoute(route, response);
    } catch {
      /* The page may already have aborted the obsolete read. */
    } finally {
      completed.resolve();
    }
  });

  return {
    release,
    waitForRelease: () =>
      waitForRoutePhase(captured.promise, `route ${pattern} capture`, release, t.signal),
    waitForCompletion: () =>
      waitForRoutePhase(completed.promise, `route ${pattern} completion`, release, t.signal),
  };
}

function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}` });
    }
  });
  return requests;
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
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("heading", { name: "Namespaces" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("debug"), "true");
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

test("console ignores stale collection successes and errors while switching Namespaces", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const slow = await fixture.createNamespace("Slow", { ready: true });
  const current = await fixture.createNamespace("Current", { ready: true });
  await fixture.createAgent(slow.id, "Slow agent");
  await fixture.createAgent(current.id, "Current agent");
  const { page } = await newPage(t, fixture);
  const slowAgents = `**/namespaces/${slow.id}/agents`;
  await login(page, fixture, `/console/agents?namespace=${slow.id}`);
  await page.getByText("Slow agent").waitFor();
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  const slowSuccess = await holdRoute(t, page, slowAgents, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => slowSuccess.release());

  await chooseNamespace(page, "Slow");
  await slowSuccess.waitForRelease();
  await expectRetainedPreview(page, "Slow agent");
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowSuccess.release();
  await slowSuccess.waitForCompletion();
  await expectNoText(page, /Slow agent|unavailable|failed/i);

  await page.unroute(slowAgents);
  const slowError = await holdRoute(t, page, slowAgents, (route) => route.abort("failed"));
  t.after(() => slowError.release());
  await chooseNamespace(page, "Slow");
  await slowError.waitForRelease();
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowError.release();
  await slowError.waitForCompletion();
  await page.waitForTimeout(100);
  await expectNoText(page, /Slow agent|unavailable|failed/i);
});

async function releaseHeldRoute(page, pattern, hold) {
  hold.release();
  await hold.waitForCompletion();
  await page.unroute(pattern);
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
  const agent = await fixture.createAgent(namespace.id, "Retained route Agent");
  const { page } = await newPage(t, fixture);

  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Retained route Agent", { exact: true }).waitFor();

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  const agentsPattern = "**/namespaces/" + namespace.id + "/agents";
  const agentsHold = await holdRoute(t, page, agentsPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => agentsHold.release());
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await agentsHold.waitForRelease();
  await expectRetainedPreview(page, "Retained route Agent");
  await releaseHeldRoute(page, agentsPattern, agentsHold);
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();

  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
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

  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "Retained route Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Retained route Agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Workspace files", exact: true }).click();
  const workspaceNotice =
    "Workspace files require a deployed Agent with an active revision and a reachable gateway.";
  await page.getByText(workspaceNotice, { exact: true }).waitFor();
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
  await page.getByRole("heading", { name: "Retained route Agent", exact: true }).waitFor();

  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Retained draft Agent");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  const createSessionHold = await holdRoute(t, page, sessionPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => createSessionHold.release());
  await page.goBack();
  await createSessionHold.waitForRelease();
  await expectRetainedPreview(page);
  assert.equal(await page.locator("#agent-name").inputValue(), "Retained draft Agent");
  await releaseHeldRoute(page, sessionPattern, createSessionHold);
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Agent name", { exact: true }).inputValue(),
    "Retained draft Agent",
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
    const pending = await holdRoute(t, page, "**/api/auth/session", (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
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

test("a replacement session for the same user discards retained creation drafts", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Session replacement", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Old session draft");
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();

  // APIRequestContext shares the browser cookie jar: this models a login in another tab.
  const response = await page.context().request.post(`${fixture.origin}/api/auth/sign-in/email`, {
    headers: { origin: fixture.origin },
    data: { email: fixture.credentials.email, password: fixture.credentials.password },
  });
  assert.equal(response.status(), 200);
  const pending = await holdRoute(t, page, "**/namespaces", (route, read) =>
    read ? route.fulfill({ response: read }) : route.continue(),
  );
  t.after(() => pending.release());
  await page.goBack();
  await pending.waitForRelease();
  // The new session has been checked; the old preview must already be gone.
  assert.equal(await page.locator("#agent-name").count(), 0);
  assert.equal(await page.locator(".content [inert]").count(), 0);
  await releaseHeldRoute(page, "**/namespaces", pending);
  await page.getByRole("button", { name: "Start without Preset", exact: true }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
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
  const { page } = await newMobilePage(t, fixture);

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

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

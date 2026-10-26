import assert from "node:assert/strict";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { UNTRUSTED_ORIGIN_MESSAGE } from "../../apps/controller/src/admission/admission-verifier.ts";
import { loadConsoleTheme } from "../../apps/controller/src/composition/console-theme.ts";

import {
  describePendingBrowserRequests,
  noteBrowserEvent,
} from "../helpers/browser-failure-diagnostics.mjs";
import {
  createConsoleAppFixture as createBaseConsoleAppFixture,
  fileConsoleApp,
} from "../helpers/console-app.mjs";
import {
  apiRequests,
  expectNoText,
  expireSessions,
  login,
  loginThroughForm,
  newPage,
  nonAuthWriteRequests,
  settledFetches,
  settledView,
  settlePageRequests,
  trackSettledFetches,
  waitForEnabled,
  waitForIdleFetches,
  waitForSettledFetches,
  writeRequests,
} from "./console-agents-browser-helpers.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { WORKSPACE_FILES_UNAVAILABLE } from "../helpers/refusal-text.mjs";

const defaultCodexPreset = JSON.parse(
  await readFile(new URL("../../deploy/presets/default-codex.json", import.meta.url), "utf8"),
);
const createConsoleAppFixture = (t, options = {}) =>
  createBaseConsoleAppFixture(t, { defaultPresets: [defaultCodexPreset], ...options });
// The sign-in page tests share one app (fileConsoleApp): they make no Namespace, change no
// policy and end no session. Every other test keeps an app of its own.
const signInApp = fileConsoleApp({ defaultPresets: [defaultCodexPreset] });

test("mounted theme brands sign-in, Agent navigation and mobile without losing session behavior", async (t) => {
  const directory = await temporaryDirectory(t, "occ-browser-theme-");
  await cp(new URL("../../deploy/examples/console-theme/", import.meta.url), directory, {
    recursive: true,
  });
  const fixture = await createConsoleAppFixture(t, {
    consoleTheme: await loadConsoleTheme(directory),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Theme workflow", { ready: true });
  await fixture.createAgent(namespace.id, "Theme assistant");
  const { page } = await newPage(t, fixture);
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.title(), "Example Agents");
  assert.equal(await page.locator(".brand-name").textContent(), "Example Agents");
  assert.equal(await page.locator(".brand img").getAttribute("src"), "/console/theme/logo.png");
  assert.equal(
    await page.evaluate(() =>
      globalThis
        .getComputedStyle(globalThis.document.documentElement)
        .getPropertyValue("--color-accent")
        .trim(),
    ),
    "#2457C5",
  );
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Theme assistant", { exact: true }).click();
  await page.getByRole("heading", { name: "Theme assistant", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".topbar .brand-name").textContent(), "Example Agents");
  const logo = await page.locator(".topbar .brand img").evaluate((node) => {
    const { width, filter } = globalThis.getComputedStyle(node);
    return { width, filter };
  });
  assert.deepEqual(logo, { width: "20px", filter: "none" }, "the theme logo keeps its own artwork");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.locator(".sidebar nav").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".sidebar .account-toggle").click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).first().click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.locator(".brand-name").textContent(), "Example Agents");
});

const routeHoldTimeoutMs = 30_000;
const mobile = {
  context: { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } },
};

test("a collection body disconnected after headers shows interruption and Retry reloads real data", async (t) => {
  let interruptNextRead = false;
  let interruptedBody;
  const fixture = await createConsoleAppFixture(t, {
    async onSend(request, reply, payload) {
      if (
        !interruptNextRead ||
        request.method !== "GET" ||
        !request.url.endsWith("/agents") ||
        reply.statusCode !== 200
      ) {
        return payload;
      }
      interruptNextRead = false;
      // The real authorized API already produced this list. Deliver its headers
      // and only a prefix, then break the socket after the browser sees headers.
      assert.equal(typeof payload, "string");
      reply.hijack();
      reply.raw.writeHead(reply.statusCode, {
        ...reply.getHeaders(),
        "content-length": Buffer.byteLength(payload),
      });
      reply.raw.write(payload.slice(0, 10));
      interruptedBody = reply.raw;
      return payload;
    },
  });
  t.after(() => interruptedBody?.destroy());
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Body interruption", { ready: true });
  await fixture.createAgent(namespace.id, "Research assistant");
  const { page, artifacts } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Research assistant", { exact: true }).waitFor();

  interruptNextRead = true;
  const headers = page.waitForResponse((response) =>
    response.url().endsWith(`/namespaces/${namespace.id}/agents`),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const received = await headers;
  assert.equal(received.status(), 200);
  assert.ok(Number((await received.allHeaders())["content-length"]) > 10);
  interruptedBody.destroy(new Error("Test connection closed after response headers"));
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "response-body-interrupted.png") });
  await page.getByRole("heading", { name: "Request interrupted", exact: true }).waitFor();
  assert.equal(await page.getByText("Research assistant", { exact: true }).count(), 0);
  const writesBeforeRetry = writeRequests(requests).length;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Research assistant", { exact: true }).waitFor();
  assert.equal(writeRequests(requests).length, writesBeforeRetry);
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).inputValue(),
    namespace.id,
  );
});

// Whether the locator's element holds focus, and what does (role, accessible text, class), so a
// failed check names the element that took focus instead of saying `false !== true`.
// Playwright resolves a locator and runs evaluate in separate steps. A shell render between
// them (the loading page 250 ms into a load, say) hands evaluate the node it replaced, detached,
// while focus is already on the replacement (finding 2016). A detached node is no verdict, so
// resolve the locator again.
async function focusState(locator) {
  for (let attempt = 1; ; attempt += 1) {
    const sample = await locator.evaluate((node) => {
      const active = globalThis.document.activeElement;
      const describe = (element) => {
        if (!element || element === globalThis.document.body) {
          return element ? "<body>" : "nothing";
        }
        const role = element.getAttribute("role");
        // getAttribute, not className: an SVG element's className is an object.
        const className = element.getAttribute("class");
        const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
        return (
          `<${element.localName}${role ? ` role=${role}` : ""}` +
          `${className ? ` class="${className}"` : ""}> "${name.slice(0, 60)}"` +
          `${element.isConnected ? "" : " (detached)"}`
        );
      };
      return {
        held: node === active,
        detached: !node.isConnected,
        active: describe(active),
        target: describe(node),
      };
    });
    if (!sample.detached || attempt === 5) {
      return sample;
    }
  }
}

async function openShellMenu(page) {
  await page.locator(".account-toggle").click();
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
  const alphaAgent = await fixture.createAgent(alpha.id, "Alpha <script>alert(1)</script>");
  const betaAgent = await fixture.createAgent(beta.id, "Beta agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  page.on("dialog", (dialog) => assert.fail(`Unexpected browser dialog: ${dialog.message()}`));

  // Through the sign-in form: a cold deep link keeps its Namespace across password sign-in.
  await loginThroughForm(page, fixture, `/console/?namespace=${beta.id}`);
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page.getByText("Beta agent").waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Namespace", exact: true }).isVisible(),
    true,
  );
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  // Resource content must remain text; the shared shell includes the OCE mascot.
  assert.equal(await page.locator(".content img").count(), 0);
  assert.equal(await page.locator(".sidebar .brand").textContent(), "OpenClaw Enterprise");
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
  await expectNoText(page, /apiKeyPath|workspaceId|credentialTtlSeconds/, () =>
    waitForIdleFetches(page),
  );

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
  await page.locator("#main").getByText(fixture.credentials.email.toLowerCase()).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Backends" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/backends\\?namespace=${beta.id}$`));

  await page.getByRole("link", { name: "Agents" }).click();
  await chooseNamespace(page, "Alpha");
  await page.getByText("Alpha <script>alert(1)</script>").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${alpha.id}$`));

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/console\/login$/);
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expectNoText(page, /Alpha|Beta|openai-primary/, () => waitForIdleFetches(page));
  assert.deepEqual(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    { local: {}, session: {} },
  );

  assert.deepEqual(nonAuthWriteRequests(requests), []);
  // List rows read revision history for Latest deployment and advisory permissions for their
  // Stop and Delete icons. Browsing these draft Agents must not read their detail or invoke any
  // deployment operation. The request log also includes the shell's deployment modules.
  const agentRequests = requests.filter(({ path }) => /\/deploy|\/agents\/agt_/.test(path));
  assert.deepEqual(
    [...new Set(agentRequests.map(({ method, path }) => `${method} ${path}`))].sort(),
    [
      "GET /console/agents/deployment-diagnostics.mjs",
      "GET /console/agents/deployment-evidence.mjs",
      "GET /console/agents/deployment-recovery.mjs",
      `GET /namespaces/${alpha.id}/agents/${alphaAgent.id}/permissions`,
      `GET /namespaces/${alpha.id}/agents/${alphaAgent.id}/revisions`,
      `GET /namespaces/${beta.id}/agents/${betaAgent.id}/permissions`,
      `GET /namespaces/${beta.id}/agents/${betaAgent.id}/revisions`,
    ].sort(),
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
  // Exact: the Namespace row "Observability access" is a link too.
  const link = page.getByRole("link", { name: "Observability", exact: true });
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
  await page.getByRole("menuitem", { name: "Sign out" }).click();
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
  await expectHeldPage(page, "Current agent", page.getByText("Slow agent", { exact: true }));
  // Namespace admission has finished, so switching away does not wait for the held read.
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowSuccess.release();
  await slowSuccess.waitForCompletion();
  // The page has settled the stale read (aborted or answered) and run its handler.
  await expectNoText(page, /Slow (new )?agent|unavailable|failed|interrupted/i, () =>
    waitForSettledFetches(page, slowAgentsPath, slowSuccessRead),
  );
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
  // A failed read the console still treated as current would show "Request interrupted".
  await expectNoText(page, /Slow (new )?agent|unavailable|failed|interrupted/i, () =>
    waitForSettledFetches(page, slowAgentsPath, slowErrorRead),
  );
  assert.equal(await page.getByText("Current agent").isVisible(), true);
});

// A caller with no readable Namespace saw "No readable Namespaces" in the selector and the panel,
// a Refresh in both the header and the panel, and "Namespaces remain available in navigation"
// (finding 2371). The panel now says it once and leaves Refresh to the header. A bookmarked link
// that names a Namespace (a member whose only grant was revoked) said "Choose another Namespace."
// beside a disabled selector; it now points at the same Refresh (finding 2393). This sign-in
// never listed the bookmarked Namespace, so the panel does not say access was lost (finding
// 2550).
test("Agents with no readable Namespace names it once and keeps one Refresh", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const granted = await fixture.createNamespace("Granted later", { ready: true });
  const agent = await fixture.createAgent(granted.id, "Bookmarked Agent");
  const denyAll = {
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  };
  for (const [path, title, text, selected] of [
    [
      "/console/agents",
      "No readable Namespaces",
      "Ask an administrator to create a Namespace or grant you access to one, then Refresh.",
      "None",
    ],
    [
      `/console/agents?namespace=${granted.id}`,
      "Namespace unavailable",
      "This Namespace is missing or not shared with you, and you cannot read any other Namespace. Ask an administrator to grant you access to one, then Refresh.",
      "Unavailable",
    ],
    // An Agent bookmark in that Namespace kept the Agent page's header above the panel: the
    // unreadable Agent's ID and copy button, a "← Agents" link to the same page and a cut-off
    // selector (finding 2400). It takes the Agents list's header instead.
    [
      `/console/agents/${agent.id}?namespace=${granted.id}`,
      "Namespace unavailable",
      "This Namespace is missing or not shared with you, and you cannot read any other Namespace. Ask an administrator to grant you access to one, then Refresh.",
      "Unavailable",
    ],
  ]) {
    fixture.policy.restrictions.push(denyAll);
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    await login(page, fixture, path);
    const state = page.locator(".state-panel");
    await state.getByRole("heading", { name: title, exact: true }).waitFor();
    await state.getByText(text, { exact: true }).waitFor();
    assert.equal(await state.getByRole("button").count(), 0, `${path}: no second Refresh`);
    assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).count(), 1);
    if (title !== selected) {
      // Said once: the disabled selector reads only "None" or "Unavailable".
      assert.equal(await page.getByText(title).count(), 1);
    }
    const selector = page.getByRole("combobox", { name: "Namespace", exact: true });
    assert.equal(await selector.isDisabled(), true);
    assert.equal(await selector.locator("option:checked").textContent(), selected);
    // The compact selector shows its whole selection, not "Namespace una…" (finding 2423).
    assert.ok(
      await selector.evaluate((select) => {
        const style = globalThis.getComputedStyle(select);
        const context = globalThis.document.createElement("canvas").getContext("2d");
        context.font = style.font;
        const text = context.measureText(select.selectedOptions[0].textContent).width;
        const room =
          select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return text <= room;
      }),
      `${path}: the selector's text fits`,
    );
    await page.getByRole("heading", { level: 1, name: "Agents", exact: true }).waitFor();
    assert.equal(await page.locator(".page-header--subpage").count(), 0, path);
    assert.equal(await page.getByRole("button", { name: "Copy Agent ID" }).count(), 0, path);
    assert.equal(await page.getByText(agent.id).count(), 0, path);

    // Granted access shows once the reader presses the header's Refresh.
    fixture.policy.restrictions.splice(fixture.policy.restrictions.indexOf(denyAll), 1);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.locator("#namespace-selector:not(:disabled)").waitFor();
    await expectNoText(page, new RegExp(title), () => waitForIdleFetches(page));
  }
});

// Secrets are scoped to a Namespace as Agents are: a URL naming one the caller cannot read shows
// the unavailable panel and reads nothing for it.
test("Secrets for a Namespace the caller cannot read shows Namespace unavailable", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  await fixture.createNamespace("Readable", { ready: true });
  const unreadable = "ns_00000000-0000-4000-8000-000000000099";
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  await trackSettledFetches(page);
  await login(page, fixture, `/console/secrets?namespace=${unreadable}`);
  await page
    .locator(".state-panel")
    .getByRole("heading", { name: "Namespace unavailable", exact: true })
    .waitFor();
  await waitForIdleFetches(page);
  assert.deepEqual(
    requests.filter((request) => request.path.startsWith(`/namespaces/${unreadable}`)),
    [],
  );
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
  await trackSettledFetches(page);
  await login(page, fixture, "/console/backends");
  await page.getByText("openai-primary", { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), null);
  // A settled view is retained reusable, so returning to it takes the unchanged fast path.
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .locator("#main")
    .getByText(fixture.credentials.email.toLowerCase(), { exact: true })
    .waitFor();
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
  await expectNoText(page, /No readable Namespaces/, () => waitForIdleFetches(page));
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

// A return keeps the page already on screen, inert, while the retained destination revalidates.
// The destination's cached view is never painted before its reads pass (`hidden` stays absent).
async function expectHeldPage(page, shownText, hidden) {
  const held = page.locator('.content [aria-live="polite"][inert]');
  await held.getByText(shownText, { exact: true }).first().waitFor();
  assert.equal(await held.count(), 1);
  assert.equal(await page.locator(".shell[inert]").count(), 0);
  await expectNoText(page, /Checking session|Checking Namespace access/);
  if (hidden) {
    assert.equal(
      await hidden.count(),
      0,
      "the retained destination was painted before revalidating",
    );
  }
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
  await expectHeldPage(
    page,
    "Retained routes",
    page.getByText("Retained route Agent", { exact: true }),
  );
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
  await expectHeldPage(
    page,
    "Retained route Agent",
    page.getByText("A second Namespace", { exact: true }),
  );
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
  await expectHeldPage(
    page,
    "Retained route Agent",
    page.getByText("openai-primary", { exact: true }),
  );
  await releaseHeldRoute(page, backendsPattern, backendsHold);
  await page.getByRole("heading", { name: "Backends", exact: true }).waitFor();

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page
    .locator("#main")
    .getByText(fixture.credentials.email.toLowerCase(), { exact: true })
    .waitFor();
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
  await expectHeldPage(page, "Retained route Agent", page.locator("dl.settings"));
  await releaseHeldRoute(page, sessionPattern, sessionHold);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();

  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("link", { name: "Retained route Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Retained route Agent", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  const workspaceNotice = WORKSPACE_FILES_UNAVAILABLE;
  await page.getByText(workspaceNotice, { exact: true }).waitFor();
  await page.locator(".native-admin-access").waitFor({ state: "attached" });
  await waitForSettledView(page);
  const originalNativePanel = await page.locator(".native-admin-access").elementHandle();
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  // The detail stays shown, inert, until the retained list revalidates.
  await page
    .locator('.content [aria-live="polite"]:not([inert])')
    .getByRole("link", { name: "Retained route Agent", exact: true })
    .waitFor();
  const detailPattern = "**/namespaces/" + namespace.id + "/agents/" + agent.id;
  const detailHold = await holdRoute(t, page, detailPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => detailHold.release());
  await page.goBack();
  await detailHold.waitForRelease();
  await expectHeldPage(page, "Retained route Agent", page.getByText(workspaceNotice));
  assert.equal(new URL(page.url()).searchParams.get("tab"), "workspace");
  await releaseHeldRoute(page, detailPattern, detailHold);
  await page.locator('.content [aria-live="polite"]:not([inert])').waitFor();
  assert.equal(
    await originalNativePanel.evaluate((node) => node.isConnected),
    true,
    "Native admin access is not reconstructed after admission succeeds",
  );
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
  createSessionHold.release();
  await createSessionHold.waitForCompletion();
  await page.unroute(sessionPattern);
  // A default starter form is kept like any other draft and returns editable (finding 1902).
  await page.waitForFunction(() => {
    const name = globalThis.document.querySelector("#agent-name");
    return name?.value === "Retained draft Agent" && !name.closest("[inert]");
  });
  assert.equal(await page.getByLabel("Preset template").count(), 0);
});

test("the account menu stays open and focused while the page under it finishes loading", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Open menu", { ready: true });
  await fixture.createAgent(namespace.id, "Open menu Agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Open menu Agent", { exact: true }).waitFor();
  await waitForSettledView(page);

  // Hold the Namespaces read so the shell renders its Loading state first and re-renders
  // with the fresh view only after the reader has opened the account menu. A retained
  // preview followed by a fresh render takes the same path through the shell.
  const namespacesPattern = "**/namespaces";
  const namespacesHold = await holdRoute(t, page, namespacesPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => namespacesHold.release());
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await namespacesHold.waitForRelease();
  await openShellMenu(page);
  const settings = page.getByRole("menuitem", { name: "Settings", exact: true });
  await settings.waitFor();
  const openedItem = await settings.elementHandle();
  await releaseHeldRoute(page, namespacesPattern, namespacesHold);
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();

  assert.equal(
    await openedItem.evaluate(
      (node) => node.isConnected && node === globalThis.document.activeElement,
    ),
    true,
    "The re-rendered shell keeps the open menu and its focus",
  );
  await settings.click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.equal(await settings.isVisible(), false, "Navigating closes the menu");
});

for (const focus of ["navigation link", "account menu"]) {
  test(`an open mobile drawer keeps its ${focus} focused while the page under it finishes loading`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Open drawer", { ready: true });
    await fixture.createAgent(namespace.id, "Open drawer Agent");
    const { page } = await newPage(t, fixture, mobile);
    await trackSettledFetches(page);
    await login(page, fixture, "/console/agents?namespace=" + namespace.id);
    await page.getByText("Open drawer Agent", { exact: true }).waitFor();
    await waitForSettledView(page);

    // Hold the Namespaces read so the shell renders its Loading state first and re-renders
    // with the fresh view only after the reader has reopened the drawer.
    const namespacesPattern = "**/namespaces";
    const namespacesHold = await holdRoute(t, page, namespacesPattern, (route, response) =>
      response ? route.fulfill({ response }) : route.continue(),
    );
    t.after(() => namespacesHold.release());
    const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
    await toggle.click();
    await page.getByRole("link", { name: "Namespaces", exact: true }).click();
    await namespacesHold.waitForRelease();
    await toggle.click();
    const agents = page.getByRole("link", { name: "Agents", exact: true });
    let focused = agents;
    if (focus === "account menu") {
      await openShellMenu(page);
      focused = page.getByRole("menuitem", { name: "Settings", exact: true });
    }
    await focused.waitFor();
    const opened = await focusState(focused);
    if (!opened.held) {
      assert.fail(
        `The opened drawer focuses its ${focus} ${opened.target}; focus is on ${opened.active}` +
          ` (drawer ${await toggle.getAttribute("aria-expanded")})`,
      );
    }
    await releaseHeldRoute(page, namespacesPattern, namespacesHold);
    await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();

    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "The drawer stays open");
    assert.equal(await page.locator("main").evaluate((node) => node.inert), true);
    const kept = await focusState(focused);
    assert.equal(
      kept.held,
      true,
      `The re-rendered drawer keeps focus on its ${focus} ${kept.target}; focus is on ${kept.active}`,
    );
    await focused.click();
    const destination = focus === "account menu" ? "Settings" : "Agents";
    await page.getByRole("heading", { name: destination, exact: true }).waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Navigating closes it");
    assert.equal(await page.locator("main").evaluate((node) => node.inert), false);
  });
}

test("an open mobile drawer keeps its navigation link focused when an address without a Namespace finishes loading", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Cold drawer", { ready: true });
  await fixture.createAgent(namespace.id, "Cold drawer Agent");
  const { page } = await newPage(t, fixture, mobile);
  await trackSettledFetches(page);
  await login(page, fixture, "/console/agents?namespace=" + namespace.id);
  await page.getByText("Cold drawer Agent", { exact: true }).waitFor();
  await waitForSettledView(page);

  // A bookmark, a typed address or the post-login return has no ?namespace=: the Loading
  // render's nav links have none, and the fresh render's links gain it.
  const namespacesPattern = "**/namespaces";
  const namespacesHold = await holdRoute(t, page, namespacesPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => namespacesHold.release());
  await page.goto(new URL("/console/agents", fixture.origin).href);
  await namespacesHold.waitForRelease();
  const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
  await toggle.click();
  const agents = page.getByRole("link", { name: "Agents", exact: true });
  await agents.waitFor();
  assert.equal(await agents.getAttribute("href"), "/console/agents");
  const opened = await focusState(agents);
  assert.equal(
    opened.held,
    true,
    `The opened drawer focuses its navigation link ${opened.target}; focus is on ${opened.active}`,
  );
  await releaseHeldRoute(page, namespacesPattern, namespacesHold);
  await page.getByText("Cold drawer Agent", { exact: true }).waitFor();
  await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();

  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "The drawer stays open");
  assert.equal(await page.locator("main").evaluate((node) => node.inert), true);
  assert.equal(await agents.getAttribute("href"), `/console/agents?namespace=${namespace.id}`);
  const kept = await focusState(agents);
  assert.equal(
    kept.held,
    true,
    `The re-rendered drawer keeps focus on its navigation link ${kept.target}; focus is on ${kept.active}`,
  );
  await page.keyboard.press("Escape");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Escape closes it");
  assert.equal(await page.locator("main").evaluate((node) => node.inert), false);
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
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  const workspaceNotice = page.getByText(WORKSPACE_FILES_UNAVAILABLE, { exact: true });
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

test("Refresh reloads and focus restoration retains rows until fresh data arrives", async (t) => {
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
    if (trigger === "Refresh") {
      // Refresh rebuilds the page, so a slow one shows loading after 250 ms (finding 1442).
      await page.getByText("Checking Namespace access.", { exact: true }).waitFor();
    } else {
      await expectHeldPage(page, "Existing background Agent");
    }
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
  expireSessions(fixture);
  const sessionPattern = "**/api/auth/session";
  const expiredSession = await holdRoute(t, page, sessionPattern, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => expiredSession.release());
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await expiredSession.waitForRelease();
  await expectHeldPage(
    page,
    "Retained invalidation",
    page.getByText("Denied retained Agent", { exact: true }),
  );
  await releaseHeldRoute(page, sessionPattern, expiredSession);
  await page.getByText("Your session has expired").waitFor();
  await expectNoText(page, /Denied retained Agent/, () => waitForIdleFetches(page));

  fixture.memoryDatabase.session.length = 0;
  await login(page, fixture, "/console/agents/" + agent.id + "?namespace=" + namespace.id);
  await page.getByRole("heading", { name: "Denied retained Agent", exact: true }).waitFor();
  // The heading shows before the detail finishes loading; leaving earlier keeps no preview.
  await waitForSettledView(page);
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  // The detail stays on screen, inert, until the list replaces it.
  await page.getByRole("link", { name: "Denied retained Agent", exact: true }).waitFor();
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
  // The list stays while the denied Agent's read runs; its cached detail never appears.
  await expectHeldPage(
    page,
    "Denied retained Agent",
    page.getByRole("heading", { name: "Denied retained Agent", exact: true }),
  );
  assert.equal(await page.locator(".agent-current-summary").count(), 0);
  await releaseHeldRoute(page, detailPattern, deniedAgent);
  await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
  // Someone else's Agent link says what the reader can do, not that a collection is unreadable.
  await page
    .getByText(
      "You do not have access to this Agent or its settings, or it was deleted. Ask its owner to share it with you.",
    )
    .waitFor();
  await expectNoText(page, /Configuration draft|Selected revision/, () => waitForIdleFetches(page));
});

// Both shared admission reads must revoke every preview when their outcome is unknown.
for (const gate of ["/api/auth/session", "/namespaces"]) {
  test(`console clears all retained pages after ${gate} fails`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Admission failure", { ready: true });
    await fixture.createAgent(namespace.id, "Private cached Agent");
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
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
    await expectNoText(page, /Private cached Agent|Admission failure/, () =>
      waitForIdleFetches(page),
    );
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

// An account can stay signed in after its IAM identity is removed, so /namespaces refuses it on
// every load. Both checks that read it must offer a way out (finding 1894): a page load, and the
// in-place recheck an open Agent page runs on refocus. Signing out then leaves a tab whose next
// deep link is a first visit (finding 1893).
for (const check of ["a page load", "an Agent page refocus"]) {
  test(`an account refused Namespace access can sign out after ${check}`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Removed identity", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Removed identity Agent");
    const { page } = await newPage(t, fixture);
    await trackSettledFetches(page);
    if (check === "a page load") {
      await login(page, fixture, "/console/namespaces");
      await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
    } else {
      await login(page, fixture, `/console/agents/${agent.id}?namespace=${namespace.id}`);
      await page.getByRole("heading", { name: "Removed identity Agent", exact: true }).waitFor();
      await waitForSettledView(page);
    }

    fixture.policy.identities.length = 0;
    const refused = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/namespaces",
    );
    if (check === "a page load") {
      await page.reload();
    } else {
      await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
    }
    assert.equal((await refused).status(), 403);
    await page.getByRole("heading", { name: "No access", exact: true }).waitFor();
    await page
      .getByText("Your account has no access to this Installation. Try again or sign out.")
      .waitFor();
    await expectNoText(page, /Removed identity/, () => waitForIdleFetches(page));
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.waitForURL(/\/console\/login$/);
    const session = await page.request.get(`${fixture.origin}/api/auth/session`);
    assert.notEqual((await session.json()).data?.authenticated, true);

    await page.goto(`${fixture.origin}/console/namespaces`);
    await page.getByLabel("Email", { exact: true }).waitFor();
    await expectNoText(page, /Your session has expired/, () => waitForIdleFetches(page));
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
  // A failed check clears the loaded session. Retry must still honor its pinned key.
  await page.route("**/api/auth/session", (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.goBack();
  await page.getByText("Session unavailable", { exact: true }).waitFor();
  const refused = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === "/api/auth/session",
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  // This tab pinned the key of its own session. The controller refuses the
  // replaced cookie for it, so the tab signs out rather than acting as another session.
  const refusedSession = await refused;
  assert.equal(refusedSession.status(), 401);
  assert.ok(refusedSession.request().headers()["x-occ-session-key"]);
  await page.getByText("Your session has expired").waitFor();
  assert.equal(await page.locator("#agent-name").count(), 0);
  assert.equal(await page.locator(".content [inert]").count(), 0);

  // A fresh sign-in restores the validated route, never the old session's draft.
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/agents/new");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespace.id);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).click();
  assert.equal(await page.getByLabel("Agent name", { exact: true }).inputValue(), "");
});

test("an abandoned GitHub attempt does not turn password sign-in into a GitHub failure", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByLabel("Email", { exact: true }).waitFor();
  // Models returning from github.com without completing the callback.
  await page.evaluate(() => sessionStorage.setItem("occ.console.githubAttempt", "a".repeat(43)));
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/console\/agents/);
  assert.equal(requests.includes("/api/auth/providers/github/result"), false);
  await expectNoText(page, /Could not (?:finish signing|sign) in with GitHub/, async () => {
    await page.locator(settledView).waitFor();
    await waitForIdleFetches(page);
  });
});

test("Google sign-in accepts only a Google authorization URL and confirms through its own result", async (t) => {
  const fixture = await signInApp(t);
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
  // The unconfigured controller refuses the result, so this tab adopts no session. The
  // callback already settled the identity, so the refusal does not read as an identity failure.
  assert.equal(refused.status(), 403);
  await page.getByText(GOOGLE_EXCHANGE_REFUSED).waitFor();
  assert.equal(requests.includes("/api/auth/providers/github/result"), false);

  await page.goto(`${fixture.origin}/console/?authError=google`);
  await page.getByText("Could not sign in with Google. Try again or use your password.").waitFor();
});

const GOOGLE_EXCHANGE_REFUSED =
  "Could not finish signing in with Google. The sign-in in this tab did not complete in time, or another sign-in replaced it. Select Continue with Google to start again.";
const UNTRUSTED_ORIGIN_SIGN_IN =
  "Sign-in was refused because this page was not opened from the console's configured address. Open the console from its configured URL and sign in there. If you did, ask an operator to check the console address setting (OCC_AUTH_BASE_URL) and any proxy in front of it.";

// Each failure says what happened and what to do; a rate limit, an outage or the origin
// check never reads as a wrong password or a refused identity (finding 2535).
test("sign-in failures name a rate limit, an outage and the origin check", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  const failure = (status, code, message, headers = {}) => ({
    status,
    headers,
    contentType: "application/json",
    body: JSON.stringify({ error: { code, message }, meta: { requestId: "browser-sign-in" } }),
  });
  const limited = (seconds) =>
    failure(429, "RATE_LIMITED", "Too many attempts.", { "retry-after": String(seconds) });
  const outage = failure(503, "DEPENDENCY_UNAVAILABLE", "Sign-in is temporarily unavailable.");
  const signIn = async (expected) => {
    await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
    // A wrong password: no step may sign in, whatever the API answers.
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText(expected, { exact: true }).waitFor();
  };
  await page.goto(`${fixture.origin}/console/login`);

  // The real API refuses a sign-in sent from another Origin before it reads the password.
  // The browser keeps its own Origin, so the request is resent from the test with another.
  await page.route("**/api/auth/sign-in/email", async (route) =>
    route.fulfill({
      response: await route.fetch({
        headers: { ...route.request().headers(), origin: "https://elsewhere.example.test" },
      }),
    }),
  );
  const refused = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/sign-in/email"),
  );
  const signingIn = signIn(UNTRUSTED_ORIGIN_SIGN_IN);
  const answer = await refused;
  assert.equal(answer.status(), 403, await answer.text());
  await signingIn;
  await page.unroute("**/api/auth/sign-in/email");

  for (const [response, expected] of [
    [limited(37), "Too many sign-in attempts. Wait 37 seconds, then try again."],
    [
      failure(429, "RATE_LIMITED", "Too many attempts."),
      "Too many sign-in attempts. Wait a minute, then try again.",
    ],
    [
      outage,
      "Sign-in is temporarily unavailable because a service it depends on did not answer. Try again shortly. If it continues, ask an operator.",
    ],
    [null, "Could not reach the sign-in service. Check your connection, then try again."],
  ]) {
    await page.route("**/api/auth/sign-in/email", (route) =>
      response === null ? route.abort("connectionrefused") : route.fulfill(response),
    );
    await signIn(expected);
    await page.unroute("**/api/auth/sign-in/email");
  }

  // Provider start: a limit waits, and the origin check is not a provider outage.
  const envelope = (data) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "browser-sign-in" } }),
  });
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill(envelope({ github: false, google: true, sessionBinding: true })),
  );
  const starts = [limited(1), failure(403, "FORBIDDEN", UNTRUSTED_ORIGIN_MESSAGE)];
  await page.route("**/api/auth/providers/google/start", (route) => {
    const next = starts.shift();
    return next === undefined
      ? route.fulfill(
          envelope({
            url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture",
            attemptId: "c".repeat(43),
          }),
        )
      : route.fulfill(next);
  });
  await page.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 302, headers: { location: `${fixture.origin}/console/` } }),
  );
  await page.goto(`${fixture.origin}/console/login`);
  const google = page.getByRole("button", { name: "Continue with Google" });
  await google.click();
  await page.getByText("Too many sign-in attempts. Wait 1 second, then try again.").waitFor();
  await google.click();
  await page.getByText(UNTRUSTED_ORIGIN_SIGN_IN, { exact: true }).waitFor();

  // The exchange after the provider's callback: the identity is already settled.
  for (const [response, expected] of [
    [limited(12), "Too many sign-in attempts. Wait 12 seconds, then try again."],
    [
      outage,
      "Could not finish signing in with Google. Sign-in is unavailable right now; try again later.",
    ],
    [failure(403, "FORBIDDEN", UNTRUSTED_ORIGIN_MESSAGE), UNTRUSTED_ORIGIN_SIGN_IN],
    [
      failure(401, "UNAUTHENTICATED", "Google sign-in could not be confirmed."),
      GOOGLE_EXCHANGE_REFUSED,
    ],
  ]) {
    await page.route("**/api/auth/providers/google/result", (route) => route.fulfill(response));
    await google.click();
    await page.getByText(expected, { exact: true }).waitFor();
    await page.unroute("**/api/auth/providers/google/result");
  }
});

test("OIDC sign-in uses the discovered label and accepts only the discovered endpoint", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
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
    .getByText(
      "Could not finish signing in with Acme SSO. The sign-in in this tab did not complete in time, or another sign-in replaced it. Select Continue with Acme SSO to start again.",
    )
    .waitFor();
  assert.equal(requests.includes("/api/auth/providers/google/result"), false);

  // A non-HTTPS discovered endpoint offers no OIDC button at all.
  discovery = {
    ...discovery,
    oidcSignIn: { label: "Acme SSO", authorizationUrl: "http://sso.example.test/auth" },
  };
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByLabel("Email", { exact: true }).waitFor();
  await expectNoText(page, /Continue with Acme SSO/, () => waitForIdleFetches(page));
});

test("GitHub allowlist refusals tell the person why, and other reasons stay generic", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
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
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expectNoText(page, /organization/, () => waitForIdleFetches(page));
});

test("a disabled account's provider sign-in says the account is disabled", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  let password = true;
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { github: true, google: true, password, sessionBinding: true },
        meta: { requestId: "browser-account-disabled" },
      }),
    }),
  );
  // Any provider's callback may carry it; neither a retry, a password nor an attach can help,
  // so the advice names only an administrator, with or without password sign-in.
  for (const [provider, label] of [
    ["github", "GitHub"],
    ["google", "Google"],
  ]) {
    for (const available of [true, false]) {
      password = available;
      await page.goto(
        `${fixture.origin}/console/?authError=${provider}&authReason=account-disabled`,
      );
      await page
        .getByText(
          `Your account is disabled, so you cannot sign in with ${label}. Ask an administrator to enable it.`,
          { exact: true },
        )
        .waitFor();
      await expectNoText(page, /attach your|use your password/, () => waitForIdleFetches(page));
    }
  }
  // Without a provider error the reason means nothing.
  password = true;
  await page.goto(`${fixture.origin}/console/?authReason=account-disabled`);
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expectNoText(page, /disabled/, () => waitForIdleFetches(page));
});

test("a provider outage says sign-in is unavailable, not to get attached", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  let password = true;
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          github: true,
          google: true,
          oidc: true,
          oidcSignIn: {
            label: "Acme SSO",
            authorizationUrl: "https://sso.example.test/realms/acme/protocol/openid-connect/auth",
          },
          password,
          sessionBinding: true,
        },
        meta: { requestId: "browser-provider-unavailable" },
      }),
    }),
  );
  // Discovery remembers the OIDC label for the message after the callback redirect.
  await page.goto(`${fixture.origin}/console/login`);
  await page.getByRole("button", { name: "Continue with Acme SSO" }).waitFor();
  for (const [provider, label] of [
    ["github", "GitHub"],
    ["google", "Google"],
    ["oidc", "Acme SSO"],
  ]) {
    for (const [available, outage] of [
      [true, `${label} sign-in is unavailable right now. Try again later or use your password.`],
      [
        false,
        `${label} sign-in is unavailable right now. Try again later. If you are an administrator, use Recovery sign-in.`,
      ],
    ]) {
      password = available;
      // The provider could not answer, or refused this Installation's client.
      await page.goto(
        `${fixture.origin}/console/?authError=${provider}&authReason=provider-unavailable`,
      );
      await page.getByText(outage, { exact: true }).waitFor();
      await expectNoText(page, /attach your/, () => waitForIdleFetches(page));
      // The callback failed inside OCE: no fallback finishes a sign-in either.
      await page.goto(`${fixture.origin}/console/?authError=${provider}&authReason=unavailable`);
      await page
        .getByText(
          `Could not finish signing in with ${label}. Sign-in is unavailable right now; try again later.`,
          { exact: true },
        )
        .waitFor();
      await expectNoText(page, /attach your|use your password/, () => waitForIdleFetches(page));
    }
  }
  // Without a provider error the reason means nothing.
  password = true;
  await page.goto(`${fixture.origin}/console/?authReason=provider-unavailable`);
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expectNoText(page, /unavailable/, () => waitForIdleFetches(page));
});

test("recovery-only password sign-in keeps the form behind Recovery sign-in", async (t) => {
  const fixture = await signInApp(t);
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
  // Without the form, the line that describes its email field is hidden too.
  assert.equal(await page.locator("#username-hint").isVisible(), false);
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
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill("not-the-recovery-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByText(
      "Could not sign in. Only the recovery account can use a password; other accounts continue with their external sign-in.",
    )
    .waitFor();
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/console\/agents/);
});

test("password sign-in stays visible unless discovery reports it recovery-only", async (t) => {
  const fixture = await signInApp(t);
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
  await trackSettledFetches(page);
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
  await expectNoText(page, /Removed from access/, () => waitForIdleFetches(page));
});

// Namespace rows were inert and their status badges showed raw lowercase enum values in one grey
// (finding 1897). Each row now opens its Namespace's Agents, and statuses read as words with a tone.
test("Namespaces rows open their Agents and status badges use words with a tone", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const ready = await fixture.createNamespace("Linked ready", { ready: true });
  const provisioning = await fixture.createNamespace("Linked provisioning");
  const retiring = await fixture.createNamespace("Linked retiring", { ready: true });
  assert.equal((await fixture.request("DELETE", `/namespaces/${retiring.id}`)).status, 202);
  await fixture.createAgent(ready.id, "Linked Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/namespaces?namespace=${provisioning.id}`);
  const list = page.getByRole("list", { name: "Namespaces", exact: true });
  await list.waitFor();
  for (const [namespace, label, tone] of [
    [ready, "Ready", "success"],
    [provisioning, "Provisioning", "warning"],
    [retiring, "Deleting", "warning"],
  ]) {
    const row = list.getByRole("listitem").filter({ hasText: namespace.id });
    const link = row.getByRole("link", { name: namespace.name, exact: true });
    assert.equal(
      await link.getAttribute("href"),
      `/console/agents?namespace=${encodeURIComponent(namespace.id)}`,
    );
    const badge = row.locator(".badge");
    assert.equal(await badge.textContent(), label);
    assert.equal(await badge.getAttribute("data-tone"), tone);
  }
  // The ID stays selectable above the row's link area, so clicking it stays on Namespaces.
  const row = list.getByRole("listitem").filter({ hasText: ready.id });
  await row.locator(".resource-id").click();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  // Selecting anywhere else on the row opens that Namespace's Agents in place.
  const box = await row.boundingBox();
  await row.click({ position: { x: box.width / 2, y: box.height - 6 } });
  await page.waitForURL(`**/console/agents?namespace=${ready.id}`);
  await page.getByText("Linked Agent", { exact: true }).waitFor();
  assert.equal(await page.locator("#namespace-selector").inputValue(), ready.id);
  // From the keyboard, Back returns focus to the row that was opened.
  await page.goBack();
  const provisioningLink = list.getByRole("link", { name: provisioning.name, exact: true });
  await provisioningLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/console/agents?namespace=${provisioning.id}`);
  await page.goBack();
  await page.waitForURL(`**/console/namespaces?namespace=${provisioning.id}`);
  await page.waitForFunction(
    (name) => globalThis.document.activeElement?.textContent === name,
    provisioning.name,
  );

  // Backend types are names, not states: human-cased and neutral.
  await page.goto(`${fixture.origin}/console/backends?namespace=${ready.id}`);
  const backend = page.getByRole("list", { name: "Backends", exact: true }).getByRole("listitem");
  await backend.getByText("openai-primary", { exact: true }).waitFor();
  assert.equal(await backend.locator(".badge").textContent(), "ChatGPT");
  assert.equal(await backend.locator(".badge").getAttribute("data-tone"), null);
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

// A member opening Backends was told "…access to this page in this Namespace… or choose
// another Namespace", with the Namespace selector shown, on an Installation-wide page (finding
// 1491). The denial now names Backends, and the selector, which cannot change it, is hidden.
test("a Backends denial names the Installation-wide page and hides the Namespace selector", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Backend member", { ready: true });
  fixture.policy.restrictions.push({
    id: "deny-backend-administration",
    resourceKind: "installation",
    action: "administer",
    effect: "deny",
  });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/backends?namespace=${namespace.id}`);
  const denial = page.locator(".state-panel");
  await denial.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
  await denial
    .getByText(
      "Your account does not have access to Backends. Backends apply to the whole Installation, so choosing another Namespace would not change this. Ask an Installation administrator for access.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Namespace", exact: true }).count(), 0);
  // Retry rebuilds the page with the selector still hidden.
  const oldPanel = await denial.elementHandle();
  await denial.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForFunction((panel) => !panel.isConnected, oldPanel);
  await page.locator(".state-panel").getByRole("heading", { name: "Access denied" }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Namespace", exact: true }).count(), 0);
  // Agents keep the Namespace wording and selector.
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("combobox", { name: "Namespace", exact: true }).waitFor();
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
  await trackSettledFetches(page);

  await login(page, fixture, `/console/agents?namespace=${alpha.id}`);
  await page.getByText("Alpha mobile agent").waitFor();

  await chooseNamespace(page, "Beta");

  await page.getByText("Beta mobile agent").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  await expectNoText(
    page,
    /Use your account email|Your session has expired|Could not confirm logout/,
    () => waitForIdleFetches(page),
  );
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

// A stale option can dispatch a change even on a disabled select. Check that it starts no
// admission or navigation, including a reload of the same Namespace already in the URL.
async function rejectStaleNamespaceOption(page, selector, staleId, requests) {
  const url = page.url();
  const count = requests.length;
  await selector.evaluate((select, id) => {
    const option = new globalThis.Option("Stale selection", id);
    select.add(option);
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    option.remove();
  }, staleId);
  await settlePageRequests(page);
  assert.equal(page.url(), url);
  assert.deepEqual(
    requests.slice(count).map(({ path }) => path.split("?")[0]),
    ["/console/favicon-16.png"],
  );
}

for (const trigger of ["Refresh", "Back with a replacement session"]) {
  for (const [feature, placement] of Object.entries({ namespaces: "inline", agents: "header" })) {
    test(`${placement} Namespace selection waits for current admission during ${trigger}`, async (t) => {
      const fixture = await createConsoleAppFixture(t);
      await fixture.bootstrap();
      const alpha = await fixture.createNamespace("Previously readable", { ready: true });
      const beta = await fixture.createNamespace("Still readable", { ready: true });
      const back = trigger !== "Refresh";
      const requested = back ? alpha.id : "ns_00000000-0000-4000-8000-000000000099";
      const target = `/console/${feature}?namespace=${requested}`;
      const { page } = await newPage(t, fixture, mobile);
      await trackSettledFetches(page);
      await login(page, fixture, target);
      await page
        .getByText("Previously readable", { exact: true })
        .first()
        .waitFor({ state: "attached" });

      if (back) {
        // Leave the readable Namespace in history. Back will request that same destination.
        await page.getByRole("button", { name: "Open navigation", exact: true }).click();
        const away = feature === "agents" ? "Namespaces" : "Agents";
        await page.getByRole("link", { name: away, exact: true }).click();
        await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
      }
      fixture.policy.restrictions.push({
        id: "deny-previously-readable-namespace",
        namespaceId: alpha.id,
        resourceKind: "namespace",
        action: "read",
        effect: "deny",
      });
      const signIn = "/api/auth/sign-in/email";
      if (back) {
        // Sign in from a second tab in the same cookie jar, without navigating this tab.
        const other = await page.context().newPage();
        await other.goto(`${fixture.origin}/console/favicon-16.png`);
        const status = await other.evaluate(
          async ({ path, email, password }) => {
            const response = await fetch(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email, password }),
            });
            return response.status;
          },
          {
            path: signIn,
            email: fixture.credentials.email,
            password: fixture.credentials.password,
          },
        );
        assert.equal(status, 200);
      }

      const requests = apiRequests(page, fixture.origin);
      const reply = (route, response) => route.fulfill({ response });
      const session = "**/api/auth/session";
      const namespaces = "**/namespaces";
      const check = await holdRoute(t, page, session, reply);
      const admission = await holdRoute(t, page, namespaces, reply);
      t.after(() => {
        check.release();
        admission.release();
      });
      if (back) {
        await page.goBack();
      } else {
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
      }

      const selector = page.locator("#namespace-selector");
      await check.waitForRelease();
      assert.equal(await page.locator("#namespace-selector:not(:disabled)").count(), 0);
      assert.equal(await selector.locator('option:not([value=""])').count(), 0);
      const sessionResponse = page.waitForResponse(session);
      await releaseHeldRoute(page, session, check);
      assert.equal((await sessionResponse).status(), back ? 401 : 200);
      if (back) {
        await page.getByText("Your session has expired").waitFor();
        assert.equal(await selector.count(), 0);
        await expectNoText(page, /Previously readable/, () => waitForIdleFetches(page));
        await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
        await page.getByLabel("Password").fill(fixture.credentials.password);
        await page.getByRole("button", { name: "Sign in" }).click();
      }

      // The URL can name the old Namespace. Neither surface may offer it while admission is pending.
      await admission.waitForRelease();
      const pendingShell = page.getByText("Checking Namespace access.", { exact: true });
      await pendingShell.waitFor();
      assert.equal(page.url(), fixture.origin + target);
      // The pending shell is the held load's last render (its loading timer has fired) until
      // admission answers, so the check after it is final.
      await expectNoText(page, /Previously readable/, () => pendingShell.waitFor());
      if (placement === "inline" && back) {
        // Sign-in cleared the previous list. Inline recovery appears only once this read returns.
        assert.equal(await selector.count(), 0);
      } else {
        assert.equal(await selector.isDisabled(), true);
        assert.equal(await selector.locator('option:not([value=""])').count(), 0);
        await rejectStaleNamespaceOption(page, selector, alpha.id, requests);
      }

      const listed = page.waitForResponse(namespaces);
      await releaseHeldRoute(page, namespaces, admission);
      const response = await listed;
      assert.equal(response.status(), 200);
      const readable = (await response.json()).data.map(({ id }) => id);
      assert.equal(
        readable.includes(alpha.id),
        false,
        "fresh admission excludes revoked Namespace",
      );
      assert.equal(readable.includes(beta.id), true, "fresh admission includes readable Namespace");
      await page.getByRole("heading", { name: "Namespace unavailable", exact: true }).waitFor();
      assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 0);
      await rejectStaleNamespaceOption(page, selector, alpha.id, requests);
      await selector.selectOption(beta.id);
      await page.waitForURL(`**/console/${feature}?namespace=${beta.id}`);
      await page.locator('.content [aria-live="polite"][aria-busy="false"]').waitFor();
      assert.equal(await selector.locator(`option[value="${alpha.id}"]`).count(), 0);

      assert.deepEqual(
        requests.filter(({ path }) => path.includes(alpha.id)).map(({ path }) => path),
        [],
      );
      assert.deepEqual(
        writeRequests(requests).map(({ path }) => path),
        back ? [signIn] : [],
      );
    });
  }
}

test("Namespaces recovers stale selection inline and handles losing all readable scopes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  const missingId = "ns_00000000-0000-4000-8000-000000000099";
  const { page } = await newPage(t, fixture, mobile);
  await login(page, fixture, `/console/namespaces?namespace=${missingId}`);
  // A navigation keeps the previous list on screen, inert and busy, until the next one replaces it.
  const shownList = page
    .locator('.content [aria-live="polite"][aria-busy="false"]')
    .getByRole("list", { name: "Namespaces", exact: true });
  await shownList.waitFor();

  // A stale bookmark must offer recovery on this page without opening the drawer.
  const selector = page.getByRole("combobox", { name: "Choose a valid Namespace", exact: true });
  assert.equal(await selector.isVisible(), true);
  assert.equal(await page.locator(".page-header select").count(), 0);
  await selector.selectOption({ label: "Alpha" });
  await shownList.waitFor();
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
  await shownList.waitFor();

  // Revocation comes from the real IAM Driver; the recovery must never offer that scope.
  fixture.policy.restrictions.push({
    id: "deny-alpha-read",
    namespaceId: alpha.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await shownList.waitFor();
  await selector.waitFor();
  assert.equal(await page.getByRole("option", { name: "Alpha", exact: true }).count(), 0);
  await selector.selectOption({ label: "Beta" });
  await shownList.waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), beta.id);

  // Include the bootstrapped default Namespace when revoking every remaining scope.
  // Losing read access must still offer creation and explain how to regain existing scopes.
  fixture.policy.restrictions.push({
    id: "deny-all-namespace-read",
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: "No accessible namespaces", exact: true }).waitFor();
  await page
    .getByText(
      "Create a Namespace to get started, or ask an administrator for access to an existing one.",
      { exact: true },
    )
    .waitFor();
  await waitForEnabled(page.getByRole("button", { name: "Create Namespace", exact: true }));
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
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Revoked agent").waitFor();

  await page.route("**/api/auth/sign-out", async (route) => {
    await route.abort("failed");
  });
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByText("Could not confirm logout").waitFor();
  await expectNoText(page, /Revoked agent/, () => waitForIdleFetches(page));
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
  await expectNoText(page, /Revoked agent/, () => waitForIdleFetches(page));
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
  expireSessions(fixture);
  // The list may still be reading its Agent rows. A row read refused after expiry shows the
  // expired sign-in itself and moves to /console/login, where a reload is an ordinary sign-in.
  // Load the private page again, so either way the console must find the expired session.
  await page.goto(`${fixture.origin}/console/agents?namespace=${namespace.id}`);
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  await expectNoText(page, /Revoked agent/, () => waitForIdleFetches(page));

  await page.screenshot({ path: join(artifacts, "session-isolation.png"), fullPage: true });
});

test("widening an open mobile drawer restores usable desktop content", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Drawer resize", { ready: true });
  await fixture.createAgent(namespace.id, "Resizable Agent");
  const { page } = await newPage(t, fixture, {
    context: { viewport: { width: 390, height: 844 } },
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Resizable Agent", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  assert.equal(await page.locator("main").evaluate((node) => node.inert), true);

  // Desktop hides drawer controls, so content must become usable without Escape.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => !globalThis.document.querySelector("main").inert);
  await page.getByRole("searchbox", { name: "Search Agents", exact: true }).fill("Resizable");
  await page.getByRole("link", { name: "Resizable Agent", exact: true }).waitFor();
  assert.equal(await page.locator(".drawer-open").count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  assert.equal(await toggle.evaluate((node) => node === globalThis.document.activeElement), true);
  assert.equal(await page.locator("main").evaluate((node) => node.inert), false);
});

test("keyboard page navigation focuses the destination before its controls", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Keyboard navigation", { ready: true });
  await fixture.createAgent(namespace.id, "Keyboard Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Keyboard Agent", { exact: true }).waitFor();
  await page.getByRole("link", { name: "Namespaces", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  await page.locator('.content [aria-busy="false"]').waitFor();
  const heading = page.getByRole("heading", { name: "Namespaces", exact: true });
  assert.equal(await heading.evaluate((node) => node === globalThis.document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .evaluate((node) => node === globalThis.document.activeElement),
    true,
  );

  // Back reuses the admitted collection while giving the destination a focus target.
  await page.goBack();
  await page.locator('.content [aria-busy="false"]:not([inert])').waitFor();
  assert.equal(
    await page
      .getByRole("heading", { name: "Agents", exact: true })
      .evaluate((node) => node === globalThis.document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page
      .getByRole("combobox", { name: "Namespace", exact: true })
      .evaluate((node) => node === globalThis.document.activeElement),
    true,
  );
});

test("login restores a scrubbed Agent destination only after the tab confirms its provider session", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Login destination", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Destination Agent");
  const { page } = await newPage(t, fixture);
  const attemptId = "d".repeat(43);
  const envelope = (data) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "browser-login" } }),
  });
  let sessionKey;
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill(envelope({ github: true, sessionBinding: true })),
  );
  await page.route("**/api/auth/providers/github/start", (route) =>
    route.fulfill(
      envelope({ url: "https://github.com/login/oauth/authorize?client_id=fixture", attemptId }),
    ),
  );
  // Model the external provider and result exchange; the cookie and session are issued by
  // the real controller. Provider callback and receipt enforcement are covered separately.
  await page.route("https://github.com/**", async (route) => {
    assert.equal(new URL(route.request().url()).searchParams.has("return"), false);
    const signedIn = await page.context().request.post(`${fixture.origin}/api/auth/sign-in/email`, {
      headers: { origin: fixture.origin },
      data: { email: fixture.credentials.email, password: fixture.credentials.password },
    });
    assert.equal(signedIn.status(), 200);
    const session = await page.context().request.get(`${fixture.origin}/api/auth/session`);
    sessionKey = (await session.json()).data.sessionKey;
    assert.equal(typeof sessionKey, "string");
    await route.fulfill({ status: 302, headers: { location: `${fixture.origin}/console/` } });
  });
  await page.route("**/api/auth/providers/github/result", async (route) => {
    assert.equal(route.request().postDataJSON().attemptId, attemptId);
    await route.fulfill(envelope({ sessionKey }));
  });
  await page.goto(
    `${fixture.origin}/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials&token=discard-me`,
  );
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page.waitForURL(
    `**/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=credentials`,
  );
  await page.getByRole("heading", { name: "Destination Agent", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("tab", { name: "Credentials", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem("occ.console.loginIntent")), null);
  assert.equal(new URL(page.url()).searchParams.has("token"), false);
  for (const stored of [
    {
      attemptId,
      time: Date.now() - 11 * 60_000,
      intent: {
        kind: "console",
        feature: `agents/${agent.id}`,
        namespaceId: namespace.id,
        revision: null,
        tab: null,
      },
    },
    {
      attemptId: "f".repeat(43),
      time: Date.now(),
      intent: {
        kind: "console",
        feature: `agents/${agent.id}`,
        namespaceId: namespace.id,
        revision: null,
        tab: null,
      },
    },
    {
      attemptId,
      time: Date.now(),
      intent: {
        kind: "console",
        feature: "//evil.example",
        namespaceId: null,
        revision: null,
        tab: null,
      },
    },
  ]) {
    await page.evaluate(
      ({ attemptId, stored }) => {
        sessionStorage.setItem("occ.console.githubAttempt", attemptId);
        sessionStorage.setItem("occ.console.loginIntent", JSON.stringify(stored));
      },
      { attemptId, stored },
    );
    await page.goto(`${fixture.origin}/console/`);
    await page.waitForURL(/\/console\/agents(?:\?|$)/);
    assert.equal(new URL(page.url()).pathname, "/console/agents");
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("occ.console.loginIntent")),
      null,
    );
  }
});

test("a cold console visit shows neither navigation nor sign-in until its session is known", async (t) => {
  const fixture = await signInApp(t);
  const { page } = await newPage(t, fixture);
  const pattern = "**/api/auth/session";
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const username = page.getByLabel("Email", { exact: true });

  async function visitWithSessionPending() {
    const held = await holdRoute(t, page, pattern, (route, response) =>
      route.fulfill({ response }),
    );
    t.after(() => held.release());
    await page.goto(`${fixture.origin}/console/`);
    await held.waitForRelease();
    await page.getByRole("status").filter({ hasText: "Checking session…" }).waitFor();
    assert.equal(await navigation.count(), 0);
    assert.equal(await username.count(), 0);
    await releaseHeldRoute(page, pattern, held);
  }

  await visitWithSessionPending();
  await username.waitFor();
  const signedIn = await page.context().request.post(`${fixture.origin}/api/auth/sign-in/email`, {
    headers: { origin: fixture.origin },
    data: { email: fixture.credentials.email, password: fixture.credentials.password },
  });
  assert.equal(signedIn.status(), 200);
  await visitWithSessionPending();
  await navigation.waitFor();
});

test("a first visit to a deep link asks to sign in; a tab whose session expired says so", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  for (const path of ["/console/agents", "/console/namespaces"]) {
    await page.goto(`${fixture.origin}${path}`);
    await page.getByLabel("Email", { exact: true }).waitFor();
    await expectNoText(page, /Your session has expired/, () => waitForIdleFetches(page));
  }

  await loginThroughForm(page, fixture, "/console/namespaces");
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  expireSessions(fixture);
  // A reload starts with no session in memory; the tab still knows it had one.
  await page.goto(`${fixture.origin}/console/agents`);
  await page.getByText("Your session has expired").waitFor();
  await page.getByLabel("Email", { exact: true }).waitFor();
});

test("login ignores untrusted returns and resolves an opaque Agent key only after authentication", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Shared Agent", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Shared Agent");
  const { page } = await newPage(t, fixture);
  const key = "a".repeat(32);
  let lookups = 0;
  let allow = true;
  await page.route(`**/native-admin/return/${key}`, async (route) => {
    lookups += 1;
    if (!allow) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "NOT_FOUND" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { namespaceId: namespace.id, agentId: agent.id },
        meta: { requestId: "browser-return" },
      }),
    });
  });
  await page.goto(`${fixture.origin}/console/#native-agent=${key}`);
  await page.getByLabel("Email", { exact: true }).waitFor();
  assert.equal(lookups, 0);
  assert.equal(new URL(page.url()).hash, "");
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`**/console/agents/${agent.id}?namespace=${namespace.id}`);
  assert.equal(lookups, 1);
  await page.goto(`${fixture.origin}/console/`);
  await page.waitForURL(/\/console\/agents(?:\?|$)/);
  assert.equal(lookups, 1);
  allow = false;
  await page.goto(`${fixture.origin}/console/#native-agent=${key}`);
  await page.waitForURL(/\/console\/agents(?:\?|$)/);
  assert.equal(lookups, 2);
  assert.equal(new URL(page.url()).pathname, "/console/agents");
  for (const value of [
    "//evil.example",
    "https://evil.example",
    "/console/\\\\evil.example",
    "/console/%252f%252fevil.example",
    "/console/login",
    "/console/agents/not-an-agent",
  ]) {
    await page.goto(`${fixture.origin}/console/login?return=${encodeURIComponent(value)}`);
    await page.waitForURL(/\/console\/agents(?:\?|$)/);
    assert.equal(new URL(page.url()).origin, fixture.origin);
    assert.equal(new URL(page.url()).pathname, "/console/agents");
  }
  await page.goto(`${fixture.origin}/console/#native-agent=${key.toUpperCase()}`);
  await page.waitForURL(/\/console\/agents(?:\?|$)/);
  assert.equal(lookups, 2);
});

test("a refused provider exchange discards its pending login destination", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Refused login", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Old destination");
  const { page } = await newPage(t, fixture);
  const envelope = (data) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, meta: { requestId: "browser-refusal" } }),
  });
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill(envelope({ github: true, sessionBinding: true })),
  );
  await page.route("**/api/auth/providers/github/start", (route) =>
    route.fulfill(
      envelope({
        url: "https://github.com/login/oauth/authorize?client_id=fixture",
        attemptId: "e".repeat(43),
      }),
    ),
  );
  await page.route("https://github.com/**", (route) =>
    route.fulfill({ status: 302, headers: { location: `${fixture.origin}/console/` } }),
  );
  await page.route("**/api/auth/providers/github/result", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FORBIDDEN" } }),
    }),
  );
  await page.goto(`${fixture.origin}/console/agents/${agent.id}?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await page
    .getByText(
      "Could not finish signing in with GitHub. The sign-in in this tab did not complete in time, or another sign-in replaced it. Select Continue with GitHub to start again.",
    )
    .waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("occ.console.loginIntent")), null);
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/console\/agents(?:\?|$)/);
  assert.equal(new URL(page.url()).pathname, "/console/agents");
});

test("Agent recovery survives a transient session check and tab refocus", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Recovery retry", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Recovery retry Agent");
  const { page } = await newPage(t, fixture);
  await login(page, fixture);
  await page.getByRole("button", { name: "Create Agent", exact: true }).waitFor();
  const key = "a".repeat(32);
  const pattern = `**/native-admin/return/${key}`;
  const held = await holdRoute(
    t,
    page,
    pattern,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { namespaceId: namespace.id, agentId: agent.id },
          meta: { requestId: "browser-retry" },
        }),
      }),
    { fetchBeforeHold: false },
  );
  t.after(() => held.release());
  await page.route(
    "**/api/auth/session",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
      }),
    { times: 1 },
  );
  await page.goto(`${fixture.origin}/console/#native-agent=${key}`);
  await page.getByText("Session unavailable", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry" }).click();
  await held.waitForRelease();
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  held.release();
  await page.waitForURL(`**/console/agents/${agent.id}?namespace=${namespace.id}`);
});

test("a naturally expired session returns to the requested page after sign-in", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Expired session", { ready: true });
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  // The button shows before the Namespace's Preset read returns. If that read reached the API
  // after the expiry below, its 401 would show the expired sign-in on this page before the click,
  // and the Namespaces link would be gone. Expire only once the page has no read in flight.
  await waitForIdleFetches(page);
  // Expire the actual session: the controller must reject it before returning to login.
  expireSessions(fixture);
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).waitFor();
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
});

test("session expiry after a failed check returns to the requested page", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Interrupted expiry", { ready: true });
  const { page } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents/new?namespace=${namespace.id}`);
  await page.getByRole("button", { name: "Start with default Preset", exact: true }).waitFor();
  await page.route(
    "**/api/auth/session",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
      }),
    { times: 1 },
  );
  await page.getByRole("link", { name: "Namespaces", exact: true }).click();
  await page.getByText("Session unavailable", { exact: true }).waitFor();
  expireSessions(fixture);
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("list", { name: "Namespaces", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/console/namespaces");
});

test("expiry on an active Agent page returns safely and rechecks denied access", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Active expiry", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Expired page Agent");
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const target = `/console/agents/${agent.id}?namespace=${namespace.id}&tab=configuration`;
  await login(page, fixture, target);
  await page.getByRole("heading", { name: "Expired page Agent", exact: true }).waitFor();
  await waitForSettledView(page);
  const requests = apiRequests(page, fixture.origin);

  // A foreground recheck discovers real expiry without navigating away from this Agent.
  expireSessions(fixture);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.getByText("Your session has expired").waitFor();
  await expectNoText(page, /Expired page Agent/, () => waitForIdleFetches(page));
  fixture.policy.restrictions.push({
    id: "deny-expired-agent-read",
    namespaceId: namespace.id,
    resourceKind: "agent",
    resourceId: agent.id,
    action: "read",
    effect: "deny",
  });

  await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  const deniedAgent = page.waitForResponse(
    `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
  );
  await page.getByRole("button", { name: "Sign in" }).click();
  assert.equal((await deniedAgent).status(), 403);
  await page.getByRole("heading", { name: "Access denied", exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, target);
  await settlePageRequests(page);
  assert.deepEqual(
    writeRequests(requests).map(({ method, path }) => ({ method, path })),
    [{ method: "POST", path: "/api/auth/sign-in/email" }],
  );
  assert.equal(await page.getByLabel("Password").count(), 0, "403 must not restart login");
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { chromium, request as playwrightRequest } from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.mjs";
import { keepRequestInterceptionEnabled } from "../helpers/browser-request-interception.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
} from "../../packages/occ/src/state/controller-work.ts";

// The in-memory fixture has no worker records. A test that supplies a failed deployment
// record builds its error with the API's own code, so the console shows the exact code,
// message and data that the API and occ return for that failure.
export function persistedDeploymentError(code, data) {
  return deploymentErrorForWork({
    state: "failed_permanent",
    reasonCode: code,
    ...(data === undefined ? {} : { resultData: data }),
  });
}

export function apiRequests(page, origin) {
  /** @type {{ method: string, path: string, body: unknown }[]} */
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

// Screenshots stay only in OCC_TEST_CONSOLE_ARTIFACT_DIR. Without it each test gets a
// directory that is removed when the test ends, because local runs share one TMPDIR.
async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  if (configured !== undefined && configured.length > 0) {
    t.diagnostic(`console Agent browser artifacts: ${configured}`);
    return configured;
  }
  const directory = await mkdtemp(join(tmpdir(), "openclaw-console-agents-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
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

// One Chromium for every test in a file (CI runs each file in its own process), launched on
// first use and closed after the file's last test: `after` here runs when the module loads, so it
// attaches to the root test. newPage uses it unless a test passes launch arguments, which need a
// browser of their own. Each test still gets its own context (cookies, storage, viewport,
// routes); this only saves the launch and close, about 0.2 CPU-s a test. A failed launch, or a
// browser that has crashed or disconnected, is launched again for the next caller.
let sharedLaunch;
after(async () => {
  await (await sharedLaunch?.catch(() => null))?.close();
});

async function sharedBrowser() {
  const pending = sharedLaunch;
  if (pending !== undefined) {
    const browser = await pending.catch(() => null);
    if (browser?.isConnected()) {
      return browser;
    }
    if (sharedLaunch === pending) {
      sharedLaunch = undefined;
    }
  }
  if (sharedLaunch === undefined) {
    const launching = launchBrowser().then(
      (browser) => {
        browser.on("disconnected", () => {
          if (sharedLaunch === launching) {
            sharedLaunch = undefined;
          }
        });
        return browser;
      },
      (error) => {
        if (sharedLaunch === launching) {
          sharedLaunch = undefined;
        }
        throw error;
      },
    );
    sharedLaunch = launching;
  }
  return sharedLaunch;
}

// The file's shared browser, for callers that pass it as newPage's `browser` option. newPage
// uses the same one by default.
export function fileBrowser() {
  return sharedBrowser;
}

/** @returns {Promise<{ page: import("playwright").Page, artifacts: string }>} */
export async function newPage(t, fixture, options = {}) {
  const artifacts = await artifactDirectory(t);
  assert.ok(
    options.browser === undefined || options.args === undefined,
    "pass a shared browser or launch arguments, not both",
  );
  const shared = options.args === undefined;
  const browser = shared
    ? await (options.browser ?? sharedBrowser)()
    : await launchBrowser(options);
  let context;
  let diagnostics;
  // A file app (fileConsoleApp) outlives the test, so its pages close when the test ends.
  const registerCleanup = fixture.sharedByFile
    ? (cleanup) => t.after(cleanup)
    : fixture.registerCleanupBeforeAppClose;
  registerCleanup(async () => {
    let cleanupError;
    try {
      await diagnostics?.capture();
      await context?.close();
    } catch (error) {
      cleanupError ??= error;
    } finally {
      try {
        if (!shared) {
          await browser.close();
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) {
      throw cleanupError;
    }
  });
  context = await browser.newContext(options.context);
  diagnostics = await watchBrowserContext(t, context);
  await keepRequestInterceptionEnabled(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return { page, artifacts };
}

const signedInPath = /\/console\/(agents|backends|namespaces|settings|secrets)/;

// Signs the page in and opens `path`. A fresh tab (still on about:blank) signs in with the same
// Better Auth password request the form sends, made in the page's own browser context so the
// browser stores the session cookie the API set, and then loads `path` already signed in: one
// page load instead of a sign-in page plus the destination, and no form to fill. A fresh tab on
// a file app (fileConsoleApp) signed in as its administrator loads the file's session cookies
// instead, so the file makes one password sign-in rather than one a test. A tab that has
// already loaded a page signs in through the form, so a test that signs in again on the same tab
// keeps that tab's session storage and history across the sign-in. So does a fixture served
// over TLS or under another host name, whose cookies are what such a test checks. Tests about
// the sign-in page itself use the form directly or loginThroughForm.
/** @param {string | URL} [path] */
export async function login(
  page,
  fixture,
  path = "/console/agents",
  credentials = fixture.credentials,
) {
  const origin = new URL(fixture.origin);
  if (
    page.url() !== "about:blank" ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1"
  ) {
    await loginThroughForm(page, fixture, path, credentials);
    return;
  }
  if (fixture.sharedByFile && credentials === fixture.credentials) {
    await page.context().addCookies(await fileSessionCookies(fixture));
    // An earlier test that ended this session would otherwise leave this test on the sign-in
    // page, which waitForURL below cannot tell apart from the console. This test fails and says
    // so; the next one signs in again, so one such test fails at most one other.
    const session = await page.request.get(new URL("/api/auth/session", origin).href);
    if ((await session.json().catch(() => null))?.data?.authenticated !== true) {
      fileSessions.delete(fixture);
      assert.fail(
        "an earlier test ended the file's shared session; a test that ends sessions needs its own app",
      );
    }
  } else {
    const response = await page.request.post(new URL("/api/auth/sign-in/email", origin).href, {
      data: { email: credentials.email, password: credentials.password },
      headers: { origin: origin.origin },
    });
    assert.equal(response.status(), 200, `password sign-in failed: ${await response.text()}`);
  }
  await page.goto(new URL(path, fixture.origin).href);
  await page.waitForURL(signedInPath);
}

// The administrator's session cookies for a file app (fileConsoleApp): one password sign-in for
// the whole file, which each test's fresh tab then loads like a saved sign-in state. The tests
// that share it must not end the session (see fileConsoleApp); login() checks it is still live.
const fileSessions = new WeakMap();

function fileSessionCookies(fixture) {
  let cookies = fileSessions.get(fixture);
  if (cookies === undefined) {
    cookies = (async () => {
      const origin = new URL(fixture.origin).origin;
      const context = await playwrightRequest.newContext();
      try {
        const response = await context.post(new URL("/api/auth/sign-in/email", origin).href, {
          data: { email: fixture.credentials.email, password: fixture.credentials.password },
          headers: { origin },
        });
        assert.equal(response.status(), 200, `password sign-in failed: ${await response.text()}`);
        return (await context.storageState()).cookies;
      } finally {
        await context.dispose();
      }
    })();
    cookies.catch(() => {
      if (fileSessions.get(fixture) === cookies) {
        fileSessions.delete(fixture);
      }
    });
    fileSessions.set(fixture, cookies);
  }
  return cookies;
}

// Signs in through the console's sign-in form, the way a person does: open `path`, which shows
// the sign-in page, and submit the email and password.
export async function loginThroughForm(
  page,
  fixture,
  path = "/console/agents",
  credentials = fixture.credentials,
) {
  await page.goto(new URL(path, fixture.origin).href);
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(signedInPath);
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

/** @param {ReturnType<typeof apiRequests>} requests */
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
  await page.getByText(label).click();
}

export function detailUrl(fixture, namespaceId, agentId, revision, tab) {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  if (revision !== undefined) {
    url.searchParams.set("revision", revision);
  }
  if (tab !== undefined) {
    url.searchParams.set("tab", tab);
  }
  return url;
}

/** @param {ReturnType<typeof apiRequests>} requests */
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

// A control becomes enabled when the page state behind it settles, which can be a task or more
// after the text a test waits for (finding 2116). A test that expects a control to be usable
// waits through this; one isEnabled() read can see the earlier state. A check that a control is
// disabled at a given moment still reads isDisabled() once.
export async function waitForEnabled(locator, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  await locator.waitFor({ state: "attached", timeout: timeoutMs });
  await waitForCondition(
    () => locator.isEnabled(),
    `${locator} stayed disabled for ${timeoutMs} ms`,
    Math.max(1, deadline - Date.now()),
  );
}

// Ordering sentinel for "this action sends no request" checks. After one macrotask turn, the
// page fetches a static asset and this waits for the response. Chromium reports requests in
// the order the page starts them, so any request started before the sentinel (synchronously,
// from a microtask or from a zero-delay timer) is already in the apiRequests() log.
export async function settlePageRequests(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await fetch(`/console/favicon-16.png?request-sentinel=${Date.now()}`, {
      cache: "no-store",
    });
    await response.arrayBuffer();
  });
}

// Test-only page hook: counts, per URL path, the page's fetches that have settled, meaning the
// fetch rejected or the page finished reading the response body. It also counts fetches still
// in flight; for that count a response without a body ends its fetch at once. Install it before
// the page loads. A count observed by waitForSettledFetches() or waitForIdleFetches() is read in
// a later task, so the page's own continuation of that fetch (for example dropping a stale
// response, or finishing the view's read bookkeeping) has already run.
export async function trackSettledFetches(page) {
  await page.addInitScript(() => {
    const settled = new Map();
    let inFlight = 0;
    const record = (input) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        globalThis.location.href,
      ).pathname;
      settled.set(path, (settled.get(path) ?? 0) + 1);
    };
    const pageFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      inFlight += 1;
      let open = true;
      const finish = () => {
        if (open) {
          open = false;
          inFlight -= 1;
        }
      };
      let response;
      try {
        response = await pageFetch(input, init);
      } catch (error) {
        record(input);
        finish();
        throw error;
      }
      if (response.body === null) {
        finish();
      }
      for (const method of ["arrayBuffer", "blob", "json", "text"]) {
        const read = response[method].bind(response);
        response[method] = async () => {
          try {
            return await read();
          } finally {
            record(input);
            finish();
          }
        };
      }
      return response;
    };
    globalThis.settledFetchCount = (path) => settled.get(path) ?? 0;
    globalThis.inFlightFetchCount = () => inFlight;
  });
}

export async function settledFetches(page, path) {
  return page.evaluate((target) => globalThis.settledFetchCount(target), path);
}

export async function waitForSettledFetches(page, path, count) {
  await page.waitForFunction(
    ([target, expected]) => globalThis.settledFetchCount(target) >= expected,
    [path, count],
  );
}

// Waits until no fetch the page has started is still in flight (see trackSettledFetches). The
// console retains a view, or an Agent tab, for a later return only if none of its reads were
// still pending when the reader left it; otherwise the return rebuilds it. Call this before
// leaving a view whose DOM a test later expects to be reused. It checks one moment: a read the
// page starts later (after a timer) is not covered, so wait for the view's content first.
export async function waitForIdleFetches(page) {
  await page.waitForFunction(() => globalThis.inFlightFetchCount() === 0);
}

export async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
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

/** @param {import("playwright").Page} page @param {string} name */
export function repositoryCheckbox(page, name) {
  return page
    .locator("#repository-results .repository-result-row")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByRole("checkbox");
}

// Holds requests matching `url` until release(). `requested` resolves when the first one is
// held. Once a test awaits it, it rejects if none is held within 10 s, so a test fails instead
// of hanging. With `once`, only the first match is held; with `method`, only matches with that
// method. Requests not held fall through to earlier routes. `once` is a hand-written flag, not
// Playwright's { times: 1 }: that
// turns interception off once no routes remain, which silently releases other held requests.
// With `afterServer`, the server answers first and the page gets that answer on release (a
// write that landed while the page waits); if that answer is lost, the page's request fails
// rather than being sent again. With `fulfill`, the held request gets that response.
/**
 * @param {import("node:test").TestContext} t
 * @param {import("playwright").Page} page
 * @param {Parameters<import("playwright").Page["route"]>[0]} url
 * @param {{ once?: boolean, method?: string, afterServer?: boolean, fulfill?: Parameters<import("playwright").Route["fulfill"]>[0] | null }} [options]
 * @returns {Promise<{ requested: Promise<void>, release: () => void, wasRequested: () => boolean }>}
 */
export async function holdRequests(
  t,
  page,
  url,
  { once = false, method, afterServer = false, fulfill = null } = {},
) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let markRequested;
  let failRequested;
  let timer;
  const requested = new Promise((resolve, reject) => {
    markRequested = () => {
      clearTimeout(timer);
      resolve();
    };
    failRequested = (error = new Error(`No ${url} request was held`)) => {
      clearTimeout(timer);
      reject(error);
    };
  });
  requested.catch(() => {});
  let taken = false;
  await page.route(url, async (route) => {
    if ((once && taken) || (method !== undefined && route.request().method() !== method)) {
      await route.fallback();
      return;
    }
    taken = true;
    let response = null;
    if (afterServer) {
      try {
        response = await route.fetch();
      } catch (error) {
        // The server may have applied a write before its answer was lost. Never send it again:
        // `requested` rejects with the failure and the page's request fails.
        failRequested(error);
        await route.abort("failed").catch(() => {});
        return;
      }
    }
    markRequested();
    await held;
    await (response || fulfill ? route.fulfill(fulfill ?? { response }) : route.continue()).catch(
      () => {},
    );
  });
  t.after(() => {
    clearTimeout(timer);
    release();
  });
  return {
    // The deadline starts at the first await, not at registration (a hold set before sign-in).
    get requested() {
      if (!taken && timer === undefined) {
        timer = setTimeout(failRequested, 10_000);
      }
      return requested;
    },
    release,
    wasRequested: () => taken,
  };
}

// Records layout shifts from the first paint, naming the elements that moved. Install it with
// page.addInitScript() before a full load, so no recent input excuses a shift.
export function recordLayoutShifts() {
  globalThis.__layoutShifts = [];
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) {
        globalThis.__layoutShifts.push({
          value: entry.value,
          sources: entry.sources.map((source) => ({
            node: `${source.node?.nodeName}.${source.node?.className}`,
            text: source.node?.textContent?.slice(0, 40),
            from: [source.previousRect.y, source.previousRect.height],
            to: [source.currentRect.y, source.currentRect.height],
          })),
        });
      }
    }
  }).observe({ type: "layout-shift", buffered: true });
}

// Returns the layout shifts recorded since the last call, and their total.
export async function takeLayoutShifts(page) {
  /** @type {{ value: number, sources: { node: string, text?: string, from: number[], to: number[] }[] }[]} */
  const shifts = await page.evaluate(() => globalThis.__layoutShifts.splice(0));
  return { shift: shifts.reduce((sum, entry) => sum + entry.value, 0), shifts };
}

// Resolves after the page has painted twice more and run a task after that, so work that has
// already settled has rendered and any layout shift from it has been reported.
export const nextFrames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => setTimeout(resolve)),
        );
      }),
  );

// The page's main view once its reads have settled and nothing holds it inert.
export const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// The desktop and phone sizes the console's layout checks sweep.
export const consoleViewports = Object.freeze([
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 390, height: 844 }),
]);

// The getAgentDeployment response for an admitted revision when the fixture has no worker.
export function deploymentStatusResponse(
  { id: deploymentId, namespaceId, agentId, createdAt },
  { status, error = null, attempt },
) {
  const progress =
    status === "queued" || status === "running"
      ? deploymentProgressForWork(
          { state: status === "queued" ? "queued" : "claimed", availableAt: new Date(createdAt) },
          attempt,
        )
      : null;
  return {
    json: {
      data: {
        deploymentId,
        namespaceId,
        agentId,
        status,
        cleanup: null,
        error,
        warnings: [],
        progress,
      },
      meta: { requestId: "req_00000000-0000-4000-8000-000000000001" },
    },
  };
}

// Answers the browser's read of one deployment with a failed record that carries the API's own
// error for `code`, so the Agent page shows that version's recovery card.
export async function routeFailedDeployment(
  page,
  fixture,
  { namespaceId, agentId, deploymentId, code = "DEPENDENCY_UNAVAILABLE" },
) {
  const error = persistedDeploymentError(code);
  const response = deploymentStatusResponse(
    { id: deploymentId, namespaceId, agentId },
    { status: "failed", error },
  );
  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/agents/${agentId}/deployments/${deploymentId}`,
    (route) => route.fulfill(response),
  );
  return error;
}

// WCAG 2 contrast between two sRGB colours given as [r, g, b] in 0-255.
function contrastRatio(a, b) {
  const luminance = (rgb) => {
    const [r, g, bl] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// A control's top edge, its own fill and the surface painted behind it: every translucent
// background up to the first opaque one, composited over it (or over white).
const controlEdge = (locator) =>
  locator.evaluate((node) => {
    const rgba = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { rgb: [r, g, b], a };
    };
    const layers = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const layer = rgba(globalThis.getComputedStyle(parent).backgroundColor);
      layers.push(layer);
      if (layer.a === 1) {
        break;
      }
    }
    let surface = [255, 255, 255];
    for (const layer of layers.reverse()) {
      surface = surface.map((value, index) => layer.rgb[index] * layer.a + value * (1 - layer.a));
    }
    const style = globalThis.getComputedStyle(node);
    return {
      edge: rgba(style.borderTopColor),
      width: style.borderTopWidth,
      fill: rgba(style.backgroundColor),
      surface,
    };
  });

// A secondary control on a light surface is marked by its edge alone, so the edge needs 3:1
// against both its fill (as painted over the surface) and the surface behind it (WCAG 1.4.11).
// `opaqueFill` also requires the control to paint its own fill.
export async function assertControlEdge(locator, label, { opaqueFill = false } = {}) {
  const { edge, width, fill, surface } = await controlEdge(locator);
  assert.equal(width, "1px", `${label}: edge width`);
  assert.equal(edge.a, 1, `${label}: the edge is opaque`);
  if (opaqueFill) {
    assert.equal(fill.a, 1, `${label}: the fill is opaque`);
  }
  const painted = fill.rgb.map((value, index) => value * fill.a + surface[index] * (1 - fill.a));
  for (const [against, colour] of [
    ["fill", painted],
    ["surface", surface],
  ]) {
    const ratio = contrastRatio(edge.rgb, colour);
    assert.ok(
      ratio >= 3,
      `${label}: edge ${edge.rgb} is ${ratio.toFixed(2)}:1 against its ${against} ${colour.map(Math.round)}`,
    );
  }
}

// A status line's look and announcement: its class, tone and role, and with `text` its text, all
// read at one moment (finding 2006).
export function statusTone(locator, { text = false } = {}) {
  return locator.evaluate(
    (node, withText) => ({
      className: node.className,
      tone: node.dataset.tone ?? null,
      role: node.getAttribute("role"),
      ...(withText ? { text: node.textContent } : {}),
    }),
    text,
  );
}

// Whether a reload or tab close would ask first: the console cancels beforeunload.
export function asksBeforeUnload(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    globalThis.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

// Checks that a write which holds the page also makes a reload or tab close ask first, only while
// it is in flight (finding 2181). It holds the next `method` request to `url`, which `start`
// sends, until the page is shown to ask; then it lets the answer through, waits for `settled`
// and checks the page no longer asks. The real server answers the write; only its answer waits.
export async function expectWriteAsksBeforeUnload(t, page, url, { method, start, settled }) {
  assert.equal(await asksBeforeUnload(page), false, "the page asked before the write started");
  const held = await holdRequests(t, page, url, {
    method,
    once: true,
    afterServer: true,
  });
  await start();
  await held.requested;
  assert.equal(await asksBeforeUnload(page), true, "a reload during the write would not ask");
  held.release();
  await settled();
  assert.equal(await asksBeforeUnload(page), false, "the page still asks after the write");
}

// Whether the locator's element holds focus.
export function hasFocus(locator) {
  return locator.evaluate((node) => node === globalThis.document.activeElement);
}

// Counts the browser's `invalid` events. Its own validation fires one per refused control
// whenever it would show its bubble (a submit without novalidate, or reportValidity); the
// console's check reads `validity` and fires none. Install it before the page loads; the
// returned function reads the targets so far.
export async function countInvalidEvents(page) {
  await page.addInitScript(() => {
    globalThis.invalidEvents = [];
    globalThis.document.addEventListener(
      "invalid",
      (event) => globalThis.invalidEvents.push(event.target.id || event.target.tagName),
      true,
    );
  });
  return () => page.evaluate(() => globalThis.invalidEvents);
}

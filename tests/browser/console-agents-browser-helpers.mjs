import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { chromium } from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.mjs";
import { keepRequestInterceptionEnabled } from "../helpers/browser-request-interception.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { deploymentErrorForWork } from "../../packages/occ/src/state/controller-work.ts";

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

// One Chromium for every test in a file, launched on first use and closed after the file's
// last test. Call it once at module top level (`after` attaches to the test that is running)
// and pass the result as newPage's `browser` option. Each test still gets its own context
// (cookies, storage, viewport, routes); this only saves the launch, about 0.35 s a test. A
// failed launch or a crashed browser is launched again for the next test.
export function fileBrowser() {
  let launched;
  after(async () => {
    await (await launched?.catch(() => null))?.close();
  });
  return () => {
    if (launched === undefined) {
      const launching = launchBrowser().then(
        (browser) => {
          browser.on("disconnected", () => {
            if (launched === launching) {
              launched = undefined;
            }
          });
          return browser;
        },
        (error) => {
          if (launched === launching) {
            launched = undefined;
          }
          throw error;
        },
      );
      launched = launching;
    }
    return launched;
  };
}

export async function newPage(t, fixture, options = {}) {
  const artifacts = await artifactDirectory(t);
  const shared = options.browser !== undefined;
  assert.ok(!shared || options.args === undefined, "a shared browser takes no launch arguments");
  const browser = shared ? await options.browser() : await launchBrowser(options);
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

export async function login(
  page,
  fixture,
  path = "/console/agents",
  credentials = fixture.credentials,
) {
  await page.goto(new URL(path, fixture.origin).href);
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/console\/(agents|backends|namespaces|settings)/);
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

// Holds requests matching `url` until release(). `requested` resolves when the first one is
// held. Once a test awaits it, it rejects if none is held within 10 s, so a test fails instead
// of hanging. With `once`, only the first match is held; with `method`, only matches with that
// method. Requests not held fall through to earlier routes. `once` is a hand-written flag, not
// Playwright's { times: 1 }: that
// turns interception off once no routes remain, which silently releases other held requests.
// With `afterServer`, the server answers first and the page gets that answer on release (a
// write that landed while the page waits); if that answer is lost, the page's request fails
// rather than being sent again. With `fulfill`, the held request gets that response.
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
  const shifts = await page.evaluate(() => globalThis.__layoutShifts.splice(0));
  return { shift: shifts.reduce((sum, entry) => sum + entry.value, 0), shifts };
}

// The page's main view once its reads have settled and nothing holds it inert.
export const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// The desktop and phone sizes the console's layout checks sweep.
export const consoleViewports = Object.freeze([
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 390, height: 844 }),
]);

// Answers the browser's read of one deployment with a failed record that carries the API's own
// error for `code`, so the Agent page shows that version's recovery card.
export async function routeFailedDeployment(
  page,
  fixture,
  { namespaceId, agentId, deploymentId, code = "DEPENDENCY_UNAVAILABLE" },
) {
  await page.route(
    `${fixture.origin}/namespaces/${namespaceId}/agents/${agentId}/deployments/${deploymentId}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            deploymentId,
            namespaceId,
            agentId,
            status: "failed",
            error: persistedDeploymentError(code),
            warnings: [],
            progress: null,
          },
          meta: { requestId: "req_test_failed_deployment" },
        }),
      }),
  );
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

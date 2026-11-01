import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { chromium, request as playwrightRequest } from "playwright";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.mjs";
import { keepRequestInterceptionEnabled } from "../helpers/browser-request-interception.mjs";
import { memberRole } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { restrict } from "../helpers/iam-grants.mjs";
import { SECRET_OPERATE_DENIED } from "../helpers/refusal-text.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
} from "../../packages/occ/src/state/controller-work.ts";

// Shared with the API tests, which drive the same fixture without a browser.
export { authorizationDenials, grantMember } from "../helpers/console-app.mjs";

// What a member who writes Agents holds in one Namespace (the ux-audit-1018 member-write
// persona), for fixture.createNamespaceMember. It has no Installation access, so it cannot read
// or write IAM policy.
/** @type {readonly (readonly [import("../../packages/contracts/src/index.ts").Permission["action"], import("../../packages/contracts/src/index.ts").Permission["resourceKind"]])[]} */
export const MEMBER_WRITE = [
  ["read", "namespace"],
  ["read", "agent"],
  ["update", "agent"],
  ["deploy", "agent"],
  ["operate", "agent"],
  ["read", "agent_revision"],
  ["read", "configuration"],
  ["update", "configuration"],
  ["read", "secret"],
  ["operate", "secret"],
  ["create", "agent"],
  ["create", "configuration"],
  ["create", "secret"],
  ["read", "preset"],
];

/**
 * MEMBER_WRITE without each [action, resourceKind] grant in `grants`, which it must hold: the
 * member-write persona missing exactly those grants.
 * @param {...(typeof MEMBER_WRITE)[number]} grants
 * @returns {typeof MEMBER_WRITE}
 */
export function memberWriteWithout(...grants) {
  const held = ([action, resourceKind]) =>
    grants.some((grant) => grant[0] === action && grant[1] === resourceKind);
  const kept = MEMBER_WRITE.filter((grant) => !held(grant));
  assert.equal(kept.length, MEMBER_WRITE.length - grants.length, "MEMBER_WRITE holds each grant");
  return kept;
}

// What a member who reads an Agent holds in one Namespace: the Namespace, the Agent, its
// versions and its Configuration. Tests add the grants their persona needs to it.
/** @type {typeof MEMBER_WRITE} */
export const AGENT_READ = [
  ["read", "namespace"],
  ["read", "agent"],
  ["read", "agent_revision"],
  ["read", "configuration"],
];

// The Credentials tab's Channel Secrets save outcome (agents/credentials.mts saveOutcomeText). It
// points to Deploy only once no grant read is still to come and every bound Secret is granted.
export const CHANNEL_SECRETS_SAVED = "Channel Secret bindings saved.";
export const CHANNEL_SECRETS_SAVED_DEPLOY = `${CHANNEL_SECRETS_SAVED} Deploy the new version to deliver them.`;

/**
 * Removes one [action, resourceKind] grant from member `label`'s Role, which must hold it.
 * Returns a function that restores the grants the Role held before.
 */
export function revokeMemberGrant(fixture, label, grant) {
  return revokeRoleGrant(memberRole(fixture, label), label, grant);
}

/**
 * Removes one [action, resourceKind] grant from the Installation administrator Role the fixture
 * seeds for its administrator account, which `login` signs in by default. Returns a restore
 * function, as revokeMemberGrant does.
 */
export function revokeAdministratorGrant(fixture, grant) {
  const role = fixture.policy.roles.find(({ name }) => name === "Installation administrator");
  assert.ok(role, "the fixture's administrator has a Role");
  return revokeRoleGrant(role, "the administrator", grant);
}

/**
 * Binds the Installation administrator Role the fixture seeds to `principal`, as another
 * administrator grants Installation administration while that account is signed in. Returns a
 * function that removes that binding again, as another administrator revokes it.
 */
export function grantInstallationAdministration(fixture, principal) {
  const role = fixture.policy.roles.find(({ name }) => name === "Installation administrator");
  assert.ok(role, "the fixture's administrator has a Role");
  const binding = fixture.policy.bindings.find(({ roleId }) => roleId === role.id);
  assert.ok(binding, "the fixture's administrator holds the Role through a binding");
  const granted = {
    ...binding,
    id: `installation-administrator-${principal.id}`,
    subjectId: principal.id,
  };
  fixture.policy.bindings.push(granted);
  return () => {
    fixture.policy.bindings.splice(fixture.policy.bindings.indexOf(granted), 1);
  };
}

function revokeRoleGrant(role, holder, [action, resourceKind]) {
  const before = role.permissions;
  role.permissions = before.filter(
    (grant) => grant.action !== action || grant.resourceKind !== resourceKind,
  );
  assert.notEqual(
    role.permissions.length,
    before.length,
    `${holder} holds ${action} ${resourceKind}`,
  );
  return () => {
    role.permissions = before;
  };
}

// Secret operate on exactly `secretIds`, as an administrator grants it per Secret: one Role
// holding Secret operate, bound to `principal` once for each Secret. `revoke(secretId)` removes
// that Secret's binding.
export function grantSecretOperate(fixture, namespaceId, principal, secretIds) {
  const roleId = `secret-operate-${principal.id}`;
  if (!fixture.policy.roles.some(({ id }) => id === roleId)) {
    fixture.policy.roles.push({
      id: roleId,
      namespaceId,
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
  }
  for (const secretId of secretIds) {
    fixture.policy.bindings.push({
      id: `${roleId}-${secretId}`,
      namespaceId,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId,
      resourceKind: "secret",
      resourceId: secretId,
    });
  }
  return {
    revoke(secretId) {
      const index = fixture.policy.bindings.findIndex(({ id }) => id === `${roleId}-${secretId}`);
      assert.notEqual(index, -1, `Secret operate on ${secretId} is granted`);
      fixture.policy.bindings.splice(index, 1);
    },
  };
}

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

// The caller-permissions answer is advisory. Report Configuration update as granted, as a page
// that read the answer before a revocation would, so the Configuration editor opens and what a
// test sees is the API's refusal (finding 2421).
export async function grantStaleConfigurationUpdate(page) {
  await page.route(/\/agents\/[^/]+\/permissions$/, (route) =>
    fulfillPatchedJson(route, (body) => ({
      ...body,
      data: {
        ...body.data,
        configurationUpdate: true,
        configurationSecretsOperate: true,
        configurationSecretsOperateDeniedBindings: [],
      },
    })),
  );
}

// Answers a routed request with the real API's answer, its JSON body replaced by what `patch`
// returns for it (`patch` may change the body it is given and return it). Status and headers
// stay the server's.
/**
 * @param {import("playwright").Route} route
 * @param {(body: any) => unknown} patch
 */
export async function fulfillPatchedJson(route, patch) {
  const response = await route.fetch();
  const body = await response.json();
  await route.fulfill({ response, json: patch(body) });
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

// Every request that is not a GET: the writes a "nothing was written" check expects none of.
// The console's CSP limits fetches to its own origin, so apiRequests sees every API write.
/** @param {ReturnType<typeof apiRequests>} requests */
export function writeRequests(requests) {
  return requests.filter((request) => request.method !== "GET");
}

// writeRequests without the sign-in and sign-out requests (/api/auth/sign-*).
/** @param {ReturnType<typeof apiRequests>} requests */
export function nonAuthWriteRequests(requests) {
  return writeRequests(requests).filter((request) => !request.path.startsWith("/api/auth/sign-"));
}

// Whether a Secret value control hides what is typed: a password input, or the masked
// multiline box every Create Secret form uses where the browser supports masking (finding 2339).
export async function isMaskedSecretValue(control) {
  return control.evaluate(
    (node) =>
      node.getAttribute("type") === "password" ||
      globalThis.getComputedStyle(node).getPropertyValue("-webkit-text-security") === "disc",
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

// Lists `secret` in the Secret field `label` and returns its option, which carries the reason in
// its accessible name when the caller may read the Secret but not operate it (finding 2453).
export async function operateDeniedSecretOption(scope, label, secret) {
  await scope.getByLabel(label, { exact: true }).fill(secret.name);
  const option = scope.getByRole("option", {
    name: `${secretOptionLabel(secret)} ${SECRET_OPERATE_DENIED}`,
    exact: true,
  });
  await option.waitFor();
  assert.equal(await option.getAttribute("aria-disabled"), "true");
  return option;
}

// Lists the Secret field `label`'s inline Create new Secret action and returns it, checking that
// it is disabled with `reason` in its accessible name.
export async function deniedCreateSecretOption(scope, label, reason) {
  await scope.getByLabel(label, { exact: true }).fill("no matching Secret");
  const option = scope.getByRole("option", {
    name: `Create new Secret... ${reason}`,
    exact: true,
  });
  await option.waitFor();
  assert.equal(await option.getAttribute("aria-disabled"), "true");
  return option;
}

// Expires every session the app holds, as time passing would: the API then refuses each one.
// Better Auth's memory adapter stores session expiry as Date values.
export function expireSessions(fixture) {
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
}

// Checks that no visible text matches `pattern`. `settled` resolves once the page has done what
// could have shown the text: the read behind it settled (waitForIdleFetches,
// waitForSettledFetches), or the page shows its last render before a held read answers. The
// check runs once that has rendered, without a fixed wait. Without `settled`, it watches the
// page for 300 ms: keep that where a timer could still show the text, such as the loading
// timers that run while a test holds a session or admission read. The settled check waits for
// page frames, so it hangs on a page whose clock is paused (page.clock.pauseAt).
export async function expectNoText(page, pattern, settled) {
  if (settled === undefined) {
    await assert.rejects(
      page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
      /Timeout/,
    );
    return;
  }
  await settled();
  await nextFrames(page);
  assert.equal(
    await page.getByText(pattern).filter({ visible: true }).count(),
    0,
    `no visible text matches ${pattern}`,
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

// The Agent page builds its tab while the view is still held back (display: none) for its first
// reads, and a picker's Secret list can load before the view is shown (findings 2034, 2626). A
// test that measures layout waits through this, not waitForInputValue alone: a hidden field
// measures 0 x 0.
export async function waitForShownInputValue(locator, expected, timeoutMs = 10_000) {
  await waitForInputValue(locator, expected, timeoutMs);
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
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
// in flight, in all and per path; for that count a response without a body ends its fetch at
// once. Install it before the page loads. A count observed by waitForSettledFetches() or
// waitForIdleFetches() is read in a later task, so the page's own continuation of that fetch
// (for example dropping a stale response, or finishing the view's read bookkeeping) has
// already run.
export async function trackSettledFetches(page) {
  await page.addInitScript(() => {
    const settled = new Map();
    const pending = new Map();
    let inFlight = 0;
    const pathOf = (input) =>
      new URL(input instanceof Request ? input.url : String(input), globalThis.location.href)
        .pathname;
    const record = (input) => {
      const path = pathOf(input);
      settled.set(path, (settled.get(path) ?? 0) + 1);
    };
    const pageFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = pathOf(input);
      inFlight += 1;
      pending.set(path, (pending.get(path) ?? 0) + 1);
      let open = true;
      const finish = () => {
        if (open) {
          open = false;
          inFlight -= 1;
          pending.set(path, pending.get(path) - 1);
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
    // With `except`, fetches to that path (one a test holds, say) are not counted.
    globalThis.inFlightFetchCount = (except) =>
      inFlight - (except === undefined ? 0 : (pending.get(except) ?? 0));
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
// page starts later (after a timer) is not covered, so wait for the view's content first. With
// `except`, fetches to that URL path (a read the test holds) do not count.
export async function waitForIdleFetches(page, { except } = {}) {
  await page.waitForFunction((path) => globalThis.inFlightFetchCount(path) === 0, except);
}

// Expires every session (expireSessions) once the page has no read in flight, so the test
// decides which read discovers the expiry. A read the page started earlier that reaches the API
// after the expiry gets a 401 and shows the expired sign-in by itself: it resets the view,
// removes the controls the test acts on next and aborts reads the test holds (findings 2156,
// 2793). `except` names the path of a read the test holds to discover the expiry. The page
// must run trackSettledFetches(); waitForIdleFetches has the same one-moment limit. Plain
// expireSessions stays right when the next step opens a private page with page.goto(): that
// abandons every read in flight and finds the expiry wherever the page was. A reload is not
// enough: after a late 401 the page is /console/login, and a reload of it is a plain sign-in.
export async function expireSessionsWhenSettled(page, fixture, { except } = {}) {
  await waitForIdleFetches(page, { except });
  expireSessions(fixture);
}

// Polls `predicate` until it is truthy; on timeout, `message` alone is the failure.
export async function waitForCondition(predicate, message, timeoutMs = 5_000) {
  try {
    await waitUntil(message, predicate, { timeoutMs, intervalMs: 50 });
  } catch (error) {
    if (
      error instanceof assert.AssertionError &&
      error.message === `Timed out waiting for ${message}.`
    ) {
      assert.fail(message);
    }
    throw error;
  }
}

// A Preset the product ships in deploy/presets, by file name without ".json" ("default-codex",
// "standard-codex"): for createConsoleAppFixture's defaultPresets or a Preset create. Each call
// reads the file again, so callers never share one object.
export async function shippedPreset(name) {
  return JSON.parse(
    await readFile(new URL(`../../deploy/presets/${name}.json`, import.meta.url), "utf8"),
  );
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
// held. Once a test awaits it, it rejects if none is held within `timeout` ms (10 s by default),
// so a test fails instead of hanging; `timeout: 0` waits as long as the test does. With `once`,
// only the first match is held; with `method`, only matches with that method. Requests not held
// fall through to earlier routes. `once` is a hand-written flag, not Playwright's { times: 1 }:
// that turns interception off once no routes remain, which silently releases other held requests.
// With `afterServer`, the server answers first, `requested` resolves with that answer, and the
// page gets it on release (a write that landed while the page waits); if that answer is lost,
// the page's request fails rather than being sent again. With `loseResponse` as well, the page's
// request fails on release although the server applied it. With `fulfill`, the held request
// gets that response.
/**
 * @param {import("node:test").TestContext} t
 * @param {import("playwright").Page} page
 * @param {Parameters<import("playwright").Page["route"]>[0]} url
 * @param {{ once?: boolean, method?: string, afterServer?: boolean, loseResponse?: boolean, fulfill?: Parameters<import("playwright").Route["fulfill"]>[0] | null, timeout?: number }} [options]
 * @returns {Promise<{ requested: Promise<import("playwright").APIResponse | undefined>, release: () => void, wasRequested: () => boolean }>}
 */
export async function holdRequests(
  t,
  page,
  url,
  {
    once = false,
    method,
    afterServer = false,
    loseResponse = false,
    fulfill = null,
    timeout = 10_000,
  } = {},
) {
  if (loseResponse && !afterServer) {
    throw new Error("loseResponse needs afterServer: only a server answer can be lost");
  }
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let markRequested;
  let failRequested;
  let timer;
  const requested = new Promise((resolve, reject) => {
    markRequested = (response) => {
      clearTimeout(timer);
      resolve(response);
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
    markRequested(response ?? undefined);
    await held;
    if (loseResponse) {
      await route.abort("failed").catch(() => {});
      return;
    }
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
      if (!taken && timer === undefined && timeout > 0) {
        timer = setTimeout(failRequested, timeout);
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

// Records every node that holds focus from now until stopFocusTrail(), in
// globalThis.focusFrames.trail: the focused node at every frame and the target of every focusin,
// so a node that holds focus for less than a frame (a busy page paints late) still shows. Nodes
// are numbered, so a replaced heading is a new entry. `loadingShown` turns true once the content
// shows one of `loadingTexts`; `frames` counts sampled frames. With `until` (a regular
// expression source), recording stops at the first entry it matches, so the trail ends there and
// `stopped` turns true.
/**
 * @param {import("playwright").Page} page
 * @param {string[]} [loadingTexts]
 * @param {{ until?: string | null }} [options]
 */
export const recordFocusTrail = (page, loadingTexts = [], { until = null } = {}) =>
  page.evaluate(
    ({ loadingTexts, until }) => {
      const ids = new WeakMap();
      let next = 0;
      const state = { trail: [], loadingShown: false, stopped: false, frames: 0 };
      const record = (node) => {
        if (node && node !== globalThis.document.body && !ids.has(node)) {
          ids.set(node, ++next);
        }
        const entry =
          !node || node === globalThis.document.body
            ? "BODY"
            : `${node.tagName}#${ids.get(node)}: ${node.textContent.trim()}`;
        if (state.trail.at(-1) !== entry) {
          state.trail.push(entry);
          state.stopped ||= until !== null && new RegExp(until).test(entry);
        }
      };
      const focused = (event) => {
        if (!state.stopped) {
          record(event.target);
        }
      };
      const sample = () => {
        if (state.stopped) {
          globalThis.document.removeEventListener("focusin", focused, true);
          return;
        }
        state.frames += 1;
        record(globalThis.document.activeElement);
        const shown = globalThis.document.querySelector(".content")?.textContent ?? "";
        state.loadingShown ||= loadingTexts.some((text) => shown.includes(text));
        globalThis.requestAnimationFrame(sample);
      };
      globalThis.document.addEventListener("focusin", focused, true);
      globalThis.focusFrames = state;
      sample();
    },
    { loadingTexts, until },
  );

// Stops the focus trail recordFocusTrail() started and returns it.
/**
 * @param {import("playwright").Page} page
 * @returns {Promise<{ trail: string[], frames: number, loadingShown: boolean, stopped: boolean }>}
 */
export const stopFocusTrail = (page) =>
  page.evaluate(() => {
    globalThis.focusFrames.stopped = true;
    return globalThis.focusFrames;
  });

// The page's main view once its reads have settled and nothing holds it inert.
export const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// Whether the whole of an element is inside the window, so the reader sees it without scrolling.
export const inViewport = (locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return top >= 0 && bottom <= globalThis.innerHeight;
  });

// The desktop and phone sizes the console's layout checks sweep.
export const consoleViewports = Object.freeze([
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 390, height: 844 }),
]);

// The getAgentDeployment response for an admitted revision when the fixture has no worker. A
// running record with `nextAttemptAt` is a started deploy whose work waits for its next attempt:
// it stays running between attempts (finding 2456).
export function deploymentStatusResponse(
  { id: deploymentId, namespaceId, agentId, createdAt },
  { status, error = null, attempt, nextAttemptAt, warnings = [] },
) {
  const waiting = status === "queued" || nextAttemptAt !== undefined;
  const progress =
    status === "queued" || status === "running"
      ? deploymentProgressForWork(
          {
            state: waiting ? "queued" : "claimed",
            availableAt: new Date(nextAttemptAt ?? createdAt),
          },
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
        warnings,
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

// One readable version per history page: the first page lists the newest readable version.
// `olderRead`, when given, is told of each older-page request and answers when it resolves.
export function routeOneVersionPerPage(page, fixture, namespace, agent, olderRead) {
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  return page.route(
    (url) => url.origin === fixture.origin && url.pathname === revisionsPath,
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "older-page") {
        await olderRead?.();
      }
      const response = await route.fetch({ url: `${fixture.origin}${revisionsPath}` });
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          data: cursor === "older-page" ? body.data.slice(1) : body.data.slice(0, 1),
          meta: { ...body.meta, nextCursor: cursor === "older-page" ? null : "older-page" },
        },
      });
    },
  );
}

// The Agent page's "Viewing version" chooser in `scope`, a page or a locator.
export const versionChooser = (scope) => scope.getByLabel("Viewing version", { exact: true });

// Version `n`'s chooser label: "vN" alone or "vN · <outcome>".
const versionName = (n) => new RegExp(`^v${n}(?: ·|$)`);

// Version `n`'s option in the chooser.
export const versionOption = (scope, n) =>
  versionChooser(scope).getByRole("option", { name: versionName(n) });

// Waits until the chooser has a selected version, or until version `n` is the selected one.
export function waitForChosenVersion(scope, n) {
  const chosen =
    n === undefined
      ? versionChooser(scope).locator("option:checked")
      : versionChooser(scope)
          .getByRole("option", { selected: true })
          .filter({ hasText: versionName(n) });
  return chosen.waitFor({ state: "attached" });
}

// Denies AgentRevision read on one version, as an administrator's per-version restriction does.
// State reads the policy on each request, so it applies from the next read on. Its id is
// `deny-read-<revision id>`: console-next-steps looks it up to deny only once.
export function denyRevisionRead(fixture, namespace, revision) {
  restrict(fixture.policy, "read", "agent_revision", {
    id: `deny-read-${revision.id}`,
    namespaceId: namespace.id,
    resourceId: revision.id,
  });
}

// The Stop Agent button in its row on the Agent page.
export const stopAgentButton = (page) =>
  page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button", { name: "Stop Agent", exact: true });

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

// A long resource ID as the console shortens it in text: its first 12 and last 6 characters.
export const shortId = (id) => `${id.slice(0, 12)}…${id.slice(-6)}`;

// A control's accessible description from aria-describedby: the text of each element it names,
// in order (finding D749). A referenced ID that renders nothing adds nothing.
export function accessibleDescription(locator) {
  return locator.evaluate((node) =>
    (node.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => globalThis.document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" "),
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

// The ID of the element that holds focus in the page: "" for one without an ID, null when nothing
// does.
export function focusedId(page) {
  return page.evaluate(() => globalThis.document.activeElement?.id ?? null);
}

// A natively disabled control is out of the Tab order, so a keyboard reader never reaches it or
// its reason (findings 2878, 2899). An unavailable control with a reason is aria-disabled
// instead: Tab reaches it, it is described by the reason, and Enter, Space, a click or (in a
// select or text field) an arrow key or typing does nothing. Nothing runs: no handler changes its
// reason or moves focus, no form submits, no checkbox flips, no select or field changes its value,
// and nothing is written.
export async function expectReachableReason(page, control, reason) {
  await control.waitFor();
  await page.evaluate(() => {
    globalThis.document.activeElement?.blur();
    globalThis.unavailableActivations = [];
    for (const type of ["submit", "change", "input"]) {
      globalThis.document.addEventListener(
        type,
        () => globalThis.unavailableActivations.push(type),
        { capture: true },
      );
    }
  });
  let presses = 0;
  while (!(await hasFocus(control))) {
    assert.ok(++presses <= 200, `Tab reaches ${reason}`);
    await page.keyboard.press("Tab");
  }
  const state = () =>
    control.evaluate((node) => ({
      focused: node === globalThis.document.activeElement,
      disabled: node.disabled,
      ariaDisabled: node.getAttribute("aria-disabled"),
      checked: node.type === "checkbox" ? node.checked : null,
      value: node.value,
    }));
  const before = await state();
  assert.deepEqual(before, { ...before, focused: true, disabled: false, ariaDisabled: "true" });
  assert.equal(await accessibleDescription(control), reason);
  const editable = await control.evaluate(
    (node) => node.localName === "select" || (node.localName === "input" && node.type === "text"),
  );
  const writes = [];
  const onRequest = (request) => {
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${request.url()}`);
    }
  };
  page.on("request", onRequest);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  if (editable) {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("x");
    // Deleting is an edit too, and typing does not cover it.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
  }
  // A mouse press too: force skips Playwright's own wait for an enabled control.
  await control.click({ force: true });
  page.off("request", onRequest);
  assert.deepEqual(await state(), before);
  assert.equal(await accessibleDescription(control), reason);
  assert.deepEqual(await page.evaluate(() => globalThis.unavailableActivations), []);
  assert.deepEqual(writes, []);
}

// Clicks `close`, a control that closes its dialog, and focuses `elsewhere` in the same task. The
// dialog's close event fires a task later, so this is the reader who has already moved on, for
// example to a field they type in (finding 2862). Resolves after the dialog's own close handlers
// ran, with whether `elsewhere` still holds focus.
export async function focusKeptOverClose(close, elsewhere) {
  const target = await elsewhere.elementHandle();
  try {
    return await close.evaluate(
      (control, node) =>
        new Promise((resolve) => {
          control
            .closest("dialog")
            .addEventListener("close", () => resolve(globalThis.document.activeElement === node), {
              once: true,
            });
          control.click();
          node.focus();
        }),
      target,
    );
  } finally {
    await target.dispose();
  }
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

import { Check } from "typebox/value";
import {
  ConfigurationValues,
  CreatePresetBody,
  JsonValue,
} from "../../packages/contracts/src/api/common.ts";
import { validatePresetTemplate } from "../../packages/contracts/src/index.ts";
import { AgentDeploymentStatusSchema } from "../../packages/contracts/src/api/resources.ts";
import {
  deploymentErrorForWork,
  deploymentProgressForWork,
} from "../../packages/occ/src/state/controller-work.ts";

import type {
  AgentRevisionWire,
  AgentDeploymentStatusWire,
  AgentDeploymentStatusResponse,
} from "../../packages/contracts/src/api/resources.ts";

import type { TestContext } from "node:test";
import type {
  APIResponse,
  Browser,
  BrowserContext,
  ElementHandle,
  Locator,
  Page,
  Request,
  Route,
} from "playwright";
import type {
  Permission,
  OpenClawConfigurationDocument,
  Secret,
  Agent,
  AgentRevision,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";

type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type PageFixture =
  | (Pick<Fixture, "registerCleanupBeforeAppClose"> & { sharedByFile?: false })
  | { sharedByFile: true };
type LoginFixture = Pick<Fixture, "origin" | "credentials"> & { sharedByFile?: boolean };
type Credentials = Pick<LoginFixture["credentials"], "email" | "password">;
type Grant = readonly [Permission["action"], Permission["resourceKind"]];
type RequestRecord = { method: string; path: string; body: unknown };
type Scope = Page | Locator;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function refusalMessage(body: unknown): string {
  assert.ok(isRecord(body) && isRecord(body.error) && typeof body.error.message === "string");
  return body.error.message;
}
type FocusFrames = { trail: string[]; loadingShown: boolean; stopped: boolean; frames: number };
type LayoutShift = {
  value: number;
  sources: { node: string; text: string | undefined; from: number[]; to: number[] }[];
};

// Test-only globals installed and read in the browser context.
declare global {
  var layoutShiftCapture: { shifts: LayoutShift[]; failure: string | null } | undefined;
  var focusFrames: FocusFrames;
  var unavailableActivations: string[];
  var invalidEvents: string[];
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { chromium, request as playwrightRequest } from "playwright";

import { AgentCallerPermissionsResponse } from "../../packages/contracts/src/api/resources.ts";

import { waitForIdleFetches } from "./console-fetch-accounting.ts";
import { fulfillPatchedJson } from "./console-patched-response.ts";

import { watchBrowserContext } from "../helpers/browser-failure-diagnostics.ts";
import { keepRequestInterceptionEnabled } from "../helpers/browser-request-interception.mjs";
import { memberRole } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { restrict } from "../helpers/iam-grants.mjs";
import { SECRET_OPERATE_DENIED } from "../helpers/refusal-text.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

// Shared with the API tests, which drive the same fixture without a browser.
export { authorizationDenials, grantMember } from "../helpers/console-app.mjs";

// What a member who writes Agents holds in one Namespace (the ux-audit-1018 member-write
// persona), for fixture.createNamespaceMember. It has no Installation access, so it cannot read
// or write IAM policy.

export const MEMBER_WRITE: readonly Grant[] = [
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
 */
export function memberWriteWithout(...grants: Grant[]) {
  const held = ([action, resourceKind]: Grant) =>
    grants.some((grant) => grant[0] === action && grant[1] === resourceKind);
  const kept = MEMBER_WRITE.filter((grant) => !held(grant));
  assert.equal(kept.length, MEMBER_WRITE.length - grants.length, "MEMBER_WRITE holds each grant");
  return kept;
}

// What a member who reads an Agent holds in one Namespace: the Namespace, the Agent, its
// versions and its Configuration. Tests add the grants their persona needs to it.

export const AGENT_READ: typeof MEMBER_WRITE = [
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
export function revokeMemberGrant(fixture: Fixture, label: string, grant: Grant) {
  return revokeRoleGrant(memberRole(fixture, label), label, grant);
}

/**
 * Removes one [action, resourceKind] grant from the Installation administrator Role the fixture
 * seeds for its administrator account, which `login` signs in by default. Returns a restore
 * function, as revokeMemberGrant does.
 */
export function revokeAdministratorGrant(fixture: Fixture, grant: Grant) {
  const role = fixture.policy.roles.find(({ name }) => name === "Installation administrator");
  assert.ok(role, "the fixture's administrator has a Role");
  return revokeRoleGrant(role, "the administrator", grant);
}

/**
 * Binds the Installation administrator Role the fixture seeds to `principal`, as another
 * administrator grants Installation administration while that account is signed in. Returns a
 * function that removes that binding again, as another administrator revokes it.
 */
export function grantInstallationAdministration(fixture: Fixture, principal: unknown) {
  assert.ok(
    principal !== null &&
      typeof principal === "object" &&
      "id" in principal &&
      typeof principal.id === "string",
  );
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

function revokeRoleGrant(
  role: Fixture["policy"]["roles"][number],
  holder: string,
  [action, resourceKind]: Grant,
) {
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
// holding Secret operate, bound to `principal` once for each Secret. `revoke(secretId: string)` removes
// that Secret's binding.
export function grantSecretOperate(
  fixture: Fixture,
  namespaceId: string,
  principal: unknown,
  secretIds: string[],
) {
  assert.ok(
    principal !== null &&
      typeof principal === "object" &&
      "id" in principal &&
      typeof principal.id === "string",
  );
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
    revoke(secretId: string) {
      const index = fixture.policy.bindings.findIndex(({ id }) => id === `${roleId}-${secretId}`);
      assert.notEqual(index, -1, `Secret operate on ${secretId} is granted`);
      fixture.policy.bindings.splice(index, 1);
    },
  };
}

// The caller-permissions answer is advisory. Report Configuration update as granted, as a page
// that read the answer before a revocation would, so the Configuration editor opens and what a
// test sees is the API's refusal (finding 2421).
export async function grantStaleConfigurationUpdate(page: Page) {
  await page.route(/\/agents\/[^/]+\/permissions$/, (route) =>
    fulfillPatchedJson(route, AgentCallerPermissionsResponse, (body) => ({
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

export function apiRequests(page: Page, origin: string) {
  const requests: RequestRecord[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      let body: unknown;
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
async function artifactDirectory(t: TestContext) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  if (configured !== undefined && configured.length > 0) {
    t.diagnostic(`console Agent browser artifacts: ${configured}`);
    return configured;
  }
  const directory = await mkdtemp(join(tmpdir(), "openclaw-console-agents-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function launchBrowser(options: { args?: string[] } = {}) {
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
let sharedLaunch: Promise<Browser> | undefined;
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

export async function newPage(
  t: TestContext,
  fixture: PageFixture,
  options: {
    args?: string[];
    launch?: () => Promise<Browser>;
    browser?: () => Promise<Browser>;
    context?: Parameters<Browser["newContext"]>[0];
  } = {},
) {
  const artifacts = await artifactDirectory(t);
  assert.ok(
    [options.browser, options.args, options.launch].filter((option) => option !== undefined)
      .length <= 1,
    "pass one of a shared browser, launch arguments, or a dedicated browser factory",
  );
  const shared = options.args === undefined && options.launch === undefined;
  const browser = shared
    ? await (options.browser ?? sharedBrowser)()
    : await (options.launch?.() ?? launchBrowser(options));
  const resources: {
    context?: BrowserContext;
    diagnostics?: Awaited<ReturnType<typeof watchBrowserContext>>;
  } = {};
  // A file app (fileConsoleApp) outlives the test, so its pages close when the test ends.
  const registerCleanup = fixture.sharedByFile
    ? (cleanup: () => Promise<void>) => t.after(cleanup)
    : fixture.registerCleanupBeforeAppClose;
  registerCleanup(async () => {
    let cleanupError;
    try {
      await resources.diagnostics?.capture();
      await resources.context?.close();
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
  const context = await browser.newContext(options.context);
  resources.context = context;
  resources.diagnostics = await watchBrowserContext(t, context);
  await keepRequestInterceptionEnabled(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return { page, artifacts };
}

const signedInPath = /\/console\/(agents|backends|namespaces|settings|secrets)/;

function assertCredentials(credentials: unknown): asserts credentials is Credentials {
  assert.ok(
    credentials !== null &&
      typeof credentials === "object" &&
      "email" in credentials &&
      typeof credentials.email === "string" &&
      "password" in credentials &&
      typeof credentials.password === "string",
  );
}

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

export async function login(
  page: Page,
  fixture: LoginFixture,
  path: string | URL = "/console/agents",
  credentials: unknown = fixture.credentials,
) {
  assertCredentials(credentials);
  const origin = new URL(fixture.origin);
  if (
    page.url() !== "about:blank" ||
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1"
  ) {
    await loginForm(page, fixture, path, credentials);
    return;
  }
  if (fixture.sharedByFile && credentials === fixture.credentials) {
    await page.context().addCookies(await fileSessionCookies(fixture));
    // An earlier test that ended this session would otherwise leave this test on the sign-in
    // page, which waitForURL below cannot tell apart from the console. This test fails and says
    // so; the next one signs in again, so one such test fails at most one other.
    const session = await page.request.get(new URL("/api/auth/session", origin).href);
    const body: unknown = await session.json().catch(() => null);
    if (!(isRecord(body) && isRecord(body.data) && body.data.authenticated === true)) {
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
const fileSessions = new WeakMap<
  LoginFixture,
  Promise<Awaited<ReturnType<BrowserContext["storageState"]>>["cookies"]>
>();

function fileSessionCookies(fixture: LoginFixture) {
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
  page: Page,
  fixture: LoginFixture,
  path: string | URL = "/console/agents",
  credentials: unknown = fixture.credentials,
) {
  assertCredentials(credentials);
  await loginForm(page, fixture, path, credentials);
}

async function loginForm(
  page: Page,
  fixture: LoginFixture,
  path: string | URL,
  credentials: Credentials,
) {
  await page.goto(new URL(path, fixture.origin).href);
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(signedInPath);
}

// Every request that is not a GET: the writes a "nothing was written" check expects none of.
// The console's CSP limits fetches to its own origin, so apiRequests sees every API write.

export function writeRequests(requests: RequestRecord[]) {
  return requests.filter((request) => request.method !== "GET");
}

// writeRequests without the sign-in and sign-out requests (/api/auth/sign-*).

export function nonAuthWriteRequests(requests: RequestRecord[]) {
  return writeRequests(requests).filter((request) => !request.path.startsWith("/api/auth/sign-"));
}

// Whether a Secret value control hides what is typed: a password input, or the masked
// multiline box every Create Secret form uses where the browser supports masking (finding 2339).
export async function isMaskedSecretValue(control: Locator) {
  return control.evaluate(
    (node) =>
      node.getAttribute("type") === "password" ||
      globalThis.getComputedStyle(node).getPropertyValue("-webkit-text-security") === "disc",
  );
}

export function secretOptionLabel(secret: Pick<Secret, "name"> | null | undefined) {
  assert.ok(secret);
  return secret.name;
}

export async function selectSecret(
  scope: Scope,
  label: string,
  secret: Pick<Secret, "name"> | null | undefined,
  options: { query?: string } = {},
) {
  assert.ok(secret);
  const field = scope.getByLabel(label, { exact: true });
  await field.fill(options.query ?? secret.name);
  await scope.getByRole("option", { name: secretOptionLabel(secret), exact: true }).click();
}

// Lists `secret` in the Secret field `label` and returns its option, which carries the reason in
// its accessible name when the caller may read the Secret but not operate it (finding 2453).

export async function operateDeniedSecretOption(
  scope: Scope,
  label: string,
  secret: Pick<Secret, "name"> | null | undefined,
) {
  assert.ok(secret);
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

export async function deniedCreateSecretOption(scope: Scope, label: string, reason: string) {
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
export function expireSessions(fixture: { memoryDatabase: { session: { expiresAt?: Date }[] } }) {
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
export async function expectNoText(page: Page, pattern: string | RegExp, settled?: () => unknown) {
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

export async function revealNativeConfiguration(page: Page, label: string) {
  await page.getByText(label).click();
}

export function detailUrl(
  fixture: Pick<Fixture, "origin">,
  namespaceId: string,
  agentId: string,
  revision?: unknown,
  tab?: string,
) {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  if (revision !== undefined) {
    assert.ok(typeof revision === "string");
    url.searchParams.set("revision", revision);
  }
  if (tab !== undefined) {
    url.searchParams.set("tab", tab);
  }
  return url;
}

export function pathRequests(
  requests: RequestRecord[],
  method: string | undefined,
  path: string | undefined,
) {
  return requests.filter((request) => request.method === method && request.path === path);
}

export function secretPostRequests(requests: RequestRecord[], namespaceId: string) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/secrets`);
}

export function accessBindingPostRequests(requests: RequestRecord[], namespaceId: string) {
  return pathRequests(requests, "POST", `/namespaces/${namespaceId}/iam/access-bindings`);
}

// A bound Secret picker reads "Bound Secret" until its Namespace Secret list loads, and every
// render (page load, save, reload) starts that load again. Read such a picker only through this.
export async function waitForInputValue(locator: Locator, expected: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await locator.inputValue();
  while (value !== expected && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
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
export async function waitForShownInputValue(
  locator: Locator,
  expected: string,
  timeoutMs = 10_000,
) {
  await waitForInputValue(locator, expected, timeoutMs);
  await locator.waitFor({ state: "visible", timeout: timeoutMs });
}

// A control becomes enabled when the page state behind it settles, which can be a task or more
// after the text a test waits for (finding 2116). A test that expects a control to be usable
// waits through this; one isEnabled() read can see the earlier state. A check that a control is
// disabled at a given moment still reads isDisabled() once.
export async function waitForEnabled(locator: Locator, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  await locator.waitFor({ state: "attached", timeout: timeoutMs });
  try {
    await waitForCondition(
      () => locator.isEnabled(),
      `${locator} stayed disabled for ${timeoutMs} ms`,
      Math.max(1, deadline - Date.now()),
    );
  } catch (error) {
    const reason = await locator.evaluate((element) =>
      (element.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; UI reason: ${reason}`,
      { cause: error },
    );
  }
}

// Ordering sentinel for "this action sends no request" checks. After one macrotask turn, the
// page fetches a static asset and this waits for the response. Chromium reports requests in
// the order the page starts them, so any request started before the sentinel (synchronously,
// from a microtask or from a zero-delay timer) is already in the apiRequests() log.
export async function settlePageRequests(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const response = await fetch(`/console/favicon-16.png?request-sentinel=${Date.now()}`, {
      cache: "no-store",
    });
    await response.arrayBuffer();
  });
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
export async function expireSessionsWhenSettled(
  page: Page,
  fixture: { memoryDatabase: { session: { expiresAt?: Date }[] } },
  { except }: { except?: string } = {},
) {
  await waitForIdleFetches(page, { except });
  expireSessions(fixture);
}

// Polls `predicate` until it is truthy; on timeout, `message` alone is the failure.
export async function waitForCondition(
  predicate: () => unknown,
  message: string,
  timeoutMs = 5_000,
) {
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

// Read a fresh shipped draft by file name without ".json". The wire shape and template
// syntax are checked; concrete launch fields and credential admission remain downstream.
export async function shippedPreset(name: string) {
  const preset: unknown = JSON.parse(
    await readFile(new URL(`../../deploy/presets/${name}.json`, import.meta.url), "utf8"),
  );
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, CreatePresetBody, preset),
    `Expected shipped Preset ${name} to match the create wire shape`,
  );
  // Discard the validator's broader return type: tokenized approvers are valid drafts but
  // need not satisfy the concrete Agent approver schema until rendered.
  validatePresetTemplate(preset.template);
  return preset;
}

type HarnessConfiguration = ReturnType<typeof createHarnessConfiguration>;
type NativeValues<Channels> = Omit<HarnessConfiguration, "plugins"> & {
  channels: Channels;
  plugins: Omit<NonNullable<HarnessConfiguration["plugins"]>, "entries"> & {
    entries: Partial<NonNullable<HarnessConfiguration["plugins"]>["entries"]> & {
      knowledge: { enabled: boolean; config: Record<string, string | number[]> };
    };
  };
};
export function nativeValues<Channels extends Record<string, unknown>>(
  marker: string,
  options: { harnessId?: string; providerModel?: string; channels: Channels },
): NativeValues<Channels>;
export function nativeValues(
  marker: string,
  options?: { harnessId?: string; providerModel?: string; channels?: undefined },
): NativeValues<Record<string, never>>;
export function nativeValues<Channels extends Record<string, unknown>>(
  marker: string,
  options: { harnessId?: string; providerModel?: string; channels?: Channels | undefined },
): NativeValues<Partial<Channels>>;
export function nativeValues(
  marker: string,
  options: {
    harnessId?: string;
    providerModel?: string;
    channels?: Record<string, unknown> | undefined;
  } = {},
) {
  const harnessId = options.harnessId ?? "openclaw";
  const providerModel = options.providerModel ?? (harnessId === "codex" ? "gpt-5.1" : "gpt-4.1");
  const base = createHarnessConfiguration(harnessId, providerModel);
  const knowledgeConfig: Record<string, string | number[]> = { marker, thresholds: [1, 2, 3] };
  const basePlugins = base.plugins;
  const basePluginEntries = basePlugins?.entries ?? {};
  return {
    ...base,
    channels: options.channels ?? {},
    plugins: {
      ...basePlugins,
      entries: {
        ...basePluginEntries,
        knowledge: {
          enabled: true,
          config: knowledgeConfig,
        },
      },
    },
  };
}

// Exercise the visible chip control rather than writing its hidden serialized value.
export async function setSlackSelection(input: Locator, value: string) {
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

export async function slackSelectionValue(input: Locator) {
  return input
    .locator("..")
    .locator("..")
    .locator(".slack-directory-chip")
    .evaluateAll((chips) => chips.map((chip) => chip.getAttribute("title")).join(", "));
}

export function repositoryCheckbox(page: Page, name: string) {
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

export async function holdRequests(
  t: TestContext,
  page: Page,
  url: Parameters<Page["route"]>[0],
  {
    once = false,
    method,
    afterServer = false,
    loseResponse = false,
    fulfill = null,
    timeout = 10_000,
  }: {
    once?: boolean;
    method?: string;
    afterServer?: boolean;
    loseResponse?: boolean;
    fulfill?: Parameters<Route["fulfill"]>[0] | null;
    timeout?: number;
  } = {},
) {
  if (loseResponse && !afterServer) {
    throw new Error("loseResponse needs afterServer: only a server answer can be lost");
  }
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: requested, resolve, reject } = Promise.withResolvers<APIResponse | undefined>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const markRequested = (response: APIResponse | undefined) => {
    clearTimeout(timer);
    resolve(response);
  };
  const failRequested = (error: unknown = new Error(`No ${url} request was held`)) => {
    clearTimeout(timer);
    reject(error);
  };
  requested.catch(() => {});
  let taken = false;
  await page.route(url, async (route) => {
    if ((once && taken) || (method !== undefined && route.request().method() !== method)) {
      await route.fallback();
      return;
    }
    taken = true;
    let response: APIResponse | null = null;
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
    await (
      response || fulfill
        ? route.fulfill(fulfill ?? (response ? { response } : {}))
        : route.continue()
    ).catch(() => {});
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
  const capture: NonNullable<typeof globalThis.layoutShiftCapture> = { shifts: [], failure: null };
  globalThis.layoutShiftCapture = capture;
  const recordFailure = (error: unknown) => {
    capture.failure ??=
      error instanceof Error ? error.message : "Unknown layout-shift capture failure";
  };
  const recordEntries: PerformanceObserverCallback = (list) => {
    try {
      for (const entry of list.getEntries()) {
        if (
          !("hadRecentInput" in entry) ||
          typeof entry.hadRecentInput !== "boolean" ||
          !("value" in entry) ||
          typeof entry.value !== "number" ||
          !("sources" in entry) ||
          !Array.isArray(entry.sources)
        ) {
          throw new Error("Expected a layout-shift entry");
        }
        if (!entry.hadRecentInput) {
          capture.shifts.push({
            value: entry.value,
            sources: entry.sources.map((source: unknown) => {
              if (
                source === null ||
                typeof source !== "object" ||
                !("node" in source) ||
                !(
                  source.node === null ||
                  source.node === undefined ||
                  source.node instanceof Node
                ) ||
                !("previousRect" in source) ||
                !(source.previousRect instanceof DOMRectReadOnly) ||
                !("currentRect" in source) ||
                !(source.currentRect instanceof DOMRectReadOnly)
              ) {
                throw new Error("Expected a layout-shift source");
              }
              return {
                node: `${source.node?.nodeName}.${source.node instanceof Element ? source.node.className : undefined}`,
                text: source.node?.textContent?.slice(0, 40),
                from: [source.previousRect.y, source.previousRect.height],
                to: [source.currentRect.y, source.currentRect.height],
              };
            }),
          });
        }
      }
    } catch (error) {
      recordFailure(error);
    }
  };
  try {
    new globalThis.PerformanceObserver(recordEntries).observe({
      type: "layout-shift",
      buffered: true,
    });
  } catch (error) {
    recordFailure(error);
  }
}

// Returns the layout shifts recorded since the last call, and their total. A capture failure
// remains fatal on every drain so an incomplete sample cannot pass as a stable layout.
export async function takeLayoutShifts(page: Page) {
  const shifts = await page.evaluate(() => {
    const capture = globalThis.layoutShiftCapture;
    if (capture === undefined) {
      throw new Error("Layout-shift recording was not installed; call recordLayoutShifts first");
    }
    if (capture.failure !== null) {
      throw new Error(`Layout-shift capture failed: ${capture.failure}`);
    }
    return capture.shifts.splice(0);
  });
  return { shift: shifts.reduce((sum, entry) => sum + entry.value, 0), shifts };
}

// Resolves after the page has painted twice more and run a task after that, so work that has
// already settled has rendered and any layout shift from it has been reported.
export const nextFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
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

export const recordFocusTrail = (
  page: Page,
  loadingTexts: string[] = [],
  { until = null }: { until?: string | null } = {},
) =>
  page.evaluate(
    ({ loadingTexts, until }) => {
      const ids = new WeakMap<Element, number>();
      let next = 0;
      const state: FocusFrames = { trail: [], loadingShown: false, stopped: false, frames: 0 };
      const record = (node: Element | null) => {
        if (node && node !== globalThis.document.body && !ids.has(node)) {
          ids.set(node, ++next);
        }
        const entry =
          !node || node === globalThis.document.body
            ? "BODY"
            : `${node.tagName}#${ids.get(node)}: ${(node.textContent ?? "").trim()}`;
        if (state.trail.at(-1) !== entry) {
          state.trail.push(entry);
          state.stopped ||= until !== null && new RegExp(until).test(entry);
        }
      };
      const focused = (event: FocusEvent) => {
        if (!state.stopped) {
          record(event.target instanceof Element ? event.target : null);
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

export const stopFocusTrail = (page: Page) =>
  page.evaluate(() => {
    globalThis.focusFrames.stopped = true;
    return globalThis.focusFrames;
  });

// The page's main view once its reads have settled and nothing holds it inert.
export const settledView = '.content [aria-live="polite"][aria-busy="false"]:not([inert])';

// Whether the whole of an element is inside the window, so the reader sees it without scrolling.
export const inViewport = (locator: Locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return top >= 0 && bottom <= globalThis.innerHeight;
  });

// The desktop and phone sizes the console's layout checks sweep.
export const consoleViewports = Object.freeze([
  Object.freeze({ width: 1440, height: 900 }),
  Object.freeze({ width: 390, height: 844 }),
] as const);

// One readable version per history page: the first page lists the newest readable version.
// `olderRead`, when given, is told of each older-page request and answers when it resolves.
export function routeOneVersionPerPage(
  page: Page,
  fixture: Pick<Fixture, "origin">,
  namespace: Pick<Namespace, "id">,
  agent: Pick<Agent, "id">,
  olderRead?: () => unknown,
) {
  const revisionsPath = `/namespaces/${namespace.id}/agents/${agent.id}/revisions`;
  return page.route(
    (url) => url.origin === fixture.origin && url.pathname === revisionsPath,
    async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === "older-page") {
        await olderRead?.();
      }
      const response = await route.fetch({ url: `${fixture.origin}${revisionsPath}` });
      const body: unknown = await response.json();
      assert.ok(isRecord(body) && Array.isArray(body.data) && isRecord(body.meta));
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

export const versionChooser = (scope: Scope) =>
  scope.getByLabel("Viewing version", { exact: true });

// Version `n`'s chooser label: "vN" alone or "vN · <outcome>".
const versionName = (n: number) => new RegExp(`^v${n}(?: ·|$)`);

// Version `n`'s option in the chooser.

export const versionOption = (scope: Scope, n: number) =>
  versionChooser(scope).getByRole("option", { name: versionName(n) });

// Waits until the chooser has a selected version, or until version `n` is the selected one.
export function waitForChosenVersion(scope: Scope, n?: number) {
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
export function denyRevisionRead(
  fixture: Pick<Fixture, "policy">,
  namespace: Pick<Namespace, "id">,
  revision: Pick<AgentRevision, "id">,
) {
  restrict(fixture.policy, "read", "agent_revision", {
    id: `deny-read-${revision.id}`,
    namespaceId: namespace.id,
    resourceId: revision.id,
  });
}

// The Stop Agent button in its row on the Agent page.

export const stopAgentButton = (page: Page) =>
  page
    .getByRole("region", { name: "Stop Agent", exact: true })
    .getByRole("button", { name: "Stop Agent", exact: true });

// WCAG 2 contrast between two sRGB colours given as [r, g, b] in 0-255.
function contrastRatio(a: number[], b: number[]) {
  const luminance = (rgb: number[]) => {
    const [r, g, bl] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    assert.ok(r !== undefined && g !== undefined && bl !== undefined);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  assert.ok(light !== undefined && dark !== undefined);
  return (light + 0.05) / (dark + 0.05);
}

// A control's top edge, its own fill and the surface painted behind it: every translucent
// background up to the first opaque one, composited over it (or over white).
const controlEdge = (locator: Locator) =>
  locator.evaluate((node) => {
    const rgba = (value: string) => {
      const [r, g, b, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number);
      if (r === undefined || g === undefined || b === undefined) {
        throw new Error("Expected RGB channels");
      }
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
      surface = surface.map((value, index) => {
        const channel = layer.rgb[index];
        if (channel === undefined) {
          throw new Error("Expected RGB channel");
        }
        return channel * layer.a + value * (1 - layer.a);
      });
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
export async function assertControlEdge(
  locator: Locator,
  label: string,
  { opaqueFill = false } = {},
) {
  const { edge, width, fill, surface } = await controlEdge(locator);
  assert.equal(width, "1px", `${label}: edge width`);
  assert.equal(edge.a, 1, `${label}: the edge is opaque`);
  if (opaqueFill) {
    assert.equal(fill.a, 1, `${label}: the fill is opaque`);
  }
  const painted = fill.rgb.map((value, index) => {
    const channel = surface[index];
    assert.ok(channel !== undefined);
    return value * fill.a + channel * (1 - fill.a);
  });
  for (const [against, colour] of [
    ["fill", painted],
    ["surface", surface],
  ] as const) {
    const ratio = contrastRatio(edge.rgb, colour);
    assert.ok(
      ratio >= 3,
      `${label}: edge ${edge.rgb} is ${ratio.toFixed(2)}:1 against its ${against} ${colour.map(Math.round)}`,
    );
  }
}

// A status line's look and announcement: its class, tone and role, and with `text` its text, all
// read at one moment (finding 2006).
type StatusTone = {
  className: string;
  tone: string | null;
  role: string | null;
};
export function statusTone(
  locator: Locator,
  options: { text: true },
): Promise<StatusTone & { text: string }>;
export function statusTone(locator: Locator, options?: { text?: false }): Promise<StatusTone>;
export function statusTone(
  locator: Locator,
  options: { text?: boolean },
): Promise<StatusTone & { text?: string }>;
export function statusTone(locator: Locator, { text = false }: { text?: boolean } = {}) {
  return locator.evaluate((node, withText) => {
    return {
      className: node.getAttribute("class") ?? "",
      tone: node.getAttribute("data-tone") ?? null,
      role: node.getAttribute("role"),
      ...(withText ? { text: node.textContent ?? "" } : {}),
    };
  }, text);
}

// A long resource ID as the console shortens it in text: its first 12 and last 6 characters.
export const shortId = (id: string) => `${id.slice(0, 12)}…${id.slice(-6)}`;

// A control's accessible description from aria-describedby: the text of each element it names,
// in order (finding D749). A referenced ID that renders nothing adds nothing.

export function accessibleDescription(locator: Locator) {
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
export function asksBeforeUnload(page: Page) {
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
export async function expectWriteAsksBeforeUnload(
  t: TestContext,
  page: Page,
  url: Parameters<Page["route"]>[0],
  { method, start, settled }: { method: string; start: () => unknown; settled: () => unknown },
) {
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
export function hasFocus(locator: Pick<ElementHandle<HTMLElement | SVGElement>, "evaluate">) {
  return locator.evaluate((node: Element) => node === globalThis.document.activeElement);
}

// The ID of the element that holds focus in the page: "" for one without an ID, null when nothing
// does.
export function focusedId(page: Page) {
  return page.evaluate(() => globalThis.document.activeElement?.id ?? null);
}

// A natively disabled control is out of the Tab order, so a keyboard reader never reaches it or
// its reason (findings 2878, 2899). An unavailable control with a reason is aria-disabled
// instead: Tab reaches it, it is described by the reason, and Enter, Space, a click or (in a
// select or text field) an arrow key or typing does nothing. Nothing runs: no handler changes its
// reason or moves focus, no form submits, no checkbox flips, no select or field changes its value,
// and nothing is written.
export async function expectReachableReason(
  page: Page,
  control: Locator,
  reason: string | null | undefined,
) {
  await control.waitFor();
  await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (active instanceof HTMLElement || active instanceof SVGElement) {
      active.blur();
    }
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
      disabled: "disabled" in node ? node.disabled : undefined,
      ariaDisabled: node.getAttribute("aria-disabled"),
      checked: node instanceof HTMLInputElement && node.type === "checkbox" ? node.checked : null,
      value: "value" in node ? node.value : undefined,
    }));
  const before = await state();
  assert.deepEqual(before, { ...before, focused: true, disabled: false, ariaDisabled: "true" });
  assert.equal(await accessibleDescription(control), reason);
  const editable = await control.evaluate(
    (node) =>
      node.localName === "select" || (node instanceof HTMLInputElement && node.type === "text"),
  );
  const writes: string[] = [];
  const onRequest = (request: Request) => {
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
export async function focusKeptOverClose(close: Locator, elsewhere: Locator) {
  const target = await elsewhere.elementHandle();
  assert.ok(target);
  try {
    return await close.evaluate(
      (control, node) =>
        new Promise<boolean>((resolve) => {
          const dialog = control.closest("dialog");
          if (!dialog || !(control instanceof HTMLElement)) {
            throw new Error("Expected a dialog close control");
          }
          dialog.addEventListener(
            "close",
            () => resolve(globalThis.document.activeElement === node),
            {
              once: true,
            },
          );
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
export async function countInvalidEvents(page: Page) {
  await page.addInitScript(() => {
    globalThis.invalidEvents = [];
    globalThis.document.addEventListener(
      "invalid",
      (event) => {
        if (event.target instanceof Element) {
          globalThis.invalidEvents.push(event.target.id || event.target.tagName);
        }
      },
      true,
    );
  });
  return () => page.evaluate(() => globalThis.invalidEvents);
}

// Rejection fixtures may have invalid native settings, but must still contain JSON values.
export function assertConfigurationValues(
  values: unknown,
): asserts values is OpenClawConfigurationDocument {
  assert.ok(
    Check({ SafeJsonValue: JsonValue }, ConfigurationValues, values),
    "Expected native Configuration JSON values",
  );
}

// A Configuration row as a release before a save rule stored it: save refuses `values` with
// `reason`, and the row is then written through the Configuration Driver, as an older release
// left it. `configurationDriver` is the fixture's test Configuration Driver.
export async function storeRefusedConfiguration(
  fixture: Pick<Fixture, "request">,
  configurationDriver: ReturnType<
    typeof import("../helpers/configuration-driver.ts").createTestConfigurationDriver
  >,
  agent: Pick<Agent, "namespaceId" | "configurationId">,
  values: Record<string, unknown>,
  reason: string,
) {
  const configurationPath = `/namespaces/${agent.namespaceId}/configurations/${agent.configurationId}`;
  const refusedSave = await fixture.request("PATCH", configurationPath, { body: { values } });
  assert.equal(refusedSave.status, 400, JSON.stringify(refusedSave.body));
  assert.equal(refusalMessage(refusedSave.body), reason);
  const stored = configurationDriver.stored({
    namespaceId: agent.namespaceId,
    id: agent.configurationId,
  });
  assert.ok(stored, "Expected the stored Configuration");
  assertConfigurationValues(values);
  await configurationDriver.update({ ...stored, values });
}

export const draftActions = (page: Page) => page.locator(".agent-draft-actions");
export const draftDeployButton = (card: Locator) =>
  card.getByRole("button", { name: "Deploy new version", exact: true });
export const draftFirstStep = (card: Locator) =>
  card.getByRole("listitem").first().locator(".checklist-detail");

// Agent detail holds Deploy for a stored draft deploy admission refuses: the draft card shows
// deploy's exact refusal, Deploy is disabled, nothing says ready, and the first step opens with
// `step` (the step text up to and including its " · " separator).
export async function expectDeployHeld(
  card: Locator,
  reason: string,
  step: string,
  message: string = "",
) {
  await card.getByText(reason, { exact: true }).waitFor();
  assert.equal(await draftDeployButton(card).isDisabled(), true, message);
  assert.equal(await card.getByText("Ready to deploy.").count(), 0, message);
  assert.ok(((await draftFirstStep(card).textContent()) ?? "").startsWith(step), message);
}

// Deploy admission refuses the stored draft with the exact text the page shows, before any
// revision.
export async function expectDeployRefused(
  fixture: Pick<Fixture, "request">,
  agent: Pick<Agent, "namespaceId" | "id">,
  reason: string | null | undefined,
) {
  const refusedDeploy = await fixture.request(
    "POST",
    `/namespaces/${agent.namespaceId}/agents/${agent.id}/deploy`,
  );
  assert.equal(refusedDeploy.status, 400, JSON.stringify(refusedDeploy.body));
  assert.equal(refusalMessage(refusedDeploy.body), reason, JSON.stringify(refusedDeploy.body));
}

// Following the held step in the Configuration editor: saving `values` makes the draft ready,
// with Deploy enabled and the first step saved.
export async function saveConfigurationUntilReady(
  page: Page,
  card: Locator,
  values: Record<string, unknown>,
) {
  const edit = page.getByRole("button", { name: "Edit Configuration", exact: true });
  await edit.scrollIntoViewIfNeeded();
  await edit.click();
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(values, null, 2));
  await page.getByRole("button", { name: "Save Configuration", exact: true }).click();
  await card.getByText("Ready to deploy.", { exact: true }).waitFor();
  assert.equal(await draftDeployButton(card).isDisabled(), false);
  assert.match((await draftFirstStep(card).textContent()) ?? "", /^Saved · Configuration /);
}

// The page fits the viewport: no horizontal scroll.
export async function expectNoHorizontalScroll(page: Page) {
  assert.equal(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    true,
  );
}

// The in-memory fixture has no worker records. A test that supplies a failed deployment
// record builds its error with the API's own code, so the console shows the exact code,
// message and data that the API and occ return for that failure.
export function persistedDeploymentError(
  code: NonNullable<Parameters<typeof deploymentErrorForWork>[0]["reasonCode"]>,
  data?: Parameters<typeof deploymentErrorForWork>[0]["resultData"],
) {
  const error = deploymentErrorForWork({
    state: "failed_permanent",
    reasonCode: code,
    ...(data === undefined ? {} : { resultData: data }),
  });
  assert.ok(error);
  assert.ok(Check(AgentDeploymentStatusSchema.properties.error, error));
  return error;
}

// The getAgentDeployment response for an admitted revision when the fixture has no worker. A
// running record with `nextAttemptAt` is a started deploy whose work waits for its next attempt:
// it stays running between attempts (finding 2456).
export function deploymentStatusResponse(
  {
    id: deploymentId,
    namespaceId,
    agentId,
    createdAt,
  }: Pick<AgentRevisionWire, "id" | "namespaceId" | "agentId"> & {
    createdAt?: AgentRevisionWire["createdAt"] | undefined;
  },
  {
    status,
    error = null,
    attempt,
    nextAttemptAt,
    warnings = [],
  }: {
    status: AgentDeploymentStatusWire["status"];
    error?: AgentDeploymentStatusWire["error"] | undefined;
    attempt?: Parameters<typeof deploymentProgressForWork>[1];
    nextAttemptAt?: string | undefined;
    warnings?: AgentDeploymentStatusWire["warnings"] | undefined;
  },
): { json: AgentDeploymentStatusResponse } {
  const waiting = status === "queued" || nextAttemptAt !== undefined;
  let progress: AgentDeploymentStatusWire["progress"] = null;
  if (status === "queued" || status === "running") {
    const availableAt = nextAttemptAt ?? createdAt;
    assert.ok(
      availableAt !== undefined,
      "A pending deployment needs its revision or next-attempt timestamp",
    );
    progress = deploymentProgressForWork(
      { state: waiting ? "queued" : "claimed", availableAt: new Date(availableAt) },
      attempt,
    );
  }
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
  page: Page,
  fixture: Pick<Fixture, "origin">,
  {
    namespaceId,
    agentId,
    deploymentId,
    code = "DEPENDENCY_UNAVAILABLE",
  }: Pick<AgentDeploymentStatusWire, "namespaceId" | "agentId" | "deploymentId"> & {
    code?: Parameters<typeof persistedDeploymentError>[0] | undefined;
  },
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

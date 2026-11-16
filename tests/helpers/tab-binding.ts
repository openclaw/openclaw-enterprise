import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import pg from "pg";
import { chromium, type Browser, type Page, type Response } from "playwright";
import { reservePort } from "./available-port.ts";
import { chromiumTrustArg, startHttpsIngress } from "./console-app.mjs";
import { deferred } from "./deferred.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  assertProviderAttached,
  authRowCounts,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin,
  sessionCookieName,
  onboardPasswordAccounts,
  signedInHeaders,
} from "./production-sign-in.mjs";
import type { SignInSettings } from "./sign-in-chart.ts";

type Provider = {
  name: string;
  title: string;
  start: (context: TestContext) => void | Promise<void>;
  settings: (recoveryUserId: string) => SignInSettings;
  secrets: Readonly<Record<string, string> & { "occ-auth/secret": string }>;
  subject: string;
  authorizationUrl: string;
  code: (url: string) => string;
};

type ReplayHeaders = { cookie: string; host: string; origin?: string };
type ReplayBody = { attemptId: string };
type ExchangeEvidence = {
  request?: { headers: ReplayHeaders; body: ReplayBody };
  withoutOrigin?: number;
  foreignOrigin?: number;
  sessionsBefore?: number;
  sessionKey?: string;
};

const adminEmail = "tabs-recovery@example.test";
const password = "tabs-member-password";

const sessionPath = "/api/auth/session";
const staleProbePath = `${sessionPath}?stale-probe`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function passwordAccount(value: unknown) {
  assert.ok(isRecord(value));
  const { id, email, password } = value;
  assert.ok(typeof id === "string" && typeof email === "string" && typeof password === "string");
  return { id, email, password };
}

function responseData(payload: unknown) {
  assert.ok(isRecord(payload) && "data" in payload, "expected an authentication response");
  return payload.data;
}

async function receiptSessionKey(response: Response) {
  const payload: unknown = await response.json();
  const data = responseData(payload);
  assert.ok(
    isRecord(data) && typeof data.sessionKey === "string",
    "expected a receipt session key",
  );
  return data.sessionKey;
}

async function inspectSession(page: Page, path = sessionPath) {
  const { status, payload } = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const payload: unknown = await response.json();
    return { status: response.status, payload };
  }, path);
  const data = responseData(payload);
  if (data === null) {
    return { status, data };
  }
  assert.ok(isRecord(data) && data.authenticated === true && typeof data.sessionKey === "string");
  assert.ok(isRecord(data.user) && typeof data.user.id === "string");
  return { status, data: { userId: data.user.id, sessionKey: data.sessionKey } };
}

function createStaleProbe() {
  const proceed = deferred();
  const deliver = deferred();
  return {
    arrived: deferred<string | undefined>(),
    ready: deferred(),
    proceed,
    deliver,
    release() {
      proceed.resolve();
      deliver.resolve();
    },
  };
}

/**
 * Two tabs of one browser share a cookie jar. Tab A signs in with the external provider and
 * exchanges its one-use receipt for its session key (#522); tab B then signs in as someone
 * else with a password. Tab A must sign out instead of acting as B. A response from a revoked
 * session must also leave the replacement sign-in in another tab intact. Chromium receives the real
 * controller responses over HTTPS. The external provider is the only simulated endpoint.
 */
export async function proveTabBinding(t: TestContext, databaseUrl: string, provider: Provider) {
  const { secrets } = provider;
  const resultPath = `/api/auth/providers/${provider.name}/result`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  const resources: {
    browser?: Browser;
    closeIngress?: () => Promise<void>;
    closeApp?: () => Promise<void>;
  } = {};
  let staleProbe: ReturnType<typeof createStaleProbe> | undefined;
  t.after(async () => {
    staleProbe?.release();
    await resources.browser?.close();
    await resources.closeIngress?.();
    await resources.closeApp?.();
    await pool.end();
  });
  await provider.start(t);
  const address = clientAddresses();
  const onboarding: unknown = await onboardPasswordAccounts(t, {
    databaseUrl,
    state,
    pool,
    email: adminEmail,
    authSecret: secrets["occ-auth/secret"],
    secrets,
    password,
    passwordHasher: undefined,
    passwordSlowLaneFloors: undefined,
    remoteAddress: address(),
    accounts: {
      alice: { email: "tabs-alice@example.test", role: "admin" },
      bob: { email: "tabs-bob@example.test", role: "admin" },
    },
  });
  assert.ok(isRecord(onboarding) && isRecord(onboarding.accounts));
  const admin = passwordAccount(onboarding.admin);
  const alice = passwordAccount(onboarding.accounts.alice);
  const bob = passwordAccount(onboarding.accounts.bob);

  const reservation = await reservePort();
  t.after(reservation.release);
  const publicOrigin = new URL(consoleOrigin);
  publicOrigin.port = String(reservation.port);
  const origin = publicOrigin.origin;
  const app = await composeProductionSignIn(t, {
    passwordHasher: undefined,
    databaseUrl,
    settings: { ...provider.settings(admin.id), OCC_AUTH_BASE_URL: origin },
    secrets,
  });
  resources.closeApp = () => app.close();
  const sessionCount = async () => {
    const counts: unknown = await authRowCounts(pool);
    assert.ok(isRecord(counts) && typeof counts.sessions === "number");
    return counts.sessions;
  };

  const exchange: ExchangeEvidence = {};
  const replay = (headers: ReplayHeaders, body: ReplayBody) =>
    app.inject({ method: "POST", url: resultPath, headers, payload: body });
  app.addHook("preHandler", async (request) => {
    if (request.url !== resultPath || request.headers.origin !== origin || exchange.request) {
      return;
    }
    // Refuse the same receipt at the real route before the browser redeems it.
    const { cookie, host } = request.headers;
    assert.ok(typeof cookie === "string" && typeof host === "string");
    const { body } = request;
    assert.ok(isRecord(body) && typeof body.attemptId === "string");
    const receiptBody = { attemptId: body.attemptId };
    exchange.request = { headers: { cookie, host, origin }, body: receiptBody };
    exchange.withoutOrigin = (await replay({ cookie, host }, receiptBody)).statusCode;
    exchange.foreignOrigin = (
      await replay({ cookie, host, origin: "https://evil.example.test" }, receiptBody)
    ).statusCode;
    exchange.sessionsBefore = await sessionCount();
  });
  app.addHook("onRequest", async (request) => {
    if (request.url === staleProbePath && staleProbe) {
      staleProbe.arrived.resolve(request.headers.cookie);
      await staleProbe.proceed.promise;
    }
  });
  app.addHook("onSend", async (request) => {
    if (request.url === staleProbePath && staleProbe) {
      staleProbe.ready.resolve();
      await staleProbe.deliver.promise;
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const upstream = app.server.address();
  assert.ok(upstream && typeof upstream !== "string");
  const ingress: { cert: unknown; close: () => Promise<void> } = await startHttpsIngress({
    port: reservation.port,
    reusePort: reservation.reusePort,
    upstreamPort: upstream.port,
    originHost: publicOrigin.hostname,
    tls: undefined,
  });
  resources.closeIngress = () => ingress.close();
  await reservation.release();
  assert.ok(Buffer.isBuffer(ingress.cert));

  const { cookie, host }: { cookie: string; host: string } = await signedInHeaders(
    app,
    origin,
    admin,
    address(),
  );
  await assertProviderAttached(
    app,
    { cookie, host, origin },
    alice.id,
    provider.name,
    provider.subject,
  );

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
    args: [
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${publicOrigin.hostname} 127.0.0.1`,
      chromiumTrustArg([ingress.cert]),
    ],
  });
  resources.browser = browser;
  const context = await browser.newContext();
  await context.route(`${provider.authorizationUrl}**`, async (route) => {
    const url = new URL(route.request().url());
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    assert.ok(redirectUri && state, "expected OIDC authorization redirect and state");
    const callback = new URL(redirectUri);
    assert.equal(callback.origin, origin);
    assert.equal(callback.pathname, `/api/auth/providers/${provider.name}/callback`);
    callback.searchParams.set("state", state);
    callback.searchParams.set("code", provider.code(url.href));
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });

  // Both tabs open the sign-in page while signed out.
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabB.goto(`${origin}/console/login`);
  await tabB.getByLabel("Email", { exact: true }).waitFor();
  await tabA.goto(`${origin}/console/`);

  await t.test(
    `tab A signs in with ${provider.title} and pins the session its receipt names`,
    async () => {
      const pinnedRead = tabA.waitForRequest(
        (request) => new URL(request.url()).pathname === "/namespaces",
      );
      const callbackResponse = tabA.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/auth/providers/${provider.name}/callback`,
      );
      const receiptResponse = tabA.waitForResponse(
        (response) => new URL(response.url()).pathname === resultPath,
      );
      await tabA.getByRole("button", { name: `Continue with ${provider.title}` }).click();
      await tabA.waitForURL(/\/console\/agents/);
      assert.equal((await callbackResponse).headers().location, "/console/");
      const receipt = await receiptResponse;
      assert.equal(exchange.withoutOrigin, 403, "the exchange needs the exact Origin");
      assert.equal(exchange.foreignOrigin, 403);
      assert.equal(receipt.status(), 200, "a refused request does not consume the receipt");
      assert.equal(await sessionCount(), exchange.sessionsBefore, "no session is issued");
      exchange.sessionKey = await receiptSessionKey(receipt);
      assert.equal((await pinnedRead).headers()["x-occ-session-key"], exchange.sessionKey);
      const { data: session } = await inspectSession(tabA);
      assert.equal(session?.userId, alice.id);
      assert.equal(session?.sessionKey, exchange.sessionKey);
      const cookies = await context.cookies(origin);
      assert.ok(cookies.some(({ name }) => name.startsWith("__Host-")));
      assert.equal(
        cookies.some(({ name }) => name === "occ_login_receipt" || name.endsWith("login_receipt")),
        false,
        "the exchange clears the receipt",
      );
    },
  );

  await t.test("replaying the receipt is refused", async () => {
    assert.ok(exchange.request, "expected the first browser exchange");
    const response = await replay(exchange.request.headers, exchange.request.body);
    assert.equal(response.statusCode, 401, response.body);
  });

  await t.test("tab B signs in as another user by password", async () => {
    await tabB.getByLabel("Email", { exact: true }).fill(bob.email);
    await tabB.getByLabel("Password").fill(bob.password);
    await tabB.getByRole("button", { name: "Sign in" }).click();
    await tabB.waitForURL(/\/console\/agents/);
    const { data: session } = await inspectSession(tabB);
    assert.equal(session?.userId, bob.id);
  });

  await t.test("tab A shows signed-out instead of acting as tab B's user", async () => {
    const refused = tabA.waitForResponse((response) => response.status() === 401);
    await tabA.getByRole("link", { name: "Namespaces", exact: true }).click();
    const response = await refused;
    assert.ok(exchange.sessionKey, "expected tab A's pinned session key");
    assert.equal(response.request().headers()["x-occ-session-key"], exchange.sessionKey);
    await tabA.getByText("Your session has expired").waitFor();
    await tabA.getByLabel("Email", { exact: true }).waitFor();
    // Tab B keeps working as its own user.
    const readB = tabB.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/namespaces",
    );
    await tabB.getByRole("link", { name: "Namespaces", exact: true }).click();
    assert.equal((await readB).status(), 200);
    assert.equal(await tabB.getByText("Your session has expired").count(), 0);
  });

  await t.test(
    "a delayed inspection of a revoked session preserves a newer browser sign-in",
    { timeout: 60_000 },
    async () => {
      const currentCookie = async () =>
        (await context.cookies(origin)).find(({ name }) => name === sessionCookieName);
      const signOut = (page: Page) =>
        page.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST" })).status);
      const signInWithProvider = async (page: Page) => {
        const exchanged = page.waitForResponse(
          (response) => new URL(response.url()).pathname === resultPath,
        );
        await page.getByRole("button", { name: `Continue with ${provider.title}` }).click();
        const response = await exchanged;
        assert.equal(response.status(), 200);
        const { data: session } = await inspectSession(page);
        assert.ok(session, "expected an authenticated browser session");
        assert.equal(session.userId, alice.id);
        assert.equal(session.sessionKey, await receiptSessionKey(response));
        return session;
      };
      assert.equal(await signOut(tabB), 200);
      await tabB.goto(`${origin}/console/login`);
      const oldSession = await signInWithProvider(tabA);
      const oldCookie = await currentCookie();
      assert.ok(oldCookie);

      const probe = createStaleProbe();
      staleProbe = probe;
      const stale = inspectSession(tabA, staleProbePath);
      try {
        // Start with A's real cookie, revoke it via sign-out in B, then let the controller
        // inspect the original request while the browser waits for its response.
        const oldHeaders = await Promise.race([probe.arrived.promise, stale]);
        assert.ok(
          typeof oldHeaders === "string" &&
            oldHeaders.split("; ").includes(`${oldCookie.name}=${oldCookie.value}`),
          "the delayed probe carried the old browser cookie",
        );
        assert.equal(await signOut(tabB), 200);
        assert.equal(await currentCookie(), undefined, "ordinary sign-out clears the cookie");
        probe.proceed.resolve();
        const held = await Promise.race([
          probe.ready.promise.then(() => true),
          stale.then(() => false),
        ]);
        assert.equal(held, true, "the stale response must be held before reaching Chromium");

        // The browser must receive the newer session first. Releasing the old
        // response afterward reproduces the order that used to clear the cookie.
        const fresh = await signInWithProvider(tabB);
        assert.notEqual(fresh.sessionKey, oldSession.sessionKey);
        probe.release();
        assert.deepEqual(await stale, { status: 200, data: null });
        assert.equal(
          (await inspectSession(tabB)).data?.sessionKey,
          fresh.sessionKey,
          "a late stale response must leave the replacement browser session authenticated",
        );
        assert.equal(
          await tabB.evaluate(
            async (sessionKey) =>
              (await fetch("/namespaces", { headers: { "x-occ-session-key": sessionKey } })).status,
            fresh.sessionKey,
          ),
          200,
        );
      } finally {
        probe.release();
        await stale.catch(() => {});
      }
    },
  );
}

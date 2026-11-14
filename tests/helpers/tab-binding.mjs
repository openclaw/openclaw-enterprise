import assert from "node:assert/strict";
import pg from "pg";
import { chromium } from "playwright";
import { reservePort } from "./available-port.mjs";
import { chromiumTrustArg, startHttpsIngress } from "./console-app.mjs";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  attachProvider,
  authRowCounts,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin,
  sessionCookieName,
  onboardPasswordAccounts,
  signedInHeaders,
} from "./production-sign-in.mjs";

const adminEmail = "tabs-recovery@example.test";
const password = "tabs-member-password";

const sessionPath = "/api/auth/session";
const staleProbePath = `${sessionPath}?stale-probe`;

/**
 * Two tabs of one browser share a cookie jar. Tab A signs in with the external provider and
 * exchanges its one-use receipt for its session key (#522); tab B then signs in as someone
 * else with a password. Tab A must sign out instead of acting as B. A response from a revoked
 * session must also leave the replacement sign-in in another tab intact. Chromium receives the real
 * controller responses over HTTPS. The external provider is the only simulated endpoint.
 *
 * `provider`: `name` (route segment), `title` (button label), `start(t)` (installs the fake
 * provider), `settings(recoveryUserId)`, `secrets`, `subject` (attached to tab A's account),
 * `authorizationUrl` (the browser redirect target to intercept) and `code(url)` (the code the
 * provider returns for an authorization URL).
 */
export async function proveTabBinding(t, databaseUrl, provider) {
  const { secrets } = provider;
  const resultPath = `/api/auth/providers/${provider.name}/result`;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  let app;
  let browser;
  let ingress;
  let staleProbe;
  t.after(async () => {
    staleProbe?.proceed.resolve();
    staleProbe?.deliver.resolve();
    await browser?.close();
    await ingress?.close();
    await app?.close();
    await pool.end();
  });
  await provider.start(t);
  const address = clientAddresses();
  const {
    admin,
    accounts: { alice, bob },
  } = await onboardPasswordAccounts(t, {
    databaseUrl,
    state,
    pool,
    email: adminEmail,
    authSecret: secrets["occ-auth/secret"],
    secrets,
    password,
    remoteAddress: address(),
    accounts: {
      alice: { email: "tabs-alice@example.test", role: "admin" },
      bob: { email: "tabs-bob@example.test", role: "admin" },
    },
  });
  const reservation = await reservePort();
  t.after(reservation.release);
  const publicOrigin = new URL(consoleOrigin);
  publicOrigin.port = String(reservation.port);
  const origin = publicOrigin.origin;
  app = await composeProductionSignIn(t, {
    databaseUrl,
    settings: { ...provider.settings(admin.id), OCC_AUTH_BASE_URL: origin },
    secrets,
  });
  const sessionCount = async () => (await authRowCounts(pool)).sessions;

  const exchange = {};
  app.addHook("preHandler", async (request) => {
    if (request.url !== resultPath || request.headers.origin !== origin || exchange.headers) {
      return;
    }
    // Refuse the same receipt at the real route before the browser redeems it.
    const { cookie, host } = request.headers;
    const replay = (headers) =>
      app.inject({ method: "POST", url: resultPath, headers, payload: request.body });
    exchange.headers = { cookie, host, origin };
    exchange.body = request.body;
    exchange.withoutOrigin = (await replay({ cookie, host })).statusCode;
    exchange.foreignOrigin = (
      await replay({ cookie, host, origin: "https://evil.example.test" })
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
  ingress = await startHttpsIngress({
    port: reservation.port,
    reusePort: reservation.reusePort,
    upstreamPort: app.server.address().port,
    originHost: publicOrigin.hostname,
  });
  await reservation.release();

  const adminHeaders = await signedInHeaders(app, origin, admin, address());
  const attached = await attachProvider(
    app,
    adminHeaders,
    alice.id,
    provider.name,
    provider.subject,
  );
  assert.equal(attached.statusCode, 200, attached.body);

  browser = await chromium.launch({
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
  const context = await browser.newContext();
  await context.route(`${provider.authorizationUrl}**`, async (route) => {
    const url = new URL(route.request().url());
    const callback = new URL(url.searchParams.get("redirect_uri"));
    assert.equal(callback.origin, origin);
    assert.equal(callback.pathname, `/api/auth/providers/${provider.name}/callback`);
    callback.searchParams.set("state", url.searchParams.get("state"));
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
      exchange.sessionKey = (await receipt.json()).data.sessionKey;
      assert.equal((await pinnedRead).headers()["x-occ-session-key"], exchange.sessionKey);
      const session = await tabA.evaluate(
        async () => (await (await fetch("/api/auth/session")).json()).data,
      );
      assert.equal(session.user.id, alice.id);
      assert.equal(session.sessionKey, exchange.sessionKey);
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
    const replay = await app.inject({
      method: "POST",
      url: resultPath,
      headers: exchange.headers,
      payload: exchange.body,
    });
    assert.equal(replay.statusCode, 401, replay.body);
  });

  await t.test("tab B signs in as another user by password", async () => {
    await tabB.getByLabel("Email", { exact: true }).fill(bob.email);
    await tabB.getByLabel("Password").fill(bob.password);
    await tabB.getByRole("button", { name: "Sign in" }).click();
    await tabB.waitForURL(/\/console\/agents/);
    const session = await tabB.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).data,
    );
    assert.equal(session.user.id, bob.id);
  });

  await t.test("tab A shows signed-out instead of acting as tab B's user", async () => {
    const refused = tabA.waitForResponse((response) => response.status() === 401);
    await tabA.getByRole("link", { name: "Namespaces", exact: true }).click();
    const response = await refused;
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
      const readSession = (page) =>
        page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).data);
      const signOut = (page) =>
        page.evaluate(async () => (await fetch("/api/auth/sign-out", { method: "POST" })).status);
      const signInWithProvider = async (page) => {
        const exchanged = page.waitForResponse(
          (response) => new URL(response.url()).pathname === resultPath,
        );
        await page.getByRole("button", { name: `Continue with ${provider.title}` }).click();
        const response = await exchanged;
        assert.equal(response.status(), 200);
        const session = await readSession(page);
        assert.equal(session.user.id, alice.id);
        assert.equal(session.sessionKey, (await response.json()).data.sessionKey);
        return session;
      };
      assert.equal(await signOut(tabB), 200);
      await tabB.goto(`${origin}/console/login`);
      const oldSession = await signInWithProvider(tabA);
      const oldCookie = await currentCookie();
      assert.ok(oldCookie);

      staleProbe = {
        arrived: Promise.withResolvers(),
        proceed: Promise.withResolvers(),
        ready: Promise.withResolvers(),
        deliver: Promise.withResolvers(),
      };
      const stale = tabA.evaluate(async (path) => {
        const response = await fetch(path);
        return { status: response.status, data: (await response.json()).data };
      }, staleProbePath);
      const settleStale = () => {
        staleProbe.proceed.resolve();
        staleProbe.deliver.resolve();
      };
      try {
        // Start with A's real cookie, revoke it via sign-out in B, then let the controller
        // inspect the original request while the browser waits for its response.
        const oldHeaders = await Promise.race([staleProbe.arrived.promise, stale]);
        assert.ok(
          typeof oldHeaders === "string" &&
            oldHeaders.split("; ").includes(`${oldCookie.name}=${oldCookie.value}`),
          "the delayed probe carried the old browser cookie",
        );
        assert.equal(await signOut(tabB), 200);
        assert.equal(await currentCookie(), undefined, "ordinary sign-out clears the cookie");
        staleProbe.proceed.resolve();
        const held = await Promise.race([
          staleProbe.ready.promise.then(() => true),
          stale.then(() => false),
        ]);
        assert.equal(held, true, "the stale response must be held before reaching Chromium");

        // The browser must receive the newer session first. Releasing the old
        // response afterward reproduces the order that used to clear the cookie.
        const fresh = await signInWithProvider(tabB);
        assert.notEqual(fresh.sessionKey, oldSession.sessionKey);
        settleStale();
        assert.deepEqual(await stale, { status: 200, data: null });
        assert.equal(
          (await readSession(tabB))?.sessionKey,
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
        settleStale();
        await stale.catch(() => {});
      }
    },
  );
}

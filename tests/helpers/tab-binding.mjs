import assert from "node:assert/strict";
import pg from "pg";
import { chromium } from "playwright";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import {
  attachProvider,
  authRowCounts,
  clientAddresses,
  composeProductionSignIn,
  consoleOrigin as origin,
  onboardPasswordAccounts,
  signedInHeaders,
} from "./production-sign-in.mjs";

const adminEmail = "tabs-recovery@example.test";
const password = "tabs-member-password";

// Playwright does not route the target of a fulfilled redirect, so a redirect is
// delivered as an immediate same-URL refresh page that keeps the response's cookies.
function refreshTo(location) {
  const target = location.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html><meta http-equiv="refresh" content="0;url=${target}">`;
}

function fulfilment(response, redirects) {
  const headers = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === "transfer-encoding" || name === "connection") {
      continue;
    }
    headers[name] = Array.isArray(value)
      ? value.join(name === "set-cookie" ? "\n" : ", ")
      : String(value);
  }
  if (response.statusCode >= 300 && response.statusCode < 400 && headers.location) {
    redirects?.push(headers.location);
    const location = headers.location;
    delete headers.location;
    delete headers["content-length"];
    headers["content-type"] = "text/html; charset=utf-8";
    return { status: 200, headers, body: refreshTo(location) };
  }
  return { status: response.statusCode, headers, body: response.rawPayload };
}

/**
 * Two tabs of one browser share a cookie jar. Tab A signs in with the external provider and
 * exchanges its one-use receipt for its session key (#522); tab B then signs in as someone
 * else with a password. Tab A must sign out instead of acting as B. The browser reaches the
 * production API over its HTTPS Origin: each request is served in-process by Fastify inject,
 * so the __Host- cookies, Origin checks and redirects are the production ones.
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
  t.after(async () => {
    await browser?.close();
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
  app = await composeProductionSignIn(t, {
    databaseUrl,
    settings: provider.settings(admin.id),
    secrets,
  });
  const adminHeaders = await signedInHeaders(app, origin, admin, address());
  const attached = await attachProvider(
    app,
    adminHeaders,
    alice.id,
    provider.name,
    provider.subject,
  );
  assert.equal(attached.statusCode, 200, attached.body);
  const sessionCount = async () => (await authRowCounts(pool)).sessions;

  browser = await chromium.launch({
    headless: true,
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext();
  const exchange = {};
  const redirects = [];
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = Object.fromEntries(
      Object.entries(await request.allHeaders()).filter(([name]) => !name.startsWith(":")),
    );
    const forward = (overrides = headers) =>
      app.inject({
        method: request.method(),
        url: url.pathname + url.search,
        headers: overrides,
        ...(request.postDataBuffer() ? { payload: request.postDataBuffer() } : {}),
      });
    if (url.pathname === resultPath) {
      // Hold tab A's exchange: the same cookies and attemptId without the exact Origin
      // are refused first, and must not consume the receipt.
      const { origin: _origin, ...withoutOrigin } = headers;
      exchange.withoutOrigin = (await forward(withoutOrigin)).statusCode;
      exchange.foreignOrigin = (
        await forward({ ...headers, origin: "https://evil.example.test" })
      ).statusCode;
      exchange.headers = headers;
      exchange.body = request.postDataBuffer();
      exchange.sessionsBefore = await sessionCount();
      const response = await forward();
      exchange.sessionsAfter = await sessionCount();
      exchange.status = response.statusCode;
      exchange.sessionKey = response.statusCode === 200 ? response.json().data.sessionKey : null;
      await route.fulfill(fulfilment(response, redirects));
      return;
    }
    await route.fulfill(fulfilment(await forward(), redirects));
  });
  await context.route(`${provider.authorizationUrl}**`, async (route) => {
    const url = route.request().url();
    const attemptState = new URL(url).searchParams.get("state");
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: refreshTo(
        `${origin}/api/auth/providers/${provider.name}/callback?state=${attemptState}&code=${provider.code(url)}`,
      ),
    });
  });

  // Both tabs open the sign-in page while signed out.
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabB.goto(`${origin}/console/login`);
  await tabB.getByLabel("Username").waitFor();
  await tabA.goto(`${origin}/console/`);

  await t.test(
    `tab A signs in with ${provider.title} and pins the session its receipt names`,
    async () => {
      const pinnedRead = tabA.waitForRequest(
        (request) => new URL(request.url()).pathname === "/namespaces",
      );
      await tabA.getByRole("button", { name: `Continue with ${provider.title}` }).click();
      await tabA.waitForURL(/\/console\/agents/);
      assert.deepEqual(redirects, ["/console/"], "the callback redirects to exactly /console/");
      assert.equal(exchange.withoutOrigin, 403, "the exchange needs the exact Origin");
      assert.equal(exchange.foreignOrigin, 403);
      assert.equal(exchange.status, 200, "a refused request does not consume the receipt");
      assert.equal(exchange.sessionsAfter, exchange.sessionsBefore, "no session is issued");
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
    await tabB.getByLabel("Username").fill(bob.email);
    await tabB.getByLabel("Password").fill(bob.password);
    await tabB.getByRole("button", { name: "Login" }).click();
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
    await tabA.getByLabel("Username").waitFor();
    // Tab B keeps working as its own user.
    const readB = tabB.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === "/namespaces",
    );
    await tabB.getByRole("link", { name: "Namespaces", exact: true }).click();
    assert.equal((await readB).status(), 200);
    assert.equal(await tabB.getByText("Your session has expired").count(), 0);
  });
}

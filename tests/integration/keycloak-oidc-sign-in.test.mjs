import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { tlsPeerCertificate } from "../helpers/tls-peer-certificate.mjs";
import pg from "pg";
import { chromium } from "playwright";
import { oidcLoginConfiguration } from "../../apps/controller/src/auth/oidc.ts";
import { providerJSON } from "../../apps/controller/src/auth/provider-transport.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { chromiumTrustArg, startHttpsIngress } from "../helpers/console-app.mjs";
import {
  bootstrapProductionInstallation,
  clientAddresses,
  composeProductionSignIn,
  installationRoles,
  oidcUpgradeSettings,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";

// Real Keycloak, prepared by scripts/ci/prepare.mjs for the keycloak-oidc lane
// (docs/testing/keycloak.md): it imports tests/fixtures/keycloak/realm-oce.json and serves
// https://keycloak.oce.localhost on 127.0.0.1:443 under a per-run CA that this process
// trusts through NODE_EXTRA_CA_CERTS. Nothing here is stubbed: the browser fills Keycloak's
// own login form, and the controller reaches the real token and JWKS endpoints with its
// production transport. Requests are only observed.
const issuer = process.env.OCC_TEST_KEYCLOAK_ISSUER;
const secretsFile = process.env.OCC_TEST_KEYCLOAK_SECRETS_FILE;
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const consolePort = Number(process.env.OCC_TEST_KEYCLOAK_CONSOLE_PORT);
const missing =
  !issuer ||
  !secretsFile ||
  !databaseUrl ||
  !Number.isInteger(consolePort) ||
  !process.env.OCC_TEST_KEYCLOAK_CA_CERT ||
  !process.env.OCC_TEST_KEYCLOAK_CONSOLE_CERT ||
  !process.env.OCC_TEST_KEYCLOAK_CONSOLE_KEY ||
  !process.env.NODE_EXTRA_CA_CERTS;
// The lane fails on a skip; outside it, this names what is missing.
const requiresKeycloak = missing
  ? "requires the keycloak-oidc lane's prepared Keycloak (docs/testing/keycloak.md)"
  : false;

function modulusBits(n) {
  const bytes = Buffer.from(n, "base64url");
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) {
    leading += 1;
  }
  const top = bytes[leading] ?? 0;
  return (bytes.length - leading - 1) * 8 + (32 - Math.clz32(top));
}

test(
  "Keycloak discovery matches the configured endpoints and its JWKS offers an RS256 key of 2,048 bits or more",
  { skip: requiresKeycloak },
  async () => {
    const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const discovery = await response.json();

    // OCE does no runtime discovery: an operator copies these four values into its
    // configuration. Production parsing must accept them as Keycloak publishes them, which
    // is the endpoint rule (HTTPS, port 443, one DNS host, issuer without a port).
    const config = oidcLoginConfiguration({
      OCC_AUTH_OIDC_ISSUER: discovery.issuer,
      OCC_AUTH_OIDC_AUTHORIZATION_URL: discovery.authorization_endpoint,
      OCC_AUTH_OIDC_TOKEN_URL: discovery.token_endpoint,
      OCC_AUTH_OIDC_JWKS_URL: discovery.jwks_uri,
      OCC_AUTH_OIDC_CLIENT_ID: secrets.clientId,
      OCC_AUTH_OIDC_CLIENT_SECRET: secrets.clientSecret,
    });
    // `iss` is compared with the configured string, so it must be the lane's exact issuer.
    assert.equal(config.issuer, issuer);
    assert.equal(config.authorizationUrl, `${issuer}/protocol/openid-connect/auth`);
    assert.equal(config.tokenUrl, `${issuer}/protocol/openid-connect/token`);
    assert.equal(config.jwksUrl, `${issuer}/protocol/openid-connect/certs`);
    assert.ok(discovery.code_challenge_methods_supported.includes("S256"));
    assert.ok(discovery.id_token_signing_alg_values_supported.includes("RS256"));
    for (const method of ["client_secret_post", "client_secret_basic"]) {
      assert.ok(discovery.token_endpoint_auth_methods_supported.includes(method), method);
    }

    // The controller's own bounded transport reads the JWKS, as it does at each callback.
    const jwks = await providerJSON(config.jwksUrl, {}, AbortSignal.timeout(10_000), "jwks");
    const signing = jwks.keys.filter((key) => key.use === "sig" && key.alg === "RS256");
    assert.ok(signing.length > 0, "the realm offers an RS256 signing key");
    for (const key of signing) {
      assert.equal(key.kty, "RSA");
      assert.equal(typeof key.kid, "string");
      assert.ok(key.kid.length > 0);
      assert.ok(modulusBits(key.n) >= 2048, `RS256 key ${key.kid} is at least 2,048 bits`);
    }
  },
);

// The realm's one redirect URI names this origin, so it is OCC_AUTH_BASE_URL.
const origin = `https://127.0.0.1:${consolePort}`;
const adminEmail = "keycloak-recovery@example.test";
// realm-oce.json fixes alice's user ID, so her subject is known before sign-in.
const aliceSubject = "6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001";
const deniedReason = "EXTERNAL_IDENTITY_REJECTED";
// Keycloak 26's login-form error for a disabled user who enters the right password.
const disabledMessage = /Account is disabled/;

let installation;
let browser;
const cleanup = [];
after(async () => {
  for (const close of cleanup.reverse()) {
    await close();
  }
});

/** The Keycloak leaf as served on 127.0.0.1:443, verified against the lane CA. */
async function keycloakLeaf() {
  const ca = await readFile(process.env.OCC_TEST_KEYCLOAK_CA_CERT);
  return tlsPeerCertificate({
    host: "127.0.0.1",
    port: 443,
    servername: new URL(issuer).hostname,
    ca,
  });
}

/**
 * Bootstraps one production Installation for the file, then, as its recovery administrator,
 * creates alice's account and attaches her Keycloak subject. carol has no account.
 */
async function prepareInstallation(t) {
  if (installation !== undefined) {
    return installation;
  }
  const secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  cleanup.push(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const authSecret = randomBytes(32).toString("base64url");
  const adminPassword = await bootstrapProductionInstallation(t, {
    databaseUrl,
    email: adminEmail,
    authSecret,
  });
  const adminId = (await pool.query('SELECT id FROM occ."user" WHERE email = $1', [adminEmail]))
    .rows[0].id;
  const endpoints = {
    issuer,
    authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    jwksUrl: `${issuer}/protocol/openid-connect/certs`,
  };
  const prepared = {
    pool,
    state,
    secrets,
    endpoints,
    address: clientAddresses("198.21"),
    composition: {
      databaseUrl,
      secrets: {
        "occ-auth/secret": authSecret,
        "occ-oidc-login/client-id": secrets.clientId,
        "occ-oidc-login/client-secret": secrets.clientSecret,
      },
    },
    // The chart's OIDC upgrade, served from the lane's HTTPS origin.
    settings: (tokenAuth) =>
      Object.freeze({
        ...oidcUpgradeSettings(adminId, endpoints, { tokenAuth, displayName: "Keycloak" }),
        OCC_AUTH_BASE_URL: origin,
      }),
  };
  const roles = await installationRoles(state, pool);
  const app = await composeProductionSignIn(t, {
    ...prepared.composition,
    settings: prepared.settings("client_secret_post"),
  });
  try {
    const headers = await signedInHeaders(
      app,
      origin,
      { email: adminEmail, password: adminPassword },
      prepared.address(),
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/accounts",
      headers,
      payload: {
        email: "alice@example.test",
        password: randomBytes(24).toString("base64url"),
        roleId: roles.reader.id,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const aliceId = created.json().data.id;
    const attached = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${aliceId}/providers/oidc`,
      headers,
      payload: {
        subject: aliceSubject,
        expectedVersion: (await readAccount(app, headers, aliceId)).version,
      },
    });
    assert.equal(attached.statusCode, 200, attached.body);
    prepared.aliceId = aliceId;
  } finally {
    await app.close();
  }
  installation = prepared;
  return installation;
}

/**
 * Composes the production API with `tokenAuth` and listens on loopback behind the lane's
 * HTTPS origin. One composition serves every page a test opens, so a flow that spans two
 * sign-ins runs against one controller, never a restarted one.
 */
async function serveConsole(t, tokenAuth) {
  const prepared = await prepareInstallation(t);
  const app = await composeProductionSignIn(t, {
    ...prepared.composition,
    settings: prepared.settings(tokenAuth),
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const tls = {
    key: await readFile(process.env.OCC_TEST_KEYCLOAK_CONSOLE_KEY),
    cert: await readFile(process.env.OCC_TEST_KEYCLOAK_CONSOLE_CERT),
  };
  const ingress = await startHttpsIngress({
    port: consolePort,
    upstreamPort: app.server.address().port,
    tls,
  });
  t.after(ingress.close);
  if (browser === undefined) {
    browser = await chromium.launch({
      headless: true,
      // Trusts exactly the two lane leaves: the Console origin and Keycloak.
      args: [chromiumTrustArg([tls.cert, await keycloakLeaf()])],
      ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
        ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
        : {}),
    });
    cleanup.push(() => browser.close());
  }
  return prepared;
}

/** Waits for the next response on an API path, bounded by Playwright's default timeout. */
function nextResponse(page, pathname) {
  const response = page.waitForResponse(
    (candidate) => new URL(candidate.url()).pathname === pathname,
  );
  // A wait a refused flow never satisfies must not surface as an unhandled rejection.
  response.catch(() => {});
  return response;
}

/**
 * Opens a fresh browser context (no Keycloak session) on the served Console. It records each
 * authorization request and the status Keycloak answered it with: 200 is its login form,
 * 302 a redirect from a live Keycloak session.
 */
async function openPage(t, prepared) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const authorizations = [];
  const authorizationStatuses = [];
  const callbacks = [];
  const authorizationUrl = (url) =>
    `${url.origin}${url.pathname}` === prepared.endpoints.authorizationUrl;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (authorizationUrl(url)) {
      authorizations.push(url.searchParams);
    }
    if (url.origin === origin && url.pathname === callbackPath) {
      callbacks.push(url);
    }
  });
  page.on("response", (response) => {
    if (authorizationUrl(new URL(response.url()))) {
      authorizationStatuses.push(response.status());
    }
  });
  return {
    prepared,
    page,
    authorizations,
    authorizationStatuses,
    callbacks,
    callback: nextResponse(page, callbackPath),
  };
}

async function openConsole(t, tokenAuth) {
  return openPage(t, await serveConsole(t, tokenAuth));
}

const callbackPath = "/api/auth/providers/oidc/callback";
const resultPath = "/api/auth/providers/oidc/result";

/** Starts sign-in from the Console and fills Keycloak's real login form as `user`. */
async function signInThroughKeycloak({ prepared, page }, user) {
  await page.goto(`${origin}/console/`);
  await page.getByRole("button", { name: "Continue with Keycloak" }).click();
  await page.waitForURL((url) => url.origin === new URL(issuer).origin);
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(prepared.secrets.users[user].password);
  await page.locator("#kc-login").click();
}

function assertAuthorizationRequest(prepared, authorizations) {
  assert.equal(authorizations.length, 1, "one authorization request reached Keycloak");
  const [parameters] = authorizations;
  assert.equal(parameters.get("response_type"), "code");
  assert.equal(parameters.get("client_id"), prepared.secrets.clientId);
  assert.equal(parameters.get("scope"), "openid");
  assert.equal(parameters.get("code_challenge_method"), "S256");
  assert.match(parameters.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.ok((parameters.get("nonce") ?? "").length > 0, "the request carries a nonce");
  assert.ok((parameters.get("state") ?? "").length > 0, "the request carries a state");
  assert.equal(parameters.get("redirect_uri"), prepared.secrets.redirectUri);
  assert.equal(prepared.secrets.redirectUri, `${origin}${callbackPath}`);
}

/**
 * Follows a started sign-in through the callback and the Console's adoption of its session,
 * and returns that session, which must be alice's.
 */
async function assertAliceSignedIn({ prepared, page }, callback, result) {
  const redirect = await callback;
  assert.equal(redirect.status(), 302);
  assert.equal(redirect.headers().location, "/console/");
  // The Console adopts only the session its own attempt created, then loads signed in.
  const confirmed = await result;
  assert.equal(confirmed.status(), 200);
  await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
  const session = await page.evaluate(
    async () => (await (await fetch("/api/auth/session")).json()).data,
  );
  assert.equal(session.user.id, prepared.aliceId);
  assert.equal((await confirmed.json()).data.sessionKey, session.sessionKey);
  return session;
}

/** Signs alice in through Keycloak's login form on a fresh page and checks the request. */
async function signInAlice(opened) {
  const result = nextResponse(opened.page, resultPath);
  await signInThroughKeycloak(opened, "alice");
  const session = await assertAliceSignedIn(opened, opened.callback, result);
  assertAuthorizationRequest(opened.prepared, opened.authorizations);
  assert.deepEqual(opened.authorizationStatuses, [200], "Keycloak showed its login form");
  return session;
}

/** Calls the Keycloak admin API as the lane's bootstrap administrator. */
async function keycloakAdmin(prepared, method, path, body) {
  const base = new URL(issuer).origin;
  const token = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: prepared.secrets.admin.username,
      password: prepared.secrets.admin.password,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(token.status, 200, "the lane administrator signs in to Keycloak");
  const response = await fetch(`${base}/admin/realms/oce${path}`, {
    method,
    headers: {
      authorization: `Bearer ${(await token.json()).access_token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    assert.fail(
      `Keycloak ${method} ${path} answered HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response.status === 200 ? response.json() : response;
}

/** The kid Keycloak signs RS256 tokens with: its highest-priority active RS256 key. */
async function activeSigningKid(prepared) {
  const kid = (await keycloakAdmin(prepared, "GET", "/keys")).active?.RS256;
  assert.equal(typeof kid, "string", "the realm has an active RS256 key");
  return kid;
}

async function jwksKids(prepared) {
  const jwks = await providerJSON(
    prepared.endpoints.jwksUrl,
    {},
    AbortSignal.timeout(10_000),
    "jwks",
  );
  return jwks.keys.map(({ kid }) => kid);
}

async function aliceSessions(prepared) {
  return (
    await prepared.pool.query("SELECT id FROM occ.session WHERE user_id = $1 ORDER BY id", [
      prepared.aliceId,
    ])
  ).rows.map(({ id }) => id);
}

async function setAliceEnabled(prepared, enabled) {
  const path = `/users/${aliceSubject}`;
  const user = await keycloakAdmin(prepared, "GET", path);
  await keycloakAdmin(prepared, "PUT", path, { ...user, enabled });
}

test(
  "attached alice signs in through Keycloak with client_secret_post",
  { skip: requiresKeycloak },
  async (t) => {
    await signInAlice(await openConsole(t, "client_secret_post"));
  },
);

test(
  "attached alice signs in through Keycloak with client_secret_basic",
  { skip: requiresKeycloak },
  async (t) => {
    await signInAlice(await openConsole(t, "client_secret_basic"));
  },
);

test(
  "a higher-priority Keycloak realm key changes the signing kid and the next sign-in succeeds without a controller restart",
  { skip: requiresKeycloak },
  async (t) => {
    const prepared = await serveConsole(t, "client_secret_post");
    // The controller reads the JWKS at this callback, under the realm's original key.
    await signInAlice(await openPage(t, prepared));
    const before = await activeSigningKid(prepared);
    const kidsBefore = await jwksKids(prepared);
    assert.ok(kidsBefore.includes(before));

    // Keycloak signs with its highest-priority active key; the imported default has 100.
    const realm = await keycloakAdmin(prepared, "GET", "");
    const created = await keycloakAdmin(prepared, "POST", "/components", {
      name: "oce-rotated-rs256",
      providerId: "rsa-generated",
      providerType: "org.keycloak.keys.KeyProvider",
      parentId: realm.id,
      config: {
        priority: ["200"],
        enabled: ["true"],
        active: ["true"],
        algorithm: ["RS256"],
        keySize: ["2048"],
      },
    });
    assert.equal(created.status, 201);
    const componentId = new URL(created.headers.get("location")).pathname.split("/").pop();
    // Later tests sign in under the realm's original key again.
    t.after(() => keycloakAdmin(prepared, "DELETE", `/components/${componentId}`));

    const rotated = await activeSigningKid(prepared);
    assert.notEqual(rotated, before, "Keycloak signs with the new key");
    assert.ok(!kidsBefore.includes(rotated), "the new kid was not published before rotation");
    assert.ok((await jwksKids(prepared)).includes(rotated), "the JWKS now publishes the new kid");

    // Same composition, same process: the next callback verifies the new kid.
    await signInAlice(await openPage(t, prepared));
  },
);

test(
  "unattached carol is refused after Keycloak sign-in, audited and given no account",
  { skip: requiresKeycloak },
  async (t) => {
    const opened = await openConsole(t, "client_secret_post");
    const { prepared, page, authorizations, callback } = opened;
    const counts = async () =>
      (
        await prepared.pool.query(
          `SELECT (SELECT count(*)::int FROM occ."user") AS users,
                  (SELECT count(*)::int FROM occ.account) AS methods,
                  (SELECT count(*)::int FROM occ.session) AS sessions`,
        )
      ).rows[0];
    const denials = async () =>
      (await prepared.state.transact((unit) => unit.audit.list())).filter(
        ({ action, outcome, reasonCode, details }) =>
          action === "authentication.login" &&
          outcome === "denied" &&
          reasonCode === deniedReason &&
          details?.provider === "oidc",
      );
    const before = await counts();
    const deniedBefore = (await denials()).length;

    await signInThroughKeycloak(opened, "carol");
    const redirect = await callback;
    assert.equal(redirect.status(), 302);
    assert.equal(redirect.headers().location, "/console/?authError=oidc");
    await page.getByText("Could not sign in with Keycloak").first().waitFor();
    assertAuthorizationRequest(prepared, authorizations);

    assert.equal(
      await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).data),
      null,
    );
    assert.deepEqual(await counts(), before, "no user, sign-in method or session is created");
    assert.equal((await denials()).length, deniedBefore + 1, "the refusal is audited");
  },
);

test(
  "Console sign-out ends alice's OCE session, one click signs her in again while her Keycloak session lives, and disabling her keeps that session but refuses her next sign-in",
  { skip: requiresKeycloak },
  async (t) => {
    const prepared = await serveConsole(t, "client_secret_post");
    const opened = await openPage(t, prepared);
    const { page } = opened;
    const first = await signInAlice(opened);
    const sessionsBefore = await aliceSessions(prepared);
    assert.ok(sessionsBefore.length > 0);

    // Console sign-out deletes exactly this OCE session; Keycloak's session is untouched
    // (RP-initiated logout is a non-goal).
    const signOut = nextResponse(page, "/api/auth/sign-out");
    await page.getByRole("button", { name: "OpenClaw Enterprise", exact: true }).click();
    await page.getByRole("menuitem", { name: "Logout" }).click();
    assert.equal((await signOut).status(), 200);
    const again = page.getByRole("button", { name: "Continue with Keycloak" });
    await again.waitFor();
    assert.equal(
      await page.evaluate(async () => (await (await fetch("/api/auth/session")).json()).data),
      null,
    );
    const afterSignOut = await aliceSessions(prepared);
    assert.equal(afterSignOut.length, sessionsBefore.length - 1, "one OCE session was deleted");

    // One click: Keycloak answers the authorization request with a redirect, no login form.
    const callback = nextResponse(page, callbackPath);
    const result = nextResponse(page, resultPath);
    await again.click();
    const second = await assertAliceSignedIn(opened, callback, result);
    assert.notEqual(second.sessionKey, first.sessionKey, "a new OCE session was created");
    assert.deepEqual(
      opened.authorizationStatuses,
      [200, 302],
      "the second request skipped the form",
    );
    assert.equal(opened.authorizations.length, 2);
    const signedIn = await aliceSessions(prepared);
    assert.equal(signedIn.length, sessionsBefore.length);

    // Keycloak decides who may authenticate; OCE sessions it already issued run to their end.
    await setAliceEnabled(prepared, false);
    t.after(() => setAliceEnabled(prepared, true));
    const kept = await page.evaluate(
      async () => (await (await fetch("/api/auth/session")).json()).data,
    );
    assert.equal(kept?.user.id, prepared.aliceId, "the current OCE session still works");
    assert.equal(kept.sessionKey, second.sessionKey);

    const refused = await openPage(t, prepared);
    await signInThroughKeycloak(refused, "alice");
    await refused.page.getByText(disabledMessage).first().waitFor();
    assert.equal(refused.callbacks.length, 0, "Keycloak never redirected to OCE");
    assert.equal(new URL(refused.page.url()).origin, new URL(issuer).origin);
    assert.deepEqual(await aliceSessions(prepared), signedIn, "no OCE session was created");
  },
);

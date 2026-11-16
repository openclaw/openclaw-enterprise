import { keycloakRealmAdmin } from "../helpers/ci-keycloak-realm.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { enrollmentWait } from "../helpers/keycloak-enrollment-wait.ts";
import { tlsPeerCertificate } from "../helpers/tls-peer-certificate.ts";
import pg from "pg";
import { chromium } from "playwright";
import { oidcLoginConfiguration } from "../../apps/controller/src/auth/oidc.ts";
import { providerJSON } from "../../apps/controller/src/auth/provider-transport.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { chromiumTrustArg, startHttpsIngress } from "../helpers/console-app.mjs";
import { installationRoles } from "../helpers/postgres-sign-in-installation.ts";
import {
  bootstrapProductionInstallation,
  clientAddresses,
  composeProductionSignIn,
  oidcUpgradeSettings,
  readAccount,
  signedInHeaders,
} from "../helpers/production-sign-in.mjs";
import { integer, record, recordData, text } from "../helpers/postgres-sign-in-test-boundaries.ts";
import {
  readBrowserSession,
  readKeycloakSecrets,
  registerKeycloakSessionLifecycleCases,
} from "./keycloak-session-lifecycle-cases.ts";

// Real Keycloak, prepared by scripts/ci/prepare.mjs for the keycloak-oidc lane
// (docs/testing/kubernetes.md#keycloak-oidc-tests): it imports tests/fixtures/keycloak/realm-oce.json and serves
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
  ? "requires the keycloak-oidc lane's prepared Keycloak (docs/testing/kubernetes.md#keycloak-oidc-tests)"
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
const origin = `https://console.oce.localhost:${consolePort}`;
const adminEmail = "keycloak-recovery@example.test";
// realm-oce.json fixes alice's user ID, so her subject is known before sign-in.
const aliceSubject = "6f1c1e9a-3d4b-4c55-9a2e-0a11ce000001";

/** @typedef {import("node:test").TestContext} TestContext */
/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").Response} BrowserResponse */
/** @typedef {import("../../apps/controller/src/auth/oidc.ts").OidcTokenAuth} OidcTokenAuth */
/** @typedef {Awaited<ReturnType<typeof prepareInstallation>>} PreparedInstallation */
/** @typedef {Awaited<ReturnType<typeof openPage>>} OpenedPage */

/** @type {Awaited<ReturnType<typeof prepareInstallationFixture>> | undefined} */
let installation;
/** @type {import("playwright").Browser | undefined} */
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
 * @param {TestContext} t
 */
async function prepareInstallation(t) {
  installation ??= await prepareInstallationFixture(t);
  return installation;
}

/** @param {TestContext} t */
async function prepareInstallationFixture(t) {
  const secrets = readKeycloakSecrets(JSON.parse(await readFile(secretsFile, "utf8")));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  cleanup.push(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const authSecret = randomBytes(32).toString("base64url");
  const adminPassword = await bootstrapProductionInstallation(t, {
    databaseUrl,
    email: adminEmail,
    authSecret,
  });
  const admin = await pool.query('SELECT id FROM occ."user" WHERE email = $1', [adminEmail]);
  const recoveryAccount = record(admin.rows[0]);
  const adminId = text(recoveryAccount.id);
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
    settings: (/** @type {OidcTokenAuth} */ tokenAuth) =>
      Object.freeze({
        ...oidcUpgradeSettings(adminId, endpoints, { tokenAuth, displayName: "Keycloak" }),
        OCC_AUTH_BASE_URL: origin,
        OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.localhost",
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
    const aliceId = text(recordData(created.json()).id);
    const attached = await app.inject({
      method: "POST",
      url: `/api/auth/accounts/${aliceId}/providers/oidc`,
      headers,
      payload: {
        subject: aliceSubject,
        expectedVersion: integer(record(await readAccount(app, headers, aliceId)).version),
      },
    });
    assert.equal(attached.statusCode, 200, attached.body);
    return { ...prepared, aliceId };
  } finally {
    await app.close();
  }
}

/** @type {ReturnType<ReturnType<typeof enrollmentWait>>} */
const unmeasured = (_operation, promise) => promise;

/**
 * Composes the production API with `tokenAuth` and listens on loopback behind the lane's
 * HTTPS origin. One composition serves every page a test opens, so a flow that spans two
 * sign-ins runs against one controller, never a restarted one.
 * @param {TestContext} t
 * @param {OidcTokenAuth} tokenAuth
 * @param {{ settings?: import("../helpers/sign-in-chart.ts").SignInSettings, secrets?: Record<string, string> }} overrides
 */
async function serveConsole(t, tokenAuth, overrides = {}, wait = unmeasured) {
  const prepared = await prepareInstallation(t);
  const app = await composeProductionSignIn(t, {
    ...prepared.composition,
    settings: { ...prepared.settings(tokenAuth), ...overrides.settings },
    ...(overrides.secrets
      ? { secrets: { ...prepared.composition.secrets, ...overrides.secrets } }
      : {}),
  });
  t.after(() => wait("close-console", app.close()));
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
  t.after(() => wait("close-ingress", ingress.close()));
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

/**
 * Waits for the next response on an API path, bounded by Playwright's default timeout.
 * @param {Page} page
 * @param {string} pathname
 */
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
 * @param {TestContext} t
 * @param {PreparedInstallation} prepared
 */
async function openPage(t, prepared, wait = unmeasured) {
  assert.ok(browser, "serveConsole starts the browser");
  const context = await browser.newContext();
  t.after(() => wait("close-context", context.close()));
  const page = await context.newPage();
  /** @type {URLSearchParams[]} */
  const authorizations = [];
  /** @type {number[]} */
  const authorizationStatuses = [];
  /** @type {URL[]} */
  const callbacks = [];
  /** @param {URL} url */
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

/**
 * @param {TestContext} t
 * @param {OidcTokenAuth} tokenAuth
 */
async function openConsole(t, tokenAuth) {
  return openPage(t, await serveConsole(t, tokenAuth));
}

const callbackPath = "/api/auth/providers/oidc/callback";
const resultPath = "/api/auth/providers/oidc/result";

/**
 * Starts sign-in from the Console and fills Keycloak's real login form as `user`.
 * @param {Pick<OpenedPage, "prepared" | "page">} opened
 * @param {string} user
 * @param {string} [password]
 */
async function signInThroughKeycloak({ prepared, page }, user, password) {
  await page.goto(`${origin}/console/`);
  await page.getByRole("button", { name: "Continue with Keycloak" }).click();
  await page.waitForURL((url) => url.origin === new URL(issuer).origin);
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(password ?? text(prepared.secrets.users[user]?.password));
  await page.locator("#kc-login").click();
}

/**
 * @param {PreparedInstallation} prepared
 * @param {URLSearchParams[]} authorizations
 */
function assertAuthorizationRequest(prepared, authorizations) {
  assert.equal(authorizations.length, 1, "one authorization request reached Keycloak");
  const [parameters] = authorizations;
  assert.ok(parameters);
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
 * @param {Pick<OpenedPage, "prepared" | "page">} opened
 * @param {Promise<BrowserResponse>} callback
 * @param {Promise<BrowserResponse>} result
 */
async function assertAliceSignedIn({ prepared, page }, callback, result) {
  const redirect = await callback;
  assert.equal(redirect.status(), 302);
  assert.equal(redirect.headers().location, "/console/");
  // The Console adopts only the session its own attempt created, then loads signed in.
  const confirmed = await result;
  assert.equal(confirmed.status(), 200);
  await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
  const session = await readBrowserSession(page);
  assert.ok(session, "the Console has an OCE session");
  assert.equal(session.user.id, prepared.aliceId);
  const cookies = await page.context().cookies(origin);
  const sharedSession = cookies.find(
    (cookie) => cookie.name === "__Secure-openclaw_occ_shared.session_token",
  );
  assert.equal(sharedSession?.domain, ".oce.localhost");
  assert.equal(sharedSession?.secure, true);
  assert.equal(sharedSession?.httpOnly, true);
  assert.equal(
    cookies.find((cookie) => cookie.name === "__Host-occ_known_device")?.domain,
    "console.oce.localhost",
  );
  assert.equal(text(recordData(await confirmed.json()).sessionKey), session.sessionKey);
  return session;
}

/**
 * Signs alice in through Keycloak's login form on a fresh page and checks the request.
 * @param {OpenedPage} opened
 */
async function signInAlice(opened) {
  const result = nextResponse(opened.page, resultPath);
  await signInThroughKeycloak(opened, "alice");
  const session = await assertAliceSignedIn(opened, opened.callback, result);
  assertAuthorizationRequest(opened.prepared, opened.authorizations);
  assert.deepEqual(opened.authorizationStatuses, [200], "Keycloak showed its login form");
  return session;
}

/**
 * @param {PreparedInstallation} prepared
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
const keycloakAdmin = (prepared, method, path, body) =>
  keycloakRealmAdmin(issuer, prepared.secrets.admin, method, path, body);

/** @param {PreparedInstallation} prepared */
async function aliceSessions(prepared) {
  return (
    await prepared.pool.query("SELECT id FROM occ.session WHERE user_id = $1 ORDER BY id", [
      prepared.aliceId,
    ])
  ).rows.map((/** @type {unknown} */ row) => text(record(row).id));
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

registerKeycloakSessionLifecycleCases({
  requiresKeycloak,
  aliceSubject,
  callbackPath,
  resultPath,
  serveConsole,
  openConsole,
  openPage,
  nextResponse,
  signInThroughKeycloak,
  signInAlice,
  assertAliceSignedIn,
  assertAuthorizationRequest,
  keycloakAdmin,
  aliceSessions,
});

test(
  "real Keycloak enrollment enforces groups and email policy without inventing verification",
  { skip: requiresKeycloak, timeout: 300_000 },
  async (t) => {
    const waitForRow = enrollmentWait(t);
    const setup = waitForRow(0);
    const prepared = await setup("prepare-installation", prepareInstallation(t));
    const admin = (wait, method, path, body) =>
      wait(
        method === "DELETE" ? "delete-realm-resource" : "configure-realm",
        keycloakAdmin(prepared, method, path, body),
      );
    // This lane owns the disposable realm. Temporarily suppress its standard
    // email mappings so per-client mappings can exercise absent claims. Restore
    // them before any later lane file uses the realm.
    const scopes = await admin(setup, "GET", "/client-scopes");
    const emailScope = scopes.find((scope) => scope.name === "email");
    assert.ok(emailScope);
    const emailMappers = await admin(
      setup,
      "GET",
      `/client-scopes/${emailScope.id}/protocol-mappers/models`,
    );
    for (const mapper of emailMappers) {
      await admin(
        setup,
        "PUT",
        `/client-scopes/${emailScope.id}/protocol-mappers/models/${mapper.id}`,
        {
          ...mapper,
          config: { ...mapper.config, "id.token.claim": "false" },
        },
      );
      t.after(() =>
        keycloakAdmin(
          prepared,
          "PUT",
          `/client-scopes/${emailScope.id}/protocol-mappers/models/${mapper.id}`,
          mapper,
        ),
      );
    }
    // Each row states independent expectations for strict and permissive policy.
    const cases = [];
    for (const [verification, strict, permissive] of [
      [true, true, true],
      [false, false, true],
      [undefined, false, true],
      ["true", false, false],
      [1, false, false],
      [null, false, false],
      [[], false, false],
      [{}, false, false],
    ]) {
      for (const [requireVerifiedEmail, allowed] of [
        [true, strict],
        [false, permissive],
      ]) {
        cases.push({
          name: `email policy ${requireVerifiedEmail}, claim ${JSON.stringify(verification)}`,
          requireVerifiedEmail,
          verification,
          groups: "members",
          allowed,
        });
      }
    }
    for (const [name, groups, allowed] of [
      ["array", ["other", "members"], true],
      ["missing", undefined, false],
      ["null", null, false],
      ["number", 1, false],
      ["object", {}, false],
      ["empty array", [], false],
      ["mixed array", ["members", 1], false],
      ["case mismatch", "Members", false],
      ["leading space", " members", false],
      ["trailing space", "members ", false],
      ["comma joined", "members,other", false],
    ]) {
      cases.push({
        name: `groups ${name}`,
        groups,
        verification: true,
        requireVerifiedEmail: true,
        allowed,
      });
    }
    for (const email of ["alice@example.test", " ALICE@EXAMPLE.TEST ", null, 42, "not-an-email"]) {
      cases.push({
        name: `invalid or occupied email ${JSON.stringify(email)}`,
        email,
        groups: "members",
        verification: false,
        requireVerifiedEmail: false,
        allowed: false,
      });
    }
    cases.push({
      name: "unsupported token signature",
      groups: "members",
      verification: true,
      requireVerifiedEmail: false,
      signingAlgorithm: "HS256",
      allowed: false,
    });
    for (const [index, scenario] of cases.entries()) {
      await t.test(scenario.name, async (subtest) => {
        const wait = waitForRow(index + 1);
        const username = `enrollment-${randomUUID()}`;
        const password = randomBytes(24).toString("base64url");
        const email = scenario.email === undefined ? `${username}@example.test` : scenario.email;
        const clientId = `client-${randomUUID()}`;
        const clientSecret = randomBytes(32).toString("base64url");
        const mapper = (name, value) => ({
          name,
          protocol: "openid-connect",
          protocolMapper: "oidc-hardcoded-claim-mapper",
          config: {
            "claim.name": name,
            "claim.value": typeof value === "string" ? value : JSON.stringify(value),
            "jsonType.label": typeof value === "string" ? "String" : "JSON",
            "id.token.claim": "true",
            "access.token.claim": "false",
            "userinfo.token.claim": "false",
          },
        });
        // The IdP emits exactly this client's profile claims in its signed token.
        await admin(wait, "POST", "/clients", {
          clientId,
          secret: clientSecret,
          enabled: true,
          protocol: "openid-connect",
          publicClient: false,
          standardFlowEnabled: true,
          redirectUris: [`${origin}${callbackPath}`],
          defaultClientScopes: ["email", "profile"],
          optionalClientScopes: [],
          attributes: { "id.token.signed.response.alg": scenario.signingAlgorithm ?? "RS256" },
          protocolMappers: [
            ...(email === null ? [] : [mapper("email", email)]),
            ...(scenario.groups === undefined ? [] : [mapper("groups", scenario.groups)]),
            ...(scenario.verification === undefined
              ? []
              : [mapper("email_verified", scenario.verification)]),
          ],
        });
        const [client] = await admin(wait, "GET", `/clients?clientId=${clientId}`);
        subtest.after(() => admin(wait, "DELETE", `/clients/${client.id}`));
        await admin(wait, "POST", "/users", {
          username,
          enabled: true,
          firstName: "Enrollment",
          lastName: "User",
          email: `${username}@example.test`,
          emailVerified: true,
          credentials: [{ type: "password", value: password, temporary: false }],
        });
        const [user] = await admin(wait, "GET", `/users?username=${username}&exact=true`);
        subtest.after(() => admin(wait, "DELETE", `/users/${user.id}`));
        const query = (sql, values) => wait("query-users", prepared.pool.query(sql, values));
        const count = async () =>
          (await query('SELECT count(*)::int AS n FROM occ."user"')).rows[0].n;
        const before = await count();
        await wait(
          "serve-console",
          serveConsole(
            subtest,
            "client_secret_post",
            {
              secrets: {
                "occ-oidc-login/client-id": clientId,
                "occ-oidc-login/client-secret": clientSecret,
              },
              settings: {
                OCC_AUTH_OIDC_ENROLLMENT: JSON.stringify({
                  admission: { groupsClaim: "groups", anyOf: ["members"] },
                  createAccount: {
                    enabled: true,
                    role: null,
                    requireVerifiedEmail: scenario.requireVerifiedEmail,
                  },
                  groupIds: [],
                }),
              },
            },
            wait,
          ),
        );
        const open = async () => {
          const flow = await wait("open-page", openPage(subtest, prepared, wait));
          await wait("sign-in", signInThroughKeycloak(flow, username, password));
          const callback = await wait("wait-for-callback", flow.callback);
          return { flow, callback };
        };
        const { flow, callback } = await open();
        if (!scenario.allowed) {
          assert.match(callback.headers().location, /authError=oidc/);
          assert.equal(await count(), before, "denial cannot create an account");
          return;
        }
        assert.equal(callback.headers().location, "/console/");
        await wait(
          "wait-for-console",
          flow.page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/),
        );
        const { rows } = await query('SELECT id, email_verified FROM occ."user" WHERE email = $1', [
          email,
        ]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].email_verified, scenario.verification === true);
        assert.equal(await count(), before + 1);
        const { callback: returning } = await open();
        assert.equal(returning.headers().location, "/console/");
        assert.equal(await count(), before + 1, "returning login reuses the account");
        assert.equal(
          (await query('SELECT id FROM occ."user" WHERE email = $1', [email])).rows[0].id,
          rows[0].id,
        );
      });
    }
  },
);

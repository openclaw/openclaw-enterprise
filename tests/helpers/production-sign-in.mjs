import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import pg from "pg";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  cliSessionSettings,
  clientAddressConfiguration,
  humanLoginConfiguration,
} from "../../apps/controller/src/auth/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import {
  privateBootstrapDirectory,
  productionBootstrapEnvironment,
  runBootstrapInstallation,
} from "./bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "./auth-session.mjs";
import { createReadyComputeDriver } from "./development.mjs";
import { idTokenSigner, rsaSigningKey } from "./id-token.mjs";
import { databaseUrl as testDatabaseUrl } from "./postgres-database.mjs";

// Only Compute is passive: no Agent is deployed, so sign-in proofs need no cluster.
// Authentication, State, IAM, audit and Fastify are the production implementations.
function passiveComputeDriver(id) {
  return createReadyComputeDriver(id, {
    implementation: "sign-in-proof-memory-compute",
    async preflight() {},
  });
}

/** Runs the chart's initialization Job command and returns the generated administrator password. */
export async function bootstrapProductionInstallation(context, { databaseUrl, email, authSecret }) {
  const directory = await privateBootstrapDirectory(context, "openclaw-sign-in-proof-");
  const environment = productionBootstrapEnvironment({
    databaseUrl,
    directory,
    email,
    authSecret,
    installationName: "Sign-in proof",
  });
  const result = await runBootstrapInstallation(environment);
  if (!result.ok) {
    throw new Error(`Production bootstrap failed:\n${result.stderr || result.stdout}`);
  }
  return (await readFile(environment.OCC_BOOTSTRAP_PASSWORD_FILE, "utf8")).trim();
}

/** Collects structured controller log events, as the API Pod would emit them. */
export function memoryLogger() {
  const events = [];
  return {
    events,
    logger: createOccLogger({
      component: "occ-api-sign-in-proof",
      destination: {
        write(chunk) {
          for (const line of String(chunk).split("\n")) {
            if (line.length > 0) {
              events.push(JSON.parse(line));
            }
          }
          return true;
        },
      },
    }),
  };
}

export const consoleOrigin = "https://console.oce.example.internal";
export const sessionCookieName = "__Host-openclaw_occ.session_token";
const gatewayApiKeyPath = "/etc/openclaw/gateway-api-key/key";
const secretRef = (name, key) => ({ secretKeyRef: { name, key } });

/**
 * The API Pod's sign-in environment rendered from deploy/examples/production/values.yaml:
 * no OCC_AUTH_GITHUB_*, no trusted proxy. sign-in-chart-parity.test.mjs asserts the
 * chart renders exactly these OCC_AUTH_* and OCC_AGENT_NATIVE_ADMIN_* entries.
 */
export const defaultInstallSettings = Object.freeze({
  OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
  OCC_AUTH_BASE_URL: consoleOrigin,
  OCC_AGENT_NATIVE_ADMIN_ENABLED: "true",
  OCC_AGENT_NATIVE_ADMIN_DOMAIN: "agents.oce.example.internal",
  OCC_AUTH_COOKIE_DOMAIN: "oce.example.internal",
  OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
});

/** The example values plus the GitHub upgrade from production-installation.md step 2. */
export function githubUpgradeValues(recoveryUserId) {
  return {
    "auth.github.enabled": "true",
    "auth.recoveryUserId": recoveryUserId,
    "agentNativeAdmin.enabled": "false",
  };
}

export function githubUpgradeSettings(recoveryUserId) {
  return Object.freeze({
    OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
    OCC_AUTH_BASE_URL: consoleOrigin,
    OCC_AUTH_GITHUB_CLIENT_ID: secretRef("occ-github-login", "client-id"),
    OCC_AUTH_GITHUB_CLIENT_SECRET: secretRef("occ-github-login", "client-secret"),
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId,
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "false",
    OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
  });
}

/** The example values plus Google sign-in, the Google counterpart of githubUpgradeValues. */
export function googleUpgradeValues(recoveryUserId, allowedDomains = []) {
  return {
    "auth.google.enabled": "true",
    ...(allowedDomains.length === 0
      ? {}
      : Object.fromEntries(
          allowedDomains.map((domain, index) => [`auth.google.allowedDomains[${index}]`, domain]),
        )),
    "auth.recoveryUserId": recoveryUserId,
    "agentNativeAdmin.enabled": "false",
  };
}

/** The API Pod's settings for googleUpgradeValues. The recovery name is shared with GitHub. */
export function googleUpgradeSettings(recoveryUserId, allowedDomains = []) {
  return Object.freeze({
    OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
    OCC_AUTH_BASE_URL: consoleOrigin,
    OCC_AUTH_GOOGLE_CLIENT_ID: secretRef("occ-google-login", "client-id"),
    OCC_AUTH_GOOGLE_CLIENT_SECRET: secretRef("occ-google-login", "client-secret"),
    ...(allowedDomains.length === 0
      ? {}
      : { OCC_AUTH_GOOGLE_ALLOWED_DOMAINS: allowedDomains.join(",") }),
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId,
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "false",
    OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
  });
}

/**
 * An Auth0-shaped OIDC issuer for the fixtures: the trailing slash is part of `iss`, and all
 * four URLs share its host, as the parser and chart require.
 */
export const fixtureOidcIssuer = Object.freeze({
  issuer: "https://tenant.idp.example.test/",
  authorizationUrl: "https://tenant.idp.example.test/authorize",
  tokenUrl: "https://tenant.idp.example.test/oauth/token",
  jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
});

/** The example values plus generic OIDC sign-in, the OIDC counterpart of googleUpgradeValues. */
export function oidcUpgradeValues(recoveryUserId, issuer = fixtureOidcIssuer, extra = {}) {
  return {
    "auth.oidc.enabled": "true",
    "auth.oidc.issuer": issuer.issuer,
    "auth.oidc.authorizationUrl": issuer.authorizationUrl,
    "auth.oidc.tokenUrl": issuer.tokenUrl,
    "auth.oidc.jwksUrl": issuer.jwksUrl,
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`auth.oidc.${key}`, value])),
    "auth.recoveryUserId": recoveryUserId,
    "agentNativeAdmin.enabled": "false",
  };
}

/** The API Pod's settings for oidcUpgradeValues. The recovery name is shared with GitHub. */
export function oidcUpgradeSettings(recoveryUserId, issuer = fixtureOidcIssuer, extra = {}) {
  return Object.freeze({
    OCC_AUTH_SECRET: secretRef("occ-auth", "secret"),
    OCC_AUTH_BASE_URL: consoleOrigin,
    OCC_AUTH_OIDC_ISSUER: issuer.issuer,
    OCC_AUTH_OIDC_AUTHORIZATION_URL: issuer.authorizationUrl,
    OCC_AUTH_OIDC_TOKEN_URL: issuer.tokenUrl,
    OCC_AUTH_OIDC_JWKS_URL: issuer.jwksUrl,
    OCC_AUTH_OIDC_CLIENT_ID: secretRef("occ-oidc-login", "client-id"),
    OCC_AUTH_OIDC_CLIENT_SECRET: secretRef("occ-oidc-login", "client-secret"),
    ...(extra.tokenAuth === undefined ? {} : { OCC_AUTH_OIDC_TOKEN_AUTH: extra.tokenAuth }),
    ...(extra.displayName === undefined ? {} : { OCC_AUTH_OIDC_DISPLAY_NAME: extra.displayName }),
    OCC_AUTH_GITHUB_RECOVERY_USER_ID: recoveryUserId,
    OCC_AGENT_NATIVE_ADMIN_ENABLED: "false",
    OCC_GATEWAY_API_KEY_PATH: gatewayApiKeyPath,
  });
}

function resolveSettings(settings, secrets) {
  const environment = {};
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value === "string") {
      environment[name] = value;
    } else {
      const { name: secret, key } = value.secretKeyRef;
      environment[name] = secrets[`${secret}/${key}`];
      if (environment[name] === undefined) {
        throw new Error(`Missing fixture Secret ${secret}/${key}.`);
      }
    }
  }
  return environment;
}

/**
 * Composes the production API from rendered API Pod settings, parsing the sign-in and
 * native-admin names the way apps/controller/src/server.mjs does.
 */
export async function composeProductionSignIn(
  context,
  { databaseUrl, settings, secrets, logger, metrics, passwordSlowLaneFloors },
) {
  const environment = resolveSettings(settings, secrets);
  // The chart mounts the gateway service key Secret at this path; use a private file.
  const keyDirectory = await privateBootstrapDirectory(context, "openclaw-gateway-key-");
  const keyFile = join(keyDirectory, "key");
  if (environment.OCC_GATEWAY_API_KEY_PATH === gatewayApiKeyPath) {
    await writeFile(keyFile, "occ_sign_in_proof_gateway_key", { mode: 0o600 });
  }
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.compute.id = "compute-sign-in-proof";
  const runtime = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration: { configuration, logging: { level: "info" } },
  });
  const { installation } = runtime;
  const humanLogin = humanLoginConfiguration(environment);
  const clientAddress = clientAddressConfiguration(environment);
  // As server.mjs reads OCC_AUTH_CLI_SESSIONS*.
  const cliSessions = cliSessionSettings(environment);
  const nativeAdminEnabled = environment.OCC_AGENT_NATIVE_ADMIN_ENABLED === "true";
  return composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret: environment.OCC_AUTH_SECRET,
    authBaseURL: environment.OCC_AUTH_BASE_URL,
    ...(environment.OCC_GATEWAY_API_KEY_PATH === undefined ? {} : { gatewayApiKeyPath: keyFile }),
    ...humanLogin,
    cliSessions,
    ...(clientAddress === undefined ? {} : { clientAddress }),
    ...(nativeAdminEnabled
      ? {
          nativeAdmin: {
            enabled: true,
            domain: environment.OCC_AGENT_NATIVE_ADMIN_DOMAIN,
            sharedCookieDomain: environment.OCC_AUTH_COOKIE_DOMAIN,
          },
        }
      : {}),
    ...(logger === undefined ? {} : { logger }),
    ...(metrics === undefined ? {} : { metrics }),
    ...(passwordSlowLaneFloors === undefined ? {} : { passwordSlowLaneFloors }),
    drivers: {
      installation,
      defaultPresets: runtime.defaultPresets,
      bundledPresetVersions: runtime.bundledPresetVersions,
      computeDriver: passiveComputeDriver(installation.drivers.compute.id),
      configurationDriver: createTestConfigurationDriver({
        id: installation.drivers.configuration.id,
      }),
      secretDriver: createTestSecretDriver({ id: installation.drivers.secret.id }),
      createIAMDriver: (state) =>
        new NativeIAMDriver(state, {
          id: installation.drivers.iam.id,
          implementation: installation.drivers.iam.implementation,
        }),
    },
  });
}

/** Password sign-in through the public route, from one client address. */
export function passwordSignIn(app, origin, { email, password }, remoteAddress = "192.0.2.10") {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress,
    headers: { origin },
    payload: { email, password },
  });
}

export async function signedInHeaders(app, origin, account, remoteAddress) {
  const response = await passwordSignIn(app, origin, account, remoteAddress);
  if (response.statusCode !== 200) {
    throw new Error(`Password sign-in failed with ${response.statusCode}: ${response.body}`);
  }
  return { cookie: cookieHeaderFromSetCookie(response.headers["set-cookie"]), origin };
}

export async function currentSession(app, cookie) {
  return (await app.inject({ url: "/api/auth/session", headers: { cookie } })).json().data;
}

/** Asserts that a sign-in response's cookie is a session for `userId`; returns the cookie header. */
export async function assertSessionUser(app, response, userId) {
  const cookie = cookieHeaderFromSetCookie(response.headers["set-cookie"]);
  assert.equal((await currentSession(app, cookie)).user.id, userId);
  return cookie;
}

/** Asserts that a provider callback lands on the Console signed in as `userId`; returns the cookie header. */
export async function assertConsoleSignIn(app, callback, userId) {
  assert.equal(callback.headers.location, "/console/", callback.body);
  return assertSessionUser(app, callback, userId);
}

/** Audited login denials with `reason`, only those for `provider` when one is given. */
export async function loginDenialCount(state, reason, provider) {
  return (await state.transact((unit) => unit.audit.list())).filter(
    ({ action, outcome, reasonCode, details }) =>
      action === "authentication.login" &&
      outcome === "denied" &&
      reasonCode === reason &&
      (provider === undefined || details?.provider === provider),
  ).length;
}

/**
 * Asserts that an external provider's callback was refused: a redirect to the Console with
 * `authError=<provider>`, no session cookie, no new user, method or session row, and one more
 * login denial with `reason`. `signIn()` resolves to `{ callback }`; `denials(reason)` resolves
 * to the number of matching denials so far (usually `loginDenialCount`).
 */
export async function assertExternalSignInRefused(
  { pool, provider, denials, signIn },
  message,
  reason = "EXTERNAL_IDENTITY_REJECTED",
  consoleReason = undefined,
) {
  const before = await authRowCounts(pool);
  const deniedBefore = await denials(reason);
  const { callback } = await signIn();
  assert.equal(callback.statusCode, 302, message);
  assert.equal(
    callback.headers.location,
    consoleReason === undefined
      ? `/console/?authError=${provider}`
      : `/console/?authError=${provider}&authReason=${consoleReason}`,
    message,
  );
  assert.equal(
    String(callback.headers["set-cookie"] ?? "").includes(sessionCookieName),
    false,
    `${message}: no session cookie`,
  );
  assert.deepEqual(await authRowCounts(pool), before, `${message}: no user, method or session`);
  assert.equal(await denials(reason), deniedBefore + 1, `${message}: the denial is audited`);
}

/**
 * A pool and PlatformState on the test database for one sign-in test. After the test, each
 * object `closeFirst()` returns (an app, or anything with `close()`) closes in order, then
 * the pool ends.
 * `let app; const { pool, state } = postgresSignInState(t, () => [app]);`
 */
export function postgresSignInState(context, closeFirst = () => []) {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl });
  const state = new PostgresPlatformState(pool);
  context.after(async () => {
    for (const closable of closeFirst()) {
      await closable?.close();
    }
    await pool.end();
  });
  return { pool, state };
}

/** Distinct client addresses, so a suite's many sign-ins never meet the per-address limit. */
export function clientAddresses(prefix = "198.18") {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}.${Math.floor(next / 250)}.${(next % 250) + 1}`;
  };
}

/**
 * The bootstrap policy's Installation administrator Role, and an Installation reader Role
 * without administer that this fixture adds (the bootstrap policy has only the administrator).
 */
export async function installationRoles(state, pool) {
  const installation = await state.loadInstallation();
  const { roles } = await state.loadNativeIAMState(installation.id);
  const admin = roles.find((role) =>
    role.permissions.some(
      ({ action, resourceKind }) => action === "administer" && resourceKind === "installation",
    ),
  );
  if (admin === undefined) {
    throw new Error("The bootstrap policy lacks an Installation administrator Role.");
  }
  const reader = { id: "role_installation_reader_fixture" };
  await pool.query(
    `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, NULL, 'Installation reader', $2::jsonb) ON CONFLICT (id) DO NOTHING`,
    [reader.id, JSON.stringify([{ action: "read", resourceKind: "installation" }])],
  );
  return { admin, reader };
}

/**
 * Listens `server` on loopback and, for the rest of test `t`, mocks fetch so the controller's
 * fixed github.com and api.github.com endpoints reach it; other origins pass through. The
 * caller owns closing `server`. Returns the server's origin.
 */
export async function serveAsGitHub(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const providerOrigin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://github.com" || url.origin === "https://api.github.com") {
      return originalFetch(new URL(url.pathname + url.search, providerOrigin), init);
    }
    return originalFetch(input, init);
  });
  return providerOrigin;
}

/**
 * A local stand-in for github.com and api.github.com, served through `serveAsGitHub`.
 * The authorization code names the GitHub subject: `subject-<id>`; its login is
 * `fixture-<id>`. Modes: "up", "error" (503) and "hang" (never answers). Set
 * `fixture.membership(path, subject)` to answer the allowlist's membership lookups with
 * "active", "pending" or an HTTP status; `fixture.paths` records each request path.
 */
export async function startFakeGitHub(t) {
  const server = createServer();
  const fixture = { mode: "up", requests: 0, paths: [], membership: undefined };
  server.on("request", async (request, response) => {
    fixture.requests += 1;
    fixture.paths.push(request.url);
    if (fixture.mode === "hang") {
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    if (fixture.mode === "error") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/login/oauth/access_token") {
      const subject = /^subject-([1-9][0-9]{0,15})$/.exec(
        new URLSearchParams(body).get("code") ?? "",
      )?.[1];
      response.end(
        JSON.stringify(
          subject === undefined
            ? { error: "bad_verification_code" }
            : { access_token: `ghu_fixture_${subject}`, token_type: "bearer" },
        ),
      );
    } else if (request.url === "/user") {
      // Strict on purpose: suites rely on this 401 to catch a wrong Authorization header.
      const subject = /^Bearer ghu_fixture_([0-9]+)$/.exec(request.headers.authorization ?? "");
      if (subject === null) {
        response.writeHead(401);
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({ id: Number(subject[1]), login: `fixture-${subject[1]}` }));
    } else if (fixture.membership !== undefined) {
      const subject = /^Bearer ghu_fixture_([0-9]+)$/.exec(request.headers.authorization ?? "");
      const answer = subject === null ? 401 : fixture.membership(request.url, Number(subject[1]));
      if (typeof answer === "number") {
        response.writeHead(answer);
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({ state: answer, role: "member" }));
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await serveAsGitHub(t, server);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return fixture;
}

/** Starts GitHub sign-in and completes the callback as `subject`, from one client address. */
export async function githubSignIn(app, origin, subject, remoteAddress = "192.0.2.50") {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/providers/github/start",
    remoteAddress,
    headers: { origin },
  });
  if (start.statusCode !== 200) {
    throw new Error(`GitHub start failed with ${start.statusCode}: ${start.body}`);
  }
  const { url, attemptId } = start.json().data;
  const state = new URL(url).searchParams.get("state");
  const callback = await app.inject({
    url: `/api/auth/providers/github/callback?state=${state}&code=subject-${subject}`,
    remoteAddress,
    headers: { cookie: cookieHeaderFromSetCookie(start.headers["set-cookie"]) },
  });
  return { callback, attemptId };
}

/**
 * A local stand-in for Google's OpenID Connect token and key endpoints. Only fetches to
 * https://oauth2.googleapis.com and https://www.googleapis.com are answered here; the
 * controller uses fixed endpoints, and `discovery` records Google's published document
 * they come from. `authorize(url, options)` plays the browser's visit to Google: it
 * captures the authorization request (client, redirect URI, PKCE challenge, nonce) and
 * returns a one-use code for `subject`. /token checks the client credentials, code,
 * redirect URI and S256 code_verifier, then returns an RS256 ID token echoing the
 * captured nonce. Per-code `claims` override ID-token claims (undefined removes one);
 * `key: "foreign"` signs with a key that /oauth2/v3/certs does not publish. Modes: "up"
 * and "error" (503).
 */
export function fakeGoogle(t, { clientId, clientSecret, hd } = {}) {
  const published = rsaSigningKey("fixture-google-kid");
  const signToken = idTokenSigner(published);
  // An unpublished key: its token's header still names the published kid, so it does not verify.
  const foreign = rsaSigningKey(published.kid);
  const codes = new Map();
  const fixture = {
    mode: "up",
    requests: 0,
    authorizations: [],
    tokens: [],
    discovery: Object.freeze({
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "email", "profile"],
      code_challenge_methods_supported: ["plain", "S256"],
    }),
    jwks: Object.freeze({ keys: [published.jwk] }),
    authorize(url, { subject, claims = {}, key = "published" }) {
      const parameters = new URL(url).searchParams;
      const code = `fixture-google-code-${randomBytes(12).toString("base64url")}`;
      const request = Object.fromEntries(parameters);
      fixture.authorizations.push(request);
      codes.set(code, { request, subject, claims, key });
      return code;
    },
  };
  function idToken({ request, subject, claims, key }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: "https://accounts.google.com",
      azp: clientId,
      aud: clientId,
      sub: subject,
      email: `${subject}@${hd ?? "gmail.com"}`,
      email_verified: true,
      ...(hd === undefined ? {} : { hd }),
      nonce: request.nonce,
      iat: now - 5,
      exp: now + 3600,
      ...claims,
    };
    return signToken(payload, key === "foreign" ? { key: foreign.privateKey } : {});
  }
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function answer(request) {
    fixture.requests += 1;
    if (fixture.mode === "error") {
      return json(503, {});
    }
    const url = new URL(request.url);
    if (url.origin === "https://www.googleapis.com" && url.pathname === "/oauth2/v3/certs") {
      return request.method === "GET" ? json(200, fixture.jwks) : json(405, {});
    }
    if (url.origin !== "https://oauth2.googleapis.com" || url.pathname !== "/token") {
      return json(404, {});
    }
    const form = new URLSearchParams(await request.text());
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const [basicId, basicSecret] =
      basic === undefined
        ? []
        : Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    fixture.tokens.push(Object.fromEntries(form));
    if (
      request.method !== "POST" ||
      form.get("grant_type") !== "authorization_code" ||
      (form.get("client_id") ?? basicId) !== clientId ||
      (form.get("client_secret") ?? basicSecret) !== clientSecret ||
      grant === undefined ||
      grant.request.client_id !== clientId ||
      grant.request.code_challenge_method !== "S256" ||
      grant.request.code_challenge !== challenge ||
      form.get("redirect_uri") !== grant.request.redirect_uri
    ) {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, {
      access_token: `ya29.fixture-${randomBytes(12).toString("base64url")}`,
      expires_in: 3599,
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
      token_type: "Bearer",
      id_token: idToken(grant),
    });
  }
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.origin === "https://oauth2.googleapis.com" ||
      url.origin === "https://www.googleapis.com"
    ) {
      return answer(new Request(input, init));
    }
    return originalFetch(input, init);
  });
  return fixture;
}

/** Starts Google sign-in, visits the fake Google and completes the callback, from one address. */
export async function googleSignIn(
  app,
  origin,
  google,
  authorization,
  remoteAddress = "192.0.2.60",
) {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/providers/google/start",
    remoteAddress,
    headers: { origin },
  });
  if (start.statusCode !== 200) {
    throw new Error(`Google start failed with ${start.statusCode}: ${start.body}`);
  }
  const { url, attemptId } = start.json().data;
  const state = new URL(url).searchParams.get("state");
  const code = google.authorize(url, authorization);
  const bindingCookie = cookieHeaderFromSetCookie(start.headers["set-cookie"]);
  const callback = await app.inject({
    url: `/api/auth/providers/google/callback?state=${state}&code=${code}`,
    remoteAddress,
    headers: { cookie: bindingCookie },
  });
  return { start, callback, attemptId, url, state, bindingCookie };
}

/**
 * A local stand-in for one OIDC issuer's token and JWKS URLs (`fixtureOidcIssuer` by
 * default). Only fetches to the issuer's origin are answered here. It plays the IdP the
 * way fakeGoogle plays Google: `authorize(url, options)` captures the authorization
 * request and returns a one-use code for `subject` (`codeLength` pads it, as Entra's long
 * codes do); /token checks the client credentials (post or basic, per `tokenAuth`), code,
 * redirect URI and S256 verifier, then returns an RS256 ID token for `issuer.issuer`
 * echoing the nonce. Per-code `claims` override ID-token claims; `key: "foreign"` signs
 * with an unpublished key. `rotate()` replaces the published key. `issuer` may be
 * reassigned to model an issuer change, and `tokenAuth`
 * to switch the credential method. Modes: "up" and "error" (503). It proves OCE
 * against its own reading of OIDC, not any IdP's behaviour.
 */
export function fakeOidc(
  t,
  { clientId, clientSecret, issuer = fixtureOidcIssuer, tokenAuth = "client_secret_post" } = {},
) {
  let generation = 0;
  let key = rsaSigningKey(`fixture-oidc-kid-${generation}`);
  const foreign = rsaSigningKey("fixture-oidc-foreign");
  const codes = new Map();
  const fixture = {
    mode: "up",
    requests: 0,
    issuer,
    tokenAuth,
    authorizations: [],
    tokens: [],
    get jwks() {
      return { keys: [key.jwk] };
    },
    rotate() {
      generation += 1;
      key = rsaSigningKey(`fixture-oidc-kid-${generation}`);
    },
    authorize(url, { subject, claims = {}, key: signer = "published", codeLength = 0 }) {
      const request = Object.fromEntries(new URL(url).searchParams);
      fixture.authorizations.push(request);
      const prefix = `fixture-oidc-code-${randomBytes(12).toString("base64url")}`;
      const code = prefix.padEnd(codeLength, "c");
      codes.set(code, { request, subject, claims, signer, key });
      return code;
    },
  };
  function idToken({ request, subject, claims, signer, key: issuedWith }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: fixture.issuer.issuer,
      aud: clientId,
      sub: subject,
      nonce: request.nonce,
      iat: now - 5,
      exp: now + 3600,
      ...claims,
    };
    return idTokenSigner(signer === "foreign" ? foreign : issuedWith)(payload);
  }
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  async function answer(request) {
    fixture.requests += 1;
    if (fixture.mode === "error") {
      return json(503, {});
    }
    const url = new URL(request.url).href;
    if (url === fixture.issuer.jwksUrl) {
      return request.method === "GET" ? json(200, fixture.jwks) : json(405, {});
    }
    if (url !== fixture.issuer.tokenUrl) {
      return json(404, {});
    }
    const form = new URLSearchParams(await request.text());
    const basic = /^Basic (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const [basicId, basicSecret] =
      basic === undefined
        ? []
        : Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent);
    const credentials =
      fixture.tokenAuth === "client_secret_basic"
        ? !form.has("client_secret") && basicId === clientId && basicSecret === clientSecret
        : basic === undefined &&
          form.get("client_id") === clientId &&
          form.get("client_secret") === clientSecret;
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    const challenge = createHash("sha256")
      .update(form.get("code_verifier") ?? "")
      .digest("base64url");
    fixture.tokens.push(Object.fromEntries(form));
    if (
      request.method !== "POST" ||
      form.get("grant_type") !== "authorization_code" ||
      !credentials ||
      grant === undefined ||
      grant.request.client_id !== clientId ||
      grant.request.scope !== "openid" ||
      grant.request.code_challenge_method !== "S256" ||
      grant.request.code_challenge !== challenge ||
      form.get("redirect_uri") !== grant.request.redirect_uri
    ) {
      return json(400, { error: "invalid_grant" });
    }
    return json(200, {
      access_token: `fixture-oidc-access-${randomBytes(12).toString("base64url")}`,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken(grant),
    });
  }
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === new URL(fixture.issuer.issuer).origin) {
      return answer(new Request(input, init));
    }
    return originalFetch(input, init);
  });
  return fixture;
}

/** Starts OIDC sign-in, visits the fake IdP and completes the callback, from one address. */
export async function oidcSignIn(app, origin, idp, authorization, remoteAddress = "192.0.2.70") {
  const start = await app.inject({
    method: "POST",
    url: "/api/auth/providers/oidc/start",
    remoteAddress,
    headers: { origin },
  });
  if (start.statusCode !== 200) {
    throw new Error(`OIDC start failed with ${start.statusCode}: ${start.body}`);
  }
  const { url, attemptId } = start.json().data;
  const state = new URL(url).searchParams.get("state");
  const code = idp.authorize(url, authorization);
  const bindingCookie = cookieHeaderFromSetCookie(start.headers["set-cookie"]);
  const callback = await app.inject({
    url: `/api/auth/providers/oidc/callback?state=${state}&code=${code}`,
    remoteAddress,
    headers: { cookie: bindingCookie },
  });
  return { start, callback, attemptId, url, state, bindingCookie };
}

/**
 * Creates a password account through the administrator route, bound to `roleId` when given.
 * Returns `{ id, email, password }`, which signs in with passwordSignIn.
 */
export async function createAccount(app, headers, { email, password, roleId }) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/accounts",
    headers,
    payload: { email, password, ...(roleId === undefined ? {} : { roleId }) },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Account creation failed with ${response.statusCode}: ${response.body}`);
  }
  return { id: response.json().data.id, email, password };
}

/**
 * The password onboarding each external sign-in proof starts from. Bootstraps a production
 * Installation, composes its default password install, signs the recovery administrator in
 * (from `remoteAddress` when given) and creates one password account per `accounts` entry,
 * then closes that app. `accounts` maps a name to its email and its Installation Role from
 * installationRoles: "reader" (the default) or "admin". Every account uses `password`.
 * Returns `{ admin: { email, password, id }, roles, accounts: { [name]: { id, email, password } } }`.
 */
export async function onboardPasswordAccounts(
  context,
  {
    databaseUrl,
    state,
    pool,
    email,
    authSecret,
    secrets,
    password,
    accounts = {},
    remoteAddress,
    passwordSlowLaneFloors,
  },
) {
  const admin = {
    email,
    password: await bootstrapProductionInstallation(context, { databaseUrl, email, authSecret }),
  };
  const roles = await installationRoles(state, pool);
  const app = await composeProductionSignIn(context, {
    databaseUrl,
    settings: defaultInstallSettings,
    secrets,
    passwordSlowLaneFloors,
  });
  try {
    const headers = await signedInHeaders(app, consoleOrigin, admin, remoteAddress);
    admin.id = (await currentSession(app, headers.cookie)).user.id;
    const created = {};
    for (const [name, account] of Object.entries(accounts)) {
      const roleName = account.role ?? "reader";
      const role = Object.hasOwn(roles, roleName) ? roles[roleName] : undefined;
      if (role === undefined) {
        throw new Error(`Unknown Installation Role ${account.role} for ${name}.`);
      }
      created[name] = await createAccount(app, headers, {
        email: account.email,
        password,
        roleId: role.id,
      });
    }
    return { admin, roles, accounts: created };
  } finally {
    await app.close();
  }
}

/** Attaches a provider subject to an account at its current version; returns the response. */
export async function attachProvider(app, headers, userId, provider, subject) {
  const { version } = await readAccount(app, headers, userId);
  return app.inject({
    method: "POST",
    url: `/api/auth/accounts/${userId}/providers/${provider}`,
    headers,
    payload: { subject, expectedVersion: version },
  });
}

/** Attaches a provider subject like attachProvider and asserts that the attach succeeded. */
export async function assertProviderAttached(app, headers, userId, provider, subject) {
  const response = await attachProvider(app, headers, userId, provider, subject);
  assert.equal(response.statusCode, 200, response.body);
  return response;
}

/** Rows that sign-in creates: users, their sign-in methods (occ.account) and sessions. */
export async function authRowCounts(pool) {
  return (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM occ."user") AS users,
              (SELECT count(*)::int FROM occ.account) AS methods,
              (SELECT count(*)::int FROM occ.session) AS sessions`,
    )
  ).rows[0];
}

/** The guarded account read an administrator uses for expectedVersion. */
export async function readAccount(app, headers, userId) {
  const response = await app.inject({ url: `/api/auth/accounts/${userId}`, headers });
  if (response.statusCode !== 200) {
    throw new Error(`Account read failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json().data;
}

/**
 * Proves which accounts keep a checkable password once strangers spend their email's budget.
 * Wrong passwords spend `holder`'s, `former`'s and a fresh email's budget until each is
 * refused with 429 and Retry-After. Then the correct password of `holder` (the recovery
 * account) still signs in, slowed; `former` does too only while it administers the
 * Installation; and the fresh email is refused like any other spent email, account or not.
 */
export async function assertReservedLane(app, { origin, holder, former, label }) {
  const address = clientAddresses("10.77");
  const fresh = { email: `lane-${label}-fresh@example.test`, password: holder.password };
  async function spend(account) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await passwordSignIn(
        app,
        origin,
        { email: account.email, password: `${label}-lane-wrong-password` },
        address(),
      );
      if (response.statusCode === 429) {
        if (!(Number(response.headers["retry-after"]) >= 1)) {
          throw new Error("A refused password sign-in must carry Retry-After.");
        }
        return;
      }
      if (response.statusCode !== 401) {
        throw new Error(`Expected 401 or 429, got ${response.statusCode}: ${response.body}`);
      }
    }
    throw new Error(`The ${account.email} budget was never spent.`);
  }
  for (const account of [holder, former, fresh]) {
    await spend(account);
  }
  const [holderResponse, formerResponse, freshResponse] = await Promise.all(
    [holder, former, fresh].map((account) => passwordSignIn(app, origin, account, address())),
  );
  return {
    fresh: freshResponse.statusCode,
    former: formerResponse.statusCode,
    holder: holderResponse.statusCode,
  };
}

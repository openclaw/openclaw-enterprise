import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  clientAddressConfiguration,
  humanLoginConfiguration,
} from "../../apps/controller/src/auth/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createInstallationDriverConfiguration } from "./installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import {
  privateBootstrapDirectory,
  productionBootstrapEnvironment,
  runBootstrapInstallation,
} from "./bootstrap-installation.mjs";
import { cookieHeaderFromSetCookie } from "./auth-session.mjs";

// Only Compute is passive: no Agent is deployed, so sign-in proofs need no cluster.
// Authentication, State, IAM, audit and Fastify are the production implementations.
function passiveComputeDriver(id) {
  return {
    id,
    capability: "compute",
    implementation: "sign-in-proof-memory-compute",
    async preflight() {},
    async ensureNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceReady: true };
    },
    async deleteNamespace(namespace) {
      return { namespaceId: namespace.id, namespaceDeleted: true };
    },
    async prepareRevision(revision) {
      return {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        ready: true,
      };
    },
    async retireRevision() {},
  };
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
const gatewayApiKeyPath = "/etc/openclaw/gateway-api-key/key";
const secretRef = (name, key) => ({ secretKeyRef: { name, key } });

/**
 * The API Pod's sign-in environment rendered from deploy/examples/production/values.yaml:
 * no OCC_AUTH_GITHUB_*, no trusted proxy. password-default-chart.test.mjs asserts the
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
export async function composeProductionSignIn(context, { databaseUrl, settings, secrets, logger }) {
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
  const nativeAdminEnabled = environment.OCC_AGENT_NATIVE_ADMIN_ENABLED === "true";
  return composeProduction({
    mode: "production",
    host: "127.0.0.1",
    databaseUrl,
    authSecret: environment.OCC_AUTH_SECRET,
    authBaseURL: environment.OCC_AUTH_BASE_URL,
    ...(environment.OCC_GATEWAY_API_KEY_PATH === undefined ? {} : { gatewayApiKeyPath: keyFile }),
    ...humanLogin,
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
    drivers: {
      installation,
      defaultPresets: runtime.defaultPresets,
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
 * A local stand-in for github.com and api.github.com. The controller's fixed provider
 * endpoints are redirected here by mocking fetch, as postgres-github-sign-in.test.mjs does.
 * The authorization code names the GitHub subject: `subject-<id>`. Modes: "up", "error"
 * (503) and "hang" (never answers).
 */
export async function startFakeGitHub(t) {
  const server = createServer();
  const fixture = { mode: "up", requests: 0 };
  server.on("request", async (request, response) => {
    fixture.requests += 1;
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
      const subject = /^Bearer ghu_fixture_([0-9]+)$/.exec(request.headers.authorization ?? "");
      if (subject === null) {
        response.writeHead(401);
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({ id: Number(subject[1]), login: `fixture-${subject[1]}` }));
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
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
  const kid = "fixture-google-kid";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const { n, e } = publicKey.export({ format: "jwk" });
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
    jwks: Object.freeze({ keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", n, e }] }),
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
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(payload)}`;
    const signer = key === "foreign" ? foreign : privateKey;
    return `${input}.${sign("sha256", Buffer.from(input), signer).toString("base64url")}`;
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

/** The guarded account read an administrator uses for expectedVersion. */
export async function readAccount(app, headers, userId) {
  const response = await app.inject({ url: `/api/auth/accounts/${userId}`, headers });
  if (response.statusCode !== 200) {
    throw new Error(`Account read failed with ${response.statusCode}: ${response.body}`);
  }
  return response.json().data;
}

async function lockWaiters(pool) {
  return (
    await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    )
  ).rows[0].count;
}

/**
 * Proves which account holds the reserved password lane on one controller: four password
 * checks held on locked user rows fill the shared lane, so a fresh account and `former`
 * are refused with 429 while `holder` is still admitted and signs in once the rows unlock.
 */
export async function assertReservedLane(app, pool, { origin, holder, former, label }) {
  const fillers = (
    await pool.query(
      `INSERT INTO occ."user" (id, name, email, email_verified, created_at, updated_at)
       SELECT 'lane-' || $1 || '-' || n, 'Lane filler', 'lane-' || $1 || '-' || n || '@example.test',
              true, now(), now()
       FROM generate_series(1, 2) AS n RETURNING id, email`,
      [label],
    )
  ).rows;
  const address = clientAddresses("10.77");
  const blocker = await pool.connect();
  let open = false;
  async function waitForLockWaiters(count, settled = () => false) {
    const deadline = performance.now() + 10_000;
    while (!settled() && (await lockWaiters(pool)) < count) {
      if (performance.now() > deadline) {
        throw new Error(`Expected ${count} password checks to be held.`);
      }
      await delay(20);
    }
  }
  try {
    await blocker.query("BEGIN");
    open = true;
    await blocker.query('SELECT id FROM occ."user" WHERE id = ANY($1) FOR UPDATE', [
      [...fillers.map((filler) => filler.id), holder.id],
    ]);
    // Two per filler email and one per address stay inside every per-key budget.
    const held = fillers.flatMap((filler) => [
      passwordSignIn(app, origin, { email: filler.email, password: holder.password }, address()),
      passwordSignIn(app, origin, { email: filler.email, password: holder.password }, address()),
    ]);
    await waitForLockWaiters(4);
    const fresh = await passwordSignIn(
      app,
      origin,
      { email: `lane-${label}-fresh@example.test`, password: holder.password },
      address(),
    );
    const refusedFormer = await passwordSignIn(app, origin, former, address());
    let holderSettled = false;
    const admitted = passwordSignIn(app, origin, holder, address()).finally(() => {
      holderSettled = true;
    });
    // An admitted holder waits on its locked row; a refused one settles at once.
    await waitForLockWaiters(5, () => holderSettled);
    await blocker.query("COMMIT");
    open = false;
    const heldStatuses = (await Promise.all(held)).map(({ statusCode }) => statusCode);
    return {
      fresh: fresh.statusCode,
      former: refusedFormer.statusCode,
      holder: (await admitted).statusCode,
      held: heldStatuses,
    };
  } finally {
    if (open) {
      await blocker.query("ROLLBACK");
    }
    blocker.release();
    await pool.query('DELETE FROM occ."user" WHERE id = ANY($1)', [
      fillers.map((filler) => filler.id),
    ]);
  }
}

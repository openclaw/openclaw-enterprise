import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createHumanLogin } from "../../apps/controller/src/auth/github.ts";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { APIError, betterAuth } = await import(require.resolve("better-auth"));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));

export const loginOrigin = "https://console.example.test";
export const loginSecret = "test-only-authentication-secret-with-at-least-32-characters";
export const attemptBinding = "b".repeat(43);
export const callbackState = "s".repeat(43);

// Runs the actual Better Auth handler and external-provider plugin with a boundary
// State fixture. Callers make no PostgreSQL or session-commit claims through it.
export function createLoginFixture({
  provider,
  providers,
  state: stateOverrides = {},
  trustedClientAddress = true,
  recoveryEmail,
}) {
  const attempts = [];
  const subjects = [];
  const denials = [];
  const errors = [];
  const authLogs = [];
  const operationalLines = [];
  // Operational events go through the production logger and sanitizer.
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: { write: (chunk) => operationalLines.push(JSON.parse(chunk)) },
  });
  const state = {
    // State's clock is deliberately ahead of the controller's: cookie lifetimes must
    // come from State's duration, not from comparing the two clocks.
    createAttempt: async (attempt) => {
      attempts.push(attempt);
      const createdAt = new Date("2030-01-01T00:00:00Z");
      return { createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) };
    },
    consumeAttempt: async (attempt) => {
      attempts.push(attempt);
      return { codeVerifier: "v".repeat(43), createdAt: new Date() };
    },
    snapshotExternal: async (providerId, subject) => {
      subjects.push([providerId, subject]);
    },
    snapshotPassword: async () => undefined,
    recordDenied: async (reason, deniedProvider) => {
      denials.push(deniedProvider === undefined ? [reason] : [reason, deniedProvider]);
    },
    ...stateOverrides,
  };
  const login = createHumanLogin(
    state,
    { recoveryUserId: "fixture-recovery", ...providers },
    loginOrigin,
    {
      trustedClientAddress,
      onOperationalEvent: (event) => emitOccLogEvent(logger, event),
    },
  );
  if (recoveryEmail !== undefined) {
    login.designateRecovery(recoveryEmail);
  }
  const db = { user: [], session: [], account: [], verification: [] };
  const auth = betterAuth({
    baseURL: loginOrigin,
    secret: loginSecret,
    database: login.database(memoryAdapter(db)),
    session: {
      expiresIn: 8 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    plugins: [login.plugin],
    rateLimit: { enabled: false },
    logger: { level: "debug", log: (...values) => authLogs.push(values) },
    onAPIError: {
      onError(error) {
        if (error instanceof APIError) {
          throw error;
        }
        errors.push(error);
        throw APIError.fromStatus("SERVICE_UNAVAILABLE", {
          message: "Authentication dependency unavailable.",
        });
      },
    },
  });
  // The controller wrapper sets x-occ-client-ip from the socket peer or a trusted ingress.
  const call = (path, init, ip = "10.0.0.1") =>
    auth.handler(
      new Request(`${loginOrigin}/api/auth${path}`, {
        ...init,
        headers: { ...init?.headers, "x-occ-client-ip": ip },
      }),
    );
  return {
    auth,
    db,
    login,
    attempts,
    subjects,
    denials,
    errors,
    authLogs,
    // Operational log records without their timestamp.
    operationalLogs: () => operationalLines.map(({ time, ...line }) => line),
    callback: (
      query = `state=${callbackState}&code=fixture-code`,
      ip = "10.0.0.1",
      cookie = `__Host-occ_login_attempt=${attemptBinding}`,
    ) =>
      call(
        `/oce/providers/${provider}/callback?${query}`,
        { headers: cookie === null ? {} : { cookie } },
        ip,
      ),
    start: (ip = "10.0.0.1", name = provider) =>
      call(
        `/oce/providers/${name}/start`,
        { method: "POST", headers: { origin: loginOrigin } },
        ip,
      ),
    result: (attemptId, cookie, ip = "10.0.0.1") =>
      call(
        `/oce/providers/${provider}/result`,
        {
          method: "POST",
          headers: { origin: loginOrigin, cookie, "content-type": "application/json" },
          body: JSON.stringify({ attemptId }),
        },
        ip,
      ),
    password: (password = "too-short", { ip = "10.0.0.1", email = "missing@example.test" } = {}) =>
      call(
        "/oce/password",
        {
          method: "POST",
          headers: { origin: loginOrigin, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
        ip,
      ),
  };
}

export async function expectDenied(response) {
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { message: "Authentication was not accepted." });
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /session_token|login_receipt/);
}

export function cookiePairs(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

export async function until(predicate) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Expected transport observation before deadline");
    await delay(10);
  }
}

// Sends only the provider's fixed URLs to `target`. Real fetch, cancellation, stream
// reads, response parsing and redirect handling stay production behavior. Any other
// destination fails the test, even when the product turns the refused fetch into a
// provider-unavailable denial.
export function redirectProviderFetch(t, allowedUrls, target) {
  const originalFetch = globalThis.fetch;
  const unexpected = [];
  t.mock.method(globalThis, "fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!allowedUrls.has(url.href)) {
      unexpected.push(url.href);
      throw new Error(`Unexpected provider request: ${url.href}`);
    }
    return originalFetch(new URL(url.pathname, target), init);
  });
  t.after(() => assert.deepEqual(unexpected, [], "unexpected provider requests"));
}

// A loopback HTTP server standing in for the provider. It records each request path
// and delegates to `handle`, which tests swap per case.
export async function startProviderServer(t, handle) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handle(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, port: server.address().port };
}

// RS256 ID tokens signed by a fresh key that the returned JWKS publishes as "fixture-kid".
export function createIdTokenSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = {
    keys: [
      { ...publicKey.export({ format: "jwk" }), kid: "fixture-kid", alg: "RS256", use: "sig" },
    ],
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    jwks,
    sign(claims) {
      const input = `${encode({ alg: "RS256", kid: "fixture-kid", typ: "JWT" })}.${encode(claims)}`;
      return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
    },
  };
}

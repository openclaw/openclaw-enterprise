import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { ControllerAuth } from "../../apps/controller/src/auth/index.ts";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  createHumanLogin,
  type ExternalProviderName,
  type HumanLoginProviders,
} from "../../apps/controller/src/auth/human-login.ts";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { idTokenSigner, rsaSigningKey } from "./id-token.mjs";
import { listen } from "./listen.ts";
import { waitUntil } from "./wait-for.mjs";

type TransportAuth = Pick<ControllerAuth["auth"], "handler" | "$context">;
type TransportAuthOptions = Omit<ControllerAuth["auth"]["options"], "plugins"> & {
  plugins: [ReturnType<typeof createHumanLogin>["plugin"]];
};
type TransportDatabase = Record<
  "user" | "session" | "account" | "verification",
  Record<string, unknown>[]
>;
type MemoryAdapter = (
  database: TransportDatabase,
) => Parameters<ReturnType<typeof createHumanLogin>["database"]>[0];

function hasBetterAuth(value: unknown): value is {
  betterAuth: (options: TransportAuthOptions) => TransportAuth;
} {
  return record(value) && typeof value.betterAuth === "function";
}

function hasMemoryAdapter(value: unknown): value is { memoryAdapter: MemoryAdapter } {
  return record(value) && typeof value.memoryAdapter === "function";
}

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
const authModule: unknown = await import(controllerRequire.resolve("better-auth"));
const memoryModule: unknown = await import(
  controllerRequire.resolve("better-auth/adapters/memory")
);
assert.ok(hasBetterAuth(authModule), "Better Auth did not expose its factory");
assert.ok(hasMemoryAdapter(memoryModule), "Better Auth did not expose its memory adapter");
const { betterAuth } = authModule;
const { memoryAdapter } = memoryModule;

export type ProviderHandler = (request: IncomingMessage, response: ServerResponse) => unknown;
export type LoginFixtureOptions = {
  provider: ExternalProviderName;
  providers: Omit<HumanLoginProviders, "recoveryUserId">;
  state?: Partial<PostgresHumanAuthentication>;
  trustedClientAddress?: boolean;
  recoveryEmail?: string;
  providerDeadlineMs?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function responseFields(response: Response): Promise<{ get(field: string): string }> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Authentication response was not valid JSON");
  }
  if (!record(value)) {
    throw new Error("Authentication response was not an object");
  }
  return {
    get(field) {
      const item = value[field];
      if (typeof item !== "string") {
        throw new Error(`Authentication response field ${field} was not a string`);
      }
      return item;
    },
  };
}

export function assertSafeEqual(actual: unknown, expected: unknown, message: string): void {
  assert.ok(isDeepStrictEqual(actual, expected), message);
}

export function assertSafeThrows(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(
      error instanceof Error && pattern.test(error.message),
      "authentication error did not match",
    );
    return true;
  });
}

export async function assertSafeRejects(
  action: Promise<unknown>,
  expected: { name: string; status: string; message: string },
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(record(error), "authentication rejection was not an object");
    assertSafeEqual(
      { name: error.name, status: error.status, message: error.message },
      expected,
      "authentication rejection did not match",
    );
    return true;
  });
}

export function parseAuthorizationUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("Authentication response URL was invalid");
  }
}

export async function readProviderRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: AsyncIterable<unknown> = request;
  let body = "";
  for await (const chunk of chunks) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new Error("Provider request body contained an unsupported chunk");
    }
    body += chunk;
  }
  return body;
}

export function createLoginState(): PostgresHumanAuthentication {
  // The production login accepts this concrete State class. Any unconfigured method must
  // fail before it can reach PostgreSQL; the transport fixture owns no database connection.
  return new PostgresHumanAuthentication(
    new PostgresPlatformState({
      connect: async () => {
        throw new Error("The login transport fixture does not provide PostgreSQL");
      },
      end: async () => {},
    }),
    "fixture-installation",
    "fixture-issuer",
  );
}

export const loginOrigin = "https://console.example.test";
export const loginSecret = "test-only-authentication-secret-with-at-least-32-characters";
export const attemptBinding = "b".repeat(43);
export const callbackState = "s".repeat(43);

/**
 * The provider instance ID that sign-in records for a human-login provider: `<kind>:` and
 * the hex SHA-256 of the client ID, or for OIDC of `<issuer>\0<clientId>`, so a new issuer
 * on the same host is a new instance. Written out here, not imported from product code, so
 * tests check the derivation rather than reuse it.
 */
export function providerInstanceId(
  kind: ExternalProviderName,
  { clientId, issuer }: { clientId: string; issuer?: string | undefined },
) {
  assert.ok(["google", "oidc"].includes(kind), "unknown provider kind");
  assert.equal(issuer === undefined, kind !== "oidc", "only OIDC instances include the issuer");
  const input = kind === "oidc" ? `${issuer}\0${clientId}` : clientId;
  return `${kind}:${createHash("sha256").update(input).digest("hex")}`;
}

/**
 * The provider ID that a sign-in attempt records: the provider instance ID, `:` and the hex
 * SHA-256 of the client secret, so rotating the secret voids pending attempts. Written out
 * here, not imported from product code.
 */
export function providerAttemptId(
  instanceId: string,
  clientSecret: string,
  enrollment: unknown = null,
) {
  const policy = instanceId.startsWith("oidc:")
    ? `:${createHash("sha256").update(JSON.stringify(enrollment)).digest("hex")}`
    : "";
  return `${instanceId}:${createHash("sha256").update(clientSecret).digest("hex")}${policy}`;
}

// Runs the actual Better Auth handler and external-provider plugin with a boundary
// State fixture. Callers make no PostgreSQL or session-commit claims through it.
export function createLoginFixture({
  provider,
  providers,
  state: stateOverrides = {},
  trustedClientAddress = true,
  recoveryEmail,
  providerDeadlineMs,
}: LoginFixtureOptions) {
  const attempts: (
    | Parameters<PostgresHumanAuthentication["createAttempt"]>[0]
    | Parameters<PostgresHumanAuthentication["consumeAttempt"]>[0]
  )[] = [];
  const subjects: [string, string][] = [];
  const denials: Parameters<PostgresHumanAuthentication["recordDenied"]>[] = [];
  const unmatched: ExternalProviderName[] = [];
  const recordedErrors: unknown[] = [];
  const authLogs: unknown[][] = [];
  const operationalLines: Record<string, unknown>[] = [];
  // Operational events go through the production logger and sanitizer.
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: {
      write(chunk: string | Buffer) {
        let line: unknown;
        try {
          line = JSON.parse(String(chunk));
        } catch {
          throw new Error("Operational log was not valid JSON");
        }
        if (!record(line)) {
          throw new Error("Operational log was not an object");
        }
        operationalLines.push(line);
        return true;
      },
    },
  });
  const state = Object.assign(createLoginState(), {
    // State's clock is deliberately ahead of the controller's: cookie lifetimes must
    // come from State's duration, not from comparing the two clocks.
    createAttempt: async (attempt) => {
      attempts.push(attempt);
      const createdAt = new Date("2030-01-01T00:00:00Z");
      return { createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) };
    },
    consumeAttempt: async (attempt) => {
      attempts.push(attempt);
      return {
        ...attempt,
        codeVerifier: "v".repeat(43),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
      };
    },
    snapshotExternal: async (providerId, subject) => {
      subjects.push([providerId, subject]);
    },
    snapshotPassword: async () => undefined,
    recordDenied: async (reason, deniedProvider, details) => {
      denials.push(
        deniedProvider === undefined
          ? [reason]
          : details === undefined
            ? [reason, deniedProvider]
            : [reason, deniedProvider, details],
      );
    },
    ...stateOverrides,
  } satisfies Partial<PostgresHumanAuthentication>);
  const login = createHumanLogin(
    state,
    { recoveryUserId: "fixture-recovery", ...providers },
    loginOrigin,
    {
      trustedClientAddress,
      onOperationalEvent: (event) => emitOccLogEvent(logger, event),
      ...(providerDeadlineMs === undefined ? {} : { providerDeadlineMs }),
      onUnmatchedCallback: (name) => unmatched.push(name),
    },
  );
  if (recoveryEmail !== undefined) {
    login.designateRecovery(recoveryEmail);
  }
  const db: TransportDatabase = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
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
    // As in the controller's human-login profile: an error Better Auth cannot classify
    // leaves its router unlogged instead of becoming a console-logged 500.
    onAPIError: { throw: true },
  });
  // The controller wrapper sets x-occ-client-ip from the socket peer or a trusted ingress.
  // It also owns a thrown dependency error and answers it as an outage; that mapping is
  // proved through the real controller (postgres-oidc-outage, postgres-oidc-cookie-commit).
  // Retain the handler's original error for the secret check without exposing its contents
  // through a rejected fixture call or a failed assertion.
  const call = async (path: string, init: RequestInit, ip = "10.0.0.1") => {
    try {
      return await auth.handler(
        new Request(`${loginOrigin}/api/auth${path}`, {
          ...init,
          headers: { ...init?.headers, "x-occ-client-ip": ip },
        }),
      );
    } catch (error) {
      recordedErrors.push(error);
    }
    throw new Error("Authentication transport call failed");
  };
  return {
    auth,
    db,
    login,
    attempts,
    subjects,
    denials,
    unmatched,
    recordedErrorIncludes(value: string): boolean {
      try {
        return recordedErrors.some((error) => String(error).includes(value));
      } catch {
        throw new Error("Authentication transport error could not be inspected");
      }
    },
    authLogs,
    // Operational log records without their timestamp.
    operationalLogs: () => operationalLines.map(({ time, ...line }) => line),
    callback: (
      query = `state=${callbackState}&code=fixture-code`,
      ip = "10.0.0.1",
      cookie: string | null = `__Host-occ_login_attempt=${attemptBinding}`,
    ) =>
      call(
        `/oce/providers/${provider}/callback?${query}`,
        { headers: cookie === null ? {} : { cookie } },
        ip,
      ),
    start: (ip = "10.0.0.1", name: string = provider) =>
      call(
        `/oce/providers/${name}/start`,
        { method: "POST", headers: { origin: loginOrigin } },
        ip,
      ),
    result: (attemptId: string, cookie: string, ip = "10.0.0.1") =>
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

export async function expectDenied(response: Response, code?: string) {
  assert.equal(response.status, 401);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Authentication denial body was not valid JSON");
  }
  assertSafeEqual(
    body,
    code === undefined
      ? { message: "Authentication was not accepted." }
      : { message: "Authentication was not accepted.", code },
    "authentication denial body did not match",
  );
  assert.equal(
    /session_token|login_receipt/.test(response.headers.get("set-cookie") ?? ""),
    false,
    "authentication denial included a session or receipt cookie",
  );
}

// A provider failure carries its code, which the controller turns into the Console's outage
// advice; it is resolved before any identity, so it reveals nothing about accounts.
export function expectProviderUnavailable(response: Response) {
  return expectDenied(response, "PROVIDER_UNAVAILABLE");
}

export function cookiePairs(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

export async function until(predicate: () => boolean | Promise<boolean>) {
  await waitUntil("the transport observation", predicate, { timeoutMs: 2_000, intervalMs: 10 });
}

// Sends only the provider's fixed URLs to `target`. Real fetch, cancellation, stream
// reads, response parsing and redirect handling stay production behavior. Any other
// destination fails the test, even when the product turns the refused fetch into a
// provider-unavailable denial.
export function redirectProviderFetch(
  t: TestContext,
  allowedUrls: ReadonlySet<string>,
  target: string,
) {
  const originalFetch = globalThis.fetch;
  let unexpected = 0;
  t.mock.method(globalThis, "fetch", (...[input, init]: Parameters<typeof fetch>) => {
    const url = parseAuthorizationUrl(input instanceof Request ? input.url : String(input));
    if (!allowedUrls.has(url.href)) {
      unexpected += 1;
      throw new Error("Unexpected provider request");
    }
    return originalFetch(new URL(url.pathname, target), init);
  });
  t.after(() => assert.equal(unexpected, 0, "unexpected provider requests"));
}

// A loopback HTTP server standing in for the provider. It records each request path
// and delegates to `handle`, which tests swap per case.
export async function startProviderServer(t: TestContext, handle: ProviderHandler) {
  const requests: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    handle(request, response);
  });
  // Pooled connections outlive each subtest. A subtest that never yields to the event loop
  // (the 4096-callback admission sweep) stalls every timer. If it runs past the server's
  // idle timeout (about 6 s), the next fetch is written to a pooled socket before the
  // overdue server timer destroys it, and fails as a provider outage. Only the client
  // closes idle connections here.
  server.keepAliveTimeout = 0;
  return { requests, port: await listen(t, server) };
}

// One subtest per [endpoint, step] and framing. The endpoint answers past the provider
// response cap (64 KiB) and leaves its stream open; every other path gets `provider()`'s
// valid answer. The callback must be denied at once, cancel the stream and log
// oversized_response. The declared case sends one byte only to flush its headers, so
// only the declared-length check can refuse it in time.
export async function testOversizedProviderBodies(
  t: TestContext,
  {
    endpoints,
    serve,
    provider,
    login,
  }: {
    endpoints: readonly (readonly [string, string])[];
    serve: (handler: ProviderHandler) => void;
    provider: () => ProviderHandler;
    login: () => ReturnType<typeof createLoginFixture>;
  },
) {
  for (const [endpoint, step] of endpoints) {
    for (const declared of [false, true]) {
      await t.test(
        `${endpoint} cancels oversized ${declared ? "declared" : "chunked"} bodies`,
        async () => {
          const fixture = login();
          const valid = provider();
          let closed = false;
          serve((request, response) => {
            if (request.url !== endpoint) {
              return valid(request, response);
            }
            response.on("close", () => {
              closed = true;
            });
            if (declared) {
              response.setHeader("content-length", String(128 * 1024));
            }
            response.write(declared ? "x" : "x".repeat(64 * 1024 + 1));
          });
          const started = performance.now();
          await expectProviderUnavailable(await fixture.callback());
          assert.ok(performance.now() - started < 2_000);
          await until(() => closed);
          assertSafeEqual(fixture.subjects, [], "recorded identity observation did not match");
          assertSafeEqual(
            fixture.operationalLogs().map((line) => [line.step, line.cause]),
            [[step, "oversized_response"]],
            "operational log did not match",
          );
        },
      );
    }
  }
}

// RS256 ID tokens signed by a fresh key that the returned JWKS publishes as "fixture-kid".
export function createIdTokenSigner() {
  const key = rsaSigningKey("fixture-kid");
  return { jwks: { keys: [key.jwk] }, sign: idTokenSigner(key) };
}

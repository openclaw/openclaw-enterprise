import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHumanLogin } from "../../apps/controller/src/auth/human-login.ts";
import { createControllerAuth as createFixtureAuth } from "../helpers/password-hasher.mjs";
import type {
  ControllerAuth,
  ControllerAuthOptions,
} from "../../apps/controller/src/auth/index.ts";
import type { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  PostgresHumanAuthentication,
  PostgresPlatformState,
} from "../../packages/occ/src/index.ts";
import {
  issueKnownDevice,
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";
import {
  SIGN_IN_RATE_LIMITED_MINUTE,
  SIGN_IN_UNAVAILABLE,
  signInRateLimited,
} from "../helpers/refusal-text.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
type App = ReturnType<typeof createFastifyApp>;
type Database = NonNullable<ControllerAuthOptions["memoryDatabase"]>;
type AdapterFactory = ReturnType<ReturnType<typeof createHumanLogin>["database"]>;
type Audit = NonNullable<ControllerAuthOptions["passwordSignInAudit"]>;
type Outcome = ["accepted", string] | ["refused"];
type OperationalEvent = Parameters<NonNullable<ControllerAuthOptions["onOperationalEvent"]>>[0];
type HumanState = Pick<
  PostgresHumanAuthentication,
  "createAttempt" | "consumeAttempt" | "snapshotExternal" | "snapshotPassword" | "recordDenied"
> &
  Partial<Pick<PostgresHumanAuthentication, "knownDeviceState">>;
const createControllerAuth: (options: ControllerAuthOptions) => ControllerAuth = createFixtureAuth;
const memoryModule: unknown = await import(require.resolve("better-auth/adapters/memory"));
assert.ok(
  typeof memoryModule === "object" &&
    memoryModule !== null &&
    "memoryAdapter" in memoryModule &&
    typeof memoryModule.memoryAdapter === "function",
);
const memoryAdapter = memoryModule.memoryAdapter as (database: Database) => AdapterFactory;
const authModule: unknown = await import(require.resolve("better-auth"));
assert.ok(
  typeof authModule === "object" &&
    authModule !== null &&
    "APIError" in authModule &&
    typeof authModule.APIError === "function",
);
const APIError = authModule.APIError as new (
  status: string | number,
  body: { message: string },
) => Error;
const fastifyModule: unknown = require("fastify");
assert.equal(typeof fastifyModule, "function");
const Fastify = fastifyModule as (options: { genReqId: () => string }) => App;

function humanState(overrides: HumanState): PostgresHumanAuthentication {
  const state = new PostgresPlatformState({
    async connect() {
      throw new Error("unexpected persistence access");
    },
    async end() {},
  });
  return Object.assign(
    new PostgresHumanAuthentication(state, "ins_sign_in_audit", "fixture"),
    overrides,
  );
}

type Sent = {
  status: number;
  headers: Awaited<ReturnType<App["inject"]>>["headers"];
  payload: unknown;
};
function isErrorPayload(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}
function errorOf(response: Sent): { code: string; message: string } {
  const payload = response.payload;
  assert.ok(typeof payload === "object" && payload !== null && "error" in payload);
  assert.ok(isErrorPayload(payload.error));
  return payload.error;
}

const baseURL = "https://console.oce.localhost";
const email = "audited@example.test";
const password = "audited-account-password";

const secret = "password-sign-in-audit-secret-at-least-32-bytes";

const REFUSED = "The caller did not provide valid authentication credentials.";
const UNAVAILABLE = SIGN_IN_UNAVAILABLE;

// An outage and a rate limit each say what happened; neither reads as a wrong password.
function assertUnavailable(response: Sent) {
  assert.equal(response.status, 503, JSON.stringify(response.payload));
  assert.deepEqual(errorOf(response), {
    code: "DEPENDENCY_UNAVAILABLE",
    message: UNAVAILABLE,
  });
}

function assertLimited(response: Sent) {
  assert.equal(response.status, 429, JSON.stringify(response.payload));
  const seconds = Number(response.headers["retry-after"]);
  assert.ok(seconds >= 1 && seconds <= 60, String(seconds));
  assert.deepEqual(errorOf(response), {
    code: "RATE_LIMITED",
    message: signInRateLimited(seconds),
  });
}

function controller(audit: Audit, extra: Partial<ControllerAuthOptions> = {}) {
  const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    memoryDatabase,
    passwordSignInAudit: audit,
    ...extra,
  });
  return { auth, memoryDatabase };
}

async function signIn(
  auth: ControllerAuth,
  body: { email: string; password: string },
  headers: Record<string, string> = {},
) {
  return send(auth.signInEmail, {
    id: "req_audit",
    ip: "127.0.0.1",
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: baseURL, ...headers },
    body,
  });
}

// Calls one auth endpoint handler and records what it sends.
async function send(
  handler: ControllerAuth["signInEmail"],
  request: {
    id: string;
    ip: string;
    method: "POST";
    url: string;
    headers: Record<string, string>;
    body: Record<string, string>;
  },
): Promise<Sent> {
  const app = Fastify({ genReqId: () => request.id });
  app.post(request.url, handler);
  try {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: request.headers,
      payload: request.body,
      remoteAddress: request.ip,
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      payload: response.json<unknown>(),
    };
  } finally {
    await app.close();
  }
}

test("a password-only sign-in reports its outcome to the audit seam", async () => {
  const outcomes: Outcome[] = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => {
      outcomes.push(["accepted", userId]);
    },
    refused: async () => {
      outcomes.push(["refused"]);
    },
  });
  const account = await auth.createAccount({ email, password });
  assert.equal((await signIn(auth, { email, password })).status, 200);
  // A wrong password and an unknown email get the same answer, so it names no account.
  for (const guess of [email, "nobody@example.test"]) {
    const refused = await signIn(auth, { email: guess, password: "wrong-password-guess" });
    assert.equal(refused.status, 401);
    assert.deepEqual(errorOf(refused), { code: "UNAUTHENTICATED", message: REFUSED });
  }
  assert.deepEqual(outcomes, [["accepted", account.id], ["refused"], ["refused"]]);
  assert.equal(memoryDatabase.session.length, 1);
});

test("a sign-in that fails on its dependency is 503, not an audited or counted refusal", async () => {
  const outcomes: Outcome[] = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => {
      outcomes.push(["accepted", userId]);
    },
    refused: async () => {
      outcomes.push(["refused"]);
    },
  });
  await auth.createAccount({ email, password });
  // Every account read now fails, as it would with the database down.
  Object.defineProperty(memoryDatabase, "user", {
    get() {
      throw new Error("database unavailable");
    },
  });
  // Nothing was refused, so nothing is audited as a refusal and no budget is spent: the
  // email lane admits ten failures, so the eleventh attempt would be 429 if these counted.
  for (let attempt = 0; attempt < 11; attempt += 1) {
    assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
  }
  assert.deepEqual(outcomes, []);
});

test("a sign-in whose audit cannot be written is refused and its session revoked", async () => {
  const { auth, memoryDatabase } = controller({
    accepted: async () => {
      throw new Error("audit unavailable");
    },
    refused: async () => {},
  });
  await auth.createAccount({ email, password });
  const response = await signIn(auth, { email, password });
  assert.equal(response.status, 503, JSON.stringify(response.payload));
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(memoryDatabase.session.length, 0);
});

for (const status of [500, 503, 599]) {
  test(`a dependency APIError ${status} is unavailable without spending the password budget`, async () => {
    const outcomes: Outcome[] = [];
    const { auth, memoryDatabase } = controller({
      accepted: async (userId) => {
        outcomes.push(["accepted", userId]);
      },
      refused: async () => {
        outcomes.push(["refused"]);
      },
    });
    const account = await auth.createAccount({ email, password });
    const users = memoryDatabase.user;
    let unavailable = true;
    Object.defineProperty(memoryDatabase, "user", {
      get() {
        if (unavailable) {
          throw new APIError(status, { message: "synthetic dependency failure" });
        }
        return users;
      },
    });
    // Eleven admitted failures distinguish an outage from the ten-failure email budget.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await signIn(auth, { email, password });
      assert.equal(response.status, 503);
      assert.equal(errorOf(response).code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(response.headers["set-cookie"], undefined);
    }
    assert.deepEqual(outcomes, []);
    assert.equal(memoryDatabase.session.length, 0);
    unavailable = false;
    assert.equal((await signIn(auth, { email, password })).status, 200);
    assert.deepEqual(outcomes, [["accepted", account.id]]);
  });
}

for (const [status, expectedStatus, expectedCode] of [
  [400, 400, "FORBIDDEN"],
  [401, 401, "UNAUTHENTICATED"],
  [409, 409, "RESOURCE_CONFLICT"],
  [429, 429, "RATE_LIMITED"],
  [499, 499, "FORBIDDEN"],
  [399, 401, "UNAUTHENTICATED"],
  [600, 401, "UNAUTHENTICATED"],
  [500.5, 401, "UNAUTHENTICATED"],
  ["500", 401, "UNAUTHENTICATED"],
] as const) {
  test(`dependency APIError ${JSON.stringify(status)} preserves its non-5xx classification`, async () => {
    let refusals = 0;
    const { auth, memoryDatabase } = controller({
      accepted: async () => assert.fail("a failed dependency cannot sign in"),
      refused: async () => {
        refusals += 1;
      },
    });
    await auth.createAccount({ email, password });
    Object.defineProperty(memoryDatabase, "user", {
      get() {
        throw new APIError(status, { message: "synthetic dependency failure" });
      },
    });
    const response = await signIn(auth, { email, password });
    assert.equal(response.status, expectedStatus);
    assert.equal(errorOf(response).code, expectedCode);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(refusals, 1);
    assert.equal(memoryDatabase.session.length, 0);
  });
}

test("a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let refusals = 0;
  const events: OperationalEvent[] = [];
  const { auth } = controller(
    {
      accepted: async () => {},
      refused: async () => {
        refusals += 1;
        throw new Error("audit unavailable");
      },
    },
    { onOperationalEvent: (event) => events.push(event) },
  );
  await auth.createAccount({ email, password });
  // The audit outage is reported, never hidden behind a 401.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
  }
  assert.equal(refusals, 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  assertLimited(await signIn(auth, { email, password: "wrong-password-guess" }));
  assert.equal(refusals, 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
});

test("guarded profile: a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let denials = 0;
  const humanLogin = createHumanLogin(
    humanState({
      createAttempt: async () => {
        throw new Error("not used");
      },
      consumeAttempt: async () => undefined,
      snapshotExternal: async () => undefined,
      snapshotPassword: async () => undefined,
      recordDenied: async () => {
        denials += 1;
        throw new Error("audit unavailable");
      },
    }),
    {
      recoveryUserId: "guarded-recovery",
      google: {
        clientId: "guarded-client",
        clientSecret: "guarded-client-secret",
        allowedDomains: [],
      },
    },
    baseURL,
  );
  const events: OperationalEvent[] = [];
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit_guarded",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret: "password-sign-in-audit-secret-at-least-32-bytes",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    humanLogin,
    onOperationalEvent: (event) => events.push(event),
  });
  // The audit outage is reported, never hidden behind a 401.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertUnavailable(await signIn(auth, { email, password: "wrong-password-guess" }));
  }
  assert.equal(denials, 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  assertLimited(await signIn(auth, { email, password: "wrong-password-guess" }));
  assert.equal(denials, 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
});

// The external sign-in budgets refill each minute and set no Retry-After, so the answer says to
// wait a minute; only the password limiter names a wait (findings 2535, 2555). The console shows
// this text's meaning from the status alone, so the API text is pinned here.
test("guarded profile: a spent provider result budget says to wait a minute, with no Retry-After", async () => {
  const humanLogin = createHumanLogin(
    humanState({
      createAttempt: async () => {
        throw new Error("not used");
      },
      consumeAttempt: async () => undefined,
      snapshotExternal: async () => undefined,
      snapshotPassword: async () => undefined,
      recordDenied: async () => {},
    }),
    {
      recoveryUserId: "guarded-recovery",
      google: {
        clientId: "guarded-client",
        clientSecret: "guarded-client-secret",
        allowedDomains: [],
      },
    },
    baseURL,
  );
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit_provider_limit",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    humanLogin,
  });
  const result = () =>
    send(auth.googleResult, {
      id: "req_provider_limit",
      ip: "127.0.0.1",
      method: "POST",
      url: "/api/auth/providers/google/result",
      headers: { origin: baseURL },
      body: { attemptId: "a".repeat(43) },
    });
  // Without a receipt every exchange is refused, and each one spends the browser's budget of
  // 30 a minute.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const refused = await result();
    assert.equal(refused.status, 401, JSON.stringify(refused.payload));
    assert.equal(errorOf(refused).message, "Google sign-in could not be confirmed.");
  }
  const limited = await result();
  assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  assert.equal(limited.headers["retry-after"], undefined);
  assert.deepEqual(errorOf(limited), {
    code: "RATE_LIMITED",
    message: SIGN_IN_RATE_LIMITED_MINUTE,
  });
});

test("a password reset during a sign-in revokes the known-device entry that sign-in sets", async () => {
  // The audit hook runs after the password check, the latest point a reset can commit
  // before the entry is issued. The entry must be bound to the state the old password
  // was checked against, so the reset revokes it.
  let version = 1;
  const reads: string[] = [];
  const knownDeviceState = async (address: string) => {
    reads.push(address);
    return `password\0user-1\0method-1\0${version}`;
  };
  const { auth } = controller(
    {
      accepted: async () => {
        version += 1;
      },
      refused: async () => {},
    },
    { knownDeviceState },
  );
  await auth.createAccount({ email, password });
  const response = await signIn(auth, { email, password });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const cookies = [response.headers["set-cookie"]]
    .flat()
    .filter((value): value is string => typeof value === "string");
  const name = knownDeviceCookieName(true);
  const entry = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(entry, "a successful sign-in marks the browser");
  const value = knownDeviceFromCookieHeader(entry.split(";", 1)[0], true);
  assert.deepEqual(reads, [email], "the state is read once per attempt");
  assert.equal(
    await verifyKnownDevice(secret, email, value, Date.now(), knownDeviceState),
    undefined,
    "the entry does not verify against the reset state",
  );
  // Without a concurrent reset, the entry verifies against the current state.
  const current = async () => `password\0user-1\0method-1\0${version - 1}`;
  assert.ok(await verifyKnownDevice(secret, email, value, Date.now(), current));
});

// A Better Auth store that, like PostgreSQL text, cannot look up a NUL character.
function nulRefusingDatabase(memoryDatabase: Database): AdapterFactory {
  return (options) => {
    const adapter = memoryAdapter(memoryDatabase)(options);
    return {
      ...adapter,
      async findOne(query) {
        if (JSON.stringify(query.where ?? []).includes("\\u0000")) {
          throw new Error("invalid byte sequence for encoding UTF8: 0x00");
        }
        return adapter.findOne(query);
      },
    };
  };
}

const unstorableEmails: [string, string][] = [
  ["nul\u0000@example.test", "a NUL character"],
  ["surrogate\ud800@example.test", "an unpaired UTF-16 surrogate"],
];

function assertUnstorableEmail(response: Sent, problem: string) {
  assert.equal(response.status, 400, JSON.stringify(response.payload));
  assert.deepEqual(errorOf(response), {
    code: "INVALID_REQUEST",
    message: `The request does not match the operation contract: body /email contains ${problem}.`,
  });
}

test("an email no account can hold is a 400 that spends the password budget", async () => {
  const outcomes: Outcome[] = [];
  const reads: string[] = [];
  const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit_unstorable",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    database: nulRefusingDatabase(memoryDatabase),
    passwordSignInAudit: {
      accepted: async (userId) => {
        outcomes.push(["accepted", userId]);
      },
      refused: async () => {
        outcomes.push(["refused"]);
      },
    },
    knownDeviceState: async (address) => {
      reads.push(address);
      return undefined;
    },
    // Every Installation administrator's email is reserved, so a spent email takes the
    // slow lane, which looks the email up.
    passwordAdministrator: async () => true,
    passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
  });
  for (const [address, problem] of unstorableEmails) {
    outcomes.length = 0;
    // Refused like the bad-credential answer it replaces: audited, and counted.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assertUnstorableEmail(
        await signIn(auth, { email: address, password: "wrong-password-guess" }),
        problem,
      );
    }
    assert.equal(outcomes.length, 10);
    assert.deepEqual(new Set(outcomes.flat()), new Set(["refused"]));
    // The spent email is refused, not looked up (PostgreSQL would answer 503).
    const limited = await signIn(auth, { email: address, password: "wrong-password-guess" });
    assert.equal(limited.status, 429, JSON.stringify(limited.payload));
    assert.equal(outcomes.length, 10);
  }
  assert.deepEqual(reads, [], "no account state is read for an email no account can hold");

  // The password is never stored as text, so it is not checked: such an account still signs in.
  const nulPassword = "account-password-\u0000-\ud800";
  const account = await auth.createAccount({ email, password: nulPassword });
  outcomes.length = 0;
  assert.equal((await signIn(auth, { email, password: nulPassword })).status, 200);
  assert.deepEqual(outcomes, [["accepted", account.id]]);
});

test("guarded profile: an email no account can hold is a 400 that spends the password budget", async () => {
  const snapshots: string[] = [];
  const denials: string[] = [];
  const humanLogin = createHumanLogin(
    humanState({
      createAttempt: async () => {
        throw new Error("not used");
      },
      consumeAttempt: async () => undefined,
      snapshotExternal: async () => undefined,
      // Like PostgreSQL text, which cannot hold a NUL character.
      snapshotPassword: async (address) => {
        snapshots.push(address);
        if (address.includes("\u0000")) {
          throw new Error("invalid byte sequence for encoding UTF8: 0x00");
        }
        return undefined;
      },
      recordDenied: async (reason) => {
        denials.push(reason);
      },
    }),
    {
      recoveryUserId: "guarded-recovery",
      google: {
        clientId: "guarded-client",
        clientSecret: "guarded-client-secret",
        allowedDomains: [],
      },
    },
    baseURL,
  );
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit_guarded_unstorable",
    baseURL,
    agentDomain: "agents.oce.localhost",
    secret,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    humanLogin,
    passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
  });
  for (const [address, problem] of unstorableEmails) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assertUnstorableEmail(
        await signIn(auth, { email: address, password: "wrong-password-guess" }),
        problem,
      );
    }
    const limited = await signIn(auth, { email: address, password: "wrong-password-guess" });
    assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  }
  assert.deepEqual(snapshots, [], "no account is read for an email no account can hold");
  // The existing guarded denial owner records every admitted invalid attempt.
  assert.equal(denials.length, 20);
  assert.deepEqual(new Set(denials), new Set(["INVALID_CREDENTIALS"]));
});

// A real cookie for the replacement-character spelling also matches the UTF-8 encoding
// of the surrogate spelling. Invalid input must skip that proof read in both profiles.
for (const profile of ["password-only", "guarded", "recovery-only"]) {
  test(`${profile}: malformed email skips known-device state and preserves denial auditing`, async () => {
    const reads: string[] = [];
    const denials: string[] = [];
    let failAudit = false;
    const recordDenied = async () => {
      denials.push("INVALID_CREDENTIALS");
      if (failAudit) {
        throw new Error("audit unavailable");
      }
    };
    const accountState = async (address: string) => {
      reads.push(address);
      return "test-password-state";
    };
    const humanLogin =
      profile === "password-only"
        ? undefined
        : createHumanLogin(
            humanState({
              createAttempt: async () => {
                throw new Error("not used");
              },
              consumeAttempt: async () => undefined,
              snapshotExternal: async () => undefined,
              snapshotPassword: async (address) => {
                reads.push(address);
                return undefined;
              },
              knownDeviceState: accountState,
              recordDenied,
            }),
            {
              recoveryUserId: "guarded-recovery",
              google: {
                clientId: "guarded-client",
                clientSecret: "guarded-client-secret",
                allowedDomains: [],
              },
              ...(profile === "recovery-only" ? { passwordSignIn: "recovery-only" } : {}),
            },
            baseURL,
          );
    const auth = createControllerAuth({
      mode: "development",
      installationId: "ins_invalid_email_known_device",
      baseURL,
      agentDomain: "agents.oce.localhost",
      secret,
      database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
      ...(humanLogin
        ? { humanLogin }
        : {
            knownDeviceState: accountState,
            passwordSignInAudit: { accepted: async () => {}, refused: recordDenied },
          }),
      passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
    });
    const malformed = "cookie-\ud800@example.test";
    const cookie = issueKnownDevice(
      secret,
      "cookie-\ufffd@example.test",
      "test-password-state",
      Date.now(),
    );
    const headers = { cookie: `${knownDeviceCookieName(true)}=${cookie}` };
    assertUnstorableEmail(
      await signIn(auth, { email: malformed, password }, headers),
      "an unpaired UTF-16 surrogate",
    );
    assert.deepEqual(reads, [], "malformed email must not reach known-device or credential State");
    assert.equal(denials.length, 1);
    failAudit = true;
    for (let attempt = 1; attempt < 10; attempt += 1) {
      const failed = await signIn(auth, { email: malformed, password }, headers);
      assert.equal(failed.status, 503);
      assert.equal(failed.headers["set-cookie"], undefined);
    }
    assert.equal(denials.length, 10);
    assert.equal((await signIn(auth, { email: malformed, password }, headers)).status, 429);
    assert.equal(denials.length, 10, "exhausted admission does not repeat the denial audit");
    assert.deepEqual(reads, []);
  });
}

// Preserve the dependency's existing email contract; the password itself is supported.
test("password-only distinguishes unsupported stored email from an unusual password", async () => {
  const outcomes: Outcome[] = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (id) => {
      outcomes.push(["accepted", id]);
    },
    refused: async () => {
      outcomes.push(["refused"]);
    },
  });
  const unusualPassword = "account-password-\u0000-\ud800-\ufffd";
  const ordinary = await auth.createAccount({
    email: "ordinary-unusual@example.test",
    password: unusualPassword,
  });
  await auth.createAccount({ email: "stored-\ufffd@example.test", password: unusualPassword });
  assert.equal(
    (await signIn(auth, { email: ordinary.email, password: unusualPassword })).status,
    200,
  );
  const sessions = memoryDatabase.session.length;
  const refused = await signIn(auth, {
    email: "stored-\ufffd@example.test",
    password: unusualPassword,
  });
  assert.equal(refused.status, 400);
  assert.equal(errorOf(refused).code, "FORBIDDEN");
  assert.equal(refused.headers["set-cookie"], undefined);
  assert.equal(
    memoryDatabase.session.length,
    sessions,
    "unsupported stored email issues no session",
  );
  assert.deepEqual(outcomes, [["accepted", ordinary.id], ["refused"]]);
});

for (const passwordSignIn of ["all", "recovery-only"] as const) {
  test(`guarded ${passwordSignIn}: literal replacement email reaches normal credential checks`, async () => {
    const reads: string[] = [];
    const denials: string[] = [];
    const literalEmail = "stored-\ufffd@example.test";
    const humanLogin = createHumanLogin(
      humanState({
        createAttempt: async () => {
          throw new Error("not used");
        },
        consumeAttempt: async () => undefined,
        snapshotExternal: async () => undefined,
        snapshotPassword: async (address) => {
          reads.push(address);
          return undefined;
        },
        recordDenied: async (reason) => {
          denials.push(reason);
        },
      }),
      {
        recoveryUserId: "guarded-recovery",
        ...(passwordSignIn === "recovery-only" ? { passwordSignIn } : {}),
        google: {
          clientId: "guarded-client",
          clientSecret: "guarded-client-secret",
          allowedDomains: [],
        },
      },
      baseURL,
    );
    humanLogin.designateRecovery(literalEmail);
    const auth = createControllerAuth({
      mode: "development",
      installationId: "ins_literal_email_guarded",
      baseURL,
      agentDomain: "agents.oce.localhost",
      secret,
      database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
      humanLogin,
    });
    const refused = await signIn(auth, {
      email: literalEmail,
      password: "account-password-\u0000-\ud800-\ufffd",
    });
    // Missing-account State is a denial, not fabricated successful authentication.
    assert.equal(refused.status, 401);
    assert.equal(refused.headers["set-cookie"], undefined);
    assert.deepEqual(reads, [literalEmail]);
    assert.deepEqual(denials, ["INVALID_CREDENTIALS"]);
  });
}

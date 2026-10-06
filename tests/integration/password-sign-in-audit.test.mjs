import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createHumanLogin } from "../../apps/controller/src/auth/github.ts";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import {
  knownDeviceCookieName,
  knownDeviceFromCookieHeader,
  verifyKnownDevice,
} from "../../apps/controller/src/auth/known-device.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { memoryAdapter } = await import(require.resolve("better-auth/adapters/memory"));

const baseURL = "http://127.0.0.1";
const email = "audited@example.test";
const password = "audited-account-password";

const secret = "password-sign-in-audit-secret-at-least-32-bytes";

function controller(audit, extra = {}) {
  const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit",
    baseURL,
    secret,
    secureCookies: false,
    memoryDatabase,
    passwordSignInAudit: audit,
    ...extra,
  });
  return { auth, memoryDatabase };
}

async function signIn(auth, body) {
  const sent = { status: 200, headers: {} };
  const reply = {
    header(name, value) {
      sent.headers[name] = value;
      return reply;
    },
    status(code) {
      sent.status = code;
      return reply;
    },
    send(payload) {
      sent.payload = payload;
      return reply;
    },
  };
  await auth.signInEmail(
    {
      id: "req_audit",
      ip: "127.0.0.1",
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseURL },
      body,
    },
    reply,
  );
  return sent;
}

test("a password-only sign-in reports its outcome to the audit seam", async () => {
  const outcomes = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => outcomes.push(["accepted", userId]),
    refused: async () => outcomes.push(["refused"]),
  });
  const account = await auth.createAccount({ email, password });
  assert.equal((await signIn(auth, { email, password })).status, 200);
  assert.equal((await signIn(auth, { email, password: "wrong-password-guess" })).status, 401);
  assert.equal(
    (await signIn(auth, { email: "nobody@example.test", password: "wrong-password-guess" })).status,
    401,
  );
  assert.deepEqual(outcomes, [["accepted", account.id], ["refused"], ["refused"]]);
  assert.equal(memoryDatabase.session.length, 1);
});

test("a sign-in that fails on its dependency is 503, not an audited or counted refusal", async () => {
  const outcomes = [];
  const { auth, memoryDatabase } = controller({
    accepted: async (userId) => outcomes.push(["accepted", userId]),
    refused: async () => outcomes.push(["refused"]),
  });
  await auth.createAccount({ email, password });
  // Every account read now fails, as it would with the database down.
  Object.defineProperty(memoryDatabase, "user", {
    get() {
      throw new Error("database unavailable");
    },
  });
  const statuses = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    statuses.push((await signIn(auth, { email, password: "wrong-password-guess" })).status);
  }
  // Nothing was refused, so nothing is audited as a refusal and no budget is spent: the
  // email lane admits ten failures, so the eleventh attempt would be 429 if these counted.
  assert.deepEqual(new Set(statuses), new Set([503]));
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

test("a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let refusals = 0;
  const events = [];
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
  const statuses = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    statuses.push((await signIn(auth, { email, password: "wrong-password-guess" })).status);
  }
  // The audit outage is reported, never hidden behind a 401.
  assert.deepEqual(new Set(statuses), new Set([503]));
  assert.equal(refusals, 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  const limited = await signIn(auth, { email, password: "wrong-password-guess" });
  assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  assert.equal(refusals, 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
});

test("guarded profile: a wrong password whose denial audit fails is 503 and still spends the budget", async () => {
  let denials = 0;
  const humanLogin = createHumanLogin(
    {
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
    },
    {
      recoveryUserId: "guarded-recovery",
      github: { clientId: "guarded-client", clientSecret: "guarded-client-secret" },
    },
    baseURL,
  );
  const events = [];
  const auth = createControllerAuth({
    mode: "development",
    installationId: "ins_sign_in_audit_guarded",
    baseURL,
    secret: "password-sign-in-audit-secret-at-least-32-bytes",
    secureCookies: false,
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], apikey: [] }),
    humanLogin,
    onOperationalEvent: (event) => events.push(event),
  });
  const statuses = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    statuses.push((await signIn(auth, { email, password: "wrong-password-guess" })).status);
  }
  // The audit outage is reported, never hidden behind a 401.
  assert.deepEqual(new Set(statuses), new Set([503]));
  assert.equal(denials, 10);
  // Every failed guess counted: the next attempt is refused before the password is checked.
  const limited = await signIn(auth, { email, password: "wrong-password-guess" });
  assert.equal(limited.status, 429, JSON.stringify(limited.payload));
  assert.equal(denials, 10);
  assert.deepEqual(
    events.map(({ event, lane }) => [event, lane]),
    [["authentication.sign-in-limited", "email"]],
  );
});

test("a password reset during a sign-in revokes the known-device entry that sign-in sets", async () => {
  // The audit hook runs after the password check, the latest point a reset can commit
  // before the entry is issued. The entry must be bound to the state the old password
  // was checked against, so the reset revokes it.
  let version = 1;
  const reads = [];
  const knownDeviceState = async (address) => {
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
  const cookies = [response.headers["set-cookie"]].flat();
  const name = knownDeviceCookieName(false);
  const entry = cookies.find((value) => value.startsWith(`${name}=`));
  assert.ok(entry, "a successful sign-in marks the browser");
  const value = knownDeviceFromCookieHeader(entry.split(";", 1)[0], false);
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

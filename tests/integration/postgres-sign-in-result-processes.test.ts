import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { cookieHeaderFromSetCookie } from "../helpers/auth-session.mjs";
import { databaseUrl, requiresPostgres, testPool } from "../helpers/postgres-database.mjs";
import {
  bootstrapProductionInstallation,
  consoleOrigin,
  sessionCookieName,
} from "../helpers/production-sign-in.mjs";

type Api = { url: string; authorize(url: string): Promise<string> };
type Login = { attemptId: string; cookie: string };
type ApiInput = { databaseUrl: string; recoveryUserId: string; secrets: Record<string, string> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startApi(t: TestContext, input: ApiInput) {
  const child = fork(new URL("../helpers/sign-in-api-process.mjs", import.meta.url), [], {
    execArgv: [],
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    try {
      const [code, signal] = await within(closed, 15000, "API process did not stop");
      assert.equal(code, 0);
      assert.equal(signal, null);
    } catch (error) {
      child.kill("SIGKILL");
      await within(closed, 5000, "API process was not reaped");
      throw error;
    }
  };
  t.after(stop);
  let outputBytes = 0;
  const discard = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) {
      child.kill("SIGKILL");
    }
  };
  assert.ok(child.stdout && child.stderr);
  child.stdout.on("data", discard);
  child.stderr.on("data", discard);
  const ready = once(child, "message");
  child.send(input);
  const [message]: unknown[] = await within(ready, 30000, "API process did not become ready");
  assert.ok(isRecord(message));
  assert.equal(message.type, "ready");
  assert.equal(message.pid, child.pid);
  assert.ok(typeof message.url === "string");
  const authorize = async (url: string) => {
    const id = randomUUID();
    let listener: (message: unknown) => void;
    const reply = new Promise<string>((resolve) => {
      listener = (message) => {
        if (
          isRecord(message) &&
          message.type === "code" &&
          message.id === id &&
          typeof message.code === "string"
        ) {
          resolve(message.code);
        }
      };
      child.on("message", listener);
      child.send({ type: "authorize", id, url });
    });
    try {
      return await within(reply, 10000, "OIDC fixture did not authorize");
    } finally {
      child.off("message", listener!);
    }
  };
  return { url: message.url, pid: child.pid, stop, authorize };
}

async function request(
  api: Api,
  path: string,
  {
    cookie,
    body,
    method = "GET",
  }: { cookie?: string; body?: Record<string, unknown>; method?: string } = {},
) {
  const response = await fetch(new URL(path, api.url), {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: {
      host: new URL(consoleOrigin).host,
      origin: consoleOrigin,
      ...(cookie === undefined ? {} : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload: unknown;
  if (text && response.headers.get("content-type")?.includes("application/json")) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Sign-in API returned invalid JSON");
    }
  }
  return {
    status: response.status,
    text,
    hasNullData: isRecord(payload) && payload.data === null,
    hasTopLevelSessionKey: isRecord(payload) && Object.hasOwn(payload, "sessionKey"),
    cookies: response.headers.getSetCookie(),
    data: isRecord(payload) && isRecord(payload.data) ? payload.data : {},
  };
}

async function callback(api: Api): Promise<Login> {
  const start = await request(api, "/api/auth/providers/oidc/start", { method: "POST" });
  assert.equal(start.status, 200);
  assert.ok(typeof start.data.url === "string" && typeof start.data.attemptId === "string");
  const redirect = URL.parse(start.data.url);
  assert.ok(redirect, "Provider redirect must be a valid URL");
  const state = redirect.searchParams.get("state");
  assert.ok(state);
  const code = await api.authorize(start.data.url);
  const completed = await request(
    api,
    `/api/auth/providers/oidc/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { cookie: cookieHeaderFromSetCookie(start.cookies) },
  );
  assert.equal(completed.status, 302);
  return {
    attemptId: start.data.attemptId,
    cookie: cookieHeaderFromSetCookie(completed.cookies),
  };
}

function collect(api: Api, login: Login) {
  return request(api, "/api/auth/providers/oidc/result", {
    method: "POST",
    cookie: login.cookie,
    body: { attemptId: login.attemptId },
  });
}

async function readSession(api: Api, cookie: string, userId: string) {
  const session = await request(api, "/api/auth/session", { cookie });
  assert.equal(session.status, 200);
  assert.equal(session.data.authenticated, true);
  assert.ok(isRecord(session.data.user));
  assert.equal(session.data.user.id, userId);
  assert.ok(typeof session.data.sessionKey === "string", "session must include a key");
  assert.ok(session.data.sessionKey.length > 0);
  return session.data.sessionKey;
}

function assertCollected(result: Awaited<ReturnType<typeof request>>, sessionKey: string) {
  assert.equal(result.status, 200);
  assert.ok(
    result.data.sessionKey === sessionKey,
    "collection must return the original session key",
  );
  assert.ok(
    result.cookies.some((cookie) =>
      /login_receipt=;.*(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(cookie),
    ),
    "successful collection clears the receipt cookie",
  );
}

function assertDenied(
  result: Awaited<ReturnType<typeof request>>,
  ...sessionKeys: [string, ...string[]]
) {
  assert.equal(result.status, 401);
  assert.ok(
    !result.hasTopLevelSessionKey &&
      !Object.hasOwn(result.data, "sessionKey") &&
      sessionKeys.every((key) => !result.text.includes(key)),
    "Denied collection must omit the session key",
  );
}

test(
  "sign-in results retain one-use ownership across real API processes",
  requiresPostgres,
  async (t) => {
    assert.ok(databaseUrl);
    const secrets = {
      "occ-auth/secret": "process-sign-in-fixture-secret-at-least-32-bytes",
      "occ-oidc-login/client-id": "process-fixture-client",
      "occ-oidc-login/client-secret": "process-fixture-client-secret",
    };
    const email = "process-recovery@example.test";
    const password = await bootstrapProductionInstallation(t, {
      databaseUrl,
      email,
      authSecret: secrets["occ-auth/secret"],
    }).catch(() => {
      throw new Error("Sign-in test installation bootstrap failed");
    });
    const pool = testPool(t, { connectionString: databaseUrl });
    const recoveryUserId = (await pool.query('SELECT id FROM occ."user" WHERE email = $1', [email]))
      .rows[0].id;
    const input = { databaseUrl, recoveryUserId, secrets };
    const a = await startApi(t, input);
    const b = await startApi(t, input);
    assert.notEqual(a.pid, b.pid);

    const signedIn = await request(a, "/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(signedIn.status, 200);
    const adminCookie = cookieHeaderFromSetCookie(signedIn.cookies);
    const account = await request(a, `/api/auth/accounts/${recoveryUserId}`, {
      cookie: adminCookie,
    });
    assert.equal(account.status, 200);
    const attached = await request(a, `/api/auth/accounts/${recoveryUserId}/providers/oidc`, {
      method: "POST",
      cookie: adminCookie,
      body: { subject: "9400011", expectedVersion: account.data.version },
    });
    assert.equal(attached.status, 200);

    // Both requests carry exactly the same real callback material. Independent API
    // processes must compete for one durable result, rather than separate memory sets.
    await t.test("concurrent collectors return exactly one original session key", async () => {
      const login = await callback(a);
      const session = await readSession(a, login.cookie, recoveryUserId);
      const results = await Promise.all([collect(a, login), collect(b, login)]);
      const [collected, denied] = results.sort((left, right) => left.status - right.status);
      assertCollected(collected, session);
      assertDenied(denied, session);
    });

    await t.test("a different active session cannot take the outstanding result", async () => {
      const login = await callback(a);
      const other = await callback(b);
      const identity = other.cookie
        .split("; ")
        .find((item) => item.startsWith(`${sessionCookieName}=`));
      assert.ok(identity, "the second callback must issue a session cookie");
      const originalKey = await readSession(b, login.cookie, recoveryUserId);
      const foreignKey = await readSession(b, identity, recoveryUserId);
      assert.ok(originalKey !== foreignKey, "the same account must have two distinct sessions");
      const receipt = login.cookie
        .split("; ")
        .find((item) => item.startsWith("__Host-occ_login_receipt="));
      assert.ok(receipt, "callback must issue the receipt");
      const foreign = { attemptId: login.attemptId, cookie: `${identity}; ${receipt}` };
      assertDenied(await collect(b, foreign), originalKey, foreignKey);
      assertCollected(await collect(b, login), originalKey);
    });

    await t.test("the peer denies an outstanding result after committed sign-out", async () => {
      const login = await callback(a);
      const originalKey = await readSession(b, login.cookie, recoveryUserId);
      const signedOut = await request(a, "/api/auth/sign-out", {
        method: "POST",
        cookie: login.cookie,
      });
      assert.equal(signedOut.status, 200);
      const revoked = await request(b, "/api/auth/session", { cookie: login.cookie });
      assert.equal(revoked.status, 200);
      assert.ok(revoked.hasNullData, "the peer must observe revocation before collection");
      assertDenied(await collect(b, login), originalKey);
    });

    const spent = await callback(a);
    const spentSession = await readSession(a, spent.cookie, recoveryUserId);
    assertCollected(await collect(a, spent), spentSession);
    const outstanding = await callback(a);
    const outstandingSession = await readSession(a, outstanding.cookie, recoveryUserId);
    const before = await pool.query(
      "SELECT id, expires_at FROM occ.session WHERE user_id = $1 ORDER BY id",
      [recoveryUserId],
    );
    // Observe the issuer's actual process exit before asking its independent peer.
    await a.stop();
    await t.test("a result consumed by the exited issuer stays spent", async () => {
      const stillCurrent = await readSession(b, spent.cookie, recoveryUserId);
      assert.ok(stillCurrent === spentSession, "the original session must remain current");
      assertDenied(await collect(b, spent), spentSession);
    });
    await t.test(
      "an outstanding result survives issuer exit without extending its session",
      async () => {
        assertCollected(await collect(b, outstanding), outstandingSession);
        assertDenied(await collect(b, outstanding), outstandingSession);
        const after = await pool.query(
          "SELECT id, expires_at FROM occ.session WHERE user_id = $1 ORDER BY id",
          [recoveryUserId],
        );
        assert.deepEqual(after.rows, before.rows);
      },
    );
  },
);

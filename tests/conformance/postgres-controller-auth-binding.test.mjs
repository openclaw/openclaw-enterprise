import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const controllerURL = new URL("../../apps/controller/src/auth/index.ts", import.meta.url);

function options(pool) {
  return {
    pool,
    mode: "production",
    installationId: "ins_auth_binding",
    baseURL: "https://controller.example.test",
    secret: "controller-auth-binding-test-secret-at-least-32-characters",
  };
}

function refusingPool() {
  const calls = [];
  const refusal = new Error("private database refusal detail");
  // Refuse at the external database resource. The actual pool class is retained
  // so Drizzle's transaction detection matches the production composition.
  const pool = new pg.Pool({ max: 1 });
  for (const method of ["connect", "query", "end"]) {
    Object.defineProperty(pool, method, {
      configurable: true,
      value: async function () {
        calls.push({ method, receiver: this });
        throw refusal;
      },
    });
  }
  return { pool, calls };
}

async function signIn(controller, baseURL) {
  // Observe the real controller's public envelope; this is not Fastify route proof.
  const response = { headers: {} };
  await controller.signInEmail(
    {
      id: "auth-binding-request",
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseURL },
      raw: { socket: { remoteAddress: "127.0.0.1" } },
      body: { email: "person@example.test", password: "test-password-long-enough" },
    },
    {
      header(name, value) {
        response.headers[name] = value;
        return this;
      },
      status(value) {
        response.status = value;
        return this;
      },
      send(value) {
        response.body = value;
        return this;
      },
    },
  );
  return response;
}

async function constructionAndRefusal() {
  const { createPostgresControllerAuth } = await import(controllerURL);
  const { pool, calls } = refusingPool();
  const selected = options(pool);
  const controller = await createPostgresControllerAuth(selected);
  // Complete BetterAuth initialization must not acquire or end the caller's pool.
  await controller.auth.$context;
  assert.deepEqual(calls, []);

  const response = await signIn(controller, selected.baseURL);
  // The known-device state read (before the password check) reaches the supplied pool and
  // its refusal only skips the marking; the real adapter then reaches the pool and
  // sanitizes its refusal.
  assert.deepEqual(calls, [
    { method: "query", receiver: pool },
    { method: "query", receiver: pool },
  ]);
  assert.deepEqual(response, {
    status: 503,
    headers: {},
    body: {
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message:
          "Sign-in is temporarily unavailable. Try again shortly. If it continues, ask an operator to check the API logs.",
      },
      meta: { requestId: "auth-binding-request" },
    },
  });
}

async function dependencyFailure(dependency) {
  const expected = new Error("auth binding dependency could not load");
  let refusals = 0;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // Refuse the actual producer's import, before dependency evaluation. The
      // unchanged binding and controller must preserve this exact error.
      if (
        context.parentURL?.endsWith("/auth-persistence/postgres-auth-binding.ts") &&
        specifier === dependency
      ) {
        refusals++;
        throw expected;
      }
      return nextResolve(specifier, context);
    },
  });
  const { pool, calls } = refusingPool();
  try {
    const { createPostgresControllerAuth } = await import(controllerURL);
    await assert.rejects(
      createPostgresControllerAuth(options(pool)),
      (error) => error === expected,
    );
    assert.equal(refusals, 1);
    assert.deepEqual(calls, []);
  } finally {
    hooks.deregister();
  }
}

function runIsolated(name) {
  // Fresh processes keep module hooks and cached dependencies out of other cases.
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=512", fileURLToPath(import.meta.url), name],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

const scenarios = {
  "controller constructs without pool I/O and sanitizes database refusal": constructionAndRefusal,
  "controller propagates Drizzle import failure without fallback or pool teardown": () =>
    dependencyFailure("drizzle-orm/node-postgres"),
  "controller propagates schema import failure without fallback or pool teardown": () =>
    dependencyFailure("../state/postgres-schema.ts"),
};
const scenario = process.argv[2];
if (scenario === undefined) {
  for (const name of Object.keys(scenarios)) {
    test(name, () => runIsolated(name));
  }
} else {
  assert.ok(Object.hasOwn(scenarios, scenario), "Unsupported child scenario");
  await scenarios[scenario]();
}

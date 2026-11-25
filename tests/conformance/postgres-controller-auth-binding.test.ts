import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import Fastify from "../../apps/controller/node_modules/fastify/fastify.js";
import type {
  ControllerAuth,
  PostgresControllerAuthOptions,
} from "../../apps/controller/src/auth/index.ts";
import { SIGN_IN_UNAVAILABLE } from "../helpers/refusal-text.mjs";

const refusalDetail = "private database refusal detail";

function options(pool: pg.Pool): PostgresControllerAuthOptions {
  return {
    pool,
    mode: "production",
    installationId: "ins_auth_binding",
    baseURL: "https://controller.example.test",
    agentDomain: "agents.example.test",
    secret: "controller-auth-binding-test-secret-at-least-32-characters",
  };
}

type PoolMethod = keyof Pick<pg.Pool, "connect" | "query" | "end">;

function refusingPool() {
  const calls: { method: PoolMethod; receiver: pg.Pool; text: string | undefined }[] = [];
  const refusal = new Error(refusalDetail);
  // Refuse at the database boundary. The actual Pool class is retained so
  // Drizzle detects it as it would in production.
  const pool = new pg.Pool({ max: 1 });
  const methods: readonly PoolMethod[] = ["connect", "query", "end"];
  for (const method of methods) {
    Object.defineProperty(pool, method, {
      configurable: true,
      value: async function (this: pg.Pool, argument?: unknown) {
        const statement =
          argument !== null && typeof argument === "object" && "text" in argument
            ? argument.text
            : argument;
        calls.push({
          method,
          receiver: this,
          text: typeof statement === "string" ? statement : undefined,
        });
        throw refusal;
      },
    });
  }
  return { pool, calls };
}

async function signIn(controller: ControllerAuth, baseURL: string) {
  // Use the real password handler with Fastify's request parsing and response serialization.
  const app = Fastify({ genReqId: () => "auth-binding-request" });
  try {
    app.post("/api/auth/sign-in/email", controller.signInEmail);
    return await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: baseURL },
      payload: { email: "person@example.test", password: "test-password-long-enough" },
    });
  } finally {
    await app.close();
  }
}

async function constructionAndRefusal() {
  const { createPostgresControllerAuth } = await import("../../apps/controller/src/auth/index.ts");
  const { pool, calls } = refusingPool();
  const selected = options(pool);
  const controller = await createPostgresControllerAuth(selected);
  // Complete BetterAuth initialization must not acquire or end the caller's pool.
  await controller.auth.$context;
  assert.equal(calls.length, 0, "Construction must not use the supplied Pool");

  const response = await signIn(controller, selected.baseURL);
  // The known-device lookup declines to mark the browser when its read fails.
  // The password adapter then sees its own refusal from that same Pool.
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["query", "query"],
  );
  assert.ok(
    calls.every(({ receiver }) => receiver === pool),
    "Queries must use the supplied Pool",
  );
  const [knownDevice, adapter] = calls;
  assert.match(knownDevice?.text ?? "", /authentication_version[\s\S]+JOIN occ\.account/i);
  assert.match(adapter?.text ?? "", /from "occ"\."user"/i);
  assert.doesNotMatch(adapter?.text ?? "", /JOIN occ\.account/i);

  assert.equal(response.statusCode, 503);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.ok(!response.body.includes(refusalDetail), "Response exposed the database refusal");
  const body: unknown = response.json();
  assert.ok(
    isDeepStrictEqual(body, {
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: SIGN_IN_UNAVAILABLE,
      },
      meta: { requestId: "auth-binding-request" },
    }),
    "Sign-in dependency refusal did not match the public envelope",
  );
}

type BindingDependency = "drizzle-orm/node-postgres" | "../state/postgres-schema.ts";

async function dependencyFailure(dependency: BindingDependency) {
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
    const { createPostgresControllerAuth } =
      await import("../../apps/controller/src/auth/index.ts");
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

function runIsolated(name: string) {
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
  assert.equal(result.status, 0, "Auth binding child failed");
}

const scenarios = new Map<string, () => Promise<void>>([
  ["controller constructs without pool I/O and sanitizes database refusal", constructionAndRefusal],
  [
    "controller propagates Drizzle import failure without fallback or pool teardown",
    () => dependencyFailure("drizzle-orm/node-postgres"),
  ],
  [
    "controller propagates schema import failure without fallback or pool teardown",
    () => dependencyFailure("../state/postgres-schema.ts"),
  ],
]);
const scenario = process.argv[2];
if (scenario === undefined) {
  for (const name of scenarios.keys()) {
    test(name, () => runIsolated(name));
  }
} else {
  const run = scenarios.get(scenario);
  assert.ok(run, "Unsupported child scenario");
  await run();
}

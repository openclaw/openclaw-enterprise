import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPostgresAuthBinding } from "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts";
import * as canonicalSchema from "../../packages/occ/src/state/postgres-schema.ts";

function forbidPoolIO(pool: object) {
  const calls: string[] = [];

  function forbid(method: "connect" | "query" | "end") {
    const fail = () => {
      calls.push(method);
      throw new Error(`Unexpected pool ${method}`);
    };
    Object.defineProperty(pool, method, { configurable: true, value: fail });
    return fail;
  }

  const connect = forbid("connect");
  const query = forbid("query");
  const end = forbid("end");
  return { calls, connect, query, end };
}

test("the real factory retains the caller pool and complete canonical schema without I/O", async () => {
  const pool = new pg.Pool({ max: 1 });
  // Caller-added properties must not make Drizzle interpret the pool as config.
  Object.assign(pool, { schema: {}, logger: false, connection: {}, client: {} });
  const { calls } = forbidPoolIO(pool);
  const pending = createPostgresAuthBinding(pool);
  assert.ok(pending instanceof Promise);
  const binding = await pending;
  assert.strictEqual(binding.schema, canonicalSchema);
  assert.ok("$client" in binding.database);
  assert.strictEqual(binding.database.$client, pool);
  assert.strictEqual(binding.database._.fullSchema, canonicalSchema);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.idleCount, 0);
  assert.equal(pool.waitingCount, 0);
  assert.deepEqual(calls, []);
});

test("structural wrappers and checked-out clients cannot replace a real pool", async () => {
  const { calls, connect, query, end } = forbidPoolIO({});
  // Pool-like queries can dispatch BEGIN and writes on different clients.
  const callers: Record<string, unknown> = {
    "connect/end wrapper": { connect, end },
    "querying wrapper": { connect, end, query },
    "checked-out client": { query, release() {} },
    "config-shaped wrapper": {
      connect,
      end,
      query,
      schema: {},
      logger: false,
      connection: {},
      client: {},
    },
    null: null,
    "connection URL": "postgresql://localhost/example",
  };
  for (const [name, caller] of Object.entries(callers)) {
    // Exercise runtime validation with inputs the public signature rejects.
    await assert.rejects(
      createPostgresAuthBinding(caller as Parameters<typeof createPostgresAuthBinding>[0]),
      /requires a node-postgres Pool/,
      name,
    );
  }
  assert.deepEqual(calls, []);
});

test("the public auth binding factory preserves inferred types and rejects unsupported contracts", () => {
  const compiler = fileURLToPath(
    new URL("./bin/tsc", import.meta.resolve("@typescript/native/package.json")),
  );
  const project = "apps/controller/tests/fixtures/postgres-auth-binding/tsconfig.json";
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=1536", compiler, "--build", project, "--pretty", "false"],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

const url = process.env.OCC_TEST_DATABASE_URL;
test(
  "a lost real COMMIT response preserves the unknown outcome and committed resource",
  {
    skip: url ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL transaction verification.",
    timeout: 30000,
  },
  async (t) => {
    await t.test("URL authority destination", () => verifyCommit(url));
    const effective = new pg.Client({ connectionString: url });
    const overridden = new URL(url);
    overridden.searchParams.set("host", effective.host);
    overridden.searchParams.set("port", String(effective.port));
    // The authority deliberately cannot reach the fixture. Both the direct pool
    // and proxy must honor pg's query overrides for the real upstream connection.
    overridden.hostname = "127.0.0.1";
    overridden.port = "1";
    await t.test("query host and port overrides", () => verifyCommit(overridden.toString()));
  },
);

async function verifyCommit(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const state = new PostgresPlatformState(pool);
  let proxy;
  let faultPool;
  try {
    // Validate the effective target and transport before any database mutation.
    proxy = await commitAckProxy(databaseUrl);
    if (!(await state.loadInstallation()))
      await state.transact((s) =>
        s.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Transaction fixture",
          createdAt: new Date().toISOString(),
        }),
      );
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Commit ${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 1,
      connectionTimeoutMillis: 3000,
    });
    const faultState = new PostgresPlatformState(faultPool);
    // The proxy consumes the server's COMMIT completion before closing the socket.
    // pg rejects the query and separately emits an error on its checked-out client.
    proxy.arm();
    await assert.rejects(
      faultState.transact((s) => s.namespaces.createNamespace(namespace)),
      { name: "PostgresCommitOutcomeUnknownError" },
    );
    assert.equal(proxy.observedCommit, true);
    assert.equal(
      (await state.read((s) => s.namespaces.findNamespace(namespace.id))).id,
      namespace.id,
    );
    // Reusing the pool obtains a working client after the dead connection was discarded.
    assert.equal(
      (await faultState.read((s) => s.namespaces.findNamespace(namespace.id))).id,
      namespace.id,
    );
  } finally {
    await faultPool?.end();
    await proxy?.close();
    await pool.end();
  }
}

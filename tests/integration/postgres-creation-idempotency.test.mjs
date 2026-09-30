import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { PostgresPlatformState, PostgresWorkQueue } from "../../packages/occ/src/index.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { authenticatedHeaders, signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const credentials = {
  email: "postgres-admin@openclaw.local",
  password: "postgres-development-password",
};
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL for real PostgreSQL creation recovery.",
  timeout: 60_000,
};

async function setup(t) {
  const config = {
    mode: "development",
    host: "127.0.0.1",
    databaseUrl,
    authBaseURL: "http://127.0.0.1",
    authSecret: "openclaw-creation-recovery-auth-secret-minimum-32-bytes",
  };
  await ensureDevelopmentBootstrap(t, {
    databaseUrl,
    ...credentials,
    authSecret: config.authSecret,
    authBaseURL: config.authBaseURL,
    installationName: "Creation recovery integration",
    environment: { PATH: process.env.PATH },
  });
  const directory = await mkdtemp(join(tmpdir(), "openclaw-creation-recovery-"));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const apps = new Set();
  t.after(async () => {
    for (const app of apps) {
      await app.close();
    }
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  async function start(url = databaseUrl) {
    const app = await composePostgresDevelopment(
      { ...config, databaseUrl: url },
      {
        computeDriver: createDevelopmentComputeDriver(),
        configurationDriver: new FilesystemConfigurationDriver(directory),
      },
    );
    apps.add(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    // Preserve the configured trusted browser origin while sending real loopback HTTP.
    const send = async (request) => {
      const target = new URL(request.url);
      return fetch(`${origin}${target.pathname}${target.search}`, {
        method: request.method,
        headers: { ...Object.fromEntries(request.headers), host: "127.0.0.1" },
        ...(request.body === null ? {} : { body: Buffer.from(await request.arrayBuffer()) }),
      });
    };
    const session = await signInWithEmailPassword({
      origin: config.authBaseURL,
      fetch: send,
      ...credentials,
    });
    return {
      async close() {
        await app.close();
        apps.delete(app);
      },
      async request(method, path, body) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            ...authenticatedHeaders(session),
            host: "127.0.0.1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        return {
          status: response.status,
          body: response.status === 204 ? undefined : await response.json(),
        };
      },
    };
  }
  return { start, pool, directory, state: new PostgresPlatformState(pool) };
}

test(
  "PostgreSQL HTTP creation retries survive concurrency, restart, and result deletion",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const first = await fixture.start();
    const second = await fixture.start();
    const namespace = await first.request("POST", "/namespaces", {
      name: `Recovery ${randomUUID()}`,
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
    const namespaceId = namespace.body.data.id;
    const configurations = `/namespaces/${namespaceId}/configurations`;
    const agents = `/namespaces/${namespaceId}/agents`;
    const configurationBody = { idempotencyKey: randomUUID(), kind: "agent", values: {} };

    // Independent API instances and connections race before either has a cached result.
    const configurationsCreated = await Promise.all([
      first.request("POST", configurations, configurationBody),
      second.request("POST", configurations, configurationBody),
    ]);
    for (const result of configurationsCreated) {
      assert.equal(result.status, 201, JSON.stringify(result.body));
    }
    const configurationId = configurationsCreated[0].body.data.id;
    assert.equal(configurationsCreated[1].body.data.id, configurationId);
    assert.deepEqual(await readdir(join(fixture.directory, namespaceId)), [
      `${configurationId}.json`,
    ]);

    const agentBody = {
      idempotencyKey: randomUUID(),
      name: "Concurrent Agent",
      configurationId,
      initialWorkspaceFiles: { "AGENTS.md": "Preserve submitted bytes." },
    };
    const createdAgents = await Promise.all([
      first.request("POST", agents, agentBody),
      second.request("POST", agents, agentBody),
    ]);
    for (const result of createdAgents) {
      assert.equal(result.status, 201, JSON.stringify(result.body));
    }
    const agentId = createdAgents[0].body.data.id;
    assert.equal(createdAgents[1].body.data.id, agentId);
    assert.equal((await first.request("GET", agents)).body.data.length, 1);
    assert.deepEqual(
      (await fixture.state.read((unit) => unit.workspaceSetups.find(namespaceId, agentId))).files,
      agentBody.initialWorkspaceFiles,
    );

    await first.close();
    await second.close();
    const reopened = await fixture.start();
    assert.equal(
      (await reopened.request("POST", configurations, configurationBody)).body.data.id,
      configurationId,
    );
    assert.equal((await reopened.request("POST", agents, agentBody)).body.data.id, agentId);
    const mismatch = await reopened.request("POST", agents, {
      ...agentBody,
      name: "Changed intent",
    });
    assert.equal(mismatch.status, 409);

    // The persisted identity is unique even for an application connection that
    // bypasses OCC's Namespace serialization.
    await assert.rejects(
      fixture.pool.query(
        `INSERT INTO occ.creation_requests
         SELECT * FROM occ.creation_requests WHERE namespace_id=$1 AND operation='createAgent'`,
        [namespaceId],
      ),
      { code: "23505" },
    );

    // Delete through OCC and complete the real deletion work transaction. No runtime
    // was ever deployed, so no external Agent resources need to be faked here.
    assert.equal((await reopened.request("DELETE", `${agents}/${agentId}`)).status, 202);
    const queue = new PostgresWorkQueue(fixture.pool);
    const claimToken = randomUUID();
    // Lease only this test's real deletion intent; a generic queue claim could
    // consume other tests' work in the shared PostgreSQL integration database.
    const leased = await fixture.pool.query(
      `UPDATE occ.controller_work SET state='claimed', attempt_count=attempt_count+1,
       claim_token=$1, lease_expires_at=clock_timestamp()+interval '30 seconds', updated_at=clock_timestamp()
     WHERE namespace_id=$2 AND agent_id=$3 AND agent_target='deleted' AND state='queued'
     RETURNING idempotency_key`,
      [claimToken, namespaceId, agentId],
    );
    assert.equal(leased.rowCount, 1, "the deletion work must be durably queued");
    await queue.completeAgentDeletion(
      { idempotencyKey: leased.rows[0].idempotency_key, claimToken },
      namespaceId,
      agentId,
    );
    const deletedAgent = await reopened.request("POST", agents, agentBody);
    assert.equal(deletedAgent.status, 409, JSON.stringify(deletedAgent.body));
    assert.match(deletedAgent.body.error.message, /no longer available/);
    assert.equal(
      (await reopened.request("DELETE", `${configurations}/${configurationId}`)).status,
      204,
    );
    assert.equal((await reopened.request("POST", configurations, configurationBody)).status, 409);
    const receipts = await fixture.pool.query(
      "SELECT count(*)::integer AS count FROM occ.creation_requests WHERE namespace_id=$1",
      [namespaceId],
    );
    assert.equal(receipts.rows[0].count, 2);
    await assert.rejects(
      fixture.pool.query("DELETE FROM occ.creation_requests WHERE namespace_id=$1", [namespaceId]),
      { code: "42501" },
    );
    await assert.rejects(
      fixture.pool.query("UPDATE occ.creation_requests SET fingerprint=$1 WHERE namespace_id=$2", [
        "0".repeat(64),
        namespaceId,
      ]),
      { code: "42501" },
    );
  },
);

test(
  "a lost PostgreSQL creation COMMIT reply reports an unknown outcome and recovers the committed resource",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const healthy = await fixture.start();
    const namespace = await healthy.request("POST", "/namespaces", {
      name: `Commit recovery ${randomUUID()}`,
    });
    assert.equal(namespace.status, 201, JSON.stringify(namespace.body));
    const namespaceId = namespace.body.data.id;
    const path = `/namespaces/${namespaceId}/configurations`;
    const body = { idempotencyKey: randomUUID(), kind: "agent", values: {} };
    const proxy = await commitAckProxy(databaseUrl);
    t.after(() => proxy.close());
    const uncertain = await fixture.start(proxy.url);
    // Only the creation transaction loses its completion. Authentication and IAM
    // reads still use the real database and receive their normal replies.
    proxy.arm({ afterStatement: "INSERT INTO occ.creation_requests" });
    const lost = await uncertain.request("POST", path, body);
    assert.equal(proxy.observedCommit, true);
    assert.equal(lost.status, 503, JSON.stringify(lost.body));
    assert.equal(lost.body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.match(lost.body.error.message, /outcome is unknown/i);
    const recovered = await healthy.request("POST", path, body);
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    const stored = await fixture.pool.query(
      "SELECT resource_id FROM occ.creation_requests WHERE namespace_id=$1",
      [namespaceId],
    );
    assert.deepEqual(stored.rows, [{ resource_id: recovered.body.data.id }]);
    assert.deepEqual(await readdir(join(fixture.directory, namespaceId)), [
      `${recovered.body.data.id}.json`,
    ]);
  },
);

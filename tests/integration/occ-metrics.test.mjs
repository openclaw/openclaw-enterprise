import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import {
  metricsConfiguration,
  startMetricsListener,
} from "../../apps/controller/src/metrics/listener.ts";
import { createPostgresPool, PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import pg from "pg";
import { requiresPostgres, setup } from "../helpers/compute-singleton-worker.mjs";

test("API metrics follow real authenticated routes and keep replica registries isolated", async (t) => {
  const metrics = createOccMetrics("api");
  const other = createOccMetrics("api");
  const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
  t.after(() => listener.close());
  const fixture = await createConsoleAppFixture(t, { metrics });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Metrics namespace");
  assert.equal((await fixture.request("GET", "/installation", { session: null })).status, 401);
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}/agents`)).status, 200);
  assert.equal(
    (await fixture.request("GET", "/metrics-private-nonexistent?token=do-not-export")).status,
    404,
  );

  // Observe the real HTTP workflow from its independent scrape surface.
  const response = await fetch(`${listener.url}/metrics`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(
    body,
    /occ_http_requests_total\{[^\n]*route="\/namespaces\/:namespaceId\/agents"[^\n]*status_class="2xx"[^\n]*\} 1/,
  );
  assert.match(body, /occ_http_request_duration_seconds_bucket/);
  assert.match(body, /occ_process_resident_memory_bytes/);
  assert.match(
    body,
    /occ_http_requests_total\{[^\n]*route="\/installation"[^\n]*status_class="4xx"/,
  );
  assert.doesNotMatch(body, new RegExp(namespace.id));
  assert.doesNotMatch(body, /do-not-export|metrics-private-nonexistent/);
  assert.doesNotMatch(await other.exposition(), /occ_http_requests_total\{/);
  assert.equal((await fetch(`${listener.url}/missing`)).status, 404);
  assert.equal((await fetch(`${listener.url}/metrics`, { method: "POST" })).status, 405);
  const occupied = { host: "127.0.0.1", port: Number(new URL(listener.url).port) };
  await assert.rejects(startMetricsListener(other, occupied), { code: "EADDRINUSE" });
  await listener.close();
  // Graceful close releases the port and can be called again by process cleanup.
  const replacement = await startMetricsListener(other, occupied);
  await replacement.close();
});

test("metrics settings reject exposed development binds and disabled stray settings", () => {
  assert.equal(metricsConfiguration({}, "development"), undefined);
  for (const [environment, refusal] of [
    [
      { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "0.0.0.0", OCC_METRICS_PORT: "9464" },
      /Development metrics require loopback/,
    ],
    [
      { OCC_METRICS_ENABLED: "false", OCC_METRICS_PORT: "9464" },
      /Disabled metrics cannot have host or port settings/,
    ],
    [{ OCC_METRICS_ENABLED: "yes" }, /OCC_METRICS_ENABLED must be true or false/],
    [
      { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "127.0.0.1", OCC_METRICS_PORT: "0" },
      /OCC_METRICS_PORT must be a distinct valid TCP port/,
    ],
    [
      { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "localhost", OCC_METRICS_PORT: "9464" },
      /OCC_METRICS_HOST must be an explicit IP address/,
    ],
  ]) {
    assert.throws(() => metricsConfiguration(environment, "development"), refusal);
  }
  assert.throws(
    () =>
      metricsConfiguration(
        { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: "127.0.0.1", OCC_METRICS_PORT: "9464" },
        "test",
      ),
    /Metrics require development or production mode/,
  );
  for (const host of ["::", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "127.0.0.2"]) {
    assert.throws(
      () =>
        metricsConfiguration(
          { OCC_METRICS_ENABLED: "true", OCC_METRICS_HOST: host, OCC_METRICS_PORT: "9464" },
          "production",
        ),
      /Production metrics require an explicit Pod interface address/,
    );
  }
});

test(
  "worker inventory reflects PostgreSQL activation and redeployment without replica multiplication",
  requiresPostgres,
  async (t) => {
    const fixture = await setup(t);
    const pool = await createPostgresPool(process.env.OCC_TEST_DATABASE_URL, {
      max: 1,
      connectionTimeoutMillis: 500,
      statement_timeout: 1500,
      query_timeout: 1500,
      options: "-c default_transaction_read_only=on",
    });
    let poolClosed = false;
    t.after(() => (poolClosed ? undefined : pool.end()));
    assert.equal(
      (await pool.query("SHOW default_transaction_read_only")).rows[0]
        .default_transaction_read_only,
      "on",
    );
    const snapshot = new PostgresMetricsSnapshot(pool);
    const a = createOccMetrics("worker", () => snapshot.collect());
    const before = await snapshot.collect();
    assert.match(
      await a.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 0(?:\n|$)/,
    );
    const agent = await fixture.agent();
    assert.deepEqual((await snapshot.collect()).agents, {
      ...before.agents,
      draft: before.agents.draft + 1,
    });
    const first = await fixture.revision(agent, 1);
    // Queue age includes time before any worker is running, not just claim time.
    await delay(80);
    const queued = await snapshot.collect();
    assert.equal(queued.agents.deploying, before.agents.deploying + 1);
    assert.ok(queued.oldestPendingAgeSeconds >= 0.05);
    let preparations = 0;
    // This existing deterministic Driver proves persistence/worker metrics, not
    // live runtime readiness. Production dedicated execution requires activation.
    await fixture.start(
      {
        ...fixture.compute,
        activationOrder: "beforeCommit",
        async prepareRevision(revision, context) {
          // A transient dependency failure forces a real queue retry. Completion
          // time must include the retry delay without counting the failed pass.
          if (++preparations === 1) {
            throw new Error("Temporary compute outage");
          }
          return fixture.compute.prepareRevision(revision, context);
        },
        async preflight() {},
        async activateRevision() {},
      },
      30_000,
      900_000,
      "production",
      undefined,
      a,
    );
    await fixture.work(first);
    assert.equal((await snapshot.collect()).agents.running, before.agents.running + 1);
    const firstMetrics = await a.exposition();
    assert.match(
      firstMetrics,
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 1(?:\n|$)/,
    );
    const duration = Number(
      firstMetrics.match(
        /occ_agent_operation_duration_seconds_sum\{[^\n]*operation="deploy"[^\n]*\} ([^\n]+)/,
      )?.[1],
    );
    assert.ok(duration >= 0.05, "completion duration must include pre-claim queue time");
    const second = await fixture.revision(agent, 2);
    await fixture.work(second);
    assert.equal((await snapshot.collect()).agents.running, before.agents.running + 1);

    assert.match(
      await a.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 2(?:\n|$)/,
    );

    // Both workers see the same shared state; it must never be summed across replicas.
    const b = createOccMetrics("worker", () => snapshot.collect());
    const inventory = (body) => body.split("\n").filter((line) => line.startsWith("occ_agents{"));
    assert.deepEqual(inventory(await a.exposition()), inventory(await b.exposition()));
    const listener = await startMetricsListener(a, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    assert.match(
      await a.exposition(),
      /occ_reconciliation_attempts_total\{[^\n]*work_kind="agent_revision"[^\n]*outcome="success"/,
    );
    assert.match(await a.exposition(), /occ_reconciliation_attempt_duration_seconds_count/);

    // Real table contention times out all overlapping scrapes together. Once the
    // lock is released, the next scrape must recover without stale fallback.
    await t.test(
      "real table contention fails overlapping scrapes and recovers",
      {
        skip: process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL
          ? false
          : "Set OCC_METRICS_TEST_MIGRATION_DATABASE_URL for table-lock failure proof.",
      },
      async () => {
        const migrationUrl = new URL(process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL);
        const applicationUrl = new URL(process.env.OCC_TEST_DATABASE_URL);
        assert.equal(migrationUrl.host, applicationUrl.host);
        assert.equal(migrationUrl.pathname, applicationUrl.pathname);
        const lockPool = new pg.Pool({ connectionString: migrationUrl.toString(), max: 1 });
        const locker = await lockPool.connect();
        try {
          await locker.query("BEGIN");
          await locker.query("LOCK TABLE occ.agents IN ACCESS EXCLUSIVE MODE");
          const started = Date.now();
          const blocked = await Promise.all(
            Array.from({ length: 4 }, () => fetch(`${listener.url}/metrics`)),
          );
          assert.ok(blocked.every((response) => response.status === 503));
          assert.ok(
            Date.now() - started < 3000,
            "concurrent scrapes must share bounded database work",
          );
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
          await lockPool.end();
        }
        assert.equal((await fetch(`${listener.url}/metrics`)).status, 200);
      },
    );
    // A real closed database pool must fail the whole scrape rather than emit old counts.
    await pool.end();
    poolClosed = true;
    assert.equal((await fetch(`${listener.url}/metrics`)).status, 503);
  },
);

// Use the actual pg pool with an in-process client so transport-event ownership
// is tested without a PostgreSQL listener, database, or credential.
function controlledMetricsPool() {
  let client;
  let resolveStarted;
  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const releases = [];
  const poolErrors = [];
  class ControlledClient extends EventEmitter {
    constructor() {
      super();
      client = this;
      this._queryable = true;
      this._ending = false;
    }
    connect(callback) {
      queueMicrotask(() => callback(null));
    }
    query() {
      return new Promise((resolve, reject) => {
        this.resolveQuery = resolve;
        this.rejectQuery = reject;
        resolveStarted();
      });
    }
    end(callback) {
      this._ending = true;
      queueMicrotask(() => callback?.());
    }
  }
  const pool = new pg.Pool({ Client: ControlledClient, max: 1, idleTimeoutMillis: 0 });
  pool.on("release", (error) => releases.push(error));
  pool.on("error", (error) => poolErrors.push(error));
  return {
    pool,
    started,
    releases,
    poolErrors,
    get client() {
      return client;
    },
  };
}

const controlledMetricsRow = Object.freeze({
  agents: { draft: 0, deploying: 0, running: 1, stopping: 0, stopped: 0, failed: 0 },
  pending: 0,
  oldestPendingAgeSeconds: 0,
});

// Starts a collection on a controlled pool client and waits for its query.
// `settle` ends that query at cleanup so the pool can close.
async function startCollection(t, settle) {
  const f = controlledMetricsPool();
  const operation = new PostgresMetricsSnapshot(f.pool).collect();
  operation.catch(() => {});
  await f.started;
  t.after(async () => {
    settle(f.client);
    await operation.catch(() => {});
    await f.pool.end();
  });
  return { f, operation };
}

// The collection discarded its only client and the pool saw no error.
function assertDiscarded(f) {
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.pool.totalCount, 0);
  assert.deepEqual(f.poolErrors, []);
}

// A collector whose pool hands out `client` directly.
function directCollector(client) {
  return new PostgresMetricsSnapshot({
    async connect() {
      return client;
    },
    async end() {},
  });
}

test("metrics owns checked-out transport errors until the rejected query settles", async (t) => {
  const { f, operation } = await startCollection(t, (client) =>
    client.rejectQuery(new Error("test cleanup")),
  );
  const transport = Object.assign(new Error("controlled transport event"), { code: "ECONNRESET" });
  const query = new Error("controlled query rejection");
  f.client.emit("error", transport);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releases.length, 0, "the in-flight query still owns its client");
  f.client.rejectQuery(query);
  await assert.rejects(operation, (error) => error === query);
  assertDiscarded(f);
});

test("metrics discards a transport-failed client even if its pending query later succeeds", async (t) => {
  const { f, operation } = await startCollection(t, (client) =>
    client.resolveQuery({ rows: [controlledMetricsRow] }),
  );
  const transport = new Error("controlled transport event before apparent success");
  f.client.emit("error", transport);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.releases.length, 0, "do not return a client with an unsettled query");
  f.client.resolveQuery({ rows: [controlledMetricsRow] });
  await assert.rejects(operation, (error) => error === transport);
  assertDiscarded(f);
});

test("metrics preserves ordinary query rejection and discards its client", async (t) => {
  const { f, operation } = await startCollection(t, (client) =>
    client.rejectQuery(new Error("test cleanup")),
  );
  const failure = new Error("controlled ordinary query rejection");
  f.client.rejectQuery(failure);
  await assert.rejects(operation, (error) => error === failure);
  assertDiscarded(f);
});

test("metrics returns a healthy client with only the pool's idle listener retained", async (t) => {
  const f = controlledMetricsPool();
  const operation = new PostgresMetricsSnapshot(f.pool).collect();
  await f.started;
  t.after(() => f.pool.end());
  f.client.resolveQuery({ rows: [controlledMetricsRow] });
  assert.deepEqual(await operation, controlledMetricsRow);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount("error"), 1);
  assert.equal(f.pool.idleCount, 1);
});

test("metrics rejects a transport event during pool handoff instead of returning a snapshot", async () => {
  const client = new EventEmitter();
  const transport = new Error("controlled transport event during release");
  const poolErrors = [];
  const releases = [];
  client.query = async () => ({ rows: [controlledMetricsRow] });
  client.release = (discard) => {
    releases.push(discard);
    client.on("error", (error) => poolErrors.push(error));
    client.emit("error", transport);
  };
  await assert.rejects(directCollector(client).collect(), (error) => error === transport);
  assert.deepEqual(releases, [false]);
  assert.deepEqual(poolErrors, [transport]);
  assert.equal(client.listenerCount("error"), 1);
  client.removeAllListeners();
});

test("metrics preserves a release failure and keeps error ownership when transfer is unknown", async () => {
  const client = new EventEmitter();
  const failure = new Error("controlled release failure");
  client.query = async () => ({ rows: [controlledMetricsRow] });
  client.release = () => {
    throw failure;
  };
  await assert.rejects(directCollector(client).collect(), (error) => error === failure);
  assert.equal(client.listenerCount("error"), 1);
  assert.doesNotThrow(() => client.emit("error", new Error("late client transport event")));
  client.removeAllListeners();
});

test("metrics preserves release error precedence when query and release both fail", async () => {
  const client = new EventEmitter();
  const queryFailure = new Error("controlled query failure");
  const releaseFailure = new Error("controlled release failure");
  client.query = async () => {
    throw queryFailure;
  };
  client.release = () => {
    throw releaseFailure;
  };
  await assert.rejects(directCollector(client).collect(), (error) => error === releaseFailure);
  assert.equal(client.listenerCount("error"), 1);
  assert.doesNotThrow(() => client.emit("error", new Error("late client transport event")));
  client.removeAllListeners();
});

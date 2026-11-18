import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import {
  metricsConfiguration,
  startMetricsListener,
} from "../../apps/controller/src/metrics/listener.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  AgentRevision,
  ComputeDriver,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import {
  createPostgresPool,
  PostgresMetricsSnapshot,
  type PlatformMetricsSnapshot,
  type PostgresClient,
} from "../../packages/occ/src/index.ts";
import { requiresPostgres, setup } from "../helpers/compute-singleton-worker.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import type { CleanupRegistrar } from "../helpers/console-file-app.ts";
import { waitFor } from "../helpers/wait-for.ts";

// The legacy fixtures expose wider shapes than this suite uses. Bind only the
// methods under test and use the platform types for their resource inputs.
type ConsoleMetricsFixture = {
  bootstrap(): Promise<unknown>;
  createNamespace(name: string): Promise<Pick<Namespace, "id">>;
  request(method: "GET", path: string, options?: { session: null }): Promise<{ status: number }>;
};
const setupConsoleMetrics: (
  context: CleanupRegistrar,
  options: { metrics: ReturnType<typeof createOccMetrics> },
) => Promise<ConsoleMetricsFixture> = createConsoleAppFixture;

type QueuedRevision = Pick<AgentRevision, "id"> & { idempotencyKey: string };
type WorkerMetricsFixture = {
  compute: ComputeDriver;
  agent(): Promise<Readonly<Agent>>;
  revision(agent: Readonly<Agent>, revision: number): Promise<QueuedRevision>;
  work(revision: QueuedRevision): Promise<unknown>;
  start(
    compute: ComputeDriver,
    leaseDurationMs?: ControllerWorkerOptions["leaseDurationMs"],
    convergenceTimeoutMs?: ControllerWorkerOptions["convergenceTimeoutMs"],
    mode?: ControllerWorkerOptions["mode"],
    emit?: () => void,
    metrics?: ControllerWorkerOptions["metrics"],
  ): Promise<void>;
  stop(): Promise<void>;
};
const setupWorkerMetrics: (context: TestContext) => Promise<WorkerMetricsFixture> = setup;

async function scrape(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
}

function sample(body: string, name: string, labels: Record<string, string>): number {
  const expected = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .sort();
  const values: number[] = [];
  for (const line of body.split("\n")) {
    const match = /^([^ {]+)(?:\{([^}]*)\})? (\S+)$/.exec(line);
    if (match?.[1] !== name) {
      continue;
    }
    const actual = match[2]?.split(",").sort() ?? [];
    if (
      actual.length === expected.length &&
      actual.every((label, index) => label === expected[index])
    ) {
      values.push(Number(match[3]));
    }
  }
  assert.equal(values.length, 1, `expected one ${name} sample with ${expected.join(",")}`);
  const value = values[0];
  assert.ok(value !== undefined && Number.isFinite(value), `invalid ${name} sample value`);
  return value;
}

test("API metrics follow real authenticated routes and keep replica registries isolated", async (t) => {
  const metrics = createOccMetrics("api");
  const other = createOccMetrics("api");
  const listener = await startMetricsListener(metrics, { host: "127.0.0.1", port: 0 });
  t.after(() => listener.close());
  const fixture = await setupConsoleMetrics(t, { metrics });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Metrics namespace");
  assert.equal((await fixture.request("GET", "/installation", { session: null })).status, 401);
  assert.equal((await fixture.request("GET", `/namespaces/${namespace.id}/agents`)).status, 200);
  assert.equal(
    (await fixture.request("GET", "/metrics-private-nonexistent?token=do-not-export")).status,
    404,
  );

  // Observe the real HTTP workflow from its independent scrape surface.
  const { status, body } = await scrape(`${listener.url}/metrics`);
  assert.equal(status, 200);
  const agentList = { route: "/namespaces/:namespaceId/agents", method: "GET", service: "api" };
  assert.equal(sample(body, "occ_http_requests_total", { ...agentList, status_class: "2xx" }), 1);
  assert.equal(
    sample(body, "occ_http_request_duration_seconds_bucket", { ...agentList, le: "+Inf" }),
    1,
  );
  assert.ok(sample(body, "occ_process_resident_memory_bytes", { service: "api" }) > 0);
  assert.equal(
    sample(body, "occ_http_requests_total", {
      route: "/installation",
      method: "GET",
      status_class: "4xx",
      service: "api",
    }),
    1,
  );
  assert.equal(
    sample(body, "occ_http_requests_total", {
      route: "unmatched",
      method: "GET",
      status_class: "4xx",
      service: "api",
    }),
    1,
  );
  assert.ok(!body.includes(namespace.id));
  assert.doesNotMatch(body, /do-not-export|metrics-private-nonexistent/);
  assert.doesNotMatch(await other.exposition(), /^occ_http_requests_total\{/m);
  assert.equal((await scrape(`${listener.url}/missing`)).status, 404);
  assert.equal((await scrape(`${listener.url}/metrics`, { method: "POST" })).status, 405);
  const occupied = { host: "127.0.0.1", port: Number(new URL(listener.url).port) };
  await assert.rejects(startMetricsListener(other, occupied), { code: "EADDRINUSE" });
  await listener.close();
  // Graceful close releases the port and can be called again by process cleanup.
  const replacement = await startMetricsListener(other, occupied);
  t.after(() => replacement.close());
  await listener.close();
  await replacement.close();
});

test("metrics settings reject exposed development binds and disabled stray settings", () => {
  assert.equal(metricsConfiguration({}, "development"), undefined);
  const cases: [NodeJS.ProcessEnv, RegExp][] = [
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
  ];
  for (const [environment, refusal] of cases) {
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
    const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
    assert.ok(databaseUrl);
    const fixture = await setupWorkerMetrics(t);
    const pool = await createPostgresPool(databaseUrl, {
      max: 1,
      connectionTimeoutMillis: 500,
      statement_timeout: 1500,
      query_timeout: 1500,
      options: "-c default_transaction_read_only=on",
    });
    let closing: Promise<void> | undefined;
    const closePool = () => (closing ??= pool.end());
    t.after(closePool);
    const mode = await pool.query<{ default_transaction_read_only: string }>(
      "SHOW default_transaction_read_only",
    );
    assert.deepEqual(mode.rows, [{ default_transaction_read_only: "on" }]);
    const snapshot = new PostgresMetricsSnapshot(pool);
    const a = createOccMetrics("worker", () => snapshot.collect());
    const before = await snapshot.collect();
    const deployment = { operation: "deploy", service: "worker" };
    assert.equal(
      sample(await a.exposition(), "occ_agent_operation_duration_seconds_count", deployment),
      0,
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
      } satisfies ComputeDriver,
      30_000,
      900_000,
      "production",
      undefined,
      a,
    );
    await fixture.work(first);
    assert.equal((await snapshot.collect()).agents.running, before.agents.running + 1);
    // A committed work row can be visible before the worker records its metrics.
    const firstMetrics = await waitFor("the worker to record the first deployment", async () => {
      const body = await a.exposition();
      return sample(body, "occ_agent_operation_duration_seconds_count", deployment) > 0
        ? body
        : undefined;
    });
    assert.equal(sample(firstMetrics, "occ_agent_operation_duration_seconds_count", deployment), 1);
    assert.ok(
      sample(firstMetrics, "occ_agent_operation_duration_seconds_sum", deployment) >= 0.05,
      "completion duration must include pre-claim queue time",
    );
    const second = await fixture.revision(agent, 2);
    await fixture.work(second);
    await fixture.stop();
    assert.equal((await snapshot.collect()).agents.running, before.agents.running + 1);

    // Both workers see the same shared state; it must never be summed across replicas.
    const b = createOccMetrics("worker", () => snapshot.collect());
    const listener = await startMetricsListener(a, { host: "127.0.0.1", port: 0 });
    t.after(() => listener.close());
    const metricsUrl = `${listener.url}/metrics`;
    const primary = await scrape(metricsUrl);
    assert.equal(primary.status, 200);
    const replica = await b.exposition();
    const expected = { ...before.agents, running: before.agents.running + 1 };
    for (const body of [primary.body, replica]) {
      assert.equal(body.split("\n").filter((line) => line.startsWith("occ_agents{")).length, 6);
      for (const [lifecycle_state, value] of Object.entries(expected)) {
        assert.equal(sample(body, "occ_agents", { lifecycle_state, service: "worker" }), value);
      }
    }
    assert.equal(sample(primary.body, "occ_agent_operation_duration_seconds_count", deployment), 2);
    const work = { work_kind: "agent_revision", service: "worker" };
    assert.equal(
      sample(primary.body, "occ_reconciliation_attempts_total", { ...work, outcome: "success" }),
      2,
    );
    assert.equal(
      sample(primary.body, "occ_reconciliation_attempt_duration_seconds_count", work),
      3,
    );

    // Real table contention times out all overlapping scrapes together. Once the
    // lock is released, the next scrape must recover without stale fallback.
    const migrationDatabaseUrl = process.env.OCC_METRICS_TEST_MIGRATION_DATABASE_URL;
    await t.test(
      "real table contention fails overlapping scrapes and recovers",
      {
        skip: migrationDatabaseUrl
          ? false
          : "Set OCC_METRICS_TEST_MIGRATION_DATABASE_URL for table-lock failure proof.",
      },
      async () => {
        assert.ok(migrationDatabaseUrl);
        const migrationUrl = new URL(migrationDatabaseUrl);
        const applicationUrl = new URL(databaseUrl);
        assert.equal(migrationUrl.host, applicationUrl.host);
        assert.equal(migrationUrl.pathname, applicationUrl.pathname);
        assert.notEqual(migrationUrl.username, applicationUrl.username);
        const lockPool = new pg.Pool({
          connectionString: migrationUrl.toString(),
          max: 1,
          connectionTimeoutMillis: 2_000,
          statement_timeout: 3_000,
        });
        try {
          const locker = await lockPool.connect();
          try {
            await locker.query("BEGIN");
            await locker.query("LOCK TABLE occ.agents IN ACCESS EXCLUSIVE MODE");
            const started = performance.now();
            const blocked = await Promise.all(
              Array.from({ length: 4 }, () =>
                scrape(metricsUrl, { signal: AbortSignal.timeout(3_000) }),
              ),
            );
            assert.deepEqual(
              blocked.map(({ status }) => status),
              [503, 503, 503, 503],
            );
            assert.ok(
              performance.now() - started < 3_000,
              "concurrent scrapes must share bounded database work",
            );
          } finally {
            // A broken transaction must not strand the checked-out client or the lock.
            try {
              await locker.query("ROLLBACK");
            } finally {
              locker.release(true);
            }
          }
        } finally {
          await lockPool.end();
        }
        assert.equal((await scrape(metricsUrl)).status, 200);
      },
    );
    // A real closed database pool must fail the whole scrape rather than emit old counts.
    await closePool();
    assert.equal((await scrape(metricsUrl)).status, 503);
  },
);

type MetricsQueryResult = { rows: PlatformMetricsSnapshot[]; rowCount: number };

function metricsRows(...rows: PlatformMetricsSnapshot[]): MetricsQueryResult {
  return { rows, rowCount: rows.length };
}

// The real pg.Pool owns release and its idle listener. Intercept just the
// network connect and query so the fault cases can control transport timing.
function controlledMetricsPool(t: TestContext) {
  const started = Promise.withResolvers<void>();
  const query = Promise.withResolvers<MetricsQueryResult>();
  let client: pg.Client | undefined;
  const releases: (Error | boolean | undefined)[] = [];
  const poolErrors: Error[] = [];
  class ControlledClient extends pg.Client {
    constructor(config?: pg.ClientConfig) {
      super(config);
      t.mock.method(
        this,
        "connect",
        (callback: (error: null, client: pg.Client) => void) =>
          queueMicrotask(() => callback(null, this)),
        {},
      );
      t.mock.method(
        this,
        "query",
        () => {
          started.resolve();
          return query.promise;
        },
        {},
      );
    }
  }
  const pool = new pg.Pool({ Client: ControlledClient, max: 1, idleTimeoutMillis: 0 });
  pool.on("connect", (connectedClient: pg.Client) => {
    client = connectedClient;
  });
  pool.on("release", (error: Error | boolean | undefined) => releases.push(error));
  pool.on("error", (error: Error) => poolErrors.push(error));
  const operation = new PostgresMetricsSnapshot(pool).collect();
  const settled = operation.catch(() => {});
  t.after(async () => {
    query.resolve(metricsRows());
    await settled;
    await pool.end();
  });
  return {
    pool,
    started: Promise.race([started.promise, operation]),
    query,
    operation,
    releases,
    poolErrors,
    get client() {
      assert.ok(client, "pool must have created a client");
      return client;
    },
  };
}

const controlledMetricsRow: PlatformMetricsSnapshot = Object.freeze({
  agents: { draft: 0, deploying: 0, running: 1, stopping: 0, stopped: 0, failed: 0 },
  pending: 0,
  oldestPendingAgeSeconds: 0,
});

function assertDiscarded(f: ReturnType<typeof controlledMetricsPool>) {
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.pool.totalCount, 0);
  assert.deepEqual(f.poolErrors, []);
}

// These cases drive the collector's synchronous handoff boundary without pg.
function directCollector(client: PostgresClient) {
  return new PostgresMetricsSnapshot({
    async connect() {
      return client;
    },
    async end() {},
  });
}

test("metrics owns checked-out transport errors until the rejected query settles", async (t) => {
  const f = controlledMetricsPool(t);
  await f.started;
  const transport = Object.assign(new Error("controlled transport event"), { code: "ECONNRESET" });
  const query = new Error("controlled query rejection");
  f.client.emit("error", transport);
  await setImmediate();
  assert.equal(f.releases.length, 0, "the in-flight query still owns its client");
  f.query.reject(query);
  await assert.rejects(f.operation, (error) => error === query);
  assertDiscarded(f);
});

test("metrics discards a transport-failed client even if its pending query later succeeds", async (t) => {
  const f = controlledMetricsPool(t);
  await f.started;
  const transport = new Error("controlled transport event before apparent success");
  f.client.emit("error", transport);
  await setImmediate();
  assert.equal(f.releases.length, 0, "do not return a client with an unsettled query");
  f.query.resolve(metricsRows(controlledMetricsRow));
  await assert.rejects(f.operation, (error) => error === transport);
  assertDiscarded(f);
});

test("metrics preserves ordinary query rejection and discards its client", async (t) => {
  const f = controlledMetricsPool(t);
  await f.started;
  const failure = new Error("controlled ordinary query rejection");
  f.query.reject(failure);
  await assert.rejects(f.operation, (error) => error === failure);
  assertDiscarded(f);
});

test("metrics refuses a missing Installation and discards its client", async (t) => {
  const f = controlledMetricsPool(t);
  await f.started;
  const listenersBeforeRelease: readonly unknown[] = f.client.listeners("error");
  assert.equal(listenersBeforeRelease.length, 1, "the collector owns the checked-out listener");
  const [collectorListener] = listenersBeforeRelease;
  assert.equal(typeof collectorListener, "function");
  f.query.resolve(metricsRows());
  await assert.rejects(f.operation, { message: "Metrics require the singleton Installation." });
  assertDiscarded(f);
  // The pool owns its listener after release. The collector must remove its own.
  const listenersAfterRelease: readonly unknown[] = f.client.listeners("error");
  assert.ok(!listenersAfterRelease.includes(collectorListener));
});

test("metrics returns a healthy client with only the pool's idle listener retained", async (t) => {
  const f = controlledMetricsPool(t);
  await f.started;
  f.query.resolve(metricsRows(controlledMetricsRow));
  assert.deepEqual(await f.operation, controlledMetricsRow);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount("error"), 1);
  assert.equal(f.pool.idleCount, 1);
});

type TransportEvents = { error: [Error] };

test("metrics rejects a transport event during pool handoff instead of returning a snapshot", async () => {
  const transport = new Error("controlled transport event during release");
  const poolErrors: Error[] = [];
  const releases: (boolean | undefined)[] = [];
  const events = new EventEmitter<TransportEvents>();
  const client = Object.assign(events, {
    async query() {
      return metricsRows(controlledMetricsRow);
    },
    release(discard?: boolean) {
      releases.push(discard);
      events.on("error", (error: Error) => poolErrors.push(error));
      events.emit("error", transport);
    },
  });
  await assert.rejects(directCollector(client).collect(), (error) => error === transport);
  assert.deepEqual(releases, [false]);
  assert.deepEqual(poolErrors, [transport]);
  assert.equal(client.listenerCount("error"), 1);
  client.removeAllListeners();
});

test("metrics preserves a release failure and keeps error ownership when transfer is unknown", async () => {
  const failure = new Error("controlled release failure");
  const client = Object.assign(new EventEmitter<TransportEvents>(), {
    async query() {
      return metricsRows(controlledMetricsRow);
    },
    release() {
      throw failure;
    },
  });
  await assert.rejects(directCollector(client).collect(), (error) => error === failure);
  assert.equal(client.listenerCount("error"), 1);
  assert.doesNotThrow(() => client.emit("error", new Error("late client transport event")));
  client.removeAllListeners();
});

test("metrics preserves release error precedence when query and release both fail", async () => {
  const queryFailure = new Error("controlled query failure");
  const releaseFailure = new Error("controlled release failure");
  const client = Object.assign(new EventEmitter<TransportEvents>(), {
    async query() {
      throw queryFailure;
    },
    release() {
      throw releaseFailure;
    },
  });
  await assert.rejects(directCollector(client).collect(), (error) => error === releaseFailure);
  assert.equal(client.listenerCount("error"), 1);
  assert.doesNotThrow(() => client.emit("error", new Error("late client transport event")));
  client.removeAllListeners();
});

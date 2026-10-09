import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import { repositoryAttempts } from "../helpers/postgres-worker-revision-support.mjs";

// Worker health, readiness, leases and outages, and exclusive replacement. Withdrawal,
// deployment and dispatch cases are in postgres-worker-agent-revision.test.mjs; repository
// sessions, Agent stop and deletion, and Namespace teardown are in
// postgres-worker-agent-revision-teardown.test.mjs. The lane runs the three files at once.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

test(
  "worker fixture disposal preserves another database's live claim and activation",
  requiresPostgres,
  async (context) => {
    const first = await setup(context);
    const firstOwner = await first.agent("isolated-first");
    await first.revision(firstOwner, 1);
    const second = await setup(context);
    const queue = new second.PostgresWorkQueue(second.observerPool);
    assert.equal(await queue.claim(), undefined, "workers cannot claim another fixture's work");

    const owner = await second.agent("isolated-second");
    const candidate = await second.revision(owner, 1);
    const release = Promise.withResolvers();
    let preparing = false;
    try {
      await second.start({
        ...second.compute,
        async prepareRevision(revision) {
          preparing = true;
          await release.promise;
          return second.compute.prepareRevision(revision);
        },
      });
      await waitFor("second fixture to hold its claim during preparation", async () =>
        preparing ? true : undefined,
      );
      const before = await second.work(candidate, "claimed");
      assert.equal(typeof before.claim_token, "string");

      await first.database.dispose();
      const renewed = await queue.heartbeat({
        idempotencyKey: candidate.idempotencyKey,
        claimToken: before.claim_token,
      });
      assert.equal(renewed?.claimToken, before.claim_token);
      release.resolve();
      await second.work(candidate, "succeeded");
      const activated = await second.currentAgent(owner);
      assert.equal(activated.activeRevisionId, candidate.id);
    } finally {
      // Release Compute before the registered owner teardown joins its worker.
      release.resolve();
    }
  },
);

// The worker is serial. A Compute wait that only saves a later pass asks whether
// other Work is waiting and ends early when it is, so another Agent's deploy
// runs next instead of queuing behind the wait (D221).
test(
  "a revision pass learns when another Agent's Work is waiting for the serial worker",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const { computeWorkWaiting } =
      await import("../../apps/controller/src/drivers/compute/operation-context.ts");
    const fixture = await setup(context);
    const first = await fixture.agent("waiting-first", { executionMode: "dedicated" });
    const second = await fixture.agent("waiting-second", { executionMode: "dedicated" });
    const prepared = [];
    let secondRevision;
    let wait;
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        prepared.push(revision.agentId);
        if (revision.agentId !== first.id || wait !== undefined) {
          return fixture.compute.prepareRevision(revision, deploymentContext);
        }
        // The first Agent's pass waits, as for its node to pair; nothing else is
        // queued yet, so nothing is waiting for the worker.
        const before = await computeWorkWaiting();
        secondRevision = await fixture.revision(second, 1);
        const started = Date.now();
        let endedEarly = false;
        while (Date.now() - started < 10_000) {
          if (await computeWorkWaiting()) {
            endedEarly = true;
            break;
          }
          await delay(25);
        }
        wait = { before, endedEarly, ms: Date.now() - started };
        return {
          ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
          ready: false,
        };
      },
    };
    await fixture.start(compute);
    const firstRevision = await fixture.revision(first, 1);
    await waitFor("the second Agent to deploy during the first pass", async () => secondRevision);
    await fixture.work(secondRevision, "succeeded");
    await fixture.work(firstRevision, "succeeded");
    assert.equal(wait.before, false, "the pass's own Agent is not other Work");
    assert.equal(wait.endedEarly, true);
    assert.ok(wait.ms < 5_000, `the wait ended early (${wait.ms} ms)`);
    // The pending first pass ended and the second Agent's pass ran next.
    assert.deepEqual(prepared.slice(0, 2), [first.id, second.id]);
  },
);

revisionTest(
  "exclusive replacement blocks overlap, supersedes old maintenance and recovers through a new revision",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-workspace", { executionMode: "dedicated" });
    const running = new Set();
    const prepared = [];
    let rejectStop = true;
    let stopFailures = 0;
    const compute = {
      ...fixture.compute,
      requiresStoppedPredecessors: () => true,
      async prepareRevision(revision) {
        // This Driver boundary represents a resource which cannot be held by
        // two revisions. PostgreSQL and the real worker own ordering and retries.
        assert.deepEqual(
          [...running].filter((id) => id !== revision.id),
          [],
        );
        running.add(revision.id);
        prepared.push(revision.id);
        return {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: revision.revision !== 2,
        };
      },
      async stopRevision(revision) {
        if (rejectStop && running.has(revision.id)) {
          rejectStop = false;
          stopFailures += 1;
          throw new Error("resource release temporarily unavailable");
        }
        running.delete(revision.id);
      },
      async retireRevision(revision) {
        running.delete(revision.id);
      },
    };
    await fixture.start(compute, { convergenceTimeoutMs: 3_000 });
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await waitFor("replacement preparation after predecessor release", async () =>
      running.has(replacement.id) ? true : undefined,
    );
    assert.equal(stopFailures, 1);
    const firstPreparations = prepared.filter((id) => id === first.id).length;
    const maintenance = {
      id: first.id,
      idempotencyKey: `agent_revision:${first.id}:maintenance:${randomUUID()}`,
    };
    await fixture.state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey: maintenance.idempotencyKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: first.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      }),
    );
    await fixture.work(maintenance, "succeeded");
    assert.equal(prepared.filter((id) => id === first.id).length, firstPreparations);
    await fixture.work(replacement, "failed_permanent");
    assert.deepEqual([...running], [replacement.id]);
    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.deepEqual([...running], [recovery.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, recovery.id);
  },
  { timeout: 30_000 },
);

function countingExclusiveCompute(fixture, { ready, onPrepare } = {}) {
  const running = new Set();
  const prepared = [];
  const stops = new Map();
  const compute = {
    ...fixture.compute,
    requiresStoppedPredecessors: () => true,
    async prepareRevision(revision) {
      const overlap = [...running].filter((id) => id !== revision.id);
      running.add(revision.id);
      prepared.push(revision.id);
      await onPrepare?.(revision, overlap);
      // The candidate cannot become ready while any predecessor still runs.
      const exclusive = [...running].every((id) => id === revision.id);
      return {
        ...(await fixture.compute.prepareRevision(revision)),
        ready: exclusive && (ready?.(revision) ?? true),
      };
    },
    async stopRevision(revision) {
      stops.set(revision.id, (stops.get(revision.id) ?? 0) + 1);
      running.delete(revision.id);
    },
    async retireRevision(revision) {
      running.delete(revision.id);
    },
  };
  const count = (revision) => stops.get(revision.id) ?? 0;
  const preparations = (revision) => prepared.filter((id) => id === revision.id).length;
  return { compute, running, count, preparations };
}

async function enqueueMaintenance(fixture, owner, revision) {
  const maintenance = {
    id: revision.id,
    idempotencyKey: `agent_revision:${revision.id}:maintenance:${randomUUID()}`,
  };
  await fixture.state.transactWithQueue((_unit, queue) =>
    queue.enqueue({
      idempotencyKey: maintenance.idempotencyKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: revision.id,
      actorId: fixture.actor.id,
      availableAt: new Date(0),
    }),
  );
  return maintenance;
}

revisionTest(
  "exclusive replacement stops each predecessor once across pending passes and maintenance",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-sweep-once", { executionMode: "dedicated" });
    let pendingPasses = 4;
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.revision !== 2 || pendingPasses-- <= 0,
    });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await fixture.work(replacement, "succeeded", 30_000);
    assert.ok(driver.preparations(replacement) >= 5, "the replacement must repeat pending passes");
    // Exactly one stop holds because the fixture lease (30 s) outlasts this pending
    // window; with a shorter lease the scheduled re-stop would add more.
    assert.equal(driver.count(first), 1, "pending passes must not repeat the predecessor stop");

    for (let index = 0; index < 2; index += 1) {
      await fixture.work(await enqueueMaintenance(fixture, owner, replacement), "succeeded");
    }
    assert.equal(driver.count(first), 1, "maintenance must not repeat the predecessor stop");

    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.equal(driver.count(replacement), 1);
    assert.equal(driver.count(first), 1, "a recorded predecessor is skipped by later sweeps");
    assert.deepEqual([...driver.running], [recovery.id]);
  },
  { timeout: 60_000 },
);

test(
  "a predecessor that comes back after the sweep is stopped again",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    for (const { leaseDurationMs, label, returns } of [
      // A late Compute effect makes the next pass fail, which forgets the record.
      { leaseDurationMs: 30_000, label: "failed-pass", returns: 1 },
      // A late effect keeps the candidate pending until one lease has elapsed.
      { leaseDurationMs: 1_000, label: "lease-restop", returns: 1 },
      // It comes back again after that re-stop; the next one follows two leases later.
      { leaseDurationMs: 1_000, label: "repeated-restop", returns: 2 },
    ]) {
      const fixture = await setup(context, { leaseDurationMs });
      const owner = await fixture.agent(`exclusive-resurrection-${label}`, {
        executionMode: "dedicated",
      });
      let first;
      let resurrections = 0;
      const driver = countingExclusiveCompute(fixture, {
        async onPrepare(revision, overlap) {
          if (revision.revision !== 2) {
            return;
          }
          if (resurrections < returns && driver.count(first) > resurrections) {
            // Model a lost claim's late Compute write landing after each stop.
            resurrections += 1;
            driver.running.add(first.id);
          } else if (overlap.length > 0 && label === "failed-pass") {
            driver.running.delete(revision.id);
            throw new Error("predecessor still holds the exclusive resource");
          }
        },
      });
      await fixture.start(driver.compute);
      first = await fixture.revision(owner, 1);
      await fixture.work(first, "succeeded");
      const replacement = await fixture.revision(owner, 2);
      await fixture.work(replacement, "succeeded", 30_000);
      assert.equal(resurrections, returns);
      assert.equal(
        driver.count(first),
        returns + 1,
        `${label}: the returned predecessor is stopped again`,
      );
      assert.deepEqual([...driver.running], [replacement.id]);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, replacement.id);
      await fixture.stop();
    }
  },
);

test(
  "worker readiness remains available when repository credentials are disabled",
  requiresPostgres,
  async (context) => {
    let healthy = false;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy = true;
      },
    });
    const { candidate } = await fixture.admitInitialRevision("no-repository-capability");
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    await waitFor("repository-disabled worker readiness", async () => (healthy ? true : undefined));
  },
);

/**
 * Relay PostgreSQL connections through a local proxy that can go silent: it stops relaying on
 * every open connection without closing it, as a client sees after a failover or partition
 * that sent no RST. New connections still reach the server.
 */
async function startSilenceableProxy(context, databaseUrl) {
  const { createServer, connect } = await import("node:net");
  const target = new URL(databaseUrl);
  const pairs = new Set();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    const pair = { client, upstream };
    pairs.add(pair);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on("error", close);
      socket.on("close", close);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    for (const { client, upstream } of pairs) {
      client.destroy();
      upstream.destroy();
    }
    return new Promise((resolve) => server.close(resolve));
  };
  context.after(close);
  const url = new URL(databaseUrl);
  url.hostname = "127.0.0.1";
  url.port = String(server.address().port);
  return {
    url: url.toString(),
    silence() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    close,
  };
}

test(
  "a worker abandons a query on a silent database connection and resumes work",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const [{ Pool }, { workerDatabasePoolOptions }] = await Promise.all([
      import("pg"),
      import("../../apps/controller/src/worker.ts"),
    ]);
    const fixture = await setup(context);
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    const pool = new Pool({
      connectionString: proxy.url,
      ...workerDatabasePoolOptions(3_000),
      max: 2,
    });
    fixture.database.pools.add(pool);
    const { candidate: before } = await fixture.admitInitialRevision("before-silence");
    await fixture.start(fixture.compute, { pool });
    await fixture.work(before, "succeeded");

    // Every pooled connection now swallows queries without an answer or an error.
    proxy.silence();
    const { candidate: after } = await fixture.admitInitialRevision("after-silence");
    await fixture.work(after, "succeeded", 30_000);
    await fixture.stop();
    await proxy.close();
  },
);

test(
  "worker progress continues through a database outage and stops when the loop is stuck",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const { Pool } = await import("pg");
    let progressed = 0;
    const fixture = await setup(context, {
      onProgress: async () => {
        progressed += 1;
      },
    });
    const proxy = await startSilenceableProxy(context, fixture.database.url);
    // No query timeout: this isolates the liveness signal from the timeout that would unstick it.
    const pool = new Pool({ connectionString: proxy.url, max: 1 });
    fixture.database.pools.add(pool);
    pool.on("error", () => {});
    await fixture.start(fixture.compute, { pool });
    await waitFor("idle worker progress", async () => (progressed >= 2 ? true : undefined));

    proxy.silence();
    // A negative check needs a fixed window. Progress is reported at most once per second
    // here (pollIntervalMs 15), so 1.5 s lets an in-flight pass settle and 3 s spans three
    // reports a moving loop would have made.
    await delay(1_500);
    const stuck = progressed;
    await delay(3_000);
    assert.equal(
      progressed,
      stuck,
      "a worker stuck on a silent query must stop reporting progress",
    );

    // Refused connections fail each pass fast; the loop still moves, so liveness holds.
    await proxy.close();
    await waitFor("progress through a database outage", async () =>
      progressed >= stuck + 2 ? true : undefined,
    );
    await fixture.stop();
  },
);

test(
  "worker readiness and fresh Agent admission require the broker capability",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    let healthy = 0;
    const fixture = await setup(context, {
      onHealthy: async () => {
        healthy += 1;
      },
    });
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
      { startRepositoryReceiptServer },
      { startControlResponseRelay },
      { createResourceScope },
      { dirname },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
      import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts"),
      import("../fixtures/repository-credentials/control-relay.mjs"),
      import("../fixtures/repository-credentials/resources.mjs"),
      import("node:path"),
    ]);
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      clock: { ...createControlledClock(), wallNow: Date.now },
      gateway: { listen: "127.0.0.1:0" },
    });
    const scope = createResourceScope();
    context.after(() => scope.close());
    const relay = await startControlResponseRelay(scope, {
      directory: dirname(credentials.config.gateway.controlSocket),
      target: credentials.config.gateway.controlSocket,
    });
    // Simulate the old broker's 404 while all other traffic still reaches the real service.
    relay.setCapabilitiesHidden(true);
    const driver = new GitHubRepoDriver(
      {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({ controlSocket: relay.socketPath }),
        drivers: { repo: "repository-credentials" },
      },
      credentials.registry,
      { sessionDurationSeconds: 60, publicCa: credentials.tls.ca },
    );
    const receiptServer = await startRepositoryReceiptServer({
      state: fixture.state,
      controlSocket: credentials.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: credentials.backendId,
    });
    context.after(() => receiptServer.close());
    const resolution = driver.resolve({
      namespaceId: fixture.namespace.id,
      bindings: [{ repositoryRef: "repo-a", profile: "git-read" }],
    });
    const owner = await fixture.agent("repository-capability");
    const selection = {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs: Date.now() + 120_000,
      bindings: resolution.bindings,
    };
    const incompatible = await fixture.revision(owner, 1, { repositoryCredentials: selection });
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials() {},
      },
      {
        pool: fixture.workerPool,
        transformDrivers: (drivers) => ({ ...drivers, repoDriver: driver }),
      },
    );
    // Four jittered retry delays can total nearly 15 seconds before the fifth claim.
    await fixture.work(incompatible, "failed_permanent", 20_000);
    assert.equal(healthy, 0);
    assert.deepEqual(await repositoryAttempts(fixture, incompatible), []);
    assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    // Restoring the real capability permits an explicit new revision.
    relay.setCapabilitiesHidden(false);
    await waitFor("worker readiness after compatible broker selection", async () =>
      healthy > 0 ? true : undefined,
    );
    const open = driver.open.bind(driver);
    let lostSessionId;
    driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (lostSessionId === undefined && result.kind === "created") {
        lostSessionId = result.session.sessionId;
        // The response is lost after the broker creates a session, then the
        // capability disappears before recovery gets another worker claim.
        relay.setCapabilitiesHidden(true);
        throw new Error("repository admission response lost after creation");
      }
      return result;
    };
    const uncertain = await fixture.revision(owner, 2, { repositoryCredentials: selection });
    await fixture.work(uncertain, "failed_permanent", 20_000);
    assert.ok(lostSessionId);
    await waitFor("lost session disposal after work failure", async () =>
      (await repositoryAttempts(fixture, uncertain)).find(
        ({ sessionId }) => sessionId === lostSessionId,
      )?.phase === "disposed"
        ? true
        : undefined,
    );
    assert.equal((await repositoryAttempts(fixture, uncertain)).length, 1);
    // Recovery and disposal ran while capability was absent; fresh material
    // requires restoring it and explicitly admitting another revision.
    relay.setCapabilitiesHidden(false);
    const compatible = await fixture.revision(owner, 3, { repositoryCredentials: selection });
    await fixture.work(compatible, "succeeded");
    assert.equal(
      (await repositoryAttempts(fixture, compatible)).filter(({ phase }) => phase === "open")
        .length,
      1,
    );
    // Losing the capability again must not gate the real stop and cleanup paths.
    relay.setCapabilitiesHidden(true);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    await waitFor("repository cleanup despite the missing capability", async () =>
      (await repositoryAttempts(fixture, compatible)).every(({ phase }) => phase === "disposed")
        ? true
        : undefined,
    );
  },
);

test(
  "worker health remains current while a Compute operation holds a renewed PostgreSQL lease",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const { candidate } = await fixture.admitInitialRevision("long-compute-health");
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          entered.resolve();
          await release.promise;
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    try {
      await entered.promise;
      const healthCount = () => events.filter(({ event }) => event === "worker.health").length;
      const before = healthCount();
      // A busy worker must report fresh database health before Compute returns,
      // not only after completion. The real queue continues renewing its lease.
      await waitFor("health observations during the unfinished Compute operation", async () =>
        healthCount() >= before + 2 ? true : undefined,
      );
      const claimed = await fixture.work(candidate, "claimed");
      assert.equal(claimed.attempt_count, 1);
    } finally {
      release.resolve();
    }
    await fixture.work(candidate, "succeeded");
  },
);

for (const slowCall of [1, 2]) {
  test(
    `slow health update ${slowCall} does not block Compute or PostgreSQL lease renewal`,
    requiresPostgres,
    async (context) => {
      const healthEntered = Promise.withResolvers();
      const releaseHealth = Promise.withResolvers();
      const releaseCompute = Promise.withResolvers();
      let healthCalls = 0;
      // Renewals run every third of the lease. A 4.5 s lease survives a busy CI host's late
      // renewal; a 1.2 s one expired under load (finding 870).
      const fixture = await setup(context, {
        leaseDurationMs: 4_500,
        async onHealthy() {
          if (++healthCalls !== slowCall) {
            return;
          }
          healthEntered.resolve();
          await releaseHealth.promise;
        },
      });
      const { owner, candidate } = await fixture.admitInitialRevision("slow-health");
      const events = [];
      let preparing = false;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            preparing = true;
            await releaseCompute.promise;
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        { emit: (event) => events.push(event) },
      );
      try {
        await healthEntered.promise;
        // Cover both the health update before the first effect and one started
        // during Compute. Neither may hold the claim's renewal chain hostage.
        await waitFor("Compute to start despite the pending health update", async () =>
          preparing ? true : undefined,
        );
        const original = await fixture.work(candidate, "claimed");
        // Count renewals instead of sampling the lease once: the same claim must be renewed
        // three times while the health update is still pending, however late each renewal
        // runs. Preparation nests two renewal chains, and each renews once before a chain that
        // waited on the health update would stop.
        const lease = async () => {
          const { rows } = await fixture.observerPool.query(
            `SELECT claim_token, attempt_count, lease_expires_at,
                    lease_expires_at > clock_timestamp() AS live
             FROM occ.controller_work WHERE idempotency_key = $1`,
            [candidate.idempotencyKey],
          );
          return rows[0];
        };
        let renewals = 0;
        let expiresAt = (await lease()).lease_expires_at.getTime();
        const renewed = await waitFor(
          "three lease renewals during the pending health update",
          async () => {
            const current = await lease();
            assert.ok(current.live, "the lease must not lapse while the health update is pending");
            if (current.lease_expires_at.getTime() > expiresAt) {
              renewals += 1;
              expiresAt = current.lease_expires_at.getTime();
            }
            return renewals >= 3 ? current : undefined;
          },
          30_000,
        );
        assert.deepEqual(
          { claim_token: renewed.claim_token, attempt_count: renewed.attempt_count },
          { claim_token: original.claim_token, attempt_count: 1 },
        );
        assert.equal(healthCalls, slowCall, "health updates must not overlap");
      } finally {
        releaseHealth.resolve();
        releaseCompute.resolve();
      }
      // A worker that gave up the claim reports it only once Compute returns.
      const done = await fixture.work(candidate, "succeeded");
      assert.equal(done.attempt_count, 1);
      assert.equal(
        events.some(({ code }) => code === "CLAIM_LOST"),
        false,
      );
      const active = await fixture.currentAgent(owner);
      assert.equal(active.activeRevisionId, candidate.id);
    },
  );
}

test(
  "failed readiness updates do not abort Compute or spend its retry budget",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, {
      leaseDurationMs: 1_200,
      async onHealthy() {
        throw new Error("readiness sink unavailable");
      },
    });
    const { candidate } = await fixture.admitInitialRevision("failed-health");
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          await delay(2_600);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      { emit: (event) => events.push(event) },
    );
    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(completed.attempt_count, 1);
    assert.ok(events.some(({ code }) => code === "HEALTH_UNAVAILABLE"));
    assert.equal(
      events.some(({ code }) => code === "CLAIM_LOST"),
      false,
    );
    assert.equal(
      events.some(({ event }) => event === "worker.health"),
      false,
    );
  },
);

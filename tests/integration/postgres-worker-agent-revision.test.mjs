import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  authorizedPrincipal,
  cleanupProviderFixtures,
  createAccessTokenServiceAccount,
  createProviderWorkerDrivers,
  createProviderController,
  databaseUrl,
  ensureInstallation,
  poolWithOneProviderBindingReadFault,
  providerDefinition,
  requiresPostgres,
  seedProviderBinding,
  waitFor,
} from "../helpers/postgres-provider-state.mjs";

async function setup(context, { leaseDurationMs = 30_000, onHealthy } = {}) {
  const [
    { Pool },
    { createControllerWorker },
    { createDevelopmentComputeDriver },
    { DEVELOPMENT_HARNESS_DESCRIPTOR, PRODUCTION_HARNESS_DESCRIPTOR },
    { PostgresPlatformState },
    { PostgresWorkQueue },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("../helpers/development.mjs"),
    import("../../apps/controller/src/composition/production-harness.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
  ]);
  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const createWorkerPool = () => new Pool({ connectionString: databaseUrl, max: 1 });
  const workerPool = createWorkerPool();
  const state = new PostgresPlatformState(observerPool);
  const installation = await ensureInstallation(state, "revision-worker");
  const actor = authorizedPrincipal(await state.loadNativeIAMState());
  assert.ok(actor, "persisted IAM must contain an unrestricted Agent-deploy Principal");

  let worker;
  context.after(async () => {
    if (worker === undefined) {
      await workerPool.end();
    } else {
      await worker.stop();
    }
    await observerPool.end();
  });

  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `revision-worker-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await state.transact((unit) => unit.namespaces.createNamespace(namespace));
  const compute = createDevelopmentComputeDriver();
  const controller = createProviderController({ installation, state }, { providers: [] });
  const secretDriver = createProviderWorkerDrivers(compute, []).secretDriver;
  const secretRoleId = `role-${randomUUID()}`;
  await observerPool.query(
    `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      secretRoleId,
      namespace.id,
      `Harness Secrets ${randomUUID()}`,
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );

  async function agent(
    label,
    executionMode = "embedded",
    serviceAccountId,
    providerId = null,
    grantHarnessSecret = true,
    runtimeAuth = false,
  ) {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    let harnessAuth;
    if (runtimeAuth) {
      harnessAuth = { method: "runtime" };
    } else if (serviceAccountId === undefined) {
      const identity = {
        id: `sec_${randomUUID()}`,
        namespaceId: namespace.id,
        name: `key-${randomUUID()}`,
      };
      const backendRef = await secretDriver.create(identity, "worker-fixture-key");
      await state.transact((unit) =>
        unit.secrets.createSecret({
          ...identity,
          driverId: secretDriver.id,
          backendRef,
          createdAt: new Date().toISOString(),
        }),
      );
      harnessAuth = {
        method: "api_key",
        source: { kind: "secret", namespaceId: namespace.id, id: identity.id },
      };
    } else {
      harnessAuth = { method: "chatgpt_service_account", serviceAccountId };
    }
    const owner = await state.transact(async (unit) => {
      await unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        createdAt: new Date().toISOString(),
      });
      return unit.agents.createAgent({
        id,
        namespaceId: namespace.id,
        name: `${label}-${randomUUID()}`,
        configurationId,
        providerId,
        harnessAuth,
        executionMode,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
    if (harnessAuth.method === "api_key" && grantHarnessSecret) {
      await observerPool.query(
        `INSERT INTO occ.iam_access_bindings
          (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, $2, $3, NULL, $4, 'secret', $5)`,
        [
          `binding-${randomUUID()}`,
          namespace.id,
          owner.servicePrincipalId,
          secretRoleId,
          harnessAuth.source.id,
        ],
      );
    }
    return owner;
  }

  async function revision(owner, number, harness) {
    let harnessAuth;
    if (owner.harnessAuth.method === "runtime") {
      harnessAuth = owner.harnessAuth;
    } else if (owner.harnessAuth.method === "chatgpt_service_account") {
      const account = await state.read((view) =>
        view.serviceAccounts.findServiceAccount(namespace.id, owner.harnessAuth.serviceAccountId),
      );
      const providerBinding = await state.read((view) =>
        view.serviceAccounts.findServiceAccountProviderBinding(namespace.id, account.id),
      );
      harnessAuth = { ...owner.harnessAuth, credential: account.credential, providerBinding };
    } else {
      harnessAuth = { ...owner.harnessAuth, secretDriverId: secretDriver.id };
    }
    const approvedHarness =
      harness ??
      (owner.executionMode === "dedicated"
        ? { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" }
        : { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" });
    const candidate = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: number,
      providerId: owner.providerId,
      configuration: { revision: String(number) },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      harness: approvedHarness,
      compute: { id: compute.id, implementation: compute.implementation },
      harnessAuth,
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.revisions.createRevision(candidate);
      await unit.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        owner.id,
        ["stopped", "running"],
        "running",
      );
      await queue.enqueue({
        idempotencyKey,
        namespaceId: namespace.id,
        agentId: owner.id,
        revisionId: candidate.id,
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    return { ...candidate, idempotencyKey };
  }

  async function work(candidate, expected) {
    return waitFor(`revision ${candidate.id} to become ${expected}`, async () => {
      const rows = await observerPool.query(
        "SELECT state, claim_token, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      return rows.rows[0]?.state === expected ? rows.rows[0] : undefined;
    });
  }

  async function requestStop(owner) {
    await controller.stopAgent(actor.id, namespace.id, owner.id);
    const work = await observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id = $1 AND agent_id = $2 AND agent_target = 'stopped'
       ORDER BY created_at DESC LIMIT 1`,
      [namespace.id, owner.id],
    );
    assert.equal(work.rowCount, 1, "OCC.stopAgent must durably enqueue its authorized stop");
    return { id: owner.id, idempotencyKey: work.rows[0].idempotency_key };
  }

  function start(
    computeDriver,
    emit = () => {},
    convergenceTimeoutMs,
    providers,
    pool = workerPool,
    transformDrivers = (drivers) => drivers,
  ) {
    const configuredDrivers = createProviderWorkerDrivers(computeDriver, providers ?? []);
    const drivers = transformDrivers({ ...configuredDrivers, secretDriver });
    worker = createControllerWorker({
      pool,
      pollIntervalMs: 15,
      leaseDurationMs,
      maxAttempts: 5,
      onHealthy,
      ...(drivers === undefined ? { computeDriver } : { drivers }),
      ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
      emit,
    });
    return worker.start();
  }

  async function stop() {
    if (worker !== undefined) {
      await worker.stop();
    }
  }

  return {
    installation,
    actor,
    namespace,
    observerPool,
    state,
    compute,
    secretDriver,
    productionHarness: PRODUCTION_HARNESS_DESCRIPTOR,
    PostgresWorkQueue,
    agent,
    revision,
    requestStop,
    work,
    start,
    stop,
    createWorkerPool,
    workerPool,
  };
}

test(
  "worker health remains current while a Compute operation holds a renewed PostgreSQL lease",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const owner = await fixture.agent("long-compute-health");
    const candidate = await fixture.revision(owner, 1);
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
      (event) => events.push(event),
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
      const fixture = await setup(context, {
        leaseDurationMs: 1_200,
        async onHealthy() {
          if (++healthCalls !== slowCall) {
            return;
          }
          healthEntered.resolve();
          await releaseHealth.promise;
        },
      });
      const owner = await fixture.agent("slow-health");
      const candidate = await fixture.revision(owner, 1);
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
        (event) => events.push(event),
      );
      try {
        await healthEntered.promise;
        // Cover both the health update before the first effect and one started
        // during Compute. Neither may hold the claim's renewal chain hostage.
        await waitFor("Compute to start despite the pending health update", async () =>
          preparing ? true : undefined,
        );
        const original = await fixture.work(candidate, "claimed");
        await delay(2_600);
        const lease = await fixture.observerPool.query(
          `SELECT claim_token, attempt_count, lease_expires_at > clock_timestamp() AS live
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [candidate.idempotencyKey],
        );
        assert.deepEqual(lease.rows, [
          { claim_token: original.claim_token, attempt_count: 1, live: true },
        ]);
        assert.equal(healthCalls, slowCall, "health updates must not overlap");
        assert.equal(
          events.some(({ code }) => code === "CLAIM_LOST"),
          false,
        );
      } finally {
        releaseHealth.resolve();
        releaseCompute.resolve();
      }
      await fixture.work(candidate, "succeeded");
      const active = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
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
    const owner = await fixture.agent("failed-health");
    const candidate = await fixture.revision(owner, 1);
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          await delay(2_600);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      (event) => events.push(event),
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

test(
  "Agent stop clears only the exact active pointer after Compute shutdown and retries safely",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-target");
    const sibling = await fixture.agent("stop-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const stoppedRevisions = [];
    let failStopOnce = true;
    let failedCandidate;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          return revision.revision === 2 ? { ...observation, ready: false } : observation;
        },
        async stopRevision(revision) {
          const current = await fixture.state.read((view) =>
            view.agents.findAgent(fixture.namespace.id, owner.id),
          );
          if (stoppedRevisions.length < 3) {
            assert.equal(
              current.activeRevisionId,
              targetRevision.id,
              "the serving pointer remains until candidate cleanup succeeds",
            );
          }
          if (revision.id === failedCandidate.id && failStopOnce) {
            failStopOnce = false;
            throw new Error("transient Compute stop failure");
          }
          stoppedRevisions.push(revision.id);
        },
      },
      () => {},
      50,
    );
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // The replacement owns resources but never becomes ready. Terminal queue
    // failure must not make it invisible to the real Agent-stop workflow.
    failedCandidate = await fixture.revision(owner, 2);
    await fixture.work(failedCandidate, "failed_permanent");
    const firstStop = await fixture.requestStop(owner);
    const completedStop = await fixture.work(firstStop, "succeeded");
    assert.equal(completedStop.attempt_count, 2);
    const [stopped, unaffected, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.agents.findAgent(fixture.namespace.id, sibling.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, targetRevision.id),
      ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(unaffected.activeRevisionId, siblingRevision.id);
    assert.equal(retainedRevision.id, targetRevision.id);
    assert.deepEqual(stoppedRevisions, [targetRevision.id, targetRevision.id, failedCandidate.id]);

    const repeatedStop = await fixture.requestStop(owner);
    await fixture.work(repeatedStop, "succeeded");
    assert.deepEqual(stoppedRevisions, [
      targetRevision.id,
      targetRevision.id,
      failedCandidate.id,
      targetRevision.id,
      failedCandidate.id,
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT action, resource_id, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.stop",
        resource_id: owner.id,
        reason_code: "AGENT_ALREADY_STOPPED",
      },
    ]);
  },
);

for (const recovery of [false, true]) {
  test(
    `fresh worker binds SSH ownership before ${recovery ? "stopped revision recovery" : "Agent stop"}`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent("cold-stop", "embedded", undefined, null, true, true);
      let candidate = await fixture.revision(owner, 1);
      await fixture.start(fixture.compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      if (recovery) {
        const previous = candidate;
        candidate = await fixture.revision(owner, 2);
        // A worker can exit after publication but before completing revision work.
        await fixture.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(
            fixture.namespace.id,
            owner.id,
            previous.id,
            candidate.id,
          ),
        );
      }
      const stop = await fixture.requestStop(owner);
      const { SshComputeDriver } =
        await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
      const operations = [];
      // Exercise the bundled SSH Driver's actual cold binding validation. Only
      // remote SSH execution is controlled; the queue and worker use PostgreSQL.
      const cold = new SshComputeDriver(
        {
          ssh: { identityFile: "/fixture/identity", knownHostsFile: "/fixture/hosts" },
          hosts: { [fixture.namespace.name]: { address: "127.0.0.1", user: "root" } },
          runtime: {
            nodePath: "/usr/bin/node",
            openclawPath: "/opt/openclaw/index.js",
            user: "runtime",
            root: "/var/lib/openclaw-enterprise",
          },
          network: { gatewayPortRange: { start: 18800, end: 18899 } },
        },
        {
          id: fixture.compute.id,
          implementation: fixture.compute.implementation,
          executor: {
            async execute(request) {
              operations.push(JSON.parse(Buffer.from(request.operation, "base64").toString()));
              return { code: 0, stdout: '{"ok":true}', stderr: "" };
            },
          },
        },
      );
      await fixture.start(
        {
          ...fixture.compute,
          bindAgent: cold.bindAgent.bind(cold),
          stopRevision: cold.stopRevision.bind(cold),
          retireRevision: cold.retireRevision.bind(cold),
        },
        () => {},
        undefined,
        undefined,
        fixture.createWorkerPool(),
      );
      if (recovery) {
        assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
      }
      assert.equal((await fixture.work(stop, "succeeded")).attempt_count, 1);
      const current = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      assert.equal(current.activeRevisionId, undefined);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.ok(operations.some((op) => op.operation === "stop-revision"));
      assert.ok(
        operations.every(
          (op) => op.namespace.id === fixture.namespace.id && op.revision.agentId === owner.id,
        ),
      );
      if (recovery) {
        assert.ok(operations.some((op) => op.operation === "retire-revision"));
      }
    },
  );
}

test(
  "a deployment admitted after stop supersedes stale stop work before Compute mutation",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-then-deploy");
    const first = await fixture.revision(owner, 1);
    const stoppedRevisions = [];
    let releaseStopAuthorization;
    const stopAuthorizationReleased = new Promise((resolve) => {
      releaseStopAuthorization = resolve;
    });
    let stopAuthorizationStarted;
    const stopAuthorizationObserved = new Promise((resolve) => {
      stopAuthorizationStarted = resolve;
    });
    const compute = {
      ...fixture.compute,
      async stopRevision(candidate) {
        stoppedRevisions.push(candidate.id);
      },
    };
    await fixture.start(
      compute,
      () => {},
      undefined,
      [],
      fixture.workerPool,
      (drivers) => {
        const createIAMDriver = drivers.createIAMDriver;
        return {
          ...drivers,
          createIAMDriver(state) {
            const iam = createIAMDriver(state);
            return {
              id: iam.id,
              implementation: iam.implementation,
              capability: iam.capability,
              lookupIdentity: iam.lookupIdentity.bind(iam),
              async authorize(request) {
                if (
                  request.action === "operate" &&
                  request.resource.kind === "agent" &&
                  request.resource.id === owner.id
                ) {
                  stopAuthorizationStarted();
                  await stopAuthorizationReleased;
                }
                return iam.authorize(request);
              },
            };
          },
        };
      },
    );
    await fixture.work(first, "succeeded");

    const stop = await fixture.requestStop(owner);
    await stopAuthorizationObserved;
    // This later admission changes intent while stop is inside its required IAM check.
    const second = await fixture.revision(owner, 2);
    releaseStopAuthorization();

    await Promise.all([fixture.work(stop, "succeeded"), fixture.work(second, "succeeded")]);
    const running = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(running.desiredRuntimeState, "running");
    assert.equal(running.activeRevisionId, second.id);
    assert.deepEqual(stoppedRevisions, []);
    const audit = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.stop'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [{ reason_code: "STOP_SUPERSEDED" }]);
  },
);

test(
  "Agent stop cleans a terminal candidate without an active revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-initial-failure");
    const candidate = await fixture.revision(owner, 1);
    const stopped = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return { ...(await fixture.compute.prepareRevision(revision)), ready: false };
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
        },
      },
      () => {},
      50,
    );
    await fixture.work(candidate, "failed_permanent");
    // Historical records from another selected Compute are not cleanup inputs
    // for this worker, even when the Agent has no active pointer.
    await fixture.state.transact((unit) =>
      unit.revisions.createRevision({
        ...candidate,
        id: `rev_${randomUUID()}`,
        revision: 2,
        compute: { id: "retired-compute", implementation: "retired-compute" },
      }),
    );
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    assert.deepEqual(stopped, [candidate.id]);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.desiredRuntimeState, "stopped");
    assert.equal(current.activeRevisionId, undefined);
  },
);

for (const admissionDuring of ["active", "candidate"]) {
  test(
    `a deployment during ${admissionDuring} cleanup supersedes the remaining Agent stop effects`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(`stop-race-${admissionDuring}`);
      const active = await fixture.revision(owner, 1);
      const stopped = [];
      let candidate;
      let newer;
      let activeWhenNewerPrepared;
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            if (revision.revision === 3) {
              const current = await fixture.state.read((view) =>
                view.agents.findAgent(fixture.namespace.id, owner.id),
              );
              activeWhenNewerPrepared = current.activeRevisionId;
            }
            return {
              ...(await fixture.compute.prepareRevision(revision)),
              ready: revision.revision !== 2,
            };
          },
          async stopRevision(revision) {
            stopped.push(revision.id);
            if (revision.id === (admissionDuring === "active" ? active.id : candidate.id)) {
              // Admission changes desired state during an exact cleanup call. The
              // old pointer must survive both the next-effect and final-CAS fences.
              newer = await fixture.revision(owner, 3);
            }
          },
        },
        () => {},
        50,
      );
      await fixture.work(active, "succeeded");
      candidate = await fixture.revision(owner, 2);
      await fixture.work(candidate, "failed_permanent");
      const stop = await fixture.requestStop(owner);
      await fixture.work(stop, "succeeded");
      assert.ok(newer);
      await fixture.work(newer, "succeeded");
      assert.deepEqual(
        stopped,
        admissionDuring === "active" ? [active.id] : [active.id, candidate.id],
      );
      assert.equal(
        activeWhenNewerPrepared,
        active.id,
        "stale stop must not clear the serving pointer after a later admission",
      );
      const current = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      assert.equal(current.desiredRuntimeState, "running");
      assert.equal(current.activeRevisionId, newer.id);
    },
  );
}

test(
  "Agent stop reauthorizes the recorded actor before Compute mutation",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-reauthorization");
    const revision = await fixture.revision(owner, 1);
    const stoppedRevisions = [];
    const compute = {
      ...fixture.compute,
      async stopRevision(candidate) {
        stoppedRevisions.push(candidate.id);
      },
    };
    await fixture.start(compute);
    await fixture.work(revision, "succeeded");

    await fixture.stop();
    const stop = await fixture.requestStop(owner);
    // Admission was authorized; revoke before restarting the worker to prove
    // dispatch independently rechecks the recorded actor's permission.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
    await fixture.work(stop, "failed_permanent");

    assert.deepEqual(stoppedRevisions, []);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, revision.id);
    assert.equal(current.desiredRuntimeState, "stopped");
    const audit = await fixture.observerPool.query(
      `SELECT kind, action, outcome,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND kind = 'authorization_denial'`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      {
        kind: "authorization_denial",
        action: "openclaw.agents.stop",
        outcome: "denied",
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
  },
);

test(
  "active revision maintenance defers shutdown to the separately authorized Agent stop work",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-maintenance-authorization");
    const revision = await fixture.revision(owner, 1);
    await fixture.start(fixture.compute);
    await fixture.work(revision, "succeeded");
    await fixture.stop();

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
    const stop = await fixture.requestStop(owner);

    // Maintenance may observe stopped intent first, but only the Agent-stop claim
    // may perform shutdown after reauthorizing its recorded actor.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'operate', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    const stoppedRevisions = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          stoppedRevisions.push(candidate.id);
        },
      },
      (event) => events.push(event),
      undefined,
      undefined,
      fixture.createWorkerPool(),
    );

    await fixture.work(maintenance, "succeeded");
    await fixture.work(stop, "failed_permanent");
    assert.deepEqual(stoppedRevisions, []);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, revision.id);
    assert.equal(current.desiredRuntimeState, "stopped");
    assert.ok(
      events.some(
        ({ event, code, revisionId }) =>
          event === "worker.completed" &&
          code === "REVISION_MAINTENANCE_SUPERSEDED" &&
          revisionId === revision.id,
      ),
    );
  },
);

test(
  "a stop accepted during revision preparation prevents the candidate from becoming active",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-prepare-race");
    const candidate = await fixture.revision(owner, 1);
    let releasePreparation;
    const preparationReleased = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    let preparationStarted = false;
    const stoppedRevisions = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        preparationStarted = true;
        await preparationReleased;
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        stoppedRevisions.push(revision.id);
      },
    });
    await waitFor("revision preparation to start", async () =>
      preparationStarted ? true : undefined,
    );

    const stop = await fixture.requestStop(owner);
    releasePreparation();
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");

    const stopped = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(stopped.desiredRuntimeState, "stopped");
    // Both the interrupted revision and Agent-stop owner perform exact,
    // idempotent cleanup; neither may activate the candidate.
    assert.deepEqual(stoppedRevisions, [candidate.id, candidate.id]);
    const activation = await fixture.observerPool.query(
      `SELECT id FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
         AND resource_id = $2`,
      [fixture.namespace.id, candidate.id],
    );
    assert.deepEqual(activation.rows, []);
  },
);

test(
  "a stop admitted immediately after publication retires the predecessor before completion",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-publication-race");
    const predecessor = await fixture.revision(owner, 1);
    await fixture.start(fixture.compute);
    await fixture.work(predecessor, "succeeded");
    await fixture.stop();

    const replacement = await fixture.revision(owner, 2);
    await fixture.compute.prepareRevision(replacement);
    // Recreate the committed publication boundary before route finalization. Stop
    // admission can observe this exact durable state while revision work remains.
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        predecessor.id,
        replacement.id,
      ),
    );
    assert.equal(published.activeRevisionId, replacement.id);
    const stop = await fixture.requestStop(owner);

    const stoppedRevisions = [];
    const retiredRevisions = [];
    let failRetirement = true;
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(candidate) {
          stoppedRevisions.push(candidate.id);
          return fixture.compute.stopRevision(candidate);
        },
        async retireRevision(candidate) {
          retiredRevisions.push(candidate.id);
          if (failRetirement) {
            failRetirement = false;
            throw new Error("transient predecessor retirement failure");
          }
          return fixture.compute.retireRevision(candidate);
        },
      },
      () => {},
      undefined,
      undefined,
      fixture.createWorkerPool(),
    );

    await fixture.work(replacement, "succeeded");
    await fixture.work(stop, "succeeded");
    const [stopped, retainedPredecessor, retainedReplacement] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, owner.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, predecessor.id),
          view.revisions.findRevision(fixture.namespace.id, owner.id, replacement.id),
        ]),
    );
    assert.equal(stopped.desiredRuntimeState, "stopped");
    assert.equal(stopped.activeRevisionId, undefined);
    assert.equal(retainedPredecessor.id, predecessor.id);
    assert.equal(retainedReplacement.id, replacement.id);
    assert.deepEqual(retiredRevisions, [predecessor.id, predecessor.id]);
    // Agent stop also covers the older same-Compute predecessor whose
    // retirement failed after publication, with serving revision cleanup first.
    assert.deepEqual(stoppedRevisions, [
      replacement.id,
      replacement.id,
      predecessor.id,
      replacement.id,
    ]);
  },
);

test(
  "maintenance retains its real lease across consecutive short predecessor retirements",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { leaseDurationMs: 1_200 });
    const owner = await fixture.agent("short-retirement-lease");
    const first = await fixture.revision(owner, 1);
    const events = [];
    let completedRetirements = 0;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 200,
        async retireRevision(previous) {
          // Exercise the real worker and PostgreSQL lease with short external
          // effects: each finishes before the heartbeat timer, but the whole
          // cleanup sequence exceeds the lease. No claim timestamps are edited.
          await delay(120);
          const result = await fixture.compute.retireRevision(previous);
          completedRetirements += 1;
          return result;
        },
      },
      (event) => events.push(event),
    );
    await fixture.work(first, "succeeded");
    // Admitted intermediate revisions can be superseded before execution. They
    // remain valid predecessors that active-revision maintenance must retire.
    await fixture.state.transact(async (unit) => {
      for (let number = 2; number <= 24; number += 1) {
        const skipped = { ...first, id: `rev_${randomUUID()}`, revision: number };
        delete skipped.idempotencyKey;
        await unit.revisions.createRevision(skipped);
      }
    });
    const current = await fixture.revision(owner, 25);
    await fixture.work(current, "succeeded");
    const maintenance = await waitFor("one successful short-effect maintenance claim", async () => {
      assert.equal(
        events.some(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
        false,
        "consecutive short effects must not starve lease renewal",
      );
      const result = await fixture.observerPool.query(
        `SELECT state, attempt_count FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE '%:maintenance:%'
           AND state = 'succeeded'`,
        [current.id],
      );
      return result.rows[0];
    });
    assert.equal(maintenance.attempt_count, 1);
    assert.ok(completedRetirements >= 25, "activation and all predecessors were retired");
    const active = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(active.activeRevisionId, current.id);
  },
);

test(
  "development workers run supplied after-commit activation hooks and retry incomplete finalization",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("development-after-commit", "dedicated");
    const candidate = await fixture.revision(owner, 1);
    const activations = [];
    let failed = false;

    async function activeRevision() {
      const current = await fixture.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [fixture.namespace.id, owner.id],
      );
      assert.equal(current.rowCount, 1);
      return current.rows[0].active_revision_id;
    }

    await fixture.start({
      ...fixture.compute,
      async activateRevision(revision, activationContext) {
        activations.push({
          revisionId: revision.id,
          activeRevisionId: await activeRevision(),
          secretEnvironment: activationContext?.secretEnvironment ?? null,
        });
        if (!failed) {
          failed = true;
          throw new Error("route publication failed");
        }
      },
    });

    const completed = await fixture.work(candidate, "succeeded");
    // Incomplete finalization requeues the same claim without spending an
    // attempt, but the second activation call proves the recovery pass ran.
    assert.equal(completed.attempt_count, 1);
    assert.equal(await activeRevision(), candidate.id);
    assert.deepEqual(
      activations.filter(({ revisionId }) => revisionId === candidate.id),
      [
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
        { revisionId: candidate.id, activeRevisionId: candidate.id, secretEnvironment: [] },
      ],
    );

    const activation = await fixture.observerPool.query(
      `SELECT resource_id
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [{ resource_id: candidate.id }]);
  },
);

test(
  "the revision worker activates admitted candidates, retires predecessors, and rejects revoked, malformed, and wrong-owner effects",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const [normal, denied, malformedAdmission, wrongOwner] = await Promise.all([
      fixture.agent("normal"),
      fixture.agent("denied"),
      fixture.agent("malformed-admission"),
      fixture.agent("wrong-owner"),
    ]);
    const [first, revoked, malformed] = await Promise.all([
      fixture.revision(normal, 1),
      fixture.revision(denied, 1),
      fixture.revision(wrongOwner, 1),
    ]);
    assert.equal(first.servicePrincipalId, normal.servicePrincipalId);
    assert.notEqual(normal.servicePrincipalId, denied.servicePrincipalId);
    // Missing its pinned Configuration, Harness, and Compute, so persistence must reject admission.
    await assert.rejects(
      fixture.state.transact((unit) =>
        unit.revisions.createRevision({
          id: `rev_${randomUUID()}`,
          namespaceId: fixture.namespace.id,
          agentId: malformedAdmission.id,
          revision: 1,
          providerId: null,
          configuration: {},
          servicePrincipalId: malformedAdmission.servicePrincipalId,
          createdAt: new Date().toISOString(),
        }),
      ),
      ({ name, message }) =>
        name === "ScopeViolationError" &&
        /harness authentication is invalid or legacy/.test(message),
      "the PostgreSQL adapter rejects incomplete snapshots before persistence",
    );
    // Configuration metadata is valid, but the incomplete Harness and missing Compute are rejected.
    await assert.rejects(
      fixture.observerPool.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         VALUES ($1, $2, $3, 1, $4::jsonb, clock_timestamp())`,
        [
          `rev_${randomUUID()}`,
          fixture.namespace.id,
          malformedAdmission.id,
          JSON.stringify({
            draft_spec: {},
            configuration_id: malformedAdmission.configurationId,
            configuration_kind: "agent",
            configuration_generation: 1,
            harness: { id: "incomplete" },
          }),
        ],
      ),
      ({ code, constraint }) =>
        code === "23514" && constraint === "agent_revisions_admitted_snapshot",
      "PostgreSQL must reject malformed revision snapshots before they can become controller work",
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, denied.id],
    );

    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(candidate) {
        effects.push({ action: "prepare", revisionId: candidate.id });
        const observation = await fixture.compute.prepareRevision(candidate);
        return candidate.id === malformed.id ? { ...observation, agentId: normal.id } : observation;
      },
      async retireRevision(candidate) {
        // The serving predecessor must survive until its replacement is durably active.
        const current = await fixture.observerPool.query(
          "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
          [candidate.namespaceId, candidate.agentId],
        );
        assert.notEqual(current.rows[0].active_revision_id, candidate.id);
        effects.push({ action: "retire", revisionId: candidate.id });
        return fixture.compute.retireRevision(candidate);
      },
    });

    await Promise.all([
      fixture.work(first, "succeeded"),
      fixture.work(revoked, "failed_permanent"),
      fixture.work(malformed, "failed_permanent"),
    ]);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === revoked.id),
      [],
      "denied revisions must never invoke Compute",
    );
    const firstActive = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, normal.id],
    );
    assert.equal(firstActive.rows[0].active_revision_id, first.id);
    const unchanged = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
      [fixture.namespace.id, [denied.id, malformedAdmission.id, wrongOwner.id]],
    );
    assert.ok(unchanged.rows.every(({ active_revision_id: active }) => active === null));

    const second = await fixture.revision(normal, 2);
    assert.equal(second.servicePrincipalId, first.servicePrincipalId);
    await fixture.work(second, "succeeded");
    const normalEffects = effects.filter(({ revisionId }) =>
      [first.id, second.id].includes(revisionId),
    );
    assert.deepEqual(normalEffects, [
      { action: "prepare", revisionId: first.id },
      { action: "prepare", revisionId: second.id },
      { action: "retire", revisionId: first.id },
    ]);
    const secondActive = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, normal.id],
    );
    assert.equal(secondActive.rows[0].active_revision_id, second.id);

    const denial = await fixture.observerPool.query(
      `SELECT kind, action, resource_id, outcome
       FROM occ.audit_events
       WHERE resource_id = $1 AND kind = 'authorization_denial'`,
      [denied.id],
    );
    assert.deepEqual(denial.rows, [
      {
        kind: "authorization_denial",
        action: "openclaw.agents.deploy",
        resource_id: denied.id,
        outcome: "denied",
      },
    ]);
    const activation = await fixture.observerPool.query(
      `SELECT resource_id, details->>'previousRevisionId' AS previous
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.activate'
       ORDER BY occurred_at`,
      [fixture.namespace.id],
    );
    assert.deepEqual(activation.rows, [
      { resource_id: first.id, previous: null },
      { resource_id: second.id, previous: first.id },
    ]);
  },
);

test(
  "the revision worker rejects associated-account access revoked after admission before invoking Compute",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const provider = providerDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "revoked-account",
    );
    await seedProviderBinding(fixture.observerPool, account);
    const owner = await fixture.agent(
      "revoked-service-account",
      "dedicated",
      account.id,
      provider.id,
    );
    const candidate = await fixture.revision(owner, 1);

    // Admission captured a readable account, but its exact read permission is revoked before dispatch.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'service_account', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, account.id],
    );

    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        effects.push({ action: "prepare", revisionId: revision.id });
        return fixture.compute.prepareRevision(revision);
      },
      async retireRevision(revision) {
        effects.push({ action: "retire", revisionId: revision.id });
        return fixture.compute.retireRevision(revision);
      },
    });

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    assert.deepEqual(
      effects.filter(({ revisionId }) => revisionId === candidate.id),
      [],
      "revoked account access must prevent Compute effects for its admitted revision",
    );

    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, null);

    // The outer deployment denial names its Agent while retaining the failed exact account decision.
    const denial = await fixture.observerPool.query(
      `SELECT action, resource_kind, resource_id, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE resource_id = $1 AND kind = 'authorization_denial'`,
      [owner.id],
    );
    assert.deepEqual(denial.rows, [
      {
        action: "openclaw.agents.deploy",
        resource_kind: "agent",
        resource_id: owner.id,
        outcome: "denied",
        authorization: {
          principalId: fixture.actor.id,
          action: "read",
          resource: {
            kind: "service_account",
            id: account.id,
            namespaceId: fixture.namespace.id,
          },
        },
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
  },
);

test(
  "the revision worker rejects managed ServiceAccount issuance revoked after admission before Compute",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const provider = providerDefinition();
    const accounts = await Promise.all(
      ["valid", "issuance-revoked"].map((label) =>
        createAccessTokenServiceAccount(fixture.state, fixture.namespace.id, label),
      ),
    );
    await Promise.all(
      accounts.map((account) => seedProviderBinding(fixture.observerPool, account)),
    );
    const owners = await Promise.all(
      accounts.map((account) => fixture.agent(account.name, "dedicated", account.id, provider.id)),
    );
    const candidates = await Promise.all(owners.map((owner) => fixture.revision(owner, 1)));
    // Only issuance metadata is mutable; private Provider/account ownership
    // remains protected by PostgreSQL grants and the immutable snapshot.
    await fixture.observerPool.query(
      "UPDATE occ.service_account_driver_bindings SET external_credential_id = NULL WHERE namespace_id = $1 AND service_account_id = $2",
      [fixture.namespace.id, accounts[1].id],
    );
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async bindAgent({ agent }) {
          effects.push({ action: "bind", agentId: agent.id });
        },
        async prepareRevision(revision) {
          effects.push({ action: "prepare", revisionId: revision.id });
          return fixture.compute.prepareRevision(revision);
        },
      },
      () => {},
      undefined,
      [provider],
    );
    await Promise.all(
      candidates.map((candidate, index) =>
        fixture.work(candidate, index === 0 ? "succeeded" : "failed_permanent"),
      ),
    );
    assert.deepEqual(effects, [
      { action: "bind", agentId: owners[0].id },
      { action: "prepare", revisionId: candidates[0].id },
    ]);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owners[1].id),
    );
    assert.equal(current.activeRevisionId, undefined);
    const failures = await fixture.observerPool.query(
      "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
      [candidates[1].id],
    );
    assert.deepEqual(failures.rows, [{ reason_code: "SERVICE_ACCOUNT_PROVIDER_MISMATCH" }]);
  },
);

test(
  "the revision worker retries transient Provider binding read failures without activating",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context);
    const provider = providerDefinition();
    const cleanup = { serviceAccountIds: [], agentIds: [], revisionIds: [] };

    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "transient-provider-read",
    );
    cleanup.serviceAccountIds.push(account.id);
    await seedProviderBinding(fixture.observerPool, account);
    const owner = await fixture.agent(
      "transient-provider-read",
      "dedicated",
      account.id,
      provider.id,
    );
    cleanup.agentIds.push(owner.id);

    const effects = [];
    const events = [];
    try {
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision) {
            effects.push({ action: "prepare", revisionId: revision.id });
            return fixture.compute.prepareRevision(revision);
          },
        },
        (event) => events.push(event),
        undefined,
        [provider],
        poolWithOneProviderBindingReadFault(fixture.workerPool),
      );

      const candidate = await fixture.revision(owner, 1);
      cleanup.revisionIds.push(candidate.id);

      const retried = await waitFor(
        "transient Provider binding read failure retry evidence",
        async () => {
          const result = await fixture.observerPool.query(
            `SELECT work.state, work.attempt_count,
                    count(audit.id)::integer AS dependency_failures
             FROM occ.controller_work AS work
             LEFT JOIN occ.audit_events AS audit
               ON audit.namespace_id = work.namespace_id
              AND audit.resource_id = work.revision_id
              AND audit.action = 'reconcile'
              AND audit.details->>'reasonCode' = 'DEPENDENCY_UNAVAILABLE'
             WHERE work.idempotency_key = $1
             GROUP BY work.state, work.attempt_count`,
            [candidate.idempotencyKey],
          );
          const row = result.rows[0];
          if (row?.dependency_failures >= 1 && row.state !== "failed_permanent") {
            return row;
          }
          return undefined;
        },
      );
      assert.ok(retried.attempt_count >= 1);
      assert.deepEqual(effects, [], "transient binding read failures must not invoke Compute");
      assert.ok(
        events.some(
          ({ event, code, revisionId }) =>
            event === "worker.completed" &&
            code === "DEPENDENCY_UNAVAILABLE" &&
            revisionId === candidate.id,
        ),
      );
      const inactive = await fixture.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [fixture.namespace.id, owner.id],
      );
      assert.equal(inactive.rows[0].active_revision_id, null);

      await fixture.work(candidate, "succeeded");
      assert.deepEqual(effects, [{ action: "prepare", revisionId: candidate.id }]);
      const active = await fixture.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [fixture.namespace.id, owner.id],
      );
      assert.equal(active.rows[0].active_revision_id, candidate.id);
    } finally {
      await fixture.stop();
      await cleanupProviderFixtures(fixture.observerPool, fixture.namespace.id, cleanup);
    }
  },
);

test(
  "an older revision retry is superseded without preparing or retiring a newer active revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("superseded-retry");
    const older = await fixture.revision(owner, 1);
    const newer = await fixture.revision(owner, 2);
    const effects = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          const observation = await fixture.compute.prepareRevision(candidate);
          return candidate.id === older.id ? { ...observation, ready: false } : observation;
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", revisionId: candidate.id });
          return fixture.compute.retireRevision(candidate);
        },
      },
      (event) => events.push(event),
    );

    await Promise.all([fixture.work(newer, "succeeded"), fixture.work(older, "succeeded")]);
    // Newer publication retires every older candidate. The later superseded retry
    // must contribute no preparation or retirement against the active revision.
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: older.id },
      { action: "prepare", revisionId: newer.id },
      { action: "retire", revisionId: older.id },
    ]);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, newer.id);
    const superseded = await fixture.observerPool.query(
      `SELECT action, outcome, details->>'activeRevisionId' AS active_revision_id,
              details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.supersede'`,
      [older.id],
    );
    assert.deepEqual(superseded.rows, [
      {
        action: "openclaw.agents.lifecycle.supersede",
        outcome: "success",
        active_revision_id: newer.id,
        reason_code: "REVISION_SUPERSEDED",
      },
    ]);
    assert.ok(
      events.some(
        ({ event, code, revisionId }) =>
          event === "worker.completed" && code === "REVISION_SUPERSEDED" && revisionId === older.id,
      ),
    );
  },
);

test(
  "real PostgreSQL preserves the failure budget while an Agent runtime converges",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("slow-runtime");
    const candidate = await fixture.revision(owner, 1);
    let observations = 0;

    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        const observation = await fixture.compute.prepareRevision(revision);
        observations += 1;
        // Image pulls and app-server startup remain ordinary pending observations, not failures.
        return observations <= 7 ? { ...observation, ready: false } : observation;
      },
    });

    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(observations, 8);
    assert.equal(completed.attempt_count, 1);

    // Every deferred observation is durable and attributable while the Agent activates exactly once.
    const pending = await fixture.observerPool.query(
      `SELECT count(*)::integer AS count FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'REVISION_INCOMPLETE'`,
      [candidate.id],
    );
    assert.equal(pending.rows[0].count, 7);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, candidate.id);
  },
);

test(
  "an overdue Agent runtime fails closed without activating its incomplete revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("expired-runtime");
    const candidate = await fixture.revision(owner, 1);

    // A real short deadline expires against the durable queued creation timestamp.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return { ...(await fixture.compute.prepareRevision(revision)), ready: false };
        },
      },
      () => {},
      1,
    );

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, null);
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' = 'CONVERGENCE_DEADLINE_EXCEEDED'`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [{ reason: "CONVERGENCE_DEADLINE_EXCEEDED" }]);
  },
);

test(
  "one worker reconciles embedded OpenClaw and dedicated Codex but rejects unapproved pinned Harnesses",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const embedded = await fixture.agent("embedded-openclaw");
    const dedicated = await fixture.agent("dedicated-codex", "dedicated");
    const unsupported = await fixture.agent("unapproved-harness", "dedicated");
    const mismatched = await fixture.agent("mismatched-placement");
    const embeddedRevision = await fixture.revision(embedded, 1);
    const dedicatedRevision = await fixture.revision(dedicated, 1);
    const unsupportedRevision = await fixture.revision(unsupported, 1, {
      id: "codex",
      version: "unapproved",
      mode: "dedicated",
    });
    const mismatchedRevision = await fixture.revision(mismatched, 1, {
      ...fixture.productionHarness,
      mode: "embedded",
    });

    await fixture.start(fixture.compute);
    await Promise.all([
      fixture.work(embeddedRevision, "succeeded"),
      fixture.work(dedicatedRevision, "succeeded"),
      fixture.work(unsupportedRevision, "failed_permanent"),
      fixture.work(mismatchedRevision, "failed_permanent"),
    ]);

    const active = await fixture.observerPool.query(
      "SELECT id, active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
      [fixture.namespace.id, [embedded.id, dedicated.id, unsupported.id, mismatched.id]],
    );
    const activeByAgent = new Map(
      active.rows.map(({ id, active_revision_id }) => [id, active_revision_id]),
    );
    assert.equal(activeByAgent.get(embedded.id), embeddedRevision.id);
    assert.equal(activeByAgent.get(dedicated.id), dedicatedRevision.id);
    assert.equal(activeByAgent.get(unsupported.id), null);
    assert.equal(activeByAgent.get(mismatched.id), null);
  },
);

test(
  "a lost retirement claim preserves the activated replacement and cannot complete stolen work",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stale-retirement");
    const first = await fixture.revision(owner, 1);
    const releaseRetirement = Promise.withResolvers();
    const effects = [];
    const events = [];
    let retirements = 0;
    context.after(() => releaseRetirement.resolve());
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(candidate) {
          effects.push({ action: "prepare", revisionId: candidate.id });
          return fixture.compute.prepareRevision(candidate);
        },
        async retireRevision(previous) {
          retirements += 1;
          effects.push({ action: "retire", revisionId: previous.id });
          if (retirements === 1) {
            await releaseRetirement.promise;
          }
          return fixture.compute.retireRevision(previous);
        },
      },
      (event) => events.push(event),
    );
    await fixture.work(first, "succeeded");
    const skipped = {
      ...first,
      id: `rev_${randomUUID()}`,
      revision: 2,
      createdAt: new Date().toISOString(),
    };
    delete skipped.idempotencyKey;
    // A persisted but never-started intermediate revision must not hide the serving predecessor.
    await fixture.state.transact((unit) => unit.revisions.createRevision(skipped));
    const second = await fixture.revision(owner, 3);
    await waitFor("the real worker to block in predecessor retirement", async () =>
      retirements === 1 ? true : undefined,
    );
    // Publishing success is not attributable until route publication and teardown have finished.
    const prematureActivation = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(prematureActivation.rowCount, 0);

    const original = await fixture.work(second, "claimed");
    assert.equal(original.attempt_count, 1);
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [second.idempotencyKey, original.claim_token],
    );
    const recoveryQueue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 5,
      random: () => 0,
    });
    const recovery = await recoveryQueue.recoverStale();
    assert.ok(recovery.recovered >= 1);
    const recovered = await recoveryQueue.claim();
    assert.ok(recovered, "the recovered revision must receive a fresh active claim");
    assert.equal(recovered.idempotencyKey, second.idempotencyKey);
    assert.notEqual(recovered.claimToken, original.claim_token);

    releaseRetirement.resolve();
    await waitFor("the expired worker to report claim loss", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    // Activation committed before teardown; a stolen claim cannot mark that teardown complete.
    const unchanged = await fixture.observerPool.query(
      `SELECT agent.active_revision_id, work.state, work.claim_token
       FROM occ.agents AS agent
       JOIN occ.controller_work AS work
         ON work.namespace_id = agent.namespace_id AND work.agent_id = agent.id
       WHERE agent.namespace_id = $1 AND agent.id = $2 AND work.idempotency_key = $3`,
      [fixture.namespace.id, owner.id, second.idempotencyKey],
    );
    assert.deepEqual(unchanged.rows, [
      {
        active_revision_id: second.id,
        state: "claimed",
        claim_token: recovered.claimToken,
      },
    ]);
    const staleCompletion = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1
         AND details->>'reasonCode' = 'RECONCILE_SUCCEEDED'`,
      [second.id],
    );
    assert.equal(staleCompletion.rowCount, 0);

    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await fixture.work(second, "succeeded");
    const converged = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(converged.rows[0].active_revision_id, second.id);
    assert.equal(retirements, 3);
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "retire" && revisionId === first.id)
        .length,
      2,
    );
    assert.equal(
      effects.filter(({ action, revisionId }) => action === "prepare" && revisionId === second.id)
        .length,
      1,
    );
    const activation = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(activation.rowCount, 1);
  },
);

test(
  "revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owners = await Promise.all(
      ["allowed", "configuration-denied", "actor-secret-denied", "agent-secret-ungranted"].map(
        (name, index) => fixture.agent(name, "embedded", undefined, null, index !== 3),
      ),
    );
    const candidates = await Promise.all(owners.map((owner) => fixture.revision(owner, 1)));
    // Revoke actor permissions after admission and independently exercise an
    // Agent lacking its own grant; actor authority never authorizes that Agent.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'configuration', $3, 'deny'),
              ($4, $2, 'operate', 'secret', $5, 'deny')`,
      [
        `restriction-${randomUUID()}`,
        fixture.namespace.id,
        owners[1].configurationId,
        `restriction-${randomUUID()}`,
        owners[2].harnessAuth.source.id,
      ],
    );
    const prepared = [];
    // Production workers have no Secret API permission. Dispatch must project
    // authoritative OCC metadata without asking the backend owner to read values.
    fixture.secretDriver.setResolveOverride(() => {
      throw new Error("Worker cannot read backend Secrets.");
    });
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, operationContext) {
        prepared.push({ id: revision.id, operationContext });
        return fixture.compute.prepareRevision(revision);
      },
    });
    await Promise.all(
      candidates.map((candidate, index) =>
        fixture.work(candidate, index === 0 ? "succeeded" : "failed_permanent"),
      ),
    );
    const source = await fixture.state.read((view) =>
      view.secrets.findSecret(fixture.namespace.id, owners[0].harnessAuth.source.id),
    );
    assert.deepEqual(
      prepared,
      [
        {
          id: candidates[0].id,
          operationContext: {
            secretEnvironment: [],
            harnessAuth: { ...candidates[0].harnessAuth, backendRef: source.backendRef },
          },
        },
      ],
      "only the independently authorized binding reaches Compute, outside gateway environment projections",
    );
    const denied = await fixture.observerPool.query(
      `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
       FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
      [fixture.namespace.id],
    );
    const deniedResources = denied.rows
      .map(
        ({ authorization }) =>
          `${authorization.principalId}:${authorization.resource.kind}:${authorization.resource.id}`,
      )
      .sort();
    assert.deepEqual(
      deniedResources,
      [
        `${fixture.actor.id}:configuration:${owners[1].configurationId}`,
        `${fixture.actor.id}:secret:${owners[2].harnessAuth.source.id}`,
        `${owners[3].servicePrincipalId}:secret:${owners[3].harnessAuth.source.id}`,
      ].sort(),
    );
  },
);

test(
  "revision dispatch refuses a different selected Secret Driver before binding or activating the Agent",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("changed-secret-owner");
    const candidate = await fixture.revision(owner, 1);
    // Installation composition changed after admission. The revision remains
    // pinned to its admitted Secret Driver and cannot use the replacement.
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async bindAgent() {
          effects.push("bind");
        },
        async prepareRevision(revision) {
          effects.push("prepare");
          return fixture.compute.prepareRevision(revision);
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      (drivers) => ({
        ...drivers,
        installation: {
          ...drivers.installation,
          drivers: {
            ...drivers.installation.drivers,
            secret: { ...drivers.installation.drivers.secret, id: "secret-replacement" },
          },
        },
        secretDriver: { ...drivers.secretDriver, id: "secret-replacement" },
      }),
    );
    await fixture.work(candidate, "failed_permanent");
    assert.deepEqual(effects, []);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, undefined);
    const work = await fixture.observerPool.query(
      "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
      [candidate.id],
    );
    assert.equal(work.rows[0].reason_code, "SECRET_DRIVER_MISMATCH");
  },
);

test(
  "revision dispatch never substitutes a later ChatGPT credential or reconfigured Provider for its admitted snapshot",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const provider = providerDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "credential-replaced",
    );
    await seedProviderBinding(fixture.observerPool, account);
    const owner = await fixture.agent("credential-replaced", "dedicated", account.id, provider.id);
    const candidate = await fixture.revision(owner, 1);
    await fixture.state.transact((unit) =>
      unit.serviceAccounts.updateCredential(fixture.namespace.id, account.id, {
        kind: "access_token",
        secretRef: { name: "later-issued-account-credential", key: "access-token" },
      }),
    );
    const changedWorkspace = "22222222-2222-4222-8222-222222222222";
    const workspaceAccount = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "workspace-replaced",
    );
    await seedProviderBinding(fixture.observerPool, workspaceAccount);
    const workspaceOwner = await fixture.agent(
      "workspace-replaced",
      "dedicated",
      workspaceAccount.id,
      provider.id,
    );
    const workspaceCandidate = await fixture.revision(workspaceOwner, 1);
    // Reconfiguring the selected Provider cannot move an admitted credential
    // across workspaces; the private source owner remains unchanged.
    const effects = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          effects.push(revision.id);
          return fixture.compute.prepareRevision(revision);
        },
      },
      () => {},
      undefined,
      [providerDefinition({ workspaceId: changedWorkspace })],
    );
    await fixture.work(candidate, "failed_permanent");
    await fixture.work(workspaceCandidate, "failed_permanent");
    assert.deepEqual(effects, []);
    const snapshot = await fixture.state.read((view) =>
      view.revisions.findRevision(fixture.namespace.id, owner.id, candidate.id),
    );
    assert.deepEqual(snapshot.harnessAuth.credential, account.credential);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, undefined);
  },
);

test(
  "runtime auth persists only its method and worker reauthorizes deployment without resolving credentials",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("runtime-owner", "embedded", undefined, null, false, true);
    const denied = await fixture.agent("runtime-denied", "embedded", undefined, null, false, true);
    const admitted = await fixture.revision(owner, 1);
    const deniedRevision = await fixture.revision(denied, 1);
    // Revoke deployment after admission: runtime does not bypass worker reauthorization.
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
     VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, denied.id],
    );
    const prepared = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, dispatch) {
          assert.deepEqual(dispatch.harnessAuth, { method: "runtime" });
          assert.deepEqual(dispatch.secretEnvironment, []);
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, dispatch);
        },
      },
      () => {},
      undefined,
      [],
      fixture.workerPool,
      (drivers) => ({
        ...drivers,
        secretDriver: {
          ...drivers.secretDriver,
          resolve() {
            assert.fail("runtime must not resolve an OCC credential");
          },
        },
      }),
    );
    await fixture.work(admitted, "succeeded");
    await fixture.work(deniedRevision, "failed_permanent");
    assert.ok(prepared.includes(admitted.id));
    assert.ok(!prepared.includes(deniedRevision.id));
    const persisted = await fixture.state.read((view) =>
      view.revisions.findRevision(fixture.namespace.id, owner.id, admitted.id),
    );
    assert.deepEqual(persisted.harnessAuth, { method: "runtime" });
    assert.ok(Object.isFrozen(persisted.harnessAuth));
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, admitted.id);
    // The database grammar rejects credential smuggling independently of the API grammar.
    for (const extra of [
      { source: {} },
      { serviceAccountId: "account" },
      { secretDriverId: "driver" },
      { value: "key" },
    ]) {
      await assert.rejects(
        fixture.observerPool.query(
          "UPDATE occ.agents SET harness_auth = $1::jsonb WHERE namespace_id = $2 AND id = $3",
          [JSON.stringify({ method: "runtime", ...extra }), fixture.namespace.id, owner.id],
        ),
        (error) => error.code === "23514",
      );
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

async function waitFor(description, read, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

const hasCutover = (work) => work?.cutover_started_at != null;
const queuedCutover = (work) => work?.state === "queued" && hasCutover(work);

function assertCutoverCleared(work) {
  assert.equal(work.cutover_started_at, null);
  assert.equal(work.cutover_expected_active_revision_id, null);
}

const revisionEffect = (action, revision, active) => ({
  action,
  revisionId: revision.id,
  activeRevisionId: active?.id ?? null,
});

// Only the remote process protocol is substituted; each call constructs a fresh
// real SSH Driver whose ownership checks and bindings are exercised by the worker.
async function sshDrivers(context, namespace, onOperation) {
  const { SshComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
  const directory = await mkdtemp(join(tmpdir(), "occ-worker-ssh-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const identityFile = join(directory, "identity");
  const knownHostsFile = join(directory, "known_hosts");
  await Promise.all([writeFile(identityFile, "fixture"), writeFile(knownHostsFile, "fixture")]);
  const operations = [];
  const options = {
    ssh: { identityFile, knownHostsFile },
    hosts: { [namespace.name]: { address: "127.0.0.1", user: "root" } },
    runtime: {
      nodePath: process.execPath,
      openclawPath: "/opt/openclaw/index.js",
      user: "openclaw",
      root: "/var/lib/openclaw-enterprise",
    },
    network: { gatewayPortRange: { start: 18800, end: 18899 } },
  };
  const executor = {
    async execute(command) {
      const operation = JSON.parse(Buffer.from(command.operation, "base64").toString());
      operations.push(operation);
      await onOperation(operation);
      return { code: 0, stdout: JSON.stringify({ ok: true, ready: true }), stderr: "" };
    },
  };
  return { operations, createDriver: () => new SshComputeDriver(options, { executor }) };
}

async function setup(context, computeDriver) {
  const [
    { Pool },
    { createControllerWorker },
    { createDevelopmentComputeDriver },
    { createAuthPrincipalSeed, NativeIAMDriver },
    { DEVELOPMENT_HARNESS_DESCRIPTOR, PRODUCTION_HARNESS_DESCRIPTOR },
    { PostgresPlatformState },
    { PostgresWorkQueue },
    { createTestConfigurationDriver },
    { createHarnessConfiguration },
    { createInstallationDriverConfiguration },
    { createTestSecretDriver },
    { createDevelopmentIAMState },
    { admitLoggingConfiguration },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("./development.mjs"),
    import("../../packages/iam/src/index.ts"),
    import("../../apps/controller/src/composition/production-harness.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../../packages/occ/src/state/postgres-work-queue.ts"),
    import("./configuration-driver.mjs"),
    import("./harness-configuration.mjs"),
    import("./installation-driver-configuration.mjs"),
    import("./secret-driver.mjs"),
    import("./development-iam-state.mjs"),
    import("../../packages/contracts/src/index.ts"),
  ]);

  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(observerPool);
  let worker;

  async function stop() {
    const current = worker;
    worker = undefined;
    if (current !== undefined) await current.stop();
  }

  context.after(async () => {
    await stop();
    await observerPool.end();
  });

  let installation = await state.loadInstallation();
  if (installation === undefined) {
    installation = {
      id: `ins_${randomUUID()}`,
      name: "Before-commit Compute Driver integration",
      createdAt: new Date().toISOString(),
    };
    state.setBootstrapNativeIAM(
      createDevelopmentIAMState(
        createAuthPrincipalSeed(installation.id, "before-commit-worker-integration", {
          id: `account-before-commit-${randomUUID()}`,
        }),
      ),
    );
    await state.transact((unit) => unit.installations.createInstallation(installation));
  }

  const iam = await state.loadNativeIAMState();
  const deployRoles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        permissions.some(
          ({ action, resourceKind }) => action === "deploy" && resourceKind === "agent",
        ),
      )
      .map(({ id }) => id),
  );
  const actor = iam.identities.find(
    ({ id, kind }) =>
      kind === "principal" &&
      iam.bindings.some(
        (binding) =>
          binding.subjectKind === "identity" &&
          binding.subjectId === id &&
          binding.namespaceId === undefined &&
          binding.resourceKind === undefined &&
          deployRoles.has(binding.roleId),
      ),
  );
  assert.ok(actor, "persisted IAM must contain an unrestricted Agent-deploy Principal");

  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `before-commit-worker-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await state.transact((unit) => unit.namespaces.createNamespace(namespace));
  const compute = computeDriver ?? createDevelopmentComputeDriver();

  async function agent(executionMode = "dedicated") {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const harnessId = executionMode === "dedicated" ? "codex" : "openclaw";
    return state.transact(async (unit) => {
      await unit.configurations.createConfiguration({
        id: configurationId,
        namespaceId: namespace.id,
        kind: "agent",
        generation: 1,
        values: createHarnessConfiguration(harnessId, "gpt-4.1"),
        createdAt: new Date().toISOString(),
      });
      return unit.agents.createAgent({
        id,
        namespaceId: namespace.id,
        name: `singleton-runtime-${randomUUID()}`,
        configurationId,
        providerId: null,
        executionMode,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async function revision(owner, number) {
    const harness =
      owner.executionMode === "dedicated"
        ? { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" }
        : { ...DEVELOPMENT_HARNESS_DESCRIPTOR, mode: "embedded" };
    const candidate = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: number,
      configuration: admitLoggingConfiguration(
        createHarnessConfiguration(harness.id, "gpt-4.1"),
        "info",
      ),
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      providerId: null,
      harness,
      compute: { id: compute.id, implementation: compute.implementation },
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

  async function requestStop(owner) {
    const idempotencyKey = `agent:${owner.id}:reconcile:stopped:${randomUUID()}`;
    await state.transactWithQueue(async (unit, queue) => {
      const current = await unit.agents.lockAgent(namespace.id, owner.id);
      assert.ok(current);
      await unit.agents.transitionAgentDesiredRuntimeState(
        namespace.id,
        owner.id,
        current.desiredRuntimeState,
        "stopped",
      );
      await queue.enqueue({
        idempotencyKey,
        namespaceId: namespace.id,
        agentId: owner.id,
        agentTarget: "stopped",
        actorId: actor.id,
        availableAt: new Date(0),
      });
    });
    return { id: owner.id, idempotencyKey };
  }

  async function activeRevision(owner) {
    const current = await observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, owner.id],
    );
    assert.equal(current.rowCount, 1);
    return current.rows[0].active_revision_id;
  }

  async function readWork(candidate) {
    const current = await observerPool.query(
      `SELECT state, attempt_count, completed_at, cutover_started_at,
              cutover_expected_active_revision_id
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    return current.rows[0];
  }

  async function waitForWork(
    candidate,
    matches,
    description = `work for ${candidate.id}`,
    timeoutMs = 10_000,
  ) {
    return waitFor(
      description,
      async () => {
        const current = await readWork(candidate);
        return current !== undefined && (await matches(current)) ? current : undefined;
      },
      timeoutMs,
    );
  }

  const work = (candidate, expected = "succeeded", timeoutMs = 10_000) =>
    waitForWork(
      candidate,
      (row) => row.state === expected,
      `revision ${candidate.id} to become ${expected}`,
      timeoutMs,
    );

  async function revokeDeploy(owner) {
    await observerPool.query(
      `INSERT INTO occ.iam_restrictions (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, namespace.id, owner.id],
    );
  }

  async function reconcileReasons(candidate, outcome) {
    const result = await observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile'
         AND ($2::text IS NULL OR outcome = $2)
       ORDER BY occurred_at`,
      [candidate.id, outcome ?? null],
    );
    return result.rows.map(({ reason }) => reason);
  }

  function driver(overrides = {}) {
    return {
      ...compute,
      async preflight() {},
      ...overrides,
    };
  }

  function recordEffects(owner, overrides = {}) {
    const selected = driver(overrides);
    const effects = [];
    const observed = { ...selected };
    for (const action of ["prepare", "activate", "deactivate", "retire"]) {
      const method = `${action}Revision`;
      if (typeof selected[method] !== "function") continue;
      observed[method] = async (candidate, ...args) => {
        effects.push({
          action,
          revisionId: candidate.id,
          activeRevisionId: await activeRevision(owner),
        });
        return selected[method](candidate, ...args);
      };
    }
    return { driver: observed, effects };
  }

  function createWorker(
    computeDriver,
    leaseDurationMs = 30_000,
    convergenceTimeoutMs = 900_000,
    mode = "production",
  ) {
    const configuration = createInstallationDriverConfiguration();
    const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
    configuration.drivers.compute.id = computeDriver.id;
    return createControllerWorker({
      pool: workerPool,
      mode,
      drivers: {
        installation: configuration,
        computeDriver,
        configurationDriver: createTestConfigurationDriver({
          id: configuration.drivers.configuration.id,
        }),
        secretDriver: createTestSecretDriver({
          id: configuration.drivers.secret.id,
        }),
        createIAMDriver(platformState) {
          return new NativeIAMDriver(platformState, {
            id: configuration.drivers.iam.id,
            implementation: "native",
          });
        },
      },
      pollIntervalMs: 15,
      leaseDurationMs,
      convergenceTimeoutMs,
      maxAttempts: 5,
      emit() {},
    });
  }

  function start(
    computeDriver,
    leaseDurationMs = 30_000,
    convergenceTimeoutMs = 900_000,
    mode = "production",
  ) {
    assert.equal(worker, undefined, "the previous worker must be stopped before restart");
    worker = createWorker(computeDriver, leaseDurationMs, convergenceTimeoutMs, mode);
    return worker.start();
  }

  return {
    observerPool,
    namespace,
    actor,
    PostgresWorkQueue,
    compute,
    agent,
    revision,
    activeRevision,
    requestStop,
    readWork,
    waitForWork,
    revokeDeploy,
    reconcileReasons,
    driver,
    recordEffects,
    work,
    createWorker,
    start,
    startWith: (overrides, ...options) => start(driver(overrides), ...options),
    stop,
  };
}

export {
  requiresPostgres,
  setup,
  waitFor,
  hasCutover,
  queuedCutover,
  assertCutoverCleared,
  sshDrivers,
  revisionEffect,
};

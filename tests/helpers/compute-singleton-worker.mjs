import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { grantAgentSecretOperate } from "./postgres-harness-auth.mjs";
import { waitFor } from "./wait-for.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const requiresPostgres = {
  skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to run real PostgreSQL integration tests.",
};

async function setup(context) {
  const [
    { Pool },
    { createControllerWorker },
    { createDevelopmentComputeDriver },
    { createAuthPrincipalSeed, NativeIAMDriver },
    { PRODUCTION_HARNESS_DESCRIPTOR },
    { PostgresPlatformState },
    { createTestConfigurationDriver },
    { createInstallationDriverConfiguration },
    { createTestSecretDriver },
    { createDevelopmentIAMState },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/worker.ts"),
    import("../helpers/development.mjs"),
    import("../../packages/iam/src/index.ts"),
    import("../../apps/controller/src/composition/production-harness.ts"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../helpers/configuration-driver.mjs"),
    import("../helpers/installation-driver-configuration.mjs"),
    import("../helpers/secret-driver.mjs"),
    import("../helpers/development-iam-state.mjs"),
  ]);

  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const workerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const state = new PostgresPlatformState(observerPool);
  let worker;
  context.after(async () => {
    if (worker === undefined) {
      await workerPool.end();
    } else {
      await worker.stop();
    }
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
        createAuthPrincipalSeed(
          installation.id,
          "before-commit-worker-integration",
          {
            id: `account-before-commit-${randomUUID()}`,
          },
          { grant: "administrator" },
        ),
      ),
    );
    await state.transact((unit) => unit.installations.createInstallation(installation));
  }

  const iam = await state.loadNativeIAMState();
  const deployRoles = new Set(
    iam.roles
      .filter(({ permissions }) =>
        [
          ["deploy", "agent"],
          ["read", "configuration"],
          ["operate", "secret"],
        ].every(([action, resourceKind]) =>
          permissions.some(
            (permission) =>
              permission.action === action && permission.resourceKind === resourceKind,
          ),
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
  const compute = createDevelopmentComputeDriver();
  const configuration = createInstallationDriverConfiguration();
  const secretDriver = createTestSecretDriver({ id: configuration.drivers.secret.id });

  async function agent() {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const secret = {
      id: `sec_${randomUUID()}`,
      namespaceId: namespace.id,
      name: `model-key-${randomUUID()}`,
    };
    // Worker lifecycle proof uses a real persisted source and independent Agent
    // grant; the passive Secret backend owns only synthetic fixture values.
    const backendRef = await secretDriver.create(secret, "singleton-worker-fixture-key");
    const harnessAuth = {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: secret.id },
    };
    const owner = await state.transact(async (unit) => {
      await unit.secrets.createSecret({
        ...secret,
        driverId: secretDriver.id,
        backendRef,
        createdAt: new Date().toISOString(),
      });
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
        name: `singleton-runtime-${randomUUID()}`,
        configurationId,
        backendId: null,
        harnessAuth,
        tags: {},
        executionMode: "dedicated",
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
    await grantAgentSecretOperate(observerPool, owner, secret.id);
    return owner;
  }

  async function revision(owner, number) {
    const candidate = {
      id: `rev_${randomUUID()}`,
      namespaceId: namespace.id,
      agentId: owner.id,
      revision: number,
      configuration: { revision: String(number) },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      backendId: null,
      tags: {},
      harness: { ...PRODUCTION_HARNESS_DESCRIPTOR, mode: "dedicated" },
      compute: { id: compute.id, implementation: compute.implementation },
      harnessAuth: { ...owner.harnessAuth, secretDriverId: secretDriver.id },
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

  async function activeRevision(owner) {
    const current = await observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [namespace.id, owner.id],
    );
    assert.equal(current.rowCount, 1);
    return current.rows[0].active_revision_id;
  }

  async function work(candidate, expected = "succeeded") {
    return waitFor(`revision ${candidate.id} to become ${expected}`, async () => {
      const current = await observerPool.query(
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      return current.rows[0]?.state === expected ? current.rows[0] : undefined;
    });
  }

  function start(
    computeDriver,
    leaseDurationMs = 30_000,
    convergenceTimeoutMs = 900_000,
    mode = "production",
    emit = () => {},
    metrics,
  ) {
    configuration.drivers.compute.id = computeDriver.id;
    worker = createControllerWorker({
      metrics,
      pool: workerPool,
      mode,
      drivers: {
        installation: configuration,
        computeDriver,
        configurationDriver: createTestConfigurationDriver({
          id: configuration.drivers.configuration.id,
        }),
        secretDriver,
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
      emit,
    });
    return worker.start();
  }

  return {
    observerPool,
    namespace,
    actor,
    compute,
    agent,
    revision,
    activeRevision,
    work,
    start,
    async stop() {
      await worker.stop();
    },
  };
}

export { requiresPostgres, setup };

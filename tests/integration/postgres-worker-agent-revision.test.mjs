import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareFile } from "../../scripts/ci/prepare.mjs";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { OpenShellAdmissionLimitError } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  ActivationFailedError,
  ActivationPendingError,
  DependencyUnavailableError,
  PostgresMetricsSnapshot,
  SandboxRevisionUnsupportedError,
  TransientDependencyError,
} from "../../packages/occ/src/index.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import {
  authorizedPrincipal,
  createAccessTokenServiceAccount,
  createBackendWorkerDrivers,
  createBackendController,
  ensureInstallation,
  poolWithOneBackendBindingReadFault,
  backendDefinition,
  requiresPostgres,
  seedBackendBinding,
} from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";

// Each test owns a database (Work claims span one), copied from one migrated template
// per file rather than migrated again. Nothing connects to the template itself. A failed
// template preparation is not cached: the next test retries it, and cleanup ignores it.
let template;
after(async () => {
  await (await template?.catch(() => undefined))?.cleanup();
});

// The worker emits worker.completed after its queue transaction commits, so another
// connection can see the committed Work state first. Wait for the event instead of
// reading the event list once.
function completion(events, description, predicate) {
  return waitFor(description, async () => events.find(predicate));
}

async function prepareDatabase(context) {
  assert.ok(
    process.env.OPENCLAW_ENTERPRISE_CI_STATE,
    "Worker tests require an owned PostgreSQL fixture; see docs/testing/postgresql.md.",
  );
  const fixture = {
    lane: "postgres-application",
    file: fileURLToPath(import.meta.url),
    statePath: process.env.OPENCLAW_ENTERPRISE_CI_STATE,
  };
  template ??= prepareFile(fixture).catch((error) => {
    template = undefined;
    throw error;
  });
  const prepared = await prepareFile({
    ...fixture,
    template: (await template).env.OCC_TEST_DATABASE_URL,
  });
  const pools = new Set();
  const workers = new Set();
  let disposal;
  function dispose() {
    return (disposal ??= (async () => {
      // Work claims span the entire database. Join every worker owned by this
      // fixture before dropping it; never rewrite another worker's live claim.
      for (const worker of workers) {
        await worker.stop();
      }
      for (const pool of pools) {
        if (!pool.ended) {
          await pool.end();
        }
      }
      await prepared.cleanup();
    })());
  }
  context.after(dispose);
  return { url: prepared.env.OCC_TEST_DATABASE_URL, pools, workers, dispose };
}

async function setup(
  context,
  {
    database,
    leaseDurationMs = 30_000,
    maxAttempts = 5,
    onHealthy,
    onProgress,
    metrics,
    repoDriver,
    secretAuthMethod = "api_key",
  } = {},
) {
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
  database ??= await prepareDatabase(context);
  function createPool(max) {
    const pool = new Pool({ connectionString: database.url, max });
    database.pools.add(pool);
    return pool;
  }
  const observerPool = createPool(8);
  const createWorkerPool = () => createPool(1);
  let workerPool = createWorkerPool();
  const state = new PostgresPlatformState(observerPool);
  const installation = await ensureInstallation(state, "revision-worker");
  const actor = authorizedPrincipal(await state.loadNativeIAMState(), [
    ["deploy", "agent"],
    ["delete", "agent"],
    ["delete", "secret"],
  ]);
  assert.ok(
    actor,
    "persisted IAM must contain a Principal authorized for Agent lifecycle and Secret cleanup",
  );

  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `revision-worker-${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  let worker;
  await state.transact((unit) => unit.namespaces.createNamespace(namespace));
  const compute = {
    ...createDevelopmentComputeDriver(),
    ...(repoDriver === undefined
      ? {}
      : {
          validateRepositoryCredentials(harness, sandboxDriverId) {
            assert.equal(harness.mode, "embedded");
            assert.equal(sandboxDriverId, undefined);
          },
        }),
  };
  const secretDriver = createBackendWorkerDrivers(compute, []).secretDriver;
  const controller = createBackendController({ installation, state }, { backends: [] });
  controller.registerDriver(secretDriver);
  controller.selectDriver("secret", secretDriver.id);
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
    backendId = null,
    grantHarnessSecret = true,
    runtimeAuth = false,
    credentialSource = false,
  ) {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    let harnessAuth;
    if (runtimeAuth) {
      harnessAuth = { method: "runtime" };
    } else if (credentialSource) {
      // A gateway-held model key, as registration leaves it once the gateway confirms its copy.
      const source = {
        id: `cs_${randomUUID()}`,
        namespaceId: namespace.id,
        name: `${label}-${randomUUID()}`,
        type: "openai",
        config: {},
        secrets: {},
        driverId: CREDENTIAL_GATEWAY_FIXTURE_ID,
        state: "registering",
        createdAt: new Date().toISOString(),
      };
      await state.transact(async (unit) => {
        await unit.credentialSources.createCredentialSource(source);
        await unit.credentialSources.markCredentialSourceReady(namespace.id, source.id);
      });
      harnessAuth = { method: "credential_source", sourceId: source.id };
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
        method: secretAuthMethod,
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
        backendId,
        harnessAuth,
        executionMode,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
    if (harnessAuth.method === "credential_source") {
      // Deployment requires the Agent, like the deploying actor, to operate its source.
      const sourceRoleId = `role-${randomUUID()}`;
      await observerPool.query(
        `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          sourceRoleId,
          namespace.id,
          `Credential sources ${randomUUID()}`,
          JSON.stringify([{ action: "operate", resourceKind: "credential_source" }]),
        ],
      );
      await observerPool.query(
        `INSERT INTO occ.iam_access_bindings
          (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
         VALUES ($1, $2, $3, NULL, $4, 'credential_source', $5)`,
        [
          `binding-${randomUUID()}`,
          namespace.id,
          owner.servicePrincipalId,
          sourceRoleId,
          harnessAuth.sourceId,
        ],
      );
    }
    if (
      (harnessAuth.method === "api_key" || harnessAuth.method === "codex_pat") &&
      grantHarnessSecret
    ) {
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

  async function revision(
    owner,
    number,
    harness,
    repositoryCredentials,
    actorId = actor.id,
    plugins,
  ) {
    let harnessAuth;
    if (owner.harnessAuth.method === "runtime") {
      harnessAuth = owner.harnessAuth;
    } else if (owner.harnessAuth.method === "credential_source") {
      const source = await state.read((view) =>
        view.credentialSources.findCredentialSource(namespace.id, owner.harnessAuth.sourceId),
      );
      harnessAuth = {
        method: "credential_source",
        sourceId: source.id,
        credentialGatewayId: source.driverId,
        sourceType: source.type,
        loginMode: "api_key",
      };
    } else if (owner.harnessAuth.method === "chatgpt_service_account") {
      const account = await state.read((view) =>
        view.serviceAccounts.findServiceAccount(namespace.id, owner.harnessAuth.serviceAccountId),
      );
      const backendBinding = await state.read((view) =>
        view.serviceAccounts.findServiceAccountBackendBinding(namespace.id, account.id),
      );
      harnessAuth = { ...owner.harnessAuth, credential: account.credential, backendBinding };
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
      backendId: owner.backendId,
      configuration: { revision: String(number) },
      configurationId: owner.configurationId,
      configurationKind: "agent",
      configurationGeneration: 1,
      harness: approvedHarness,
      compute: { id: compute.id, implementation: compute.implementation },
      ...(plugins === undefined ? {} : { plugins }),
      harnessAuth,
      servicePrincipalId: owner.servicePrincipalId,
      ...(repositoryCredentials === undefined ? {} : { repositoryCredentials }),
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      // Match production Namespace→Agent admission order so queue foreign keys
      // cannot deadlock with a worker holding the Namespace while locking the Agent.
      await unit.namespaces.lockNamespace(namespace.id);
      await unit.agents.lockAgent(namespace.id, owner.id);
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
        actorId,
        availableAt: new Date(0),
      });
    });
    return { ...candidate, idempotencyKey };
  }

  async function work(candidate, expected, timeoutMs) {
    return waitFor(
      `revision ${candidate.id} to become ${expected}`,
      async () => {
        const rows = await observerPool.query(
          "SELECT state, claim_token, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        return rows.rows[0]?.state === expected ? rows.rows[0] : undefined;
      },
      timeoutMs,
    );
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

  async function requestDeletion(owner) {
    const idempotencyKey = `agent:${owner.id}:reconcile:deleted`;
    await controller.deleteAgent(actor.id, namespace.id, owner.id);
    return { id: owner.id, idempotencyKey };
  }

  function start(
    computeDriver,
    emit = () => {},
    convergenceTimeoutMs,
    providers,
    pool = workerPool,
    transformDrivers = (drivers) => drivers,
  ) {
    const configuredDrivers = createBackendWorkerDrivers(computeDriver, providers ?? []);
    const drivers = transformDrivers({
      ...configuredDrivers,
      secretDriver,
      ...(repoDriver === undefined ? {} : { repoDriver }),
    });
    worker = createControllerWorker({
      metrics,
      pool,
      pollIntervalMs: 15,
      leaseDurationMs,
      maxAttempts,
      onHealthy,
      onProgress,
      ...(drivers === undefined ? { computeDriver } : { drivers }),
      ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
      emit,
    });
    database.workers.add(worker);
    return worker.start();
  }

  async function stop() {
    if (worker !== undefined) {
      await worker.stop();
      worker = undefined;
      workerPool = createWorkerPool();
    }
  }

  return {
    database,
    installation,
    controller,
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
    requestDeletion,
    requestStop,
    work,
    start,
    stop,
    createWorkerPool,
    workerPool,
  };
}

const CREDENTIAL_GATEWAY_FIXTURE_ID = "credential-gateway-worker-fixture";

// Selects a paired Sandbox and Credential Gateway so the worker admits credential-source
// revisions. Compute stands in for the gateway calls; these doubles only identify the pair.
function withCredentialGateway(drivers) {
  const sandboxDriver = {
    id: "sandbox-worker-fixture",
    capability: "sandbox",
    implementation: "sandbox-worker-fixture",
    facets: ["networking"],
    async cleanup() {},
  };
  const credentialGatewayDriver = {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    capability: "credential_gateway",
    implementation: "credential-gateway-worker-fixture",
    async listSourceTypes() {
      return [];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async updateSource() {
      return { state: "ready" };
    },
    async rotateSource() {
      return { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async removeSource() {},
    async attachForRevision() {
      return [];
    },
    async attachmentStatus() {
      return [];
    },
    async withdraw(context) {
      return { sourceId: context.sourceId, state: "pending" };
    },
  };
  return {
    ...drivers,
    installation: {
      ...drivers.installation,
      drivers: {
        ...drivers.installation.drivers,
        sandbox: { id: sandboxDriver.id, configuration: {} },
        credential_gateway: { id: credentialGatewayDriver.id, configuration: {} },
      },
    },
    sandboxDriver,
    credentialGatewayDriver,
  };
}

function codexPluginRevisionState(pluginId) {
  return {
    driver: { id: "codex-plugin", implementation: "occ/codex-plugin" },
    plugins: {
      [pluginId]: {
        enabled: true,
        toolDefaults: { approval: "provider_default" },
      },
    },
  };
}

// Model the next cleanup interval without waiting an hour for the boundary
// Driver. Change only this revision's queued due times; claims remain real.
async function advanceCleanupRetries(fixture, revision) {
  await fixture.observerPool.query(
    `UPDATE occ.controller_work SET available_at = clock_timestamp()
     WHERE state = 'queued' AND idempotency_key LIKE $1`,
    [`agent_revision:${revision.id}:repository_cleanup:%`],
  );
}

// This boundary Driver supplies protocol observations. The real worker, native
// IAM, State, and PostgreSQL queue own every lifecycle decision asserted below;
// these cases do not qualify the concrete credential service or Compute runtime.
function repositoryBoundary({ count = 1, deadlineWallMs = Date.now() + 120_000 } = {}) {
  const bindings = Array.from({ length: count }, (_, index) => ({
    repositoryRef: `repository-${index}-${randomUUID()}`,
    profile: "read",
    backendId: "repository-provider",
    grant: {
      providerInstanceId: "repository-provider-instance",
      repositoryId: `repository-${index}`,
      grantId: `grant-${index}`,
    },
  }));
  const admissions = new Map();
  const sessions = new Map();
  const calls = [];
  const driver = {
    id: "repository-worker-boundary",
    implementation: "repository-worker-boundary",
    capability: "repo",
    maintenanceIntervalMs: 3_600_000,
    async listOptions() {
      return { options: [], descriptionsPending: false };
    },
    resolve() {
      return { bindings, sessionDurationSeconds: 60 };
    },
    async open(input, signal) {
      calls.push({ operation: input.recoverOnly ? "recover" : "open", input, signal });
      const existing = admissions.get(input.admissionId);
      if (existing !== undefined) {
        return { kind: "recovered", status: existing };
      }
      if (input.recoverOnly) {
        return { kind: "missing" };
      }
      const session = {
        sessionId: `session_${randomUUID()}`,
        state: "OPEN",
        deadlineWallMs: Math.min(Date.now() + input.durationSeconds * 1000, input.deadlineWallMs),
        binding: input.binding.grant,
      };
      admissions.set(input.admissionId, session);
      sessions.set(session.sessionId, session);
      return {
        kind: "created",
        session,
        files: encodeRepositoryCredentialSessionFiles({
          session,
          bearer: `worker_boundary_bearer_${randomUUID().replaceAll("-", "")}`,
          client: {
            gatewayOrigin: "https://repository-gateway.example.test",
            gitRemote: "https://repository-gateway.example.test/organization/repository.git",
            gitUsername: "repository-session",
            canonicalApiHost: "api.example.test",
            apiHost: "repository-gateway.example.test",
            repository: "organization/repository",
          },
        }),
      };
    },
    async status(sessionId) {
      calls.push({ operation: "status", sessionId });
      return sessions.get(sessionId);
    },
    async close(sessionId) {
      calls.push({ operation: "close", sessionId });
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return undefined;
      }
      const disposed = { ...session, state: "DISPOSED" };
      sessions.set(sessionId, disposed);
      for (const [admissionId, admitted] of admissions) {
        if (admitted.sessionId === sessionId) {
          admissions.set(admissionId, disposed);
        }
      }
      return disposed;
    },
  };
  return {
    driver,
    calls,
    snapshot: {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs,
      bindings,
    },
  };
}

async function coldSshComputeDriver(fixture, operations) {
  const { SshComputeDriver } =
    await import("../../apps/controller/src/drivers/compute/ssh/index.ts");
  return new SshComputeDriver(
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
}

function repositoryAttempts(fixture, revision) {
  return fixture.state.read((view) =>
    view.repositorySessions.listRevisionAttempts({
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
    }),
  );
}

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
      const activated = await second.state.read((view) =>
        view.agents.findAgent(second.namespace.id, owner.id),
      );
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
    const first = await fixture.agent("waiting-first", "dedicated");
    const second = await fixture.agent("waiting-second", "dedicated");
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

test(
  "exclusive replacement blocks overlap, supersedes old maintenance and recovers through a new revision",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("exclusive-workspace", "dedicated");
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
    await fixture.start(compute, undefined, 3_000);
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
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, recovery.id);
  },
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

test(
  "exclusive replacement stops each predecessor once across pending passes and maintenance",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("exclusive-sweep-once", "dedicated");
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
      const owner = await fixture.agent(`exclusive-resurrection-${label}`, "dedicated");
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
      const current = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
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
    const owner = await fixture.agent("no-repository-capability");
    const candidate = await fixture.revision(owner, 1);
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
    const first = await fixture.agent("before-silence");
    const before = await fixture.revision(first, 1);
    await fixture.start(fixture.compute, undefined, undefined, undefined, pool);
    await fixture.work(before, "succeeded");

    // Every pooled connection now swallows queries without an answer or an error.
    proxy.silence();
    const second = await fixture.agent("after-silence");
    const after = await fixture.revision(second, 1);
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
    await fixture.start(fixture.compute, undefined, undefined, undefined, pool);
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
    const incompatible = await fixture.revision(owner, 1, undefined, selection);
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials() {},
      },
      () => {},
      undefined,
      undefined,
      fixture.workerPool,
      (drivers) => ({ ...drivers, repoDriver: driver }),
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
    const uncertain = await fixture.revision(owner, 2, undefined, selection);
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
    const compatible = await fixture.revision(owner, 3, undefined, selection);
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
  "worker revalidates admitted repository selections through the concrete GitHub Driver and Unix control",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const fixture = await setup(context);
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
    ]);
    const clock = createControlledClock();
    const startedWall = clock.wallNow();
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      // Worker admission IDs use real wall time. Preserve that progress while
      // allowing this fixture's provider-retirement expiry to advance explicitly.
      clock: { ...clock, wallNow: () => Date.now() + clock.wallNow() - startedWall },
      gateway: { listen: "127.0.0.1:0" },
    });
    const driver = new GitHubRepoDriver(
      {
        id: credentials.backendId,
        client: new UnixRepositoryCredentialControlClient({
          controlSocket: credentials.config.gateway.controlSocket,
        }),
        drivers: { repo: "repository-credentials" },
      },
      credentials.registry,
      { sessionDurationSeconds: 60, publicCa: credentials.tls.ca },
    );
    // The real resolver admits selection fields and returns the richer frozen
    // binding. Worker revalidation must project that snapshot back to selections;
    // the strict registry parser rejects backendId/grant as caller input.
    const resolution = driver.resolve({
      namespaceId: fixture.namespace.id,
      bindings: [{ repositoryRef: "repo-a", profile: "git-read" }],
    });
    // Bound admissions require the worker-owned receipt transport and its real
    // PostgreSQL state; without it the broker correctly refuses the session.
    const { startRepositoryReceiptServer } =
      await import("../../apps/controller/src/backends/repository-credentials/receipt-server.ts");
    const receiptServer = await startRepositoryReceiptServer({
      state: fixture.state,
      controlSocket: credentials.config.gateway.controlSocket,
      driverId: driver.id,
      implementation: driver.implementation,
      backendId: credentials.backendId,
    });
    context.after(() => receiptServer.close());
    const owner = await fixture.agent("repository-concrete-driver");
    const candidate = await fixture.revision(owner, 1, undefined, {
      driver: { id: driver.id, implementation: driver.implementation },
      deadlineWallMs: Date.now() + 120_000,
      bindings: resolution.bindings,
    });
    const open = driver.open.bind(driver);
    const close = driver.close.bind(driver);
    let lostSessionId;
    const closures = [];
    // Lose only the first response. The real service owns CLOSED -> DISPOSED,
    // and the real worker must wait before delivering replacement material.
    driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (lostSessionId === undefined && result.kind === "created") {
        lostSessionId = result.session.sessionId;
        throw new Error("repository admission response lost after creation");
      }
      return result;
    };
    driver.close = async (sessionId, signal) => {
      const status = await close(sessionId, signal);
      closures.push(status?.state);
      return status;
    };
    const material = [];
    const events = [];
    const retired = [];
    await fixture.start(
      {
        ...fixture.compute,
        validateRepositoryCredentials(harness, sandboxDriverId) {
          assert.equal(harness.mode, "embedded");
          assert.equal(sandboxDriverId, undefined);
        },
        async prepareRevision(revision, deploymentContext) {
          material.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
        async retireRevision(revision) {
          retired.push(revision.id);
          return fixture.compute.retireRevision(revision);
        },
      },
      (event) => events.push(event),
      undefined,
      undefined,
      fixture.workerPool,
      (drivers) => ({ ...drivers, repoDriver: driver }),
    );
    const terminal = await waitFor(
      "the concrete repository revision's terminal result",
      async () => {
        const result = await fixture.observerPool.query(
          "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        return ["succeeded", "failed_permanent"].includes(result.rows[0]?.state)
          ? result.rows[0]
          : undefined;
      },
    );
    assert.equal(
      terminal.state,
      "succeeded",
      JSON.stringify(events.filter(({ workId }) => workId === candidate.idempotencyKey)),
    );
    assert.ok(terminal.attempt_count >= 2);
    assert.equal(material.length, 1);
    assert.equal(material[0].kind, "new");
    assert.equal(material[0].repositoryRef, "repo-a");
    assert.equal(JSON.parse(material[0].files["client.json"]).sessionId, material[0].sessionId);
    assert.equal(material[0].files["ca.pem"], credentials.tls.ca.toString("utf8"));
    const status = await driver.status(material[0].sessionId, new AbortController().signal);
    assert.equal(status.state, "OPEN");
    assert.deepEqual(status.binding, resolution.bindings[0].grant);
    const attempts = await repositoryAttempts(fixture, candidate);
    assert.equal(attempts.length, 2);
    assert.equal(attempts.find(({ sessionId }) => sessionId === lostSessionId).phase, "disposed");
    assert.ok(closures.includes("CLOSED"));
    const attempt = attempts.find(({ phase }) => phase === "open");
    assert.equal(attempt.phase, "open");
    assert.equal(attempt.sessionId, status.sessionId);
    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    // Both the lost admission and the delivered session must settle even when
    // their cleanup requests share one durable work item.
    await waitFor("both concrete repository sessions to settle", async () => {
      const settled = await repositoryAttempts(fixture, candidate);
      return settled.length === 2 && settled.every(({ phase }) => phase === "disposed")
        ? true
        : undefined;
    });
    await waitFor("the concrete session's cleanup work to complete", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    await fixture.requestDeletion(owner);
    await waitFor("disposed repository evidence to outlive its Agent", async () =>
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      )) === undefined
        ? true
        : undefined,
    );
    const retained = await fixture.state.read((view) =>
      view.repositorySessions.findAttempt(attempt.admissionId),
    );
    assert.equal(retained.phase, "disposed");
    assert.equal(retained.liveRevisionId, null);
    assert.equal(retained.revisionId, candidate.id);
    assert.equal(retained.agentId, owner.id);
    assert.deepEqual(retained.cleanupContext, {
      driver: candidate.repositoryCredentials.driver,
      binding: resolution.bindings[0],
    });

    // A provider retirement response can be lost after the remote effect. Only
    // the service's eventual DISPOSED observation settles retained cleanup.
    const pendingOwner = await fixture.agent("repository-pending-deletion");
    const pendingRevision = await fixture.revision(
      pendingOwner,
      1,
      undefined,
      candidate.repositoryCredentials,
    );
    await fixture.work(pendingRevision, "succeeded");
    const pendingMaterial = material.at(-1);
    const responseStatus = await new Promise((resolve, reject) => {
      const outgoing = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: credentials.listeners.address.port,
          path: "/fixture/repository.git/info/refs?service=git-upload-pack",
          method: "GET",
          ca: credentials.tls.ca,
          agent: false,
          headers: {
            host: "credentials.example.test",
            authorization: `Basic ${Buffer.from(`gateway-session:${pendingMaterial.files.bearer}`).toString("base64")}`,
          },
        },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode));
          incoming.once("error", reject);
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
    });
    assert.equal(responseStatus, 200);
    const provider = credentials.repositories[0].github;
    assert.equal(provider.issuesOfTokens.length, 1);
    provider.disconnectAfterMutation("DELETE", "/installation/token");
    await fixture.requestDeletion(pendingOwner);
    await waitFor(
      "Agent deletion to complete while repository cleanup remains pending",
      async () =>
        retired.includes(pendingRevision.id) &&
        (await fixture.state.read((view) =>
          view.agents.findAgent(fixture.namespace.id, pendingOwner.id),
        )) === undefined
          ? true
          : undefined,
    );
    await waitFor("independent cleanup to close the deleted Agent's broker session", async () => {
      const status = await driver.status(pendingMaterial.sessionId, new AbortController().signal);
      return status?.state === "CLOSED" ? true : undefined;
    });
    const [pendingAttempt] = await repositoryAttempts(fixture, pendingRevision);
    assert.equal(pendingAttempt.phase, "closing");
    assert.equal(pendingAttempt.liveRevisionId, null);
    // Unsettled provider authority must retain durable cleanup without using
    // the foreground readiness cadence and repeatedly occupying the worker.
    const deferredCleanup = await waitFor("pending cleanup to release its claim", async () => {
      const result = await fixture.observerPool.query(
        `SELECT idempotency_key, state, claim_token, lease_expires_at,
           EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
         FROM occ.controller_work WHERE idempotency_key LIKE $1 AND state = 'queued'`,
        [`agent_revision:${pendingRevision.id}:repository_cleanup:%`],
      );
      return events.some(
        (event) =>
          event.workId === result.rows[0]?.idempotency_key &&
          event.code === "REPOSITORY_CLEANUP_PENDING",
      )
        ? result.rows[0]
        : undefined;
    });
    assert.ok(Number(deferredCleanup.delay_ms) >= driver.maintenanceIntervalMs - 1_000);
    assert.equal(deferredCleanup.claim_token, null);
    assert.equal(deferredCleanup.lease_expires_at, null);
    const nextOwner = await fixture.agent("repository-cleanup-neighbor");
    const nextRevision = await fixture.revision(
      nextOwner,
      1,
      undefined,
      candidate.repositoryCredentials,
    );
    await fixture.work(nextRevision, "succeeded");
    const scheduled = await fixture.observerPool.query(
      "SELECT state, available_at > clock_timestamp() AS deferred FROM occ.controller_work WHERE idempotency_key = $1",
      [deferredCleanup.idempotency_key],
    );
    assert.deepEqual(scheduled.rows, [{ state: "queued", deferred: true }]);
    assert.equal(
      (
        await fixture.state.read((view) =>
          view.repositorySessions.findAttempt(pendingAttempt.admissionId),
        )
      ).phase,
      "closing",
    );
    assert.equal(
      (
        await fixture.observerPool.query(
          "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key LIKE $1",
          [`agent_revision:${pendingRevision.id}:repository_cleanup:%`],
        )
      ).rows[0].count,
      1,
    );
    await clock.advance(3_600_001);
    // Advance this exact retry after provider expiry instead of waiting for
    // the real 30-second interval. The worker still claims and settles it.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1 AND state = 'queued'",
      [deferredCleanup.idempotency_key],
    );
    const settled = await waitFor(
      "settled provider cleanup to dispose retained evidence",
      async () => {
        const attempt = await fixture.state.read((view) =>
          view.repositorySessions.findAttempt(pendingAttempt.admissionId),
        );
        return attempt?.phase === "disposed" ? attempt : undefined;
      },
    );
    assert.equal(settled.phase, "disposed");
    assert.equal(settled.liveRevisionId, null);
    assert.equal(settled.deadlineWallMs, pendingAttempt.deadlineWallMs);
    assert.deepEqual(settled.cleanupContext, pendingAttempt.cleanupContext);
    assert.equal(provider.issuesOfTokens.length, 1, "deletion must never mint a replacement token");
    assert.equal(
      provider.trace.filter(
        ({ method, target }) => method === "DELETE" && target === "/installation/token",
      ).length,
      1,
      "uncertain provider retirement must not be replayed",
    );
  },
);

test(
  "repository admission persists its opening request before dispatch and session ID before Compute",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-ordering");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const open = repository.driver.open;
    repository.driver.open = async (input, signal) => {
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].phase, "opening");
      assert.equal(attempts[0].sessionId, undefined);
      assert.equal(attempts[0].admissionId, input.admissionId);
      assert.equal(attempts[0].repositoryRef, input.binding.repositoryRef);
      assert.equal(attempts[0].durationSeconds, input.durationSeconds);
      assert.equal(attempts[0].deadlineWallMs, input.deadlineWallMs);
      return open(input, signal);
    };
    const material = [];
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          const attempts = await repositoryAttempts(fixture, revision);
          const [binding] = deploymentContext.repositoryCredentials;
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0].phase, "open");
          assert.equal(attempts[0].sessionId, binding.sessionId);
          assert.equal(binding.kind, "new");
          assert.equal(binding.repositoryRef, repository.snapshot.bindings[0].repositoryRef);
          material.push(binding.files.bearer);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      (event) => events.push(event),
    );
    assert.equal((await fixture.work(candidate, "succeeded")).attempt_count, 1);
    assert.equal(material.length, 1);
    const persisted = await fixture.observerPool.query(
      `SELECT to_jsonb(attempt) AS value FROM occ.repository_session_attempts AS attempt
       WHERE revision_id = $1
       UNION ALL SELECT to_jsonb(work) FROM occ.controller_work AS work WHERE revision_id = $1
       UNION ALL SELECT to_jsonb(audit) FROM occ.audit_events AS audit WHERE namespace_id = $2`,
      [candidate.id, candidate.namespaceId],
    );
    assert.equal(JSON.stringify(persisted.rows).includes(material[0]), false);
    assert.equal(JSON.stringify(events).includes(material[0]), false);
  },
);

for (const alreadyDisposed of [false, true]) {
  test(
    alreadyDisposed
      ? "a dropped repository-open response preserves recovered disposal after service pruning"
      : "a dropped repository-open response recovers and closes its admission before opening fresh material",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const owner = await fixture.agent("repository-lost-response");
      const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
      const open = repository.driver.open;
      let lostSessionId;
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (lostSessionId === undefined && result.kind === "created") {
          lostSessionId = result.session.sessionId;
          throw new Error("repository admission response lost after creation");
        }
        if (alreadyDisposed && result.kind === "recovered") {
          return { ...result, status: { ...result.status, state: "DISPOSED" } };
        }
        return result;
      };
      if (alreadyDisposed) {
        // The service's terminal observation is authoritative even if another
        // admission prunes that inventory before a redundant close could arrive.
        repository.driver.close = async (sessionId) => {
          repository.calls.push({ operation: "close", sessionId });
          return undefined;
        };
      }
      const material = [];
      await fixture.start({
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          material.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      });
      const completed = await fixture.work(candidate, "succeeded");
      assert.equal(completed.attempt_count, 2);
      const attempts = await repositoryAttempts(fixture, candidate);
      assert.equal(attempts.find(({ sessionId }) => sessionId === lostSessionId).phase, "disposed");
      assert.deepEqual(
        repository.calls.map(({ operation }) => operation),
        alreadyDisposed ? ["open", "recover", "open"] : ["open", "recover", "close", "open"],
      );
      const [original, recovered] = repository.calls;
      const fresh = repository.calls.at(-1);
      assert.deepEqual(recovered.input, { ...original.input, recoverOnly: true });
      if (!alreadyDisposed) {
        assert.equal(repository.calls[2].sessionId, lostSessionId);
      }
      assert.notEqual(fresh.input.admissionId, original.input.admissionId);
      assert.deepEqual(fresh.input.binding, original.input.binding);
      assert.equal(fresh.input.deadlineWallMs, original.input.deadlineWallMs);
      assert.ok(fresh.input.durationSeconds <= original.input.durationSeconds);
      assert.equal(
        attempts.find(({ admissionId }) => admissionId === fresh.input.admissionId).phase,
        "open",
      );
      assert.equal(material.length, 1);
      assert.equal(material[0].kind, "new");
      assert.notEqual(material[0].sessionId, lostSessionId);
    },
  );
}

test(
  "a missing never-delivered repository opening can recover without inventing disposal",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-unseen-opening");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const open = repository.driver.open;
    let undelivered;
    repository.driver.open = async (input, signal) => {
      if (undelivered === undefined) {
        undelivered = input.admissionId;
        throw new Error("control request did not reach the service");
      }
      return open(input, signal);
    };
    const material = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        material.push(...deploymentContext.repositoryCredentials);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    await fixture.work(candidate, "succeeded");
    const attempts = await repositoryAttempts(fixture, candidate);
    const missing = attempts.find(({ admissionId }) => admissionId === undelivered);
    assert.equal(missing.phase, "invalidated");
    assert.equal(missing.sessionId, undefined);
    assert.equal(missing.liveRevisionId, candidate.id);
    assert.equal(attempts.length, 2);
    assert.equal(material.length, 1);
    assert.equal(material[0].sessionId, attempts.find(({ phase }) => phase === "open").sessionId);
    assert.deepEqual(
      repository.calls.map(({ operation }) => operation),
      ["recover", "open"],
    );
    await fixture.stop();
  },
);

test(
  "exhausted repository maintenance during a dependency outage keeps the active runtime",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    // One attempt makes the first unavailable dependency exhaust the claim, as
    // a longer outage exhausts the default retries.
    const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
    const owner = await fixture.agent("repository-maintenance-outage");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const stopped = [];
    let iamUnavailable = false;
    const compute = {
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    };
    const withUnavailableIAM = (drivers) => {
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
              if (iamUnavailable) {
                throw new Error("IAM is temporarily unavailable");
              }
              return iam.authorize(request);
            },
          };
        },
      };
    };
    const startWorker = () =>
      fixture.start(
        compute,
        () => {},
        undefined,
        undefined,
        fixture.createWorkerPool(),
        withUnavailableIAM,
      );
    await startWorker();
    await fixture.work(candidate, "succeeded");
    await fixture.stop();

    iamUnavailable = true;
    const maintenance = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(maintenance.rowCount, 1);
    const outage = { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key };
    await startWorker();
    await fixture.work(outage, "failed_permanent");
    await fixture.stop();
    const failed = await fixture.observerPool.query(
      "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [outage.idempotencyKey],
    );
    assert.equal(failed.rows[0].reason_code, "DEPENDENCY_UNAVAILABLE");
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "an outage must not retire the authorized runtime");
    assert.deepEqual(stopped, []);
    const agent = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(agent.activeRevisionId, candidate.id);
    assert.equal(agent.desiredRuntimeState, "running");

    // The maintenance chain continues, so the runtime is kept current once
    // the dependency recovers.
    iamUnavailable = false;
    const next = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(next.rowCount, 1);
    assert.notEqual(next.rows[0].idempotency_key, outage.idempotencyKey);
    await startWorker();
    await fixture.work(
      { id: candidate.id, idempotencyKey: next.rows[0].idempotency_key },
      "succeeded",
    );
    await fixture.stop();
    assert.deepEqual(stopped, []);
  },
);

test(
  "an expired exhausted repository maintenance claim keeps the active runtime",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
    const owner = await fixture.agent("repository-maintenance-lease-expiry");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const stopped = [];
    const compute = {
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();

    // A worker claims the maintenance item on its last attempt and crashes
    // before it finishes, so only lease expiry can release the claim.
    const maintenance = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(maintenance.rowCount, 1);
    const crashedKey = maintenance.rows[0].idempotency_key;
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 1,
      random: () => 0,
    });
    const crashed = await queue.claim();
    assert.equal(crashed?.idempotencyKey, crashedKey);
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
      [crashedKey, crashed.claimToken],
    );
    const recovery = await queue.recoverStale();
    assert.equal(recovery.recovered, 1);

    const failed = await fixture.observerPool.query(
      "SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1",
      [crashedKey],
    );
    assert.deepEqual(failed.rows[0], { state: "failed_permanent", reason_code: "LEASE_EXPIRED" });
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "a crashed worker must not retire the active runtime");
    const agent = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(agent.activeRevisionId, candidate.id);
    assert.equal(agent.desiredRuntimeState, "running");

    // The maintenance chain continues with the next bucket.
    const next = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key, attempt_count, actor_id`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(next.rowCount, 1);
    const bucket = BigInt(crashedKey.slice(crashedKey.lastIndexOf(":") + 1));
    assert.deepEqual(next.rows[0], {
      idempotency_key: `agent_revision:${candidate.id}:maintenance:${bucket + 1n}`,
      attempt_count: 0,
      actor_id: crashed.actorId,
    });
    await fixture.start(compute);
    await fixture.work(
      { id: candidate.id, idempotencyKey: next.rows[0].idempotency_key },
      "succeeded",
    );
    await fixture.stop();
    assert.deepEqual(stopped, []);
  },
);

for (const [name, crashes, finishFails] of [
  [
    "a deployment whose lease expires on its last attempt after publishing its revision gets one more attempt",
    1,
    false,
  ],
  [
    "a published deployment that loses its lease again fails without retiring the active runtime",
    2,
    false,
  ],
  [
    "a published deployment whose extra attempt fails ends without retiring the active runtime",
    1,
    true,
  ],
]) {
  test(name, requiresPostgres, async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver, maxAttempts: 1 });
    const owner = await fixture.agent(`publish-crash-${crashes}-${finishFails}`);
    const first = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const stopped = [];
    const retired = [];
    let iamUnavailable = false;
    const compute = {
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
      async retireRevision(revision) {
        retired.push(revision.id);
        return fixture.compute.retireRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(first, "succeeded");
    await fixture.stop();

    // A worker claims the replacement on its last attempt, publishes the active pointer and
    // crashes before activation, predecessor retirement and completion.
    const second = await fixture.revision(owner, 2, undefined, repository.snapshot);
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
      leaseDurationMs: 30_000,
      maxAttempts: 1,
      random: () => 0,
    });
    const crash = async () => {
      const claim = await queue.claim();
      assert.equal(claim?.idempotencyKey, second.idempotencyKey);
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
           SET lease_expires_at = clock_timestamp() - interval '1 second'
           WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
        [claim.idempotencyKey, claim.claimToken],
      );
      assert.equal((await queue.recoverStale()).recovered, 1);
    };
    await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(fixture.namespace.id, owner.id, first.id, second.id),
    );
    for (let crash_ = 0; crash_ < crashes; crash_ += 1) {
      await crash();
    }
    const row = async () =>
      (
        await fixture.observerPool.query(
          "SELECT state, reason_code, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
          [second.idempotencyKey],
        )
      ).rows[0];
    const retirement = await fixture.observerPool.query(
      "SELECT 1 FROM occ.controller_work WHERE idempotency_key LIKE $1",
      [`agent_revision:${second.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 0, "recovery must not retire the active runtime");
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events
         WHERE kind = 'mutation' AND action = 'reconcile' AND details->>'workId' = $1
         ORDER BY occurred_at, id`,
      [second.idempotencyKey],
    );
    if (crashes === 2) {
      // The extra attempt is granted once; a second loss ends the deployment.
      assert.deepEqual(await row(), {
        state: "failed_permanent",
        reason_code: "LEASE_EXPIRED",
        attempt_count: 1,
      });
      assert.deepEqual(evidence.rows.map(({ reason_code }) => reason_code).slice(-2), [
        "ACTIVE_REVISION_RECOVERY",
        "LEASE_EXPIRED",
      ]);
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, []);
      return;
    }
    assert.deepEqual(await row(), { state: "queued", reason_code: null, attempt_count: 0 });
    assert.equal(evidence.rows.at(-1).reason_code, "ACTIVE_REVISION_RECOVERY");
    const progress = await fixture.state.read((view) =>
      view.operations.findWorkAttempt(second.idempotencyKey),
    );
    assert.equal(progress?.code, "ACTIVE_REVISION_RECOVERY");

    if (finishFails) {
      // A retry outcome on the extra (last) attempt fails the deployment but keeps the
      // runtime it already activated.
      iamUnavailable = true;
      await fixture.start(
        compute,
        () => {},
        undefined,
        undefined,
        undefined,
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
                  if (iamUnavailable) {
                    throw new Error("IAM is temporarily unavailable");
                  }
                  return iam.authorize(request);
                },
              };
            },
          };
        },
      );
      await fixture.work(second, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(await row(), {
        state: "failed_permanent",
        reason_code: "DEPENDENCY_UNAVAILABLE",
        attempt_count: 1,
      });
      const retireAfterFailure = await fixture.observerPool.query(
        "SELECT 1 FROM occ.controller_work WHERE idempotency_key LIKE $1",
        [`agent_revision:${second.id}:repository_cleanup:retire:%`],
      );
      assert.equal(retireAfterFailure.rowCount, 0, "a failed finish must not retire the runtime");
      assert.deepEqual(stopped, []);
      assert.deepEqual(retired, []);
      return;
    }

    // A worker finishes the published deployment through the already-active path.
    await fixture.start(compute);
    await fixture.work(second, "succeeded");
    await fixture.stop();
    assert.equal((await row()).reason_code, "REVISION_ALREADY_ACTIVE");
    assert.deepEqual(retired, [first.id], "the predecessor must be retired");
    assert.deepEqual(stopped, [], "the active revision must keep running");
    const agent = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(agent.activeRevisionId, second.id);
  });
}

for (const loss of ["missing", "closed-repair"]) {
  test(
    loss === "missing"
      ? "repository missing refuses replacement after exposure and retains refusal across worker restart"
      : "repository closed-repair waits across worker restart and replaces material only after disposal",
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, {
        repoDriver: repository.driver,
        leaseDurationMs: 600,
      });
      const owner = await fixture.agent(`repository-${loss}`);
      const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
      const delivered = [];
      const stopped = [];
      let missingMaterial = false;
      const compute = {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          delivered.push(...deploymentContext.repositoryCredentials);
          const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
          return missingMaterial
            ? {
                ...observation,
                ready: false,
                repositoryCredentialMaterialMissing: [
                  {
                    repositoryRef: delivered[0].repositoryRef,
                    sessionId: delivered[0].sessionId,
                  },
                ],
              }
            : observation;
        },
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
      };
      await fixture.start(compute);
      await fixture.work(candidate, "succeeded");
      await fixture.stop();
      const [original] = await repositoryAttempts(fixture, candidate);
      const status = await repository.driver.status(original.sessionId);
      const close = repository.driver.close;
      // These are Driver protocol observations. Real PostgreSQL and worker
      // admission must refuse replacement without inferring provider settlement.
      if (loss === "missing") {
        repository.driver.status = async () => undefined;
        repository.driver.close = async () => undefined;
      } else {
        missingMaterial = true;
        repository.driver.close = async () => ({ ...status, state: "CLOSED" });
      }
      const maintenance = await fixture.observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp()
         WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
         RETURNING idempotency_key`,
        [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
      assert.equal(maintenance.rowCount, 1);
      await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
      if (loss === "closed-repair") {
        await waitFor("known closing session to retain cleanup ownership", async () => {
          const [attempt] = await repositoryAttempts(fixture, candidate);
          return attempt.phase === "closing" ? attempt : undefined;
        });
        await fixture.work(
          { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
          "failed_permanent",
        );
        await fixture.stop();
        const [pending] = await repositoryAttempts(fixture, candidate);
        assert.equal(pending.sessionId, original.sessionId);
        assert.equal(pending.liveRevisionId, candidate.id);
        assert.deepEqual(pending.cleanupContext, original.cleanupContext);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);

        // A restarted worker must still wait; CLOSED has not settled the
        // original session's provider obligations or authorized new material.
        const queued = await fixture.observerPool.query(
          `UPDATE occ.controller_work SET available_at = clock_timestamp()
           WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
           RETURNING idempotency_key`,
          [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
        );
        assert.equal(queued.rowCount, 1);
        const retry = { id: candidate.id, idempotencyKey: queued.rows[0].idempotency_key };
        await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
        await fixture.work(retry, "failed_permanent");
        await fixture.stop();
        const refusal = await fixture.observerPool.query(
          "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
          [retry.idempotencyKey],
        );
        assert.equal(refusal.rows[0].reason_code, "REVISION_FINALIZATION_INCOMPLETE");
        assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
        assert.deepEqual(stopped, []);

        // Only confirmed disposal permits the existing bounded continuation
        // to obtain a fresh session under the original revision deadline.
        repository.driver.close = close;
        missingMaterial = false;
        const continuation = await fixture.observerPool.query(
          `UPDATE occ.controller_work SET available_at = clock_timestamp()
           WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
           RETURNING idempotency_key`,
          [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
        );
        assert.ok(continuation.rowCount > 0);
        await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
        await fixture.work(
          { id: candidate.id, idempotencyKey: continuation.rows[0].idempotency_key },
          "succeeded",
        );
        await fixture.stop();
        const attempts = await repositoryAttempts(fixture, candidate);
        assert.equal(
          attempts.find(({ sessionId }) => sessionId === original.sessionId).phase,
          "disposed",
        );
        const fresh = attempts.find(({ phase }) => phase === "open");
        assert.ok(fresh);
        assert.notEqual(fresh.sessionId, original.sessionId);
        assert.notEqual(fresh.admissionId, original.admissionId);
        assert.equal(fresh.deadlineWallMs, original.deadlineWallMs);
        assert.ok(fresh.durationSeconds <= original.durationSeconds);
        assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
        assert.equal(delivered.filter(({ kind }) => kind === "new").length, 2);
        assert.deepEqual(stopped, []);
        return;
      }
      await fixture.work(
        { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
        "failed_permanent",
      );
      await waitFor("unsafe revision runtime to retire", async () =>
        stopped.includes(candidate.id) ? true : undefined,
      );
      if (loss === "missing") {
        await waitFor("invalidated cleanup to wait for Driver maintenance", async () => {
          const delayed = await fixture.observerPool.query(
            `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
             FROM occ.controller_work
             WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
            [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
          );
          return Number(delayed.rows[0]?.delay_ms) >=
            repository.driver.maintenanceIntervalMs - 1_000
            ? true
            : undefined;
        });
      }
      await fixture.stop();
      const refusal = await fixture.observerPool.query(
        "SELECT reason_code FROM occ.controller_work WHERE idempotency_key = $1",
        [maintenance.rows[0].idempotency_key],
      );
      assert.equal(refusal.rows[0].reason_code, "REPOSITORY_SESSION_RECOVERY_UNSAFE");
      const [retained] = await repositoryAttempts(fixture, candidate);
      assert.equal(retained.phase, loss === "missing" ? "invalidated" : "closing");
      assert.equal(retained.sessionId, original.sessionId);
      assert.equal(retained.liveRevisionId, candidate.id);
      assert.deepEqual(retained.cleanupContext, original.cleanupContext);
      const cleanup = await fixture.observerPool.query(
        `SELECT state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      assert.equal(cleanup.rows[0].state, "queued");
      assert.equal(cleanup.rows[0].actor_id, fixture.actor.id);

      // Previously admitted maintenance observations must keep refusing the
      // lost session without multiplying the durable retirement obligation.
      await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
      for (let index = 0; index < 4; index += 1) {
        const another = {
          id: candidate.id,
          idempotencyKey: `agent_revision:${candidate.id}:maintenance:${Math.floor(Date.now() / repository.driver.maintenanceIntervalMs) + 2 + index}`,
        };
        await fixture.state.transactWithQueue((_unit, queue) =>
          queue.enqueue({
            idempotencyKey: another.idempotencyKey,
            namespaceId: candidate.namespaceId,
            agentId: candidate.agentId,
            revisionId: candidate.id,
            actorId: fixture.actor.id,
            availableAt: new Date(0),
          }),
        );
        await fixture.work(another, "failed_permanent");
      }
      await fixture.stop();
      const repeatedCleanup = await fixture.observerPool.query(
        `SELECT state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      assert.equal(repeatedCleanup.rowCount, 1);
      assert.equal(repeatedCleanup.rows[0].state, "queued");
      assert.equal(repeatedCleanup.rows[0].actor_id, fixture.actor.id);
      assert.equal((await repositoryAttempts(fixture, candidate)).length, 1);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      assert.equal(delivered.filter(({ kind }) => kind === "new").length, 1);
      assert.ok(stopped.every((id) => id === candidate.id));

      // A separately admitted revision is a new user request. It must not erase
      // the old unresolved evidence or inherit the old session's authority.
      missingMaterial = false;
      const replacement = await fixture.revision(owner, 2, undefined, repository.snapshot);
      await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
      await fixture.work(replacement, "succeeded");
      await fixture.stop();
      const [fresh] = await repositoryAttempts(fixture, replacement);
      assert.equal(fresh.phase, "open");
      assert.notEqual(fresh.sessionId, original.sessionId);
      assert.notEqual(fresh.admissionId, original.admissionId);
      assert.equal((await repositoryAttempts(fixture, candidate))[0].phase, retained.phase);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
    },
  );
}

test(
  "worker restart resumes repository maintenance and repairs only Compute's exact missing subset once",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-maintenance-restart");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const initial = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        initial.push(...deploymentContext.repositoryCredentials);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
    });
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    assert.equal(initial.length, 2);
    const initialAttempts = await repositoryAttempts(fixture, candidate);
    for (const binding of initial) {
      const attempt = initialAttempts.find(
        (entry) =>
          entry.repositoryRef === binding.repositoryRef && entry.sessionId === binding.sessionId,
      );
      assert.ok(attempt);
      assert.equal(binding.admissionId, attempt.admissionId);
    }

    // Successful activation already owns a queued observation with its original
    // actor. Advancing this owned work's due time models a restart at that time.
    const maintenance = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key, actor_id`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(maintenance.rowCount, 1);
    assert.equal(maintenance.rows[0].actor_id, fixture.actor.id);
    const observed = [];
    const stopped = [];
    const callsBeforeRestart = repository.calls.length;
    await fixture.start(
      {
        ...fixture.compute,
        async stopRevision(revision) {
          stopped.push(revision.id);
          return fixture.compute.stopRevision(revision);
        },
        async prepareRevision(revision, deploymentContext) {
          observed.push(deploymentContext.repositoryCredentials);
          const result = await fixture.compute.prepareRevision(revision, deploymentContext);
          return observed.length === 1
            ? {
                ...result,
                ready: false,
                repositoryCredentialMaterialMissing: [
                  { repositoryRef: initial[0].repositoryRef, sessionId: initial[0].sessionId },
                ],
              }
            : result;
        },
      },
      () => {},
      undefined,
      undefined,
      fixture.createWorkerPool(),
    );
    await fixture.work(
      { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
      "succeeded",
    );
    assert.equal(observed.length, 2, "one missing observation permits one bounded repair");
    assert.deepEqual(
      observed[0].map(({ kind, repositoryRef, sessionId, admissionId }) => ({
        kind,
        repositoryRef,
        sessionId,
        admissionId,
      })),
      initial.map(({ repositoryRef, sessionId, admissionId }) => ({
        kind: "retained",
        repositoryRef,
        sessionId,
        admissionId,
      })),
    );
    const repaired = observed[1].find(
      ({ repositoryRef }) => repositoryRef === initial[0].repositoryRef,
    );
    const retained = observed[1].find(
      ({ repositoryRef }) => repositoryRef === initial[1].repositoryRef,
    );
    assert.equal(repaired.kind, "new");
    assert.notEqual(repaired.sessionId, initial[0].sessionId);
    assert.notEqual(repaired.admissionId, initial[0].admissionId);
    assert.deepEqual(retained, observed[0][1]);
    const repairedAttempts = await repositoryAttempts(fixture, candidate);
    const repairedAttempt = repairedAttempts.find(
      (entry) => entry.sessionId === repaired.sessionId,
    );
    assert.ok(repairedAttempt);
    assert.equal(repaired.admissionId, repairedAttempt.admissionId);
    const recoveryCalls = repository.calls.slice(callsBeforeRestart);
    assert.deepEqual(
      recoveryCalls
        .filter(({ operation }) => operation === "status")
        .map(({ sessionId }) => sessionId)
        .sort(),
      initial.map(({ sessionId }) => sessionId).sort(),
    );
    assert.deepEqual(
      recoveryCalls
        .filter(({ operation }) => operation === "close")
        .map(({ sessionId }) => sessionId),
      [initial[0].sessionId],
    );
    assert.equal(recoveryCalls.filter(({ operation }) => operation === "open").length, 1);
    await waitFor("session-only repair cleanup to settle", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    assert.deepEqual(stopped, []);
  },
);

test(
  "repeated missing repository material fails the observation after one repair and cannot activate",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-repair-bound");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    let preparations = 0;
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        preparations += 1;
        const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
        const [binding] = deploymentContext.repositoryCredentials;
        return {
          ...observation,
          ready: false,
          repositoryCredentialMaterialMissing: [
            {
              repositoryRef: binding.repositoryRef,
              sessionId: binding.sessionId,
            },
          ],
        };
      },
    });
    assert.equal((await fixture.work(candidate, "failed_permanent")).attempt_count, 1);
    assert.equal(preparations, 2);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, undefined);
    await waitFor("both unusable material attempts to be disposed", async () => {
      const attempts = await repositoryAttempts(fixture, candidate);
      return attempts.length === 2 && attempts.every(({ phase }) => phase === "disposed")
        ? true
        : undefined;
    });
  },
);

for (const change of ["revoked", "stopped", "expired", "superseded"]) {
  test(
    `an unfinished repository admission cannot reopen after its revision is ${change}`,
    requiresPostgres,
    async (context) => {
      const repository = repositoryBoundary();
      const fixture = await setup(context, { repoDriver: repository.driver });
      const owner = await fixture.agent(`repository-${change}`);
      if (change === "expired") {
        repository.snapshot.deadlineWallMs = Date.now() + 3_000;
      }
      let actorId = fixture.actor.id;
      if (change === "revoked") {
        actorId = `principal-${randomUUID()}`;
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
           SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
          [actorId, fixture.actor.id],
        );
        const granted = await fixture.observerPool.query(
          `INSERT INTO occ.iam_access_bindings
            (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           SELECT gen_random_uuid()::text, namespace_id, $1, NULL, role_id, resource_kind, resource_id
           FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
          [actorId, fixture.actor.id],
        );
        assert.ok(granted.rowCount > 0);
      }
      const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot, actorId);
      const open = repository.driver.open;
      let lostSessionId;
      repository.driver.open = async (input, signal) => {
        const result = await open(input, signal);
        if (lostSessionId === undefined && result.kind === "created") {
          lostSessionId = result.session.sessionId;
          // Change real authority while its external admission result is lost.
          // Cleanup may recover that admission but cannot deliver or replace it.
          if (change === "revoked") {
            // Restrictions are the supported app-role mutation that revokes
            // effective authority; identity deletion requires a different role.
            await fixture.observerPool.query(
              `INSERT INTO occ.iam_restrictions
                 (id, namespace_id, action, resource_kind, resource_id, effect)
               VALUES ($1, $2, 'deploy', 'agent', $3, 'deny')`,
              [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
            );
          } else if (change === "stopped") {
            await fixture.requestStop(owner);
          } else if (change === "expired") {
            await delay(Math.max(0, repository.snapshot.deadlineWallMs - Date.now()) + 30);
          } else {
            const replacement = await fixture.revision(owner, 2);
            await fixture.state.transact((unit) =>
              unit.agents.compareAndSetActiveRevision(
                fixture.namespace.id,
                owner.id,
                undefined,
                replacement.id,
              ),
            );
          }
          throw new Error("repository admission response lost during authority change");
        }
        return result;
      };
      const prepared = [];
      const events = [];
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            prepared.push(revision.id);
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
        },
        (event) => events.push(event),
      );
      if (change === "superseded") {
        await waitFor("the superseded revision to finish without new authority", async () => {
          const result = await fixture.observerPool.query(
            "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          return ["succeeded", "failed_permanent"].includes(result.rows[0]?.state)
            ? true
            : undefined;
        });
      } else {
        await fixture.work(candidate, change === "stopped" ? "succeeded" : "failed_permanent");
      }
      await waitFor("the unfinished admission to settle without renewed authority", async () => {
        const attempts = await repositoryAttempts(fixture, candidate);
        return attempts.length === 1 && attempts[0].phase === "disposed" ? attempts : undefined;
      });
      assert.ok(lostSessionId);
      assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
      assert.ok(repository.calls.some(({ operation }) => operation === "recover"));
      assert.ok(
        repository.calls.some(
          ({ operation, sessionId }) => operation === "close" && sessionId === lostSessionId,
        ),
      );
      assert.equal(prepared.includes(candidate.id), false);
      const reasons = {
        revoked: ["AUTHORIZATION_DENIED"],
        stopped: ["REVISION_STOPPED"],
        expired: ["REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED"],
        superseded: ["REPOSITORY_REVISION_SUPERSEDED", "REVISION_SUPERSEDED"],
      };
      await waitFor("the worker's exact terminal authority reason", async () =>
        events.find(
          ({ event, workId, code }) =>
            event === "worker.completed" &&
            workId === candidate.idempotencyKey &&
            reasons[change].includes(code),
        ),
      );
      if (change === "revoked") {
        const cleanup = await fixture.observerPool.query(
          `SELECT actor_id FROM occ.controller_work
           WHERE revision_id = $1 AND idempotency_key LIKE $2`,
          [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
        );
        assert.ok(cleanup.rowCount > 0);
        assert.ok(cleanup.rows.every(({ actor_id }) => actor_id === actorId));
      }
    },
  );
}

test(
  "repository service outage during Agent stop still stops Compute and retains durable closing work",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-stop-outage");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const stopped = [];
    await fixture.start({
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
    });
    await fixture.work(candidate, "succeeded");
    const close = repository.driver.close;
    let unavailable = true;
    repository.driver.close = async (sessionId, signal) => {
      if (unavailable) {
        throw new Error("repository service temporarily unavailable");
      }
      return close(sessionId, signal);
    };
    const stop = await fixture.requestStop(owner);
    await waitFor("Compute shutdown despite the credential service outage", async () =>
      stopped.includes(candidate.id) ? true : undefined,
    );
    const attempts = await repositoryAttempts(fixture, candidate);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].phase, "closing");
    const cleanup = await fixture.observerPool.query(
      `SELECT actor_id, state FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
    );
    assert.ok(cleanup.rowCount >= 1);
    assert.ok(
      cleanup.rows.every(
        ({ actor_id, state }) =>
          actor_id === fixture.actor.id && ["queued", "claimed"].includes(state),
      ),
    );
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    // Hold the outage through a completed cleanup pass. Otherwise recovery can
    // race the first close and never exercise the durable retry schedule.
    await waitFor("outage cleanup to defer at the Driver interval", async () => {
      const deferred = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE idempotency_key LIKE $1 AND state = 'queued'
           AND available_at - updated_at >= $2::double precision * interval '1 millisecond'`,
        [
          `agent_revision:${candidate.id}:repository_cleanup:%`,
          repository.driver.maintenanceIntervalMs - 1_000,
        ],
      );
      return deferred.rowCount === 1 ? true : undefined;
    });
    unavailable = false;
    await advanceCleanupRetries(fixture, candidate);
    await waitFor(
      "the persisted shutdown obligation to settle after service recovery",
      async () => {
        const current = await repositoryAttempts(fixture, candidate);
        return current[0]?.phase === "disposed" ? true : undefined;
      },
    );
    await fixture.work(stop, "succeeded");
  },
);

test(
  "terminal repository retirement survives repeated Compute failures and restart without reopening authority",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-grant-drift");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const prepared = [];
    const stopped = [];
    let unavailable = true;
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision, deploymentContext) {
        prepared.push(revision.id);
        return fixture.compute.prepareRevision(revision, deploymentContext);
      },
      async stopRevision(revision) {
        stopped.push(revision.id);
        if (unavailable) {
          throw new Error("Compute retirement temporarily unavailable");
        }
        return fixture.compute.stopRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();
    const [original] = await repositoryAttempts(fixture, candidate);
    repository.driver.resolve = () => ({
      sessionDurationSeconds: 60,
      bindings: repository.snapshot.bindings.map((binding) => ({
        ...binding,
        grant: { ...binding.grant, grantId: "replacement-grant" },
      })),
    });
    const maintenance = await fixture.observerPool.query(
      `UPDATE occ.controller_work SET available_at = clock_timestamp()
       WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
       RETURNING idempotency_key`,
      [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
    );
    assert.equal(maintenance.rowCount, 1);
    await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
    await fixture.work(
      { id: candidate.id, idempotencyKey: maintenance.rows[0].idempotency_key },
      "failed_permanent",
    );
    await waitFor("the old grant's existing session to be disposed", async () => {
      const attempts = await repositoryAttempts(fixture, candidate);
      return attempts.length === 1 && attempts[0].phase === "disposed" ? true : undefined;
    });
    // The foreground is already terminal and every session is disposed. Compute
    // must retain a separate durable obligation beyond its ordinary failure budget.
    await waitFor("retirement to retry beyond the foreground's five attempts", async () => {
      if (stopped.length <= 5) {
        await advanceCleanupRetries(fixture, candidate);
        return undefined;
      }
      // Join the final failed pass before shutdown; aborting it mid-claim would
      // leave a stale lease instead of the deferred work this restart exercises.
      const deferred = await fixture.observerPool.query(
        "SELECT state FROM occ.controller_work WHERE idempotency_key LIKE $1 AND state = 'queued'",
        [`agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      return deferred.rowCount === 1 ? true : undefined;
    });
    await fixture.stop();
    const retirement = await fixture.observerPool.query(
      `SELECT idempotency_key, state, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
    );
    assert.equal(retirement.rowCount, 1);
    assert.equal(retirement.rows[0].state, "queued");
    assert.equal(retirement.rows[0].actor_id, fixture.actor.id);
    assert.deepEqual(prepared, [candidate.id]);

    // A restart may retire only the failed revision, even after a newer revision
    // and another Agent become active. Neither needs this expired repository grant.
    const sibling = await fixture.agent("repository-retirement-sibling");
    const newer = await fixture.revision(owner, 2);
    const siblingRevision = await fixture.revision(sibling, 1);
    const stopsBeforeRestart = stopped.length;
    await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
    await fixture.work(newer, "succeeded");
    await fixture.work(siblingRevision, "succeeded");
    await waitFor("the restarted worker to resume exact retirement", async () => {
      if (stopped.length > stopsBeforeRestart) {
        return true;
      }
      await advanceCleanupRetries(fixture, candidate);
      return undefined;
    });
    await fixture.work(
      { id: candidate.id, idempotencyKey: retirement.rows[0].idempotency_key },
      "queued",
    );
    unavailable = false;
    await advanceCleanupRetries(fixture, candidate);
    await fixture.work(
      { id: candidate.id, idempotencyKey: retirement.rows[0].idempotency_key },
      "succeeded",
    );
    assert.ok(stopped.every((id) => id === candidate.id));
    assert.equal(prepared.filter((id) => id === candidate.id).length, 1);
    const active = await fixture.state.read(async (view) => [
      await view.agents.findAgent(fixture.namespace.id, owner.id),
      await view.agents.findAgent(fixture.namespace.id, sibling.id),
    ]);
    assert.deepEqual(
      active.map((agent) => agent.activeRevisionId),
      [newer.id, siblingRevision.id],
    );
    assert.deepEqual(
      (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase),
      ["disposed"],
    );
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    assert.ok(
      repository.calls.some(
        ({ operation, sessionId }) => operation === "close" && sessionId === original.sessionId,
      ),
    );
    const failure = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [candidate.id],
    );
    assert.ok(failure.rows.some(({ code }) => code === "REPOSITORY_BINDING_CHANGED"));
  },
);

test(
  "repository stop rechecks locked intent after a newer deployment commits while cleanup waits",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-stop-admission-race");
    const first = await fixture.revision(owner, 1, undefined, repository.snapshot);
    await fixture.start(fixture.compute);
    await fixture.work(first, "succeeded");
    await fixture.stop();
    const [original] = await repositoryAttempts(fixture, first);
    const stop = await fixture.requestStop(owner);
    const replacement = {
      ...first,
      id: `rev_${randomUUID()}`,
      revision: 2,
      configuration: { revision: "2" },
      createdAt: new Date().toISOString(),
    };
    delete replacement.idempotencyKey;
    const replacementKey = `agent_revision:${replacement.id}:reconcile`;
    const commitAdmission = Promise.withResolvers();
    const releaseCompute = Promise.withResolvers();
    let locked = false;
    let preparingReplacement = false;
    const stopped = [];
    const events = [];
    // Follow production Namespace→Agent lock ordering. The stop worker can read
    // committed stopped intent, then waits while admission atomically publishes
    // its newer revision, running intent, and queue item.
    const admission = fixture.state.transactWithQueue(async (unit, queue) => {
      await unit.namespaces.lockNamespace(fixture.namespace.id);
      await unit.agents.lockAgent(fixture.namespace.id, owner.id);
      locked = true;
      await commitAdmission.promise;
      await unit.revisions.createRevision(replacement);
      await unit.agents.transitionAgentDesiredRuntimeState(
        fixture.namespace.id,
        owner.id,
        ["stopped"],
        "running",
      );
      await queue.enqueue({
        idempotencyKey: replacementKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: replacement.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      });
    });
    // Keep a rejected setup promise observed while the finally block owns its join.
    void admission.catch(() => {});
    try {
      await waitFor("replacement admission to hold its resource locks", async () =>
        locked ? true : undefined,
      );
      const workerPool = fixture.createWorkerPool();
      const backend = await workerPool.query("SELECT pg_backend_pid() AS pid");
      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision(revision, deploymentContext) {
            if (revision.id === replacement.id) {
              preparingReplacement = true;
              await releaseCompute.promise;
            }
            return fixture.compute.prepareRevision(revision, deploymentContext);
          },
          async stopRevision(revision) {
            stopped.push(revision.id);
            return fixture.compute.stopRevision(revision);
          },
        },
        (event) => events.push(event),
        undefined,
        undefined,
        workerPool,
      );
      await waitFor("the stop worker's real database lock wait", async () => {
        const waiting = await fixture.observerPool.query(
          `SELECT pid FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
           AND query LIKE '%FROM occ.namespaces%' AND query LIKE '%FOR UPDATE%'
           AND cardinality(pg_blocking_pids(pid)) > 0`,
          [backend.rows[0].pid],
        );
        return waiting.rowCount === 1 ? true : undefined;
      });
      assert.equal((await fixture.work(stop, "claimed")).attempt_count, 1);
      commitAdmission.resolve();
      await admission;
      await waitFor("the newer revision to reach Compute preparation", async () =>
        preparingReplacement ? true : undefined,
      );
      assert.equal((await fixture.work(stop, "succeeded")).attempt_count, 1);
      await completion(
        events,
        "the stop's STOP_SUPERSEDED completion",
        ({ event, workId, code }) =>
          event === "worker.completed" &&
          workId === stop.idempotencyKey &&
          code === "STOP_SUPERSEDED",
      );
      assert.deepEqual(stopped, []);
      assert.equal(
        repository.calls.some(
          ({ operation, sessionId }) => operation === "close" && sessionId === original.sessionId,
        ),
        false,
      );
      const [retained] = await repositoryAttempts(fixture, first);
      assert.equal(retained.phase, "open");
      assert.equal(retained.sessionId, original.sessionId);
      const current = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      assert.equal(current.desiredRuntimeState, "running");
      assert.equal(current.activeRevisionId, first.id);
    } finally {
      commitAdmission.resolve();
      releaseCompute.resolve();
      await admission;
    }
    await fixture.work({ id: replacement.id, idempotencyKey: replacementKey }, "succeeded");
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, replacement.id);
  },
);

test(
  "repository cleanup rereads obligations added while its external close is outstanding",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-cleanup-reread");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const open = repository.driver.open;
    const close = repository.driver.close;
    const releaseCleanup = Promise.withResolvers();
    let firstSession;
    let cleanupWaiting = false;
    let preparations = 0;
    const stopped = [];
    repository.driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (result.kind === "created" && firstSession === undefined) {
        firstSession = result.session;
      }
      return result;
    };
    repository.driver.close = async (sessionId, signal) => {
      if (sessionId === firstSession?.sessionId && !cleanupWaiting) {
        const source = await fixture.observerPool.query(
          "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
          [candidate.idempotencyKey],
        );
        if (source.rows[0].state === "claimed") {
          // A failed repair leaves its first binding closing while the other
          // binding remains open until foreground exhaustion transfers it.
          throw new Error("repository close temporarily unavailable");
        }
        cleanupWaiting = true;
        await releaseCleanup.promise;
      }
      return close(sessionId, signal);
    };
    await fixture.start({
      ...fixture.compute,
      async stopRevision(revision) {
        stopped.push(revision.id);
        return fixture.compute.stopRevision(revision);
      },
      async prepareRevision(revision, deploymentContext) {
        preparations += 1;
        if (preparations > 1) {
          throw new Error("Compute unavailable during repair");
        }
        const observation = await fixture.compute.prepareRevision(revision, deploymentContext);
        const [binding] = deploymentContext.repositoryCredentials;
        return {
          ...observation,
          ready: false,
          repositoryCredentialMaterialMissing: [
            {
              repositoryRef: binding.repositoryRef,
              sessionId: binding.sessionId,
            },
          ],
        };
      },
    });
    let cleanupKey;
    try {
      await waitFor("the durable cleanup worker to enter its pending close", async () =>
        cleanupWaiting ? true : undefined,
      );
      const before = await repositoryAttempts(fixture, candidate);
      assert.equal(before.length, 2);
      assert.deepEqual(before.map(({ phase }) => phase).sort(), ["closing", "open"]);
      const cleanup = await fixture.observerPool.query(
        `SELECT idempotency_key, state, actor_id, claim_token FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      assert.equal(cleanup.rows[0].state, "claimed");
      assert.equal(cleanup.rows[0].actor_id, fixture.actor.id);
      cleanupKey = cleanup.rows[0].idempotency_key;

      // Recovery transfers another stop's session cleanup while the first
      // worker is in the external close. The Agent remains running, as when
      // later intent supersedes an earlier stop; recovery must retain the claim.
      const stopKey = `agent:${owner.id}:reconcile:stopped:${randomUUID()}`;
      await fixture.state.transactWithQueue((_unit, queue) =>
        queue.enqueue({
          idempotencyKey: stopKey,
          namespaceId: candidate.namespaceId,
          agentId: candidate.agentId,
          agentTarget: "stopped",
          actorId: fixture.actor.id,
        }),
      );
      await fixture.observerPool.query(
        "UPDATE occ.controller_work SET attempt_count = 1 WHERE idempotency_key = $1",
        [stopKey],
      );
      // A separately configured queue can exhaust the original queued source
      // while its already-claimed session cleanup retains its own purpose.
      const recovery = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      assert.ok((await recovery.recoverStale()).exhaustedQueued >= 2);
      await fixture.work(candidate, "failed_permanent");
      const stillClaimed = await fixture.observerPool.query(
        "SELECT state, claim_token FROM occ.controller_work WHERE idempotency_key = $1",
        [cleanupKey],
      );
      assert.deepEqual(stillClaimed.rows[0], {
        state: "claimed",
        claim_token: cleanup.rows[0].claim_token,
      });
      assert.ok(
        (await repositoryAttempts(fixture, candidate)).every(({ phase }) => phase === "closing"),
      );
    } finally {
      releaseCleanup.resolve();
    }
    await waitFor(
      "cleanup to close the newly transferred obligation before completion",
      async () => {
        const attempts = await repositoryAttempts(fixture, candidate);
        return attempts.length === 2 && attempts.every(({ phase }) => phase === "disposed")
          ? true
          : undefined;
      },
    );
    await advanceCleanupRetries(fixture, candidate);
    await fixture.work({ id: candidate.id, idempotencyKey: cleanupKey }, "succeeded");
    const cleanup = await fixture.observerPool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE revision_id = $1 AND idempotency_key LIKE $2`,
      [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
    );
    assert.equal(cleanup.rowCount, 2);
    const retirement = cleanup.rows.find(({ idempotency_key }) =>
      idempotency_key.includes(":repository_cleanup:retire:"),
    );
    assert.ok(retirement);
    await fixture.work(
      { id: candidate.id, idempotencyKey: retirement.idempotency_key },
      "succeeded",
    );
    assert.deepEqual(stopped, [candidate.id]);
    assert.equal(preparations, 1);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 2);
  },
);

test(
  "a PostgreSQL claim lost during repository admission aborts its signal and rejects late material",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, {
      leaseDurationMs: 600,
      repoDriver: repository.driver,
    });
    const owner = await fixture.agent("repository-stale-claim");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const release = Promise.withResolvers();
    const open = repository.driver.open;
    let firstInput;
    let operationSignal;
    let staleSessionId;
    repository.driver.open = async (input, signal) => {
      const result = await open(input, signal);
      if (firstInput === undefined) {
        firstInput = input;
        operationSignal = signal;
        staleSessionId = result.session.sessionId;
        // A remote response can arrive even after cancellation. The worker must
        // fence the successful result, independently of Driver cooperation.
        await release.promise;
      }
      return result;
    };
    const prepared = [];
    let preparations = 0;
    const events = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          preparations += 1;
          prepared.push(...deploymentContext.repositoryCredentials);
          return fixture.compute.prepareRevision(revision, deploymentContext);
        },
      },
      (event) => events.push(event),
    );
    let recoveryQueue;
    let recovered;
    try {
      await waitFor("the worker to dispatch its first repository admission", async () =>
        firstInput === undefined ? undefined : true,
      );
      const original = await fixture.work(candidate, "claimed");
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
        [candidate.idempotencyKey, original.claim_token],
      );
      recoveryQueue = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 5,
        random: () => 0,
      });
      assert.ok((await recoveryQueue.recoverStale()).recovered >= 1);
      recovered = await recoveryQueue.claim();
      assert.equal(recovered?.idempotencyKey, candidate.idempotencyKey);
      assert.equal(recovered.attemptCount, 2);
      assert.notEqual(recovered.claimToken, original.claim_token);
      await waitFor("the lost PostgreSQL claim to abort the outstanding admission", async () =>
        operationSignal.aborted ? true : undefined,
      );
      assert.deepEqual(prepared, []);
      assert.equal(preparations, 0);
    } finally {
      release.resolve();
    }
    await waitFor("the stale worker to reject the late admission response", async () =>
      events.find(({ event, code }) => event === "worker.error" && code === "CLAIM_LOST"),
    );
    assert.deepEqual(prepared, []);
    assert.equal(preparations, 0);
    const attempts = await repositoryAttempts(fixture, candidate);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].admissionId, firstInput.admissionId);
    assert.equal(attempts[0].phase, "opening");
    assert.equal(attempts[0].sessionId, undefined);
    const unchanged = await fixture.observerPool.query(
      `SELECT state, claim_token, attempt_count, completed_at
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(unchanged.rows, [
      {
        state: "claimed",
        claim_token: recovered.claimToken,
        attempt_count: 2,
        completed_at: null,
      },
    ]);
    const inactive = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(inactive.activeRevisionId, undefined);
    await recoveryQueue.retry(recovered, { code: "TEST_RECOVERY_HANDOFF" });
    await fixture.work(candidate, "succeeded");
    assert.equal(prepared.length, 1);
    assert.equal(preparations, 1);
    assert.notEqual(prepared[0].sessionId, staleSessionId);
    assert.equal(
      (await repositoryAttempts(fixture, candidate)).find(
        ({ admissionId }) => admissionId === firstInput.admissionId,
      ).phase,
      "disposed",
    );
  },
);

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
  "credential withdrawal work revokes from the active revision without redeploying it",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent(
      "withdraw-target",
      "embedded",
      undefined,
      null,
      true,
      false,
      true,
    );
    const active = await fixture.revision(owner, 1);
    const prepared = [];
    const withdrawn = [];
    let pendingOnce = true;
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          // The first observation is still pending, so the worker must retry, not report success.
          if (pendingOnce) {
            pendingOnce = false;
            return { sourceId: source.id, state: "pending" };
          }
          return { sourceId: source.id, state: "revoked" };
        },
      },
      () => {},
      50,
      undefined,
      undefined,
      withCredentialGateway,
    );
    await fixture.work(active, "succeeded");
    const deployments = prepared.length;

    // Record the withdrawal the way the API does: a pending row plus revision-scoped work.
    const source = { id: owner.harnessAuth.sourceId };
    const operationId = randomUUID();
    await fixture.state.transact(async (unit) => {
      await unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: active.id,
        credentialSourceId: source.id,
        state: "pending",
        requestedBy: fixture.actor.id,
        requestedAt: new Date().toISOString(),
      });
      await unit.operations.append({
        kind: "agent_revision",
        action: "reconcile",
        target: "credentials_withdrawn",
        operationId,
        namespaceId: fixture.namespace.id,
        resourceId: active.id,
        actorId: fixture.actor.id,
      });
    });
    const withdrawal = {
      idempotencyKey: `agent_revision:${active.id}:reconcile:credentials_withdrawn:${operationId}`,
      id: active.id,
    };
    const completed = await fixture.work(withdrawal, "succeeded");
    assert.equal(completed.attempt_count, 2, "a pending revocation retries until confirmed");
    assert.deepEqual(withdrawn, [
      [active.id, source.id],
      [active.id, source.id],
    ]);

    // Withdrawal never redeploys or replaces the active revision.
    assert.equal(prepared.length, deployments);
    const [agent, recorded] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.credentialSources.findCredentialWithdrawal(fixture.namespace.id, active.id, source.id),
      ]),
    );
    assert.equal(agent.activeRevisionId, active.id);
    assert.equal(recorded.state, "revoked");
    assert.ok(recorded.completedAt);
    const deployment = await fixture.observerPool.query(
      "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
      [active.idempotencyKey],
    );
    assert.deepEqual(deployment.rows[0], { state: "succeeded", attempt_count: 1 });
    const audit = await fixture.observerPool.query(
      `SELECT resource_id, outcome, details->>'reasonCode' AS reason_code,
              details->>'revisionId' AS revision_id, details->'credentialSourceIds' AS sources
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        resource_id: owner.id,
        outcome: "success",
        reason_code: "CREDENTIALS_WITHDRAWN",
        revision_id: active.id,
        sources: [source.id],
      },
    ]);
  },
);

test(
  "an exhausted credential withdrawal stays pending, reports no attempt in progress, and a replay retries it",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 2 });
    const owner = await fixture.agent(
      "withdraw-exhausted",
      "embedded",
      undefined,
      null,
      true,
      false,
      true,
    );
    const active = await fixture.revision(owner, 1);
    let revoke = false;
    await fixture.start(
      {
        ...fixture.compute,
        async withdrawCredentialSource(_revision, source) {
          // A Sandbox without a running process never reports REVOKED.
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      },
      () => {},
      50,
      undefined,
      undefined,
      withCredentialGateway,
    );
    await fixture.work(active, "succeeded");
    const request = {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      credentialSourceId: owner.harnessAuth.sourceId,
    };
    const withdrawalWork = async () =>
      (
        await fixture.observerPool.query(
          `SELECT idempotency_key, state FROM occ.controller_work
           WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn'
           ORDER BY created_at`,
          [active.id],
        )
      ).rows;
    const requested = await fixture.controller.withdrawAgentCredentialSource(
      fixture.actor.id,
      request,
    );
    assert.equal(requested.withdrawalInProgress, true);
    const read = () => fixture.controller.readAgentCredentialWithdrawal(fixture.actor.id, request);
    assert.equal((await read()).withdrawalInProgress, true);
    const [first] = await withdrawalWork();
    await fixture.work(
      { id: active.id, idempotencyKey: first.idempotency_key },
      "failed_permanent",
    );

    // Exhausting attempts leaves the withdrawal pending, and the row says why. Nothing retries
    // it (this revision has no maintenance), so the read must not suggest an attempt is coming.
    const exhausted = await fixture.controller.readAgentCredentialWithdrawal(
      fixture.actor.id,
      request,
    );
    assert.equal(exhausted.state, "pending");
    assert.equal(exhausted.lastReason, "CREDENTIAL_WITHDRAWAL_PENDING");
    assert.ok(exhausted.lastAttemptAt);
    assert.equal(exhausted.withdrawalInProgress, false);
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "failure", reason_code: "CREDENTIAL_WITHDRAWAL_PENDING" },
    ]);

    // With no attempt outstanding, a replay queues another one, which can then succeed.
    revoke = true;
    await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
    const work = await withdrawalWork();
    assert.equal(work.length, 2);
    assert.equal((await read()).withdrawalInProgress, true);
    await fixture.work({ id: active.id, idempotencyKey: work[1].idempotency_key }, "succeeded");
    const revoked = await fixture.controller.readAgentCredentialWithdrawal(
      fixture.actor.id,
      request,
    );
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.lastReason, "CREDENTIALS_WITHDRAWN");
    assert.equal(revoked.withdrawalInProgress, false);
  },
);

test(
  "maintenance of a withdrawn revision retries the withdrawal and stops once it is revoked",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent(
      "withdraw-maintenance",
      "embedded",
      undefined,
      null,
      true,
      false,
      true,
    );
    const active = await fixture.revision(owner, 1);
    const prepared = [];
    let revoke = false;
    await fixture.start(
      {
        ...fixture.compute,
        maintenanceIntervalMs: 3_600_000,
        async prepareRevision(revision, revisionContext) {
          prepared.push(revision.id);
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async withdrawCredentialSource(_revision, source) {
          return { sourceId: source.id, state: revoke ? "revoked" : "pending" };
        },
      },
      () => {},
      50,
      undefined,
      undefined,
      withCredentialGateway,
    );
    await fixture.work(active, "succeeded");
    const deployments = prepared.length;
    const sourceId = owner.harnessAuth.sourceId;

    // A pending withdrawal with no attempt outstanding, as exhausted attempts leave it.
    await fixture.state.transact((unit) =>
      unit.credentialSources.requestCredentialWithdrawal({
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: active.id,
        credentialSourceId: sourceId,
        state: "pending",
        requestedBy: fixture.actor.id,
        requestedAt: new Date().toISOString(),
      }),
    );
    const runMaintenance = async () => {
      const due = await fixture.observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp()
         WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
         RETURNING idempotency_key`,
        [active.id, `agent_revision:${active.id}:maintenance:%`],
      );
      assert.equal(due.rowCount, 1);
      const pass = { id: active.id, idempotencyKey: due.rows[0].idempotency_key };
      await fixture.work(pass, "succeeded");
      return pass;
    };
    const queuedWork = async (pattern) =>
      (
        await fixture.observerPool.query(
          `SELECT idempotency_key FROM occ.controller_work
           WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2`,
          [active.id, pattern],
        )
      ).rows;

    // Maintenance never re-attaches the source; it queues a withdrawal attempt and keeps going.
    const first = await runMaintenance();
    const withdrawal = await fixture.observerPool.query(
      `SELECT idempotency_key, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn'`,
      [active.id],
    );
    assert.equal(withdrawal.rowCount, 1);
    assert.equal(withdrawal.rows[0].actor_id, fixture.actor.id);
    // Five pending attempts back off 1+2+4+8 s times jitter, which can exceed the default wait.
    await fixture.work(
      { id: active.id, idempotencyKey: withdrawal.rows[0].idempotency_key },
      "failed_permanent",
      30_000,
    );
    const [next] = await queuedWork(`agent_revision:${active.id}:maintenance:%`);
    assert.notEqual(next.idempotency_key, first.idempotencyKey);
    assert.equal(prepared.length, deployments);

    // The next pass queues another attempt, which is revoked; after that maintenance stops.
    revoke = true;
    await runMaintenance();
    await waitFor("the withdrawal to be revoked", async () => {
      const found = await fixture.state.read((view) =>
        view.credentialSources.findCredentialWithdrawal(fixture.namespace.id, active.id, sourceId),
      );
      return found.state === "revoked" ? found : undefined;
    });
    await runMaintenance();
    assert.deepEqual(await queuedWork(`agent_revision:${active.id}:%`), []);
    assert.equal(prepared.length, deployments);
  },
);

test(
  "a deployment retry never re-attaches a source withdrawn while it was finishing",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent(
      "withdraw-during-activation",
      "embedded",
      undefined,
      null,
      true,
      false,
      true,
    );
    const active = await fixture.revision(owner, 1);
    const sourceId = owner.harnessAuth.sourceId;
    const request = {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      credentialSourceId: sourceId,
    };
    const prepared = [];
    const withdrawn = [];
    const events = [];
    let interruptActivation = true;
    await fixture.start(
      {
        ...fixture.compute,
        // The Harness receives the source's attachment only through a prepare.
        async prepareRevision(revision, revisionContext) {
          if (revision.namespaceId === fixture.namespace.id) {
            prepared.push(revision.id);
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
        async activateRevision(revision) {
          if (revision.id === active.id && interruptActivation) {
            interruptActivation = false;
            // The active pointer is already published, so admission accepts the withdrawal
            // while this deployment still has to be retried.
            await fixture.controller.withdrawAgentCredentialSource(fixture.actor.id, request);
            throw new Error("activation interrupted");
          }
        },
        async withdrawCredentialSource(revision, source) {
          withdrawn.push([revision.id, source.id]);
          return { sourceId: source.id, state: "revoked" };
        },
      },
      (event) => events.push(event),
      undefined,
      undefined,
      undefined,
      withCredentialGateway,
    );
    await waitFor(
      "the deployment retry to stop at the withdrawal",
      async () =>
        events.some(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === active.id &&
            event.operation === "agent_revision.reconcile" &&
            event.code === "CREDENTIAL_WITHDRAWN",
        )
          ? true
          : undefined,
      30_000,
    );
    await waitFor(
      "the withdrawal to be revoked",
      async () => {
        const found = await fixture.state.read((view) =>
          view.credentialSources.findCredentialWithdrawal(
            fixture.namespace.id,
            active.id,
            sourceId,
          ),
        );
        return found?.state === "revoked" ? found : undefined;
      },
      30_000,
    );
    await fixture.stop();

    // Only the first attempt prepared the revision; the retry stopped before re-attaching.
    assert.deepEqual(prepared, [active.id]);
    const deployment = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      active.id,
    );
    assert.notEqual(deployment.status, "succeeded");
    assert.deepEqual(withdrawn, [[active.id, sourceId]]);
    const agent = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(agent.activeRevisionId, active.id);
    // Keep the deferred deployment from being claimed by a later test's worker.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'WITHDRAWN_DEPLOYMENT_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1 AND state = 'queued'`,
      [active.idempotencyKey],
    );
  },
);

test(
  "a withdrawal whose requester lost Agent operate fails once with a denial and no revocation",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent(
      "withdraw-denied",
      "embedded",
      undefined,
      null,
      true,
      false,
      true,
    );
    const active = await fixture.revision(owner, 1);
    const withdrawn = [];
    const compute = {
      ...fixture.compute,
      async withdrawCredentialSource(revision, source) {
        withdrawn.push([revision.id, source.id]);
        return { sourceId: source.id, state: "revoked" };
      },
    };
    const startWorker = () =>
      fixture.start(compute, () => {}, 50, undefined, undefined, withCredentialGateway);
    await startWorker();
    await fixture.work(active, "succeeded");
    await fixture.stop();

    // A second operator requests the withdrawal and is offboarded before the worker runs it.
    const requester = `withdraw-requester-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
       SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
      [requester, fixture.actor.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
              resource_kind, resource_id
       FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
      [requester, fixture.actor.id],
    );
    const request = {
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      credentialSourceId: owner.harnessAuth.sourceId,
    };
    await fixture.controller.withdrawAgentCredentialSource(requester, request);
    await fixture.observerPool.query(
      `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
      [requester],
    );
    const work = await fixture.observerPool.query(
      `SELECT idempotency_key, actor_id FROM occ.controller_work
       WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn'`,
      [active.id],
    );
    assert.equal(work.rowCount, 1);
    assert.equal(work.rows[0].actor_id, requester);

    await startWorker();
    const failed = await fixture.work(
      { id: active.id, idempotencyKey: work.rows[0].idempotency_key },
      "failed_permanent",
    );
    // A denial is final on the first attempt and never reaches the gateway.
    assert.equal(failed.attempt_count, 1);
    assert.deepEqual(withdrawn, []);
    const recorded = await fixture.controller.readAgentCredentialWithdrawal(
      fixture.actor.id,
      request,
    );
    assert.equal(recorded.state, "pending");
    assert.equal(recorded.requestedBy, requester);
    assert.equal(recorded.lastReason, "AUTHORIZATION_DENIED");
    assert.ok(recorded.lastAttemptAt);
    const audit = await fixture.observerPool.query(
      `SELECT kind, actor_id, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'`,
      [fixture.namespace.id],
    );
    assert.deepEqual(audit.rows, [
      {
        kind: "authorization_denial",
        actor_id: requester,
        outcome: "denied",
        reason_code: "AUTHORIZATION_DENIED",
      },
    ]);
  },
);

test(
  "Agent stop clears only the exact active pointer after Compute shutdown and retries safely",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
    const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
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
          return revision.namespaceId === fixture.namespace.id && revision.revision === 2
            ? { ...observation, ready: false }
            : observation;
        },
        async stopRevision(revision) {
          // The real queue can dispatch due work from earlier Namespaces. Keep
          // this failure injection and its ownership assertions in this fixture.
          if (revision.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(revision);
          }
          const during = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
          assert.equal(
            during.agents.stopping,
            before.agents.stopping + 1,
            "stop stays in progress until Compute shutdown commits",
          );
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
    // Stop work must retain its own bounded kind and committed retry/success
    // outcomes after integrating stop support with metrics instrumentation. Both
    // are recorded after the stop commits, the attempt outcome last.
    const exposition = await waitFor("the stop's successful attempt metric", async () => {
      const text = await metrics.exposition();
      return /occ_reconciliation_attempts_total\{[^\n]*work_kind="agent_stop"[^\n]*outcome="success"/.test(
        text,
      )
        ? text
        : undefined;
    });
    assert.match(
      exposition,
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 1(?:\n|$)/,
    );
    const after = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
    assert.equal(after.agents.stopped, before.agents.stopped + 1);
    assert.equal(after.agents.running, before.agents.running + 1);
    for (const outcome of ["retry", "success"]) {
      assert.match(
        exposition,
        new RegExp(
          `occ_reconciliation_attempts_total\\{[^\\n]*work_kind="agent_stop"[^\\n]*outcome="${outcome}"[^\\n]*\\} 1(?:\\n|$)`,
        ),
      );
    }
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
      const operations = [];
      // Exercise the bundled SSH Driver's actual cold binding validation. Only
      // remote SSH execution is controlled; the queue and worker use PostgreSQL.
      const cold = await coldSshComputeDriver(fixture, operations);
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
  "fresh worker binds SSH ownership before Agent deletion",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("cold-delete", "embedded", undefined, null, true, true);
    const candidate = await fixture.revision(owner, 1);
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    await fixture.stop();

    // Deletion is admitted while the Agent is running, then a fresh worker must
    // reconstruct the SSH binding before it can retire the persisted revision.
    await fixture.requestDeletion(owner);
    const operations = [];
    const cold = await coldSshComputeDriver(fixture, operations);
    await fixture.start(
      {
        ...fixture.compute,
        bindAgent: cold.bindAgent.bind(cold),
        retireRevision: cold.retireRevision.bind(cold),
      },
      () => {},
      undefined,
      undefined,
      fixture.createWorkerPool(),
    );

    await waitFor(`Agent ${owner.id} deletion to complete`, async () => {
      const deleted = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      return deleted === undefined ? true : undefined;
    });
    const audit = await fixture.observerPool.query(
      `SELECT (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action = 'openclaw.agents.lifecycle.delete' AND outcome = 'success'`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [{ attempt_count: 1 }]);
    assert.deepEqual(
      operations.map(({ operation }) => operation),
      ["retire-revision"],
    );
    assert.ok(
      operations.every(
        (operation) =>
          operation.namespace.id === fixture.namespace.id &&
          operation.revision.agentId === owner.id,
      ),
    );
  },
);

test(
  "Agent deploy, stop, and deletion complete as one persisted lifecycle",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("complete-lifecycle");
    const effects = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        effects.push(`prepare:${revision.id}`);
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        effects.push(`stop:${revision.id}`);
      },
      async retireRevision(revision) {
        effects.push(`retire:${revision.id}`);
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        effects.push(`credentials:${agent.id}`);
      },
    });

    const revision = await fixture.revision(owner, 1);
    await fixture.work(revision, "succeeded");
    const running = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(running?.desiredRuntimeState, "running");
    assert.equal(running?.activeRevisionId, revision.id);

    const stop = await fixture.requestStop(owner);
    await fixture.work(stop, "succeeded");
    const [stopped, retainedRevision] = await fixture.state.read(async (view) =>
      Promise.all([
        view.agents.findAgent(fixture.namespace.id, owner.id),
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ]),
    );
    assert.equal(stopped?.desiredRuntimeState, "stopped");
    assert.equal(stopped?.activeRevisionId, undefined);
    assert.equal(retainedRevision?.id, revision.id);

    await fixture.requestDeletion(owner);
    await waitFor(`Agent ${owner.id} lifecycle deletion to complete`, async () => {
      const deleted = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      return deleted === undefined ? true : undefined;
    });
    const [deletedRevision, deletedIdentity, remainingWork] = await Promise.all([
      fixture.state.read((view) =>
        view.revisions.findRevision(fixture.namespace.id, owner.id, revision.id),
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE agent_id = $1",
        [owner.id],
      ),
    ]);
    assert.equal(deletedRevision, undefined);
    assert.deepEqual(deletedIdentity.rows, [{ count: 0 }]);
    assert.deepEqual(remainingWork.rows, [{ count: 0 }]);
    assert.deepEqual(effects, [
      `prepare:${revision.id}`,
      `stop:${revision.id}`,
      `retire:${revision.id}`,
      `credentials:${owner.id}`,
    ]);

    const lifecycleAudit = await fixture.observerPool.query(
      `SELECT action, outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND action IN (
           'openclaw.agents.lifecycle.stop',
           'openclaw.agents.lifecycle.delete'
         )
       ORDER BY occurred_at`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(lifecycleAudit.rows, [
      {
        action: "openclaw.agents.lifecycle.stop",
        outcome: "success",
        reason_code: "AGENT_STOPPED",
      },
      {
        action: "openclaw.agents.lifecycle.delete",
        outcome: "success",
        reason_code: "AGENT_DELETED",
      },
    ]);
  },
);

test(
  "a repository cleanup stuck on an invalidated attempt logs its cause once and backs off",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // The production default; the fixture's hour-long interval would hide the backoff.
    repository.driver.maintenanceIntervalMs = 30_000;
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("cleanup-invalidated");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    const events = [];
    await fixture.start(fixture.compute, (event) => events.push(event));
    await fixture.work(candidate, "succeeded");
    const [attempt, sibling] = await repositoryAttempts(fixture, candidate);
    // An invalidated attempt has no outgoing transition, so no pass can settle this cleanup.
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [attempt.admissionId],
    );
    const cleanupKey = `agent_revision:${candidate.id}:repository_cleanup:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp() - interval '1 day', clock_timestamp())`,
      [cleanupKey, fixture.namespace.id, owner.id, candidate.id, fixture.actor.id],
    );
    const deferred = async (passes) =>
      waitFor(`cleanup pass ${passes} to defer`, async () => {
        const completed = events.filter(
          (event) => event.event === "worker.completed" && event.workId === cleanupKey,
        );
        if (completed.length < passes) {
          return undefined;
        }
        const { rows } = await fixture.observerPool.query(
          `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
           FROM occ.controller_work WHERE idempotency_key = $1`,
          [cleanupKey],
        );
        return rows[0]?.state === "queued" ? rows[0] : undefined;
      });
    // A day-old stuck cleanup rechecks every 10 minutes, not every 30 s.
    const first = await deferred(1);
    assert.ok(Number(first.delay_ms) >= 590_000, `delay ${first.delay_ms} ms`);
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [cleanupKey],
    );
    await deferred(2);
    // The cause is logged once, not on every recheck.
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.event === "worker.repository-cleanup-warning" && event.workId === cleanupKey,
        )
        .map(({ code, cause }) => ({ code, cause })),
      [{ code: "REPOSITORY_CLEANUP_STALLED", cause: "REPOSITORY_ATTEMPT_INVALIDATED" }],
    );
    // A session still closing keeps the configured cadence, even next to an invalidated one.
    repository.driver.close = async () => {
      throw new Error("REPOSITORY_BROKER_UNAVAILABLE");
    };
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'closing', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [sibling.admissionId],
    );
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
      [cleanupKey],
    );
    const closing = await deferred(3);
    assert.ok(Number(closing.delay_ms) < 60_000, `delay ${closing.delay_ms} ms`);
    // Retain the unsettled obligation while keeping it out of later scheduling.
    await fixture.observerPool.query(
      "UPDATE occ.controller_work SET available_at = 'infinity' WHERE idempotency_key = $1",
      [cleanupKey],
    );
    await fixture.stop();
  },
);

test(
  "Agent deletion completes with unresolved repository sessions retained as evidence",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary({ count: 2 });
    // Release blocked broker calls before setup's worker shutdown hook, including on failure.
    const cleanupBarrier = Promise.withResolvers();
    context.after(() => cleanupBarrier.resolve());
    const fixture = await setup(context, { repoDriver: repository.driver });
    const pendingOwner = await fixture.agent("delete-repository-unresolved");
    const missingOwner = await fixture.agent("delete-repository-missing");
    const pendingRevision = await fixture.revision(pendingOwner, 1, undefined, repository.snapshot);
    const missingRevision = await fixture.revision(missingOwner, 1);
    const close = repository.driver.close.bind(repository.driver);
    repository.driver.close = async (...args) => {
      await cleanupBarrier.promise;
      return close(...args);
    };
    await fixture.start(fixture.compute);
    await Promise.all([
      fixture.work(pendingRevision, "succeeded"),
      fixture.work(missingRevision, "succeeded"),
    ]);
    const opened = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      opened.map(({ phase, liveRevisionId }) => ({ phase, liveRevisionId })),
      [
        { phase: "open", liveRevisionId: pendingRevision.id },
        { phase: "open", liveRevisionId: pendingRevision.id },
      ],
    );
    await fixture.observerPool.query(
      `UPDATE occ.repository_session_attempts
       SET phase = 'invalidated', updated_at = clock_timestamp()
       WHERE admission_id = $1`,
      [opened[0].admissionId],
    );
    const missingAdmissionId = `missing-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.repository_session_attempts
         (namespace_id, agent_id, revision_id, repository_ref, admission_id,
          duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at,
          broker_protocol)
       VALUES ($1, $2, $3, $4, $5, 60, $6, 'opening', NULL, clock_timestamp(),
          clock_timestamp(), 0)`,
      [
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        repository.snapshot.bindings[0].repositoryRef,
        missingAdmissionId,
        repository.snapshot.deadlineWallMs,
      ],
    );
    await fixture.stop();
    await fixture.requestDeletion(pendingOwner);
    await fixture.requestDeletion(missingOwner);
    const retireCleanupKey = `agent_revision:${pendingRevision.id}:repository_cleanup:retire:${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.controller_work
         (idempotency_key, namespace_id, agent_id, revision_id, actor_id,
          namespace_target, agent_target, state, available_at, attempt_count, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, 'queued',
          clock_timestamp(), 0, clock_timestamp(), clock_timestamp())`,
      [
        retireCleanupKey,
        fixture.namespace.id,
        pendingOwner.id,
        pendingRevision.id,
        fixture.actor.id,
      ],
    );
    await fixture.start(fixture.compute);
    await waitFor("Agent deletion to finish despite unresolved repository sessions", async () =>
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, pendingOwner.id),
      )) === undefined &&
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, missingOwner.id),
      )) === undefined
        ? true
        : undefined,
    );
    await Promise.all([
      fixture.requestDeletion(pendingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
      fixture.requestDeletion(missingOwner).then(
        () => assert.fail("repeated DELETE after completion should not recreate the Agent"),
        (error) => assert.match(error.message, /exact Namespace/),
      ),
    ]);

    const retained = await repositoryAttempts(fixture, pendingRevision);
    assert.deepEqual(
      retained.map(({ phase, liveRevisionId, cleanupContext }) => ({
        phase,
        liveRevisionId,
        repositoryRef: cleanupContext.binding.repositoryRef,
      })),
      [
        {
          phase: "invalidated",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[1].repositoryRef,
        },
        {
          phase: "closing",
          liveRevisionId: null,
          repositoryRef: repository.snapshot.bindings[0].repositoryRef,
        },
      ],
    );
    await waitFor("retained runtime cleanup to claim without live owner", async () => {
      const { rows } = await fixture.observerPool.query(
        `SELECT agent_id, revision_id, state
         FROM occ.controller_work
         WHERE idempotency_key = $1`,
        [retireCleanupKey],
      );
      return rows[0]?.agent_id === null &&
        rows[0]?.revision_id === null &&
        rows[0]?.state === "claimed"
        ? true
        : undefined;
    });
    assert.equal(
      retained.some(({ phase }) => phase === "disposed"),
      false,
      "deletion must not fabricate disposal for unresolved repository sessions",
    );
    const retainedCounts = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.repository_session_attempts
          WHERE agent_id = $1) AS attempts,
         (SELECT count(*)::integer FROM occ.agent_revisions
          WHERE agent_id IN ($1, $2)) AS revisions,
         (SELECT count(*)::integer FROM occ.controller_work
          WHERE agent_id IN ($1, $2) OR idempotency_key LIKE $3) AS work`,
      [
        pendingOwner.id,
        missingOwner.id,
        `agent_revision:${pendingRevision.id}:repository_cleanup:%`,
      ],
    );
    assert.deepEqual(retainedCounts.rows, [{ attempts: 3, revisions: 0, work: 2 }]);
    cleanupBarrier.resolve();
    let missing;
    await waitFor("retained repository cleanup to run after Agent deletion", async () => {
      const afterCleanup = await repositoryAttempts(fixture, pendingRevision);
      missing = await fixture.state.read((view) =>
        view.repositorySessions.findAttempt(missingAdmissionId),
      );
      if (
        missing.phase !== "closing" &&
        afterCleanup.some(
          ({ phase, repositoryRef, liveRevisionId }) =>
            repositoryRef === repository.snapshot.bindings[1].repositoryRef &&
            phase === "disposed" &&
            liveRevisionId === null,
        )
      ) {
        return true;
      }
      // Incomplete cleanup defers by the boundary Driver's hourly interval.
      await advanceCleanupRetries(fixture, pendingRevision);
      return undefined;
    });
    assert.equal(missing.phase, "invalidated");
    assert.equal(missing.liveRevisionId, null);
    assert.equal(missing.sessionId, undefined);
  },
);

test(
  "Agent deletion retries teardown, removes owned state, and preserves sibling resources",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-target");
    const sibling = await fixture.agent("delete-sibling");
    const targetRevision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    const retiredRevisions = [];
    const deletedCredentialOwners = [];
    let failRetirementOnce = true;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(revision) {
        retiredRevisions.push(revision.id);
        if (revision.id === targetRevision.id && failRetirementOnce) {
          failRetirementOnce = false;
          throw new Error("transient Compute retirement failure");
        }
      },
      async deleteAgentRuntimeCredentials({ agent }) {
        deletedCredentialOwners.push(agent.id);
      },
    });
    await Promise.all([
      fixture.work(targetRevision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);

    // Use an exact Namespace-local role so the binding is realistic and the
    // finalizer must remove it without relying on a foreign-key cascade.
    const revisionRoleId = `role-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        revisionRoleId,
        fixture.namespace.id,
        `Agent revision reader ${randomUUID()}`,
        JSON.stringify([{ action: "read", resourceKind: "agent_revision" }]),
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'agent_revision', $5)`,
      [
        `binding-${randomUUID()}`,
        fixture.namespace.id,
        owner.servicePrincipalId,
        revisionRoleId,
        targetRevision.id,
      ],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', 'agent', $3, 'deny')`,
      [`restriction-${randomUUID()}`, fixture.namespace.id, owner.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.apikey
         (id, config_id, reference_id, key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), randomUUID(), owner.servicePrincipalId, randomUUID()],
    );

    await fixture.requestDeletion(owner);
    await waitFor(`Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      return deleted === undefined ? true : undefined;
    });

    await fixture.stop();
    // Deletion passes have their own work kind and record the committed retry
    // and completion, rather than appearing as Namespace errors.
    const exposition = await metrics.exposition();
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="retry"[^}]*\} 1/,
    );
    assert.match(
      exposition,
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="success"[^}]*\} 1/,
    );
    assert.doesNotMatch(exposition, /work_kind="namespace_ensure"[^}]*outcome="error"/);

    const [survivingAgent, survivingRevision, survivingConfiguration] = await fixture.state.read(
      async (view) =>
        Promise.all([
          view.agents.findAgent(fixture.namespace.id, sibling.id),
          view.revisions.findRevision(fixture.namespace.id, sibling.id, siblingRevision.id),
          view.configurations.findConfiguration(fixture.namespace.id, owner.configurationId),
        ]),
    );
    assert.equal(survivingAgent?.activeRevisionId, siblingRevision.id);
    assert.equal(survivingRevision?.id, siblingRevision.id);
    assert.equal(survivingConfiguration?.id, owner.configurationId);
    assert.deepEqual(
      retiredRevisions.filter((id) => id === targetRevision.id),
      [targetRevision.id, targetRevision.id],
    );
    assert.equal(retiredRevisions.includes(siblingRevision.id), false);
    assert.deepEqual(
      deletedCredentialOwners.filter((id) => id === owner.id),
      [owner.id],
    );
    assert.equal(deletedCredentialOwners.includes(sibling.id), false);

    const leftovers = await fixture.observerPool.query(
      `SELECT
         (SELECT count(*)::integer FROM occ.agent_revisions
           WHERE namespace_id = $1 AND agent_id = $2) AS revisions,
         (SELECT count(*)::integer FROM occ.iam_identities WHERE id = $3) AS identities,
         (SELECT count(*)::integer FROM occ.iam_access_bindings
           WHERE identity_subject_id = $3 OR resource_id IN ($2, $4)) AS bindings,
         (SELECT count(*)::integer FROM occ.iam_restrictions
           WHERE resource_id IN ($2, $4)) AS restrictions,
         (SELECT count(*)::integer FROM occ.apikey WHERE reference_id = $3) AS api_keys,
         (SELECT count(*)::integer FROM occ.controller_work
           WHERE namespace_id = $1 AND agent_id = $2) AS work`,
      [fixture.namespace.id, owner.id, owner.servicePrincipalId, targetRevision.id],
    );
    assert.deepEqual(leftovers.rows, [
      { revisions: 0, identities: 0, bindings: 0, restrictions: 0, api_keys: 0, work: 0 },
    ]);
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code,
              (details->>'attemptCount')::integer AS attempt_count
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "success", reason_code: "AGENT_DELETED", attempt_count: 2 },
    ]);
  },
);

test(
  "repeating Agent deletion recovers exhausted teardown without resetting an active claim",
  requiresPostgres,
  async (context) => {
    const retirement = Promise.withResolvers();
    context.after(() => retirement.resolve());
    const fixture = await setup(context, { maxAttempts: 1 });
    const owner = await fixture.agent("delete-exhausted");
    const sibling = await fixture.agent("delete-retry-sibling");
    const revision = await fixture.revision(owner, 1);
    const siblingRevision = await fixture.revision(sibling, 1);
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
        await retirement.promise;
      },
    });
    await Promise.all([
      fixture.work(revision, "succeeded"),
      fixture.work(siblingRevision, "succeeded"),
    ]);
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.attemptCount, 1);
    assert.equal(exhausted.reasonCode, "DEPENDENCY_UNAVAILABLE");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteAgent(
        `unprivileged-${randomUUID()}`,
        fixture.namespace.id,
        owner.id,
      ),
    );
    assert.deepEqual(await observe(), exhausted);

    const otherActor = `delete-operator-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
       SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
      [otherActor, fixture.actor.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
              resource_kind, resource_id
       FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
      [otherActor, fixture.actor.id],
    );
    await assert.rejects(
      fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id),
      {
        name: "DeletionRetryOwnedError",
        message: /Only the actor that started this deletion can retry it/,
        initiatingActorId: fixture.actor.id,
        authorization: {
          action: "delete",
          resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
        },
      },
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.requestDeletion(owner);
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the exhausted teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.createdAt.getTime(), exhausted.createdAt.getTime());
    assert.equal(retried.reasonCode, undefined);
    await waitFor("retried teardown to hold a live claim", async () => {
      const work = await observe();
      return work.state === "claimed" && retirementAttempts === 2 ? work : undefined;
    });
    const claimed = await observe();
    await Promise.all([fixture.requestDeletion(owner), fixture.requestDeletion(owner)]);
    const repeated = await observe();
    assert.equal(repeated.state, "claimed");
    assert.equal(repeated.claimToken, claimed.claimToken);
    assert.equal(repeated.attemptCount, claimed.attemptCount);

    retirement.resolve();
    await waitFor("retried deletion to remove its Agent", async () =>
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      )) === undefined
        ? true
        : undefined,
    );
    assert.equal(retirementAttempts, 2);
    assert.equal(await observe(), undefined);
    const surviving = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, sibling.id),
    );
    assert.equal(surviving.activeRevisionId, siblingRevision.id);
    const { rows: ownedAudit } = await fixture.observerPool.query(
      `SELECT action, actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.equal(
      ownedAudit.filter((event) => event.action === "reconcile" && event.outcome === "failure")
        .length,
      1,
      "retry must retain the original failure evidence",
    );
    assert.deepEqual(
      ownedAudit
        .filter((event) => event.action === "openclaw.agents.delete.retry")
        .map((event) => ({
          actorId: event.actorId,
          outcome: event.outcome,
          details: {
            workId: event.details.workId,
            previousAttemptCount: event.details.previousAttemptCount,
            previousReasonCode: event.details.previousReasonCode,
          },
        })),
      [
        {
          actorId: fixture.actor.id,
          outcome: "success",
          details: {
            workId: deletion.idempotencyKey,
            previousAttemptCount: 1,
            previousReasonCode: "DEPENDENCY_UNAVAILABLE",
          },
        },
      ],
    );
  },
);

test(
  "another authorized actor takes over failed Agent deletion once the initiator loses permission",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context, { maxAttempts: 1 });
    const owner = await fixture.agent("delete-takeover");
    const revision = await fixture.revision(owner, 1);
    let unavailable = true;
    let retirementAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async retireRevision(target) {
        assert.equal(target.id, revision.id);
        retirementAttempts += 1;
        if (unavailable) {
          throw new Error("Compute temporarily unavailable during teardown");
        }
      },
    });
    await fixture.work(revision, "succeeded");
    const deletion = await fixture.requestDeletion(owner);
    await fixture.work(deletion, "failed_permanent");
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
       SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
      [otherActor, fixture.actor.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
              resource_kind, resource_id
       FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
      [otherActor, fixture.actor.id],
    );
    // The initiator is offboarded: it no longer holds any access.
    await fixture.observerPool.query(
      `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
      [fixture.actor.id],
    );
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteAgent(
        `unprivileged-${randomUUID()}`,
        fixture.namespace.id,
        owner.id,
      ),
    );
    assert.deepEqual(await observe(), exhausted);

    unavailable = false;
    await fixture.controller.deleteAgent(otherActor, fixture.namespace.id, owner.id);
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    await waitFor("taken-over deletion to remove its Agent", async () =>
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      )) === undefined
        ? true
        : undefined,
    );
    assert.equal(retirementAttempts, 2);
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2 AND action = 'openclaw.agents.delete.retry'`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(
      retryAudit.map((event) => ({
        actorId: event.actorId,
        outcome: event.outcome,
        takeover: event.details.takeover,
        previousActorId: event.details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

test(
  "repeating Namespace deletion recovers a teardown that exceeded its convergence deadline",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-exhausted-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      () => {},
      1,
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.reasonCode, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.equal(deleteAttempts, 1);
    const stranded = await fixture.state.read((view) =>
      view.namespaces.findNamespace(namespace.id),
    );
    assert.equal(stranded.status, "deleting");

    // A rejected caller cannot replenish the worker's attempt budget.
    await assert.rejects(
      fixture.controller.deleteNamespace(`unprivileged-${randomUUID()}`, namespace.id),
    );
    assert.deepEqual(await observe(), exhausted);

    // Retrying before the teardown is repaired keeps the original deadline and
    // fails again after one pass instead of looping.
    const repeated = await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      ["queued", "claimed"].includes(retried.state),
      "authorized repeated DELETE must requeue the failed Namespace teardown",
    );
    assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    assert.equal(retried.actorId, exhausted.actorId);
    assert.equal(retried.reasonCode, undefined);
    await waitFor("unrepaired retry to fail again", async () => {
      const work = await observe();
      return deleteAttempts === 2 && work.state === "failed_permanent" ? work : undefined;
    });

    terminating = false;
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 3);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        workId: details.workId,
        previousReasonCode: details.previousReasonCode,
      })),
      Array.from({ length: 2 }, () => ({
        actorId: fixture.actor.id,
        outcome: "success",
        workId: deletion.idempotencyKey,
        previousReasonCode: "CONVERGENCE_DEADLINE_EXCEEDED",
      })),
    );
  },
);

test(
  "Namespace teardown audits one pending pass and the terminal pass, not every pass",
  requiresPostgres,
  async (context) => {
    // D323: each worker pass while Kubernetes namespaces terminated wrote its own
    // lifecycle.delete audit row (38 rows for one deletion).
    const fixture = await setup(context);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        assert.equal(target.id, namespace.id);
        deleteAttempts += 1;
        return { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 4 };
      },
    });
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 4);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, details }) => ({
        outcome,
        namespaceDeleted: details.namespaceDeleted,
        convergencePending: details.convergencePending,
      })),
      [
        { outcome: "success", namespaceDeleted: false, convergencePending: true },
        { outcome: "success", namespaceDeleted: true, convergencePending: undefined },
      ],
    );
    // The queue's own reconcile evidence follows the same rule: one row for the
    // unchanged waiting state, one for completion.
    const reconcile = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      reconcile.rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

test(
  "Namespace teardown records the same waiting state again after a retry in between",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-retry-audit-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    let deleteAttempts = 0;
    await fixture.start({
      ...fixture.compute,
      async deleteNamespace(target) {
        deleteAttempts += 1;
        // waiting, waiting, retryable failure, waiting, waiting, deleted
        return deleteAttempts === 3
          ? { namespaceId: target.id, namespaceDeleted: false, failure: "retryable" }
          : { namespaceId: target.id, namespaceDeleted: deleteAttempts >= 6 };
      },
    });
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(
      { id: namespace.id, idempotencyKey: `namespace:${namespace.id}:reconcile:deleted` },
      "succeeded",
    );
    assert.equal(deleteAttempts, 6);
    const { rows } = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS code FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'reconcile' AND resource_kind = 'namespace'
       ORDER BY occurred_at, id`,
      [namespace.id],
    );
    assert.deepEqual(
      rows.map(({ outcome, code }) => ({ outcome, code })),
      [
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "failure", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "NAMESPACE_INCOMPLETE" },
        { outcome: "success", code: "RECONCILE_SUCCEEDED" },
      ],
    );
  },
);

test(
  "another authorized actor takes over failed Namespace deletion once the initiator loses permission",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `delete-takeover-${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await fixture.state.transact((unit) => unit.namespaces.createNamespace(namespace));
    // A stuck finalizer keeps the Namespace terminating past the deadline.
    let terminating = true;
    let deleteAttempts = 0;
    await fixture.start(
      {
        ...fixture.compute,
        async deleteNamespace(target) {
          assert.equal(target.id, namespace.id);
          deleteAttempts += 1;
          return { namespaceId: target.id, namespaceDeleted: !terminating };
        },
      },
      () => {},
      1,
    );
    const deletion = {
      id: namespace.id,
      idempotencyKey: `namespace:${namespace.id}:reconcile:deleted`,
    };
    const observe = () =>
      fixture.state.read((view) => view.operations.findWork(deletion.idempotencyKey));
    await fixture.controller.deleteNamespace(fixture.actor.id, namespace.id);
    await fixture.work(deletion, "failed_permanent");
    const exhausted = await observe();
    assert.equal(exhausted.actorId, fixture.actor.id);

    const otherActor = `delete-successor-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
       SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
      [otherActor, fixture.actor.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
              resource_kind, resource_id
       FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
      [otherActor, fixture.actor.id],
    );
    // While the initiator still holds delete permission, it keeps ownership.
    await assert.rejects(fixture.controller.deleteNamespace(otherActor, namespace.id), {
      name: "DeletionRetryOwnedError",
      message: /Only the actor that started this deletion can retry it/,
      initiatingActorId: fixture.actor.id,
      authorization: {
        action: "delete",
        resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      },
    });
    assert.deepEqual(await observe(), exhausted);

    // The initiator is offboarded: it no longer holds any access.
    await fixture.observerPool.query(
      `DELETE FROM occ.iam_access_bindings WHERE identity_subject_id = $1`,
      [fixture.actor.id],
    );
    // A caller without delete permission still cannot take over.
    await assert.rejects(
      fixture.controller.deleteNamespace(`unprivileged-${randomUUID()}`, namespace.id),
    );
    assert.deepEqual(await observe(), exhausted);

    terminating = false;
    const repeated = await fixture.controller.deleteNamespace(otherActor, namespace.id);
    assert.equal(repeated.status, "deleting");
    const retried = await observe();
    assert.ok(
      retried === undefined || ["queued", "claimed", "succeeded"].includes(retried.state),
      "an authorized takeover must requeue the exhausted teardown",
    );
    if (retried !== undefined) {
      assert.equal(retried.actorId, otherActor);
      assert.equal(retried.idempotencyKey, exhausted.idempotencyKey);
    }
    // Namespace policy left at teardown is removed with the tombstone and audited.
    const policyRole = `role-${randomUUID()}`;
    const policyBinding = `binding-${randomUUID()}`;
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       VALUES ($1, $2, NULL, '[{"action":"read","resourceKind":"namespace"}]'::jsonb)`,
      [policyRole, namespace.id],
    );
    await fixture.observerPool.query(
      `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4, 'namespace', $2)`,
      [policyBinding, namespace.id, otherActor, policyRole],
    );
    await fixture.work(deletion, "succeeded");
    assert.equal(deleteAttempts, 2);
    assert.equal(
      await fixture.state.read((view) => view.namespaces.findNamespace(namespace.id)),
      undefined,
    );
    const { rows: leftover } = await fixture.observerPool.query(
      `SELECT (SELECT count(*) FROM occ.iam_roles WHERE namespace_id = $1)::int AS roles,
              (SELECT count(*) FROM occ.iam_access_bindings WHERE namespace_id = $1)::int AS bindings`,
      [namespace.id],
    );
    assert.deepEqual(leftover, [{ roles: 0, bindings: 0 }]);
    const { rows: teardownAudit } = await fixture.observerPool.query(
      `SELECT details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.lifecycle.delete'
         AND outcome = 'success'`,
      [namespace.id],
    );
    assert.equal(teardownAudit.length, 1);
    assert.ok(teardownAudit[0].details.removedRoleIds.includes(policyRole));
    assert.ok(
      teardownAudit[0].details.removedAccessBindings.some(
        (binding) => binding.id === policyBinding && binding.subjectId === otherActor,
      ),
    );
    const { rows: retryAudit } = await fixture.observerPool.query(
      `SELECT actor_id AS "actorId", outcome, details FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.namespaces.delete.retry'`,
      [namespace.id],
    );
    assert.deepEqual(
      retryAudit.map(({ actorId, outcome, details }) => ({
        actorId,
        outcome,
        takeover: details.takeover,
        previousActorId: details.previousActorId,
      })),
      [
        {
          actorId: otherActor,
          outcome: "success",
          takeover: true,
          previousActorId: fixture.actor.id,
        },
      ],
    );
  },
);

test(
  "Agent deletion fails closed when a credential-provisioning Driver cannot delete credentials",
  requiresPostgres,
  async (context) => {
    let snapshot;
    const metrics = createOccMetrics("worker", () => snapshot.collect());
    const fixture = await setup(context, { metrics });
    snapshot = new PostgresMetricsSnapshot(fixture.observerPool);
    const owner = await fixture.agent("delete-credentials-unsupported");
    const before = await snapshot.collect();
    const deletion = await fixture.requestDeletion(owner);
    // Even a draft enters teardown while deletion is queued. Failed cleanup
    // retains the Agent and must remain visible as a failed lifecycle.
    const pending = await snapshot.collect();
    assert.equal(pending.agents.draft, before.agents.draft - 1);
    assert.equal(pending.agents.stopping, before.agents.stopping + 1);
    await fixture.start({
      ...fixture.compute,
      async provisionAgentRuntimeCredentials() {},
    });

    const failed = await fixture.work(deletion, "failed_permanent");
    assert.equal(failed.attempt_count, 1);
    await fixture.stop();
    const after = await snapshot.collect();
    assert.equal(after.agents.failed, before.agents.failed + 1);
    assert.equal(after.agents.draft, before.agents.draft - 1);
    assert.match(
      await metrics.exposition(),
      /occ_reconciliation_attempts_total\{[^}]*work_kind="agent_delete"[^}]*outcome="permanent"[^}]*\} 1/,
    );
    const retained = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(retained?.status, "deleting");
    assert.equal(retained?.desiredRuntimeState, "stopped");
    const audit = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.delete'
         AND resource_id = $2`,
      [fixture.namespace.id, owner.id],
    );
    assert.deepEqual(audit.rows, [
      { outcome: "failure", reason_code: "CREDENTIAL_DELETION_UNSUPPORTED" },
    ]);
  },
);

test(
  "Agent deletion finalization rejects an expired lease without removing state",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("delete-expired-lease");
    const deletion = await fixture.requestDeletion(owner);
    const claimToken = randomUUID();
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'claimed', claim_token = $1, lease_expires_at = now() - interval '1 second',
           attempt_count = 1, updated_at = now()
       WHERE idempotency_key = $2`,
      [claimToken, deletion.idempotencyKey],
    );
    const queue = new fixture.PostgresWorkQueue(fixture.workerPool);

    await assert.rejects(
      queue.completeAgentDeletion(
        { idempotencyKey: deletion.idempotencyKey, claimToken },
        fixture.namespace.id,
        owner.id,
      ),
      { name: "WorkClaimLostError" },
    );
    const [retained, revisions, identity, work] = await Promise.all([
      fixture.state.read((view) => view.agents.findAgent(fixture.namespace.id, owner.id)),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
        [owner.id],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.iam_identities WHERE id = $1",
        [owner.servicePrincipalId],
      ),
      fixture.observerPool.query(
        "SELECT count(*)::integer AS count FROM occ.controller_work WHERE idempotency_key = $1",
        [deletion.idempotencyKey],
      ),
    ]);
    assert.equal(retained?.status, "deleting");
    assert.deepEqual(revisions.rows, [{ count: 0 }]);
    assert.deepEqual(identity.rows, [{ count: 1 }]);
    assert.deepEqual(work.rows, [{ count: 1 }]);
    // Keep this deliberately expired fixture from being recovered by a later
    // worker test; the assertions above already proved the live product path.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work
       SET state = 'failed_permanent', claim_token = NULL, lease_expires_at = NULL,
           completed_at = now(), reason_code = 'EXPIRED_LEASE_TEST_CLEANUP',
           result_data = NULL, updated_at = now()
       WHERE idempotency_key = $1`,
      [deletion.idempotencyKey],
    );
  },
);

test(
  "deleting the last Agent releases its Namespace for ordinary offboarding",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("last-agent");
    await fixture.start(fixture.compute);

    await fixture.requestDeletion(owner);
    await waitFor(`last Agent ${owner.id} to be removed`, async () => {
      const deleted = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      return deleted === undefined ? true : undefined;
    });

    // Agent deletion preserves Namespace-owned inputs. Remove the surviving
    // harness Secret through the production controller before offboarding.
    assert.equal(owner.harnessAuth.method, "api_key");
    await fixture.controller.deleteSecret(
      fixture.actor.id,
      fixture.namespace.id,
      owner.harnessAuth.source.id,
    );
    await fixture.state.transactWithQueue(async (unit, queue) => {
      assert.equal(await unit.namespaces.hasAgents(fixture.namespace.id), false);
      assert.equal(
        await unit.configurations.deleteConfiguration(fixture.namespace.id, owner.configurationId),
        true,
      );
      const deleting = await unit.namespaces.transitionNamespaceStatus(
        fixture.namespace.id,
        "ready",
        "deleting",
      );
      assert.ok(deleting);
      await queue.enqueue({
        idempotencyKey: `namespace:${fixture.namespace.id}:reconcile:deleted`,
        namespaceId: fixture.namespace.id,
        namespaceTarget: "deleted",
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      });
    });
    await waitFor(`Namespace ${fixture.namespace.id} to be tombstoned`, async () => {
      const namespace = await fixture.state.read((view) =>
        view.namespaces.findNamespace(fixture.namespace.id),
      );
      return namespace === undefined ? true : undefined;
    });
  },
);

test(
  "the application role can finalize Agent deletion without direct table deletion grants",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const privileges = await fixture.observerPool.query(
      `SELECT
         has_table_privilege(current_user, 'occ.agents', 'DELETE') AS delete_agent,
         has_table_privilege(current_user, 'occ.agent_revisions', 'DELETE') AS delete_revision,
         has_table_privilege(current_user, 'occ.iam_identities', 'DELETE') AS delete_identity,
         has_function_privilege(
           current_user,
           'occ.finalize_agent_deletion(text,text,text,uuid)',
           'EXECUTE'
         ) AS execute_finalizer,
         EXISTS (
           SELECT 1
           FROM information_schema.routine_privileges
           WHERE routine_schema = 'occ'
             AND routine_name = 'finalize_agent_deletion'
             AND grantee = 'PUBLIC'
             AND privilege_type = 'EXECUTE'
         ) AS public_execute`,
    );
    assert.deepEqual(privileges.rows, [
      {
        delete_agent: false,
        delete_revision: false,
        delete_identity: false,
        execute_finalizer: true,
        public_execute: false,
      },
    ]);
  },
);

test(
  "a deployment admitted after stop supersedes stale stop work before Compute mutation",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
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
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
    );
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
          // The shared queue can also dispatch another fixture's durable cleanup.
          if (revision.namespaceId === fixture.namespace.id) {
            stopped.push(revision.id);
          }
          return fixture.compute.stopRevision(revision);
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
            // The shared queue can also dispatch another fixture's durable cleanup.
            if (revision.namespaceId !== fixture.namespace.id) {
              return fixture.compute.stopRevision(revision);
            }
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

for (const { operation, action } of [
  { operation: "stop", action: "operate" },
  { operation: "delete", action: "delete" },
]) {
  test(
    `Agent ${operation} reauthorizes the recorded actor before Compute mutation`,
    requiresPostgres,
    async (context) => {
      const metrics = createOccMetrics("worker", () =>
        new PostgresMetricsSnapshot(fixture.observerPool).collect(),
      );
      const fixture = await setup(context, { metrics });
      const before = await new PostgresMetricsSnapshot(fixture.observerPool).collect();
      const owner = await fixture.agent(`${operation}-reauthorization`);
      const revision = await fixture.revision(owner, 1);
      const effects = [];
      const compute = {
        ...fixture.compute,
        async stopRevision(candidate) {
          effects.push({ action: "stop", agentId: candidate.agentId });
        },
        async retireRevision(candidate) {
          effects.push({ action: "retire", agentId: candidate.agentId });
        },
        async deleteAgentRuntimeCredentials({ agent }) {
          effects.push({ action: "credentials", agentId: agent.id });
        },
      };
      await fixture.start(compute);
      await fixture.work(revision, "succeeded");

      await fixture.stop();
      const work = await (operation === "stop"
        ? fixture.requestStop(owner)
        : fixture.requestDeletion(owner));
      // Admission was authorized; revoke before restarting the worker to prove
      // dispatch independently rechecks the recorded actor's permission.
      await fixture.observerPool.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, $3, 'agent', $4, 'deny')`,
        [`restriction-${randomUUID()}`, fixture.namespace.id, action, owner.id],
      );
      await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
      assert.equal((await fixture.work(work, "failed_permanent")).attempt_count, 1);
      if (operation === "stop") {
        assert.equal(
          (await new PostgresMetricsSnapshot(fixture.observerPool).collect()).agents.failed,
          before.agents.failed + 1,
        );
        assert.match(
          await metrics.exposition(),
          /occ_agent_operation_duration_seconds_count\{[^\n]*operation="stop"[^\n]*\} 0(?:\n|$)/,
        );
      }

      // The shared queue can also dispatch another fixture's durable cleanup.
      assert.deepEqual(
        effects.filter(({ agentId }) => agentId === owner.id),
        [],
      );
      const current = await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, owner.id),
      );
      assert.equal(current.activeRevisionId, revision.id);
      assert.equal(current.desiredRuntimeState, "stopped");
      assert.equal(current.status, operation === "delete" ? "deleting" : "active");
      const audit = await fixture.observerPool.query(
        `SELECT kind, action, outcome,
              details->'__occAuditMetadata'->'authorization' AS authorization,
              details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1 AND resource_id = $2
         AND kind = 'authorization_denial'`,
        [fixture.namespace.id, owner.id],
      );
      assert.deepEqual(audit.rows, [
        {
          kind: "authorization_denial",
          action: `openclaw.agents.${operation}`,
          outcome: "denied",
          authorization: {
            principalId: fixture.actor.id,
            action,
            resource: { kind: "agent", id: owner.id, namespaceId: fixture.namespace.id },
          },
          reason_code: "AUTHORIZATION_DENIED",
        },
      ]);
    },
  );
}

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

    // The shared queue can also deliver an independently authorized stop from
    // another Namespace while this Namespace denies its own Agent's shutdown.
    const neighbor = await setup(context, { database: fixture.database });
    const neighborOwner = await neighbor.agent("authorized-neighbor-stop");
    const neighborRevision = await neighbor.revision(neighborOwner, 1);
    await neighbor.start(neighbor.compute);
    await neighbor.work(neighborRevision, "succeeded");
    await neighbor.stop();
    const neighborStop = await neighbor.requestStop(neighborOwner);

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
          if (candidate.namespaceId === fixture.namespace.id) {
            stoppedRevisions.push(candidate.id);
          }
          return fixture.compute.stopRevision(candidate);
        },
      },
      (event) => events.push(event),
      undefined,
      undefined,
      fixture.createWorkerPool(),
    );

    await fixture.work(maintenance, "succeeded");
    await fixture.work(stop, "failed_permanent");
    await neighbor.work(neighborStop, "succeeded");
    assert.deepEqual(stoppedRevisions, []);
    const current = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(current.activeRevisionId, revision.id);
    assert.equal(current.desiredRuntimeState, "stopped");
    await completion(
      events,
      "the maintenance's REVISION_MAINTENANCE_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" &&
        code === "REVISION_MAINTENANCE_SUPERSEDED" &&
        revisionId === revision.id,
    );
  },
);

test(
  "a stop accepted during revision preparation prevents the candidate from becoming active",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("stop-prepare-race");
    // Other Namespaces share this worker's queue. Their durable stop work must
    // drain without changing this candidate's preparation gate or observations.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-prepare-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);
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
        if (revision.namespaceId === fixture.namespace.id) {
          preparationStarted = true;
          await preparationReleased;
        }
        return fixture.compute.prepareRevision(revision);
      },
      async stopRevision(revision) {
        if (revision.namespaceId === fixture.namespace.id) {
          stoppedRevisions.push(revision.id);
        }
        return fixture.compute.stopRevision(revision);
      },
    });
    await waitFor("revision preparation to start", async () =>
      preparationStarted ? true : undefined,
    );

    const stop = await fixture.requestStop(owner);
    releasePreparation();
    await fixture.work(candidate, "succeeded");
    await fixture.work(stop, "succeeded");
    await foreign.work(foreignRevision, "succeeded");
    await foreign.work(foreignStop, "succeeded");

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
    // The deployment did not activate, and its error says why instead of a generic failure.
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      candidate.id,
    );
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "REVISION_STOPPED",
      message: "Deployment ended because the Agent was stopped.",
    });
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

    // This worker must drain another Namespace's real stop work without adding
    // its effects to this Agent's observations or consuming its injected fault.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("stop-publication-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const foreignStop = await foreign.requestStop(foreignOwner);

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
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.stopRevision(candidate);
          }
          stoppedRevisions.push(candidate.id);
          return fixture.compute.stopRevision(candidate);
        },
        async retireRevision(candidate) {
          if (candidate.namespaceId !== fixture.namespace.id) {
            return fixture.compute.retireRevision(candidate);
          }
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
    await Promise.all([
      foreign.work(foreignRevision, "succeeded"),
      foreign.work(foreignStop, "succeeded"),
    ]);
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
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics, leaseDurationMs: 1_200 });
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
    // Periodic reconciliation must not inflate successful deployment counts.
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 2(?:\n|$)/,
    );
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
          backendId: null,
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
    const provider = backendDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "revoked-account",
    );
    await seedBackendBinding(fixture.observerPool, account);
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
    // The shared worker must drain another Namespace without including its
    // Compute effects in this Namespace's issuance-revocation assertions.
    const foreign = await setup(context, { database: fixture.database });
    const foreignOwner = await foreign.agent("issuance-foreign");
    const foreignRevision = await foreign.revision(foreignOwner, 1);
    const provider = backendDefinition();
    const accounts = await Promise.all(
      ["valid", "issuance-revoked"].map((label) =>
        createAccessTokenServiceAccount(fixture.state, fixture.namespace.id, label),
      ),
    );
    await Promise.all(accounts.map((account) => seedBackendBinding(fixture.observerPool, account)));
    const owners = await Promise.all(
      accounts.map((account) => fixture.agent(account.name, "dedicated", account.id, provider.id)),
    );
    const candidates = await Promise.all(owners.map((owner) => fixture.revision(owner, 1)));
    // Only issuance metadata is mutable; private Backend/account ownership
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
          if (agent.namespaceId === fixture.namespace.id) {
            effects.push({ action: "bind", agentId: agent.id });
          }
        },
        async prepareRevision(revision) {
          if (revision.namespaceId === fixture.namespace.id) {
            effects.push({ action: "prepare", revisionId: revision.id });
          }
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
    await foreign.work(foreignRevision, "succeeded");
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
    assert.deepEqual(failures.rows, [{ reason_code: "SERVICE_ACCOUNT_BACKEND_MISMATCH" }]);
  },
);

test(
  "the revision worker retries transient Backend binding read failures without activating",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    const events = [];
    const releaseRetry = Promise.withResolvers();
    const fixture = await setup(context, {
      async onHealthy() {
        if (
          events.some(
            ({ event, code, namespaceId }) =>
              event === "worker.completed" &&
              code === "DEPENDENCY_UNAVAILABLE" &&
              namespaceId === fixture.namespace.id,
          )
        ) {
          // Hold the next pass while inspecting the failed attempt, regardless
          // of how much of the retry backoff the observer has already consumed.
          await releaseRetry.promise;
        }
      },
    });
    const provider = backendDefinition();

    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "transient-provider-read",
    );
    await seedBackendBinding(fixture.observerPool, account);
    const owner = await fixture.agent(
      "transient-provider-read",
      "dedicated",
      account.id,
      provider.id,
    );

    const effects = [];
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
        poolWithOneBackendBindingReadFault(fixture.workerPool),
      );

      const candidate = await fixture.revision(owner, 1);

      // A different connection can see the committed retry before the worker
      // receives COMMIT's acknowledgment and emits its completion event.
      const completion = await waitFor("transient Provider read failure completion", async () =>
        events.find(
          ({ event, code, revisionId }) =>
            event === "worker.completed" &&
            code === "DEPENDENCY_UNAVAILABLE" &&
            revisionId === candidate.id,
        ),
      );
      assert.equal(completion.outcome, "retry");
      const retried = await waitFor(
        "transient Backend binding read failure retry evidence",
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
      assert.deepEqual(retried, { state: "queued", attempt_count: 1, dependency_failures: 1 });
      assert.deepEqual(effects, [], "transient binding read failures must not invoke Compute");
      const inactive = await fixture.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [fixture.namespace.id, owner.id],
      );
      assert.equal(inactive.rows[0].active_revision_id, null);

      releaseRetry.resolve();
      await fixture.work(candidate, "succeeded");
      assert.deepEqual(effects, [{ action: "prepare", revisionId: candidate.id }]);
      const active = await fixture.observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [fixture.namespace.id, owner.id],
      );
      assert.equal(active.rows[0].active_revision_id, candidate.id);
    } finally {
      releaseRetry.resolve();
      await fixture.stop();
    }
  },
);

test(
  "an older revision retry is superseded without preparing or retiring a newer active revision",
  requiresPostgres,
  async (context) => {
    const metrics = createOccMetrics("worker", () =>
      new PostgresMetricsSnapshot(fixture.observerPool).collect(),
    );
    const fixture = await setup(context, { metrics });
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
    // The deploy duration is observed just before the newer revision's completion
    // event; the older retry's supersession completes without a deploy observation.
    await completion(
      events,
      "the newer revision's successful completion",
      ({ event, workId, outcome }) =>
        event === "worker.completed" && workId === newer.idempotencyKey && outcome === "success",
    );
    await completion(
      events,
      "the older revision's REVISION_SUPERSEDED completion",
      ({ event, code, revisionId }) =>
        event === "worker.completed" && code === "REVISION_SUPERSEDED" && revisionId === older.id,
    );
    assert.match(
      await metrics.exposition(),
      /occ_agent_operation_duration_seconds_count\{[^\n]*operation="deploy"[^\n]*\} 1(?:\n|$)/,
    );
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
  },
);

test(
  "deployment progress distinguishes deferred work and isolates each work item's evidence",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("deployment-progress");
    const candidate = await fixture.revision(owner, 1);
    const queue = new fixture.PostgresWorkQueue(fixture.observerPool);
    const readStatus = () =>
      fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      );

    const initial = await readStatus();
    assert.equal(initial.status, "queued");
    assert.equal(initial.progress.lastAttempt, null);

    const evidenceCodes = async () =>
      (
        await fixture.observerPool.query(
          `SELECT details->>'reasonCode' AS code FROM occ.audit_events
           WHERE details->>'workId' = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
          [candidate.idempotencyKey],
        )
      ).rows.map(({ code }) => code);
    const makeDue = () =>
      fixture.observerPool.query(
        "UPDATE occ.controller_work SET available_at = clock_timestamp() WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );

    // A normal pending observation restores the failure budget to zero. It must
    // still be distinguishable from a deployment that has never been checked.
    const first = await queue.claim();
    assert.equal(first.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(first, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const firstDeferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);

    // Repeating the same pending result is not a state transition: it adds no audit row,
    // and progress keeps reporting when that result was first recorded.
    await makeDue();
    const claim = await queue.claim();
    assert.equal(claim.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(claim, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const deferred = await readStatus();
    assert.deepEqual(await evidenceCodes(), ["REVISION_INCOMPLETE"]);
    assert.deepEqual(deferred.progress.lastAttempt, firstDeferred.progress.lastAttempt);
    assert.equal(deferred.status, "queued");
    assert.equal((await queue.findWork(candidate.idempotencyKey)).attemptCount, 0);
    assert.equal(deferred.progress.lastAttempt.code, "REVISION_INCOMPLETE");
    assert.equal(deferred.progress.lastAttempt.message, "Waiting for the runtime to become ready.");
    assert.ok(Number.isFinite(Date.parse(deferred.progress.lastAttempt.at)));
    assert.equal(
      deferred.progress.nextAttemptAt,
      (await queue.findWork(candidate.idempotencyKey)).availableAt.toISOString(),
    );

    // Maintenance shares the revision and actor, but cannot overwrite the
    // original deployment's progress. Both transitions use the real queue.
    const maintenanceKey = `agent_revision:${candidate.id}:maintenance:0`;
    await queue.enqueue({
      idempotencyKey: maintenanceKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
      actorId: fixture.actor.id,
    });
    const maintenance = await queue.claim();
    assert.equal(maintenance.idempotencyKey, maintenanceKey);
    await queue.defer(maintenance, { code: "DEPENDENCY_UNAVAILABLE" }, { delayMs: 60_000 });
    assert.deepEqual((await readStatus()).progress, deferred.progress);

    // Rescheduling only our fixture work lets a new claim exercise retry output.
    await makeDue();
    const retry = await queue.claim();
    assert.equal(retry.idempotencyKey, candidate.idempotencyKey);
    const running = await readStatus();
    assert.equal(running.status, "running");
    assert.equal(running.progress.nextAttemptAt, null);
    assert.deepEqual(running.progress.lastAttempt, deferred.progress.lastAttempt);
    await queue.retry(retry, { code: "PRIVATE_PROVIDER_DETAIL_DO_NOT_EXPOSE" });
    const retrying = await readStatus();
    assert.equal(retrying.progress.lastAttempt.code, "RECONCILIATION_PENDING");
    assert.doesNotMatch(JSON.stringify(retrying), /PRIVATE_PROVIDER/);

    // Returning to the pending result after a failure is a transition and is recorded again.
    await makeDue();
    const recovered = await queue.claim();
    assert.equal(recovered.idempotencyKey, candidate.idempotencyKey);
    await queue.defer(recovered, { code: "REVISION_INCOMPLETE" }, { delayMs: 60_000 });
    const codes = await evidenceCodes();
    assert.equal(codes.length, 3);
    assert.equal(codes[0], "REVISION_INCOMPLETE");
    assert.equal(codes[2], "REVISION_INCOMPLETE");
    assert.equal((await readStatus()).progress.lastAttempt.code, "REVISION_INCOMPLETE");

    // Let the real worker finish this admitted revision; completion must remove
    // the pending explanation rather than retain an obsolete readiness warning.
    await makeDue();
    await fixture.start(fixture.compute);
    await fixture.work(candidate, "succeeded");
    const completed = await readStatus();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.progress, null);
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
    const events = [];

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          const observation = await fixture.compute.prepareRevision(revision);
          observations += 1;
          // Image pulls and app-server startup remain ordinary pending observations, not failures.
          return observations <= 7 ? { ...observation, ready: false } : observation;
        },
      },
      (event) => events.push(event),
    );

    const completed = await fixture.work(candidate, "succeeded");
    assert.equal(observations, 8);
    assert.equal(completed.attempt_count, 1);

    // Each pass reports its deployment phase timing; the successful pass carries
    // the totals across all eight passes of this one work item.
    const passes = await waitFor("the successful deployment pass to be reported", () => {
      const reported = events.filter(
        (event) => event.event === "worker.completed" && event.workId === candidate.idempotencyKey,
      );
      return reported.at(-1)?.outcome === "success" ? reported : undefined;
    });
    assert.deepEqual(
      passes.map(({ outcome, code, deployPasses }) => ({ outcome, code, deployPasses })),
      [
        ...Array.from({ length: 7 }, (_, index) => ({
          outcome: "pending",
          code: "REVISION_INCOMPLETE",
          deployPasses: index + 1,
        })),
        { outcome: "success", code: "REVISION_ACTIVATED", deployPasses: 8 },
      ],
    );
    for (const pass of passes.slice(0, 7)) {
      assert.equal(pass.activationMs, undefined, "an unready pass has no activation phase");
    }
    const success = passes.at(-1);
    // Seven jittered readiness retries separate the first unready and the ready observation.
    assert.ok(success.readinessWaitMs > 0);
    assert.ok(success.readinessWaitMs >= passes[6].readinessWaitMs);
    assert.ok(success.elapsedMs >= success.readinessWaitMs);
    assert.ok(success.prepareMs >= 0 && success.prepareMs <= success.elapsedMs);
    assert.ok(success.activationMs >= 0 && success.activationMs <= success.durationMs);
    assert.ok(success.durationMs <= success.elapsedMs);

    // The pending state is durable and attributable, but seven identical deferrals are one
    // state transition: the audit log records it once, then the activation.
    const evidence = await fixture.observerPool.query(
      `SELECT outcome, details->>'reasonCode' AS reason_code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at, id`,
      [candidate.id],
    );
    assert.deepEqual(evidence.rows, [
      { outcome: "success", reason_code: "REVISION_INCOMPLETE" },
      { outcome: "success", reason_code: "REVISION_ACTIVATED" },
    ]);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, candidate.id);
  },
);

test(
  "real PostgreSQL rechecks a not-ready runtime on a short fixed delay after transient failures",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("readiness-recheck");
    const candidate = await fixture.revision(owner, 1);
    const recheckDelays = [];
    let observations = 0;

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          if (revision.id !== candidate.id) {
            return fixture.compute.prepareRevision(revision);
          }
          observations += 1;
          // Two dependency failures raise the attempt count, so the queue's
          // exponential retry backoff would now allow up to 4 s per recheck.
          if (observations <= 2) {
            throw new Error("transient Compute dependency failure");
          }
          const observation = await fixture.compute.prepareRevision(revision);
          return observations <= 5 ? { ...observation, ready: false } : observation;
        },
      },
      (event) => {
        if (
          event.event === "worker.completed" &&
          event.workId === candidate.idempotencyKey &&
          event.outcome === "pending"
        ) {
          // The deferral sets the due time and updated_at in one statement, and the
          // row stays queued until that due time, about 500 ms after this event.
          recheckDelays.push(
            fixture.observerPool
              .query(
                `SELECT state, EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                [candidate.idempotencyKey],
              )
              .then(({ rows }) => rows[0]),
          );
        }
      },
    );

    const completed = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(observations, 6);
    // Failures consumed two attempts; readiness rechecks refunded theirs.
    assert.equal(completed.attempt_count, 3);
    const recheckDelaysMs = [];
    for (const { state, delay_ms } of await Promise.all(recheckDelays)) {
      assert.equal(state, "queued");
      recheckDelaysMs.push(Number(delay_ms));
    }
    assert.equal(recheckDelaysMs.length, 3);
    for (const delayMs of recheckDelaysMs) {
      assert.ok(
        delayMs > 450 && delayMs <= 500,
        `readiness recheck must wait about 500 ms, not the retry backoff (${delayMs} ms)`,
      );
    }
  },
);

test(
  "deployment progress names Compute's pending reason and old pending work rechecks less often",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const unscheduled = await fixture.agent("pending-unschedulable");
    const unpaired = await fixture.agent("pending-node");
    const unscheduledRevision = await fixture.revision(unscheduled, 1);
    const unpairedRevision = await fixture.revision(unpaired, 1);
    const reasons = new Map([
      [unscheduledRevision.id, "WORKLOAD_UNSCHEDULABLE"],
      [unpairedRevision.id, "WORKSPACE_NODE_PENDING"],
    ]);
    const delays = [];
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            pendingReason: reasons.get(revision.id),
          };
        },
      },
      (event) => {
        if (
          event.event === "worker.completed" &&
          event.workId === unpairedRevision.idempotencyKey &&
          event.outcome === "pending"
        ) {
          delays.push(
            fixture.observerPool
              .query(
                `SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) * 1000 AS delay_ms
                 FROM occ.controller_work WHERE idempotency_key = $1`,
                [event.workId],
              )
              .then(({ rows }) => Number(rows[0].delay_ms)),
          );
        }
      },
    );
    const progress = async (owner, revision) => {
      const lastAttempt = await waitFor(`pending progress for ${revision.id}`, async () => {
        const status = await fixture.controller.getDeploymentStatus(
          fixture.actor.id,
          fixture.namespace.id,
          owner.id,
          revision.id,
        );
        return status.progress?.lastAttempt ?? undefined;
      });
      return { code: lastAttempt.code, message: lastAttempt.message };
    };
    assert.deepEqual(await progress(unscheduled, unscheduledRevision), {
      code: "REVISION_UNSCHEDULABLE",
      message:
        "The cluster has no room for this Agent's Pods yet; they are waiting to be scheduled.",
    });
    assert.deepEqual(await progress(unpaired, unpairedRevision), {
      code: "WORKSPACE_NODE_PENDING",
      message: "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
    });
    const fresh = await delays[0];
    assert.ok(fresh > 450 && fresh <= 500, `a new deployment rechecks in 500 ms (${fresh} ms)`);

    // Five minutes later, still inside the 900-second deadline, a runtime that
    // stays unready is rechecked every 5 s, so one stuck Agent cannot take most
    // of the serial worker (D223). Only the worker's wall clock moves.
    const realNow = Date.now;
    Date.now = () => realNow() + 300_000;
    context.after(() => {
      Date.now = realNow;
    });
    const seen = delays.length;
    await waitFor("a recheck after five minutes", async () => delays.length > seen || undefined);
    const old = await delays[seen];
    Date.now = realNow;
    assert.ok(old > 4_500 && old <= 5_000, `an old deployment rechecks in 5 s (${old} ms)`);
  },
);

test(
  "the revision worker emits bounded Driver diagnostics for failed Compute preparation",
  requiresPostgres,
  async (context) => {
    const events = [];
    const fixture = await setup(context, { maxAttempts: 1 });
    const owner = await fixture.agent("compute-preparation-diagnostic");
    const candidate = await fixture.revision(owner, 1);
    const failure = new Error("opaque provider response that must not be logged");

    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          if (revision.id === candidate.id) {
            throw failure;
          }
          return fixture.compute.prepareRevision(revision);
        },
        describePrepareRevisionFailure(error) {
          assert.equal(error, failure);
          return {
            code: "KUBERNETES_API_REJECTED",
            stage: "gateway_deployment",
            errorClass: "KubernetesApiError",
            message: "The Kubernetes API rejected revision preparation.",
            status: 422,
          };
        },
      },
      (event) => events.push(event),
    );

    await fixture.work(candidate, "failed_permanent");
    await completion(
      events,
      "the failed preparation's completion",
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.code === "DEPENDENCY_UNAVAILABLE" &&
        event.outcome === "retry",
    );
    const diagnostic = events.find(
      (event) =>
        event.event === "worker.compute-prepare-failed" && event.revisionId === candidate.id,
    );
    assert.deepEqual(diagnostic, {
      event: "worker.compute-prepare-failed",
      workId: candidate.idempotencyKey,
      attempt: 1,
      operation: "agent_revision.reconcile",
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: candidate.id,
      computeDriverId: fixture.compute.id,
      code: "KUBERNETES_API_REJECTED",
      step: "gateway_deployment",
      errorClass: "KubernetesApiError",
      message: "The Kubernetes API rejected revision preparation.",
      status: 422,
    });
    assert.equal(JSON.stringify(events).includes(failure.message), false);
  },
);

test(
  "an overdue Agent runtime fails closed without activating its incomplete revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("expired-runtime");
    const candidate = await fixture.revision(owner, 1);
    const runtimeFailure = {
      component: "gateway",
      check: "readyz",
      checkedAt: "2026-09-19T20:30:00.000Z",
      code: "STARTUP_FAILED",
    };

    // A real short deadline expires against the durable queued creation timestamp.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision) {
          return {
            ...(await fixture.compute.prepareRevision(revision)),
            ready: false,
            runtimeFailure,
          };
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
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      candidate.id,
    );
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "CONVERGENCE_DEADLINE_EXCEEDED",
      message: "Deployment convergence deadline exceeded.",
      data: { timeoutMs: 1, runtimeFailure },
    });
    assert.deepEqual(status.warnings, []);
  },
);

test(
  "rejected runtime credentials fail deployment before the convergence deadline",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("rejected-runtime");
    const candidate = await fixture.revision(owner, 1);
    const failure = (code) => ({
      component: "agent",
      check: "model-probe",
      checkedAt: "2026-09-29T08:00:00.000Z",
      code,
    });
    let observations = 0;

    // The default 900-second deadline stays in force: an unready runtime without
    // failure evidence remains pending, and the held rejection ends the deployment.
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        observations += 1;
        const observed = {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: false,
        };
        return observations === 1
          ? observed
          : { ...observed, runtimeFailure: failure("AUTHENTICATION_FAILED") };
      },
    });

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(observations, 2);
    assert.equal(failed.attempt_count, 1);
    const result = await fixture.observerPool.query(
      "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(result.rows, [
      { reason_code: "RUNTIME_AUTHENTICATION_FAILED", result_data: null },
    ]);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, null);
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND details->>'reasonCode' IN
         ('REVISION_INCOMPLETE', 'RUNTIME_AUTHENTICATION_FAILED')
       ORDER BY occurred_at`,
      [candidate.id],
    );
    assert.deepEqual(
      evidence.rows.map(({ reason }) => reason),
      ["REVISION_INCOMPLETE", "RUNTIME_AUTHENTICATION_FAILED"],
    );
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      candidate.id,
    );
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "RUNTIME_AUTHENTICATION_FAILED",
      message: "Deployment runtime credentials were rejected.",
    });
  },
);

test(
  "a CPU-starved startup model probe fails deployment before the convergence deadline",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("cpu-starved-runtime");
    const candidate = await fixture.revision(owner, 1);
    let observations = 0;

    // Under the default 900-second deadline an unready runtime without failure
    // evidence stays pending; a probe that ran out of CPU at the container's
    // limit ends the deployment.
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        observations += 1;
        const observed = {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: false,
        };
        return observations === 1
          ? observed
          : {
              ...observed,
              runtimeFailure: {
                component: "gateway",
                check: "model-probe",
                checkedAt: "2026-09-30T08:00:00.000Z",
                code: "MODEL_PROBE_CPU_STARVED",
              },
            };
      },
    });

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(observations, 2);
    assert.equal(failed.attempt_count, 1);
    const result = await fixture.observerPool.query(
      "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(result.rows, [{ reason_code: "RUNTIME_CPU_STARVED", result_data: null }]);
    const active = await fixture.observerPool.query(
      "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
      [fixture.namespace.id, owner.id],
    );
    assert.equal(active.rows[0].active_revision_id, null);
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      candidate.id,
    );
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "RUNTIME_CPU_STARVED",
      message: "Deployment runtime did not get enough CPU to start.",
    });
  },
);

test(
  "held runtime probe and login failures fail deployment before the convergence deadline",
  requiresPostgres,
  async (context) => {
    // Runtime entrypoints publish these codes only after their own retries end
    // and then hold the container unready with nothing to restart it, so the
    // default 900-second deadline could only report the same failure later.
    const fixture = await setup(context);
    const cases = [
      [
        "agent",
        "model-probe",
        "MODEL_PROBE_TIMEOUT",
        "RUNTIME_MODEL_PROBE_TIMEOUT",
        "Deployment runtime startup model check timed out.",
      ],
      [
        "gateway",
        "model-probe",
        "MODEL_PROBE_FAILED",
        "RUNTIME_MODEL_PROBE_FAILED",
        "Deployment runtime startup model check failed.",
        // The runtime's classified cause is persisted with the failure it explains.
        { kind: "PROBE_STATUS", detail: "format" },
      ],
      [
        "agent",
        "model-probe",
        "MODEL_PROBE_FAILED",
        "RUNTIME_MODEL_PROBE_FAILED",
        "Deployment runtime startup model check failed.",
        { kind: "WRAPPER_ERROR" },
      ],
      [
        "agent",
        "login",
        "LOGIN_FAILED",
        "RUNTIME_LOGIN_FAILED",
        "Deployment runtime could not sign in to the model provider.",
      ],
      [
        "gateway",
        "plugin-approvers",
        "INCOMPATIBLE_RESPONSE",
        "RUNTIME_STARTUP_FAILED",
        "Deployment runtime failed a startup check.",
      ],
    ];
    const failures = new Map();
    const candidates = [];
    for (const [index, [component, check, runtimeCode, , , cause]] of cases.entries()) {
      const owner = await fixture.agent(`held-runtime-${index}`);
      const candidate = await fixture.revision(owner, 1);
      failures.set(candidate.id, {
        component,
        check,
        checkedAt: "2026-10-01T08:00:00.000Z",
        code: runtimeCode,
        ...(cause === undefined ? {} : { cause }),
      });
      candidates.push({ owner, candidate });
    }
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        return {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: false,
          runtimeFailure: failures.get(revision.id),
        };
      },
    });

    for (const [index, { owner, candidate }] of candidates.entries()) {
      const [, , , code, message] = cases[index];
      const failed = await fixture.work(candidate, "failed_permanent", 10_000);
      assert.equal(failed.attempt_count, 1);
      const result = await fixture.observerPool.query(
        "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      // Only a failed model probe keeps its runtime failure evidence.
      const data =
        code === "RUNTIME_MODEL_PROBE_FAILED"
          ? { runtimeFailure: failures.get(candidate.id) }
          : undefined;
      assert.deepEqual(result.rows, [{ reason_code: code, result_data: data ?? null }]);
      const status = await fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      );
      assert.equal(status.status, "failed");
      assert.deepEqual(status.error, { code, message, ...(data === undefined ? {} : { data }) });
    }

    // The database admits only the classified shape: no extra fields, no
    // unknown kind, no free text in the detail, and no cause on another code.
    const [{ candidate: probeFailed }] = candidates.slice(1, 2);
    const evidence = failures.get(probeFailed.id);
    for (const invalid of [
      {},
      { runtimeFailure: { ...evidence, cause: { kind: "PROBE_STATUS", detail: "HTTP 404 body" } } },
      { runtimeFailure: { ...evidence, cause: { kind: "PROVIDER_TEXT", detail: "format" } } },
      { runtimeFailure: { ...evidence, cause: { detail: "format" } } },
      { runtimeFailure: { ...evidence, cause: { kind: "PROBE_STATUS", message: "raw" } } },
      { runtimeFailure: { ...evidence, error: "raw provider response" } },
      { runtimeFailure: { ...evidence, code: "AUTHENTICATION_FAILED" } },
      { runtimeFailure: evidence, timeoutMs: 1 },
    ]) {
      await assert.rejects(
        fixture.observerPool.query(
          "UPDATE occ.controller_work SET result_data = $2::jsonb WHERE idempotency_key = $1",
          [probeFailed.idempotencyKey, JSON.stringify(invalid)],
        ),
        (error) =>
          error.code === "23514" && error.constraint === "controller_work_result_data_state",
        JSON.stringify(invalid),
      );
    }
  },
);

test(
  "a replacement that fails after pointer publication stays the Agent's active revision",
  requiresPostgres,
  async (context) => {
    // Kubernetes embedded replacement reports a new revision ready while its
    // predecessor serves, publishes it, and only then replaces the shared
    // gateway. When the replacement's startup model probe then rejects the
    // credential, the predecessor no longer runs: the failed revision owns the
    // only runtime, so it stays active for stop, deletion, and diagnostics
    // until a later revision replaces it. OCC never rolls back automatically.
    const fixture = await setup(context);
    const owner = await fixture.agent("failed-published-replacement");
    const healthy = await fixture.revision(owner, 1);
    let rejectCredential = false;
    const activations = [];
    const retired = [];
    const compute = {
      ...fixture.compute,
      async prepareRevision(revision) {
        const observation = await fixture.compute.prepareRevision(revision);
        // The first observation of a replacement reflects the serving predecessor.
        if (!rejectCredential || !activations.includes(revision.id)) {
          return observation;
        }
        return {
          ...observation,
          ready: false,
          runtimeFailure: {
            component: "gateway",
            check: "model-probe",
            checkedAt: "2026-09-30T17:14:54.000Z",
            code: "AUTHENTICATION_FAILED",
          },
        };
      },
      async activateRevision(revision) {
        activations.push(revision.id);
        if (rejectCredential) {
          throw new Error("The exact AgentRevision gateway is not ready.");
        }
      },
      async retireRevision(revision) {
        retired.push(revision.id);
        return fixture.compute.retireRevision(revision);
      },
    };
    await fixture.start(compute);
    await fixture.work(healthy, "succeeded");
    const activeRevision = async () =>
      (
        await fixture.observerPool.query(
          "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
          [fixture.namespace.id, owner.id],
        )
      ).rows[0].active_revision_id;
    assert.equal(await activeRevision(), healthy.id);

    rejectCredential = true;
    const rejected = await fixture.revision(owner, 2);
    await fixture.work(rejected, "failed_permanent");
    const codes = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS reason FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' ORDER BY occurred_at`,
      [rejected.id],
    );
    assert.deepEqual(
      [...new Set(codes.rows.map(({ reason }) => reason))],
      ["REVISION_FINALIZATION_INCOMPLETE", "RUNTIME_AUTHENTICATION_FAILED"],
    );
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      rejected.id,
    );
    assert.equal(status.status, "failed");
    assert.equal(status.error.code, "RUNTIME_AUTHENTICATION_FAILED");
    assert.equal(await activeRevision(), rejected.id);
    assert.deepEqual(retired, []);

    // Recovery is a new, higher revision; it replaces the failed one.
    rejectCredential = false;
    const repaired = await fixture.revision(owner, 3);
    await fixture.work(repaired, "succeeded");
    assert.equal(await activeRevision(), repaired.id);
    assert.deepEqual(retired.toSorted(), [healthy.id, rejected.id].toSorted());
  },
);

test(
  "a Sandbox Driver that cannot run the revision fails deployment without retrying",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("sandbox-unsupported");
    const candidate = await fixture.revision(owner, 1);
    let observations = 0;

    // The OpenShell SandboxDriver cannot project secretKeyRef environment. The
    // same revision fails the same way on every attempt, so it is terminal.
    await fixture.start({
      ...fixture.compute,
      async prepareRevision() {
        observations += 1;
        throw new SandboxRevisionUnsupportedError(
          "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
          "OpenShell v0.1.3-pre.2 cannot receive secretKeyRef environment APP_SERVER_TOKEN.",
        );
      },
    });

    const failed = await fixture.work(candidate, "failed_permanent");
    assert.equal(observations, 1);
    assert.equal(failed.attempt_count, 1);
    const result = await fixture.observerPool.query(
      "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
      [candidate.idempotencyKey],
    );
    assert.deepEqual(result.rows, [
      { reason_code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED", result_data: null },
    ]);
    const status = await fixture.controller.getDeploymentStatus(
      fixture.actor.id,
      fixture.namespace.id,
      owner.id,
      candidate.id,
    );
    assert.equal(status.status, "failed");
    assert.deepEqual(status.error, {
      code: "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
      message:
        "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness.",
    });
  },
);

test(
  "a Gateway route that lags its Ready Pod is retried within the deadline, not the attempt budget",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("gateway-route-lag");
    const candidate = await fixture.revision(owner, 1);
    const events = [];
    const progress = [];
    let failures = 0;

    // D28: the worker reaches a new Gateway through its private route as soon as
    // the Pod is Ready. Until Envoy programs the new HTTPRoute the upgrade answers
    // 404, for longer than five quick retries last. Fail more passes than the
    // attempt budget allows, then let the route converge.
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, revisionContext) {
          if (failures < 8) {
            failures += 1;
            if (failures === 3) {
              const status = await fixture.controller.getDeploymentStatus(
                fixture.actor.id,
                fixture.namespace.id,
                owner.id,
                candidate.id,
              );
              progress.push(status.progress?.lastAttempt);
            }
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          return fixture.compute.prepareRevision(revision, revisionContext);
        },
      },
      (event) => events.push(event),
    );

    const succeeded = await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(failures, 8);
    assert.equal(succeeded.attempt_count, 1);
    assert.equal(
      (
        await fixture.controller.getDeploymentStatus(
          fixture.actor.id,
          fixture.namespace.id,
          owner.id,
          candidate.id,
        )
      ).status,
      "succeeded",
    );
    assert.equal(progress.length, 1);
    assert.equal(progress[0]?.code, "AGENT_GATEWAY_UNAVAILABLE");
    assert.equal(
      progress[0]?.message,
      "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
    );
    const passes = events.filter(
      (event) => event.event === "worker.completed" && event.revisionId === candidate.id,
    );
    assert.deepEqual(
      passes.slice(0, 8).map(({ outcome, code, dependency, cause }) => ({
        outcome,
        code,
        dependency,
        cause,
      })),
      Array.from({ length: 8 }, () => ({
        outcome: "pending",
        code: "AGENT_GATEWAY_UNAVAILABLE",
        dependency: "agent_gateway",
        cause: "unavailable",
      })),
    );
  },
);

test(
  "an activation wait or a lagging Gateway route keeps its own code, not REVISION_FINALIZATION_INCOMPLETE",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("activation-wait-codes");
    const candidate = await fixture.revision(owner, 1);
    const events = [];
    const progress = [];
    const readProgress = async () =>
      (
        await fixture.controller.getDeploymentStatus(
          fixture.actor.id,
          fixture.namespace.id,
          owner.id,
          candidate.id,
        )
      ).progress?.lastAttempt;
    let activations = 0;

    // D330: dedicated activation runs after the pointer is published. It waits
    // for the Gateway to apply its workspace node, for the Harness node to
    // connect, and reaches the Gateway through its route, which can answer 404
    // while Envoy converges. Each pass must name what it waits on.
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations > 1) {
            progress.push(await readProgress());
          }
          if (activations <= 2) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_BINDING_PENDING",
              "The exact AgentRevision gateway has not applied its workspace node.",
            );
          }
          if (activations === 3) {
            throw new ActivationPendingError(
              "WORKSPACE_NODE_PENDING",
              "The exact AgentRevision Harness node is not ready.",
            );
          }
          if (activations === 4) {
            throw new TransientDependencyError(
              "agent_gateway",
              "unavailable",
              "The Agent Gateway route answered HTTP 404 to the connection upgrade.",
            );
          }
          if (activations === 5) {
            throw new RangeError("unexpected activation failure");
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      (event) => events.push(event),
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 6);
    assert.deepEqual(
      progress.map((attempt) => [attempt?.code, attempt?.message]),
      [
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_BINDING_PENDING",
          "Workloads are ready; waiting for the Gateway to apply the workspace node.",
        ],
        [
          "WORKSPACE_NODE_PENDING",
          "Workloads are ready; waiting for the workspace node to connect to the Gateway.",
        ],
        [
          "AGENT_GATEWAY_UNAVAILABLE",
          "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.",
        ],
        [
          "RECONCILIATION_PENDING",
          "Deployment has not completed. Another reconciliation is pending.",
        ],
      ],
    );
    const passes = events
      .filter(
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.id &&
          event.outcome === "pending",
      )
      .slice(-5)
      .map(({ code, dependency, cause }) => ({ code, dependency, cause }));
    assert.deepEqual(passes, [
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      {
        code: "WORKSPACE_NODE_BINDING_PENDING",
        dependency: undefined,
        cause: "ActivationPendingError",
      },
      { code: "WORKSPACE_NODE_PENDING", dependency: undefined, cause: "ActivationPendingError" },
      { code: "AGENT_GATEWAY_UNAVAILABLE", dependency: "agent_gateway", cause: "unavailable" },
      { code: "REVISION_FINALIZATION_INCOMPLETE", dependency: undefined, cause: "RangeError" },
    ]);
    const succeeded = await fixture.work(candidate, "succeeded");
    assert.equal(succeeded.attempt_count, 1);
  },
);

test(
  "an activation pass that a failed private Secret write ends logs the API status and reason",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const owner = await fixture.agent("activation-private-write-status");
    const candidate = await fixture.revision(owner, 1);
    const events = [];
    let activations = 0;
    const { ApiException } = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    )("@kubernetes/client-node");

    // The Kubernetes Driver writes a revision's private Secrets on activation too. When the
    // API server refuses such a write, it raises its own DependencyUnavailableError rather
    // than the client error, whose message and body echo the Secret, and keeps only the HTTP
    // status and Status reason as the cause. tests/conformance/kubernetes-compute.test.mjs
    // pins that Driver shape; this case proves the worker's side: its log must carry that
    // status and reason, not only the class. A 429 or 5xx answer is transient instead and
    // keeps the same evidence as its cause. Any other 4xx client error, which the Driver
    // passes on unchanged, carries the status in its own code.
    const refused = new DependencyUnavailableError(
      "Workspace setup private delivery is unavailable.",
    );
    refused.cause = Object.assign(new Error("The Kubernetes API answered HTTP 403 (Forbidden)."), {
      code: 403,
      reason: "Forbidden",
    });
    const unavailable = new TransientDependencyError(
      "kubernetes_api",
      "unavailable",
      "The Kubernetes API answered HTTP 503.",
      {
        cause: Object.assign(
          new Error("The Kubernetes API answered HTTP 503 (ServiceUnavailable)."),
          { code: 503, reason: "ServiceUnavailable" },
        ),
      },
    );
    await fixture.start(
      {
        ...fixture.compute,
        async activateRevision(revision, revisionContext) {
          activations += 1;
          if (activations === 1) {
            throw refused;
          }
          if (activations === 2) {
            throw unavailable;
          }
          if (activations === 3) {
            throw new ApiException(409, "conflict", "{}", {});
          }
          return fixture.compute.activateRevision?.(revision, revisionContext);
        },
      },
      (event) => events.push(event),
    );

    await fixture.work(candidate, "succeeded", 30_000);
    assert.equal(activations, 4);
    const pending = events.filter(
      (event) =>
        event.event === "worker.completed" &&
        event.revisionId === candidate.id &&
        event.outcome === "pending",
    );
    assert.deepEqual(
      pending.map(({ code, dependency, cause, status, reason }) => ({
        code,
        dependency,
        cause,
        status,
        reason,
      })),
      [
        {
          code: "REVISION_FINALIZATION_INCOMPLETE",
          dependency: undefined,
          cause: "DependencyUnavailableError",
          status: 403,
          reason: "Forbidden",
        },
        {
          code: "KUBERNETES_API_UNAVAILABLE",
          dependency: "kubernetes_api",
          cause: "unavailable",
          status: 503,
          reason: "ServiceUnavailable",
        },
        {
          code: "REVISION_FINALIZATION_INCOMPLETE",
          dependency: undefined,
          cause: "ApiException",
          status: 409,
          reason: undefined,
        },
      ],
    );
  },
);

// D381 follow-up: a dedicated Gateway that refuses its own in-Pod CLI as unauthorized
// can never apply its workspace node for this revision, so activation must fail the
// deployment with a named code instead of staying pending until the convergence
// deadline. Both activation paths are covered: the pass that publishes the active
// pointer, and a later pass that finds the pointer already published.
for (const pendingPasses of [0, 1]) {
  test(
    `an activation the Gateway refuses as unauthorized fails deployment at once (after ${pendingPasses} pending passes)`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(`gateway-unauthorized-${pendingPasses}`);
      const candidate = await fixture.revision(owner, 1);
      const events = [];
      let activations = 0;

      await fixture.start(
        {
          ...fixture.compute,
          async activateRevision() {
            activations += 1;
            if (activations <= pendingPasses) {
              throw new ActivationPendingError(
                "WORKSPACE_NODE_BINDING_PENDING",
                "The exact AgentRevision gateway has not applied its workspace node.",
              );
            }
            throw new ActivationFailedError(
              "AGENT_GATEWAY_UNAUTHORIZED",
              "The exact AgentRevision gateway refused its own CLI as unauthorized.",
            );
          },
        },
        (event) => events.push(event),
      );

      const failed = await fixture.work(candidate, "failed_permanent", 30_000);
      // No retry after the refusal: the first refused pass ends the deployment.
      assert.equal(activations, pendingPasses + 1);
      assert.equal(failed.attempt_count, 1);
      const result = await fixture.observerPool.query(
        "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      assert.deepEqual(result.rows, [
        { reason_code: "AGENT_GATEWAY_UNAUTHORIZED", result_data: null },
      ]);
      const status = await fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      );
      assert.equal(status.status, "failed");
      assert.deepEqual(status.error, {
        code: "AGENT_GATEWAY_UNAUTHORIZED",
        message:
          "The Agent Gateway refused its own CLI as unauthorized. Check that the Agent's Configuration sets gateway.auth.password to OPENCLAW_GATEWAY_PASSWORD (Enable gateway password access), then deploy again.",
      });
      await completion(
        events,
        "the refused activation's terminal completion",
        (event) =>
          event.event === "worker.completed" &&
          event.revisionId === candidate.id &&
          event.outcome === "permanent",
      );
      const last = events
        .filter((event) => event.event === "worker.completed" && event.revisionId === candidate.id)
        .at(-1);
      assert.deepEqual(
        { outcome: last?.outcome, code: last?.code, cause: last?.cause },
        {
          outcome: "permanent",
          code: "AGENT_GATEWAY_UNAUTHORIZED",
          cause: "ActivationFailedError",
        },
      );
    },
  );
}

// The admission-limit case uses the real OpenShellAdmissionLimitError class, thrown from a
// stubbed Compute prepareRevision; the gateway wire test proves the client raises it. The
// limit frees up as completed admissions age out, so it must wait like any other dependency
// instead of spending the attempt budget.
for (const { label, failure, code, message } of [
  {
    label: "Kubernetes API",
    failure: () =>
      new TransientDependencyError(
        "kubernetes_api",
        "timeout",
        "A Kubernetes API request timed out.",
      ),
    code: "KUBERNETES_API_UNAVAILABLE",
    message: "The Kubernetes API was still unavailable at the deployment deadline.",
  },
  {
    label: "OpenShell admission limit",
    failure: () =>
      new OpenShellAdmissionLimitError("CreateSandbox", {
        code: 8,
        details:
          "caller has reached the durable mutation admission limit; unresolved requests require reconciliation",
      }),
    code: "SANDBOX_ADMISSION_LIMIT_REACHED",
    message:
      "The Sandbox gateway still refused new requests from the controller (request admission limit reached) at the deployment deadline.",
  },
]) {
  test(
    `a dependency still failing at the convergence deadline fails deployment with its own code (${label})`,
    requiresPostgres,
    async (context) => {
      // The 2.5 s deadline fits only four to six passes on a loaded runner, too close
      // to the default budget of five; with one attempt, more passes than the budget
      // means two.
      const fixture = await setup(context, { maxAttempts: 1 });
      const owner = await fixture.agent("dependency-down");
      const candidate = await fixture.revision(owner, 1);
      let observations = 0;

      await fixture.start(
        {
          ...fixture.compute,
          async prepareRevision() {
            observations += 1;
            throw failure();
          },
        },
        undefined,
        2_500,
      );

      const failed = await fixture.work(candidate, "failed_permanent", 30_000);
      assert.ok(
        observations > 1,
        `expected more passes than the attempt budget, saw ${observations}`,
      );
      assert.equal(failed.attempt_count, 1);
      const result = await fixture.observerPool.query(
        "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
      assert.deepEqual(result.rows, [{ reason_code: code, result_data: null }]);
      const status = await fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      );
      assert.equal(status.status, "failed");
      assert.deepEqual(status.error, { code, message });
    },
  );
}

test(
  "plugin startup warnings complete deployment and remain visible in status",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const pluginId = "codex-plugin:linear@openai-curated-remote";
    const otherPluginId = "codex-plugin:calendar@openai-curated-remote";
    const warnings = [
      { code: "PLUGIN_AUTH_REQUIRED", pluginId },
      { code: "PLUGIN_INSTALL_FAILED", pluginId: otherPluginId },
    ];
    const pluginState = codexPluginRevisionState(pluginId);
    pluginState.plugins[otherPluginId] = {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
    };
    const owner = await fixture.agent("plugin-warning", "dedicated");
    const candidate = await fixture.revision(
      owner,
      1,
      undefined,
      undefined,
      undefined,
      pluginState,
    );
    const prepared = [];

    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        prepared.push(revision.id);
        if (revision.id !== candidate.id) {
          return fixture.compute.prepareRevision(revision);
        }
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings,
        };
      },
    });

    await fixture.work(candidate, "succeeded");
    const terminal = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ACTIVATED",
        result_data: { warnings },
      },
    ]);
    const active = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(active.activeRevisionId, candidate.id);
    assert.deepEqual(prepared, [candidate.id]);
    // The public status projection reads the persisted result through OCC;
    // individual plugin failures must not turn a successful deployment into an error.
    assert.deepEqual(
      await fixture.controller.getDeploymentStatus(
        fixture.actor.id,
        fixture.namespace.id,
        owner.id,
        candidate.id,
      ),
      {
        deploymentId: candidate.id,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        status: "succeeded",
        error: null,
        warnings,
        progress: null,
      },
    );
  },
);

test(
  "plugin warnings after active-pointer publication still activate the ready revision",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const pluginId = "codex-plugin:github@openai-curated-remote";
    const owner = await fixture.agent("plugin-post-pointer-warning", "dedicated");
    const candidate = await fixture.revision(
      owner,
      1,
      undefined,
      undefined,
      undefined,
      codexPluginRevisionState(pluginId),
    );
    const published = await fixture.state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        fixture.namespace.id,
        owner.id,
        undefined,
        candidate.id,
      ),
    );
    assert.equal(published.activeRevisionId, candidate.id);

    let prepareCount = 0;
    const activations = [];
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        prepareCount += 1;
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }],
        };
      },
      async activateRevision(revision) {
        activations.push(revision.id);
      },
    });

    await fixture.work(candidate, "succeeded");
    assert.equal(prepareCount, 1);
    assert.deepEqual(activations, [candidate.id]);
    const terminal = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(terminal.rows, [
      {
        state: "succeeded",
        reason_code: "REVISION_ALREADY_ACTIVE",
        result_data: { warnings: [{ code: "PLUGIN_INSTALL_FAILED", pluginId }] },
      },
    ]);
  },
);

test(
  "foreign plugin warnings remain generic invalid Compute observations",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const pluginId = "codex-plugin:slack@openai-curated-remote";
    const owner = await fixture.agent("foreign-plugin-diagnostic", "dedicated");
    const candidate = await fixture.revision(
      owner,
      1,
      undefined,
      undefined,
      undefined,
      codexPluginRevisionState(pluginId),
    );
    await fixture.start({
      ...fixture.compute,
      async prepareRevision(revision) {
        return {
          namespaceId: revision.namespaceId,
          agentId: revision.agentId,
          revisionId: revision.id,
          ready: true,
          warnings: [
            {
              code: "PLUGIN_INSTALL_FAILED",
              pluginId: "codex-plugin:foreign@openai-curated-remote",
            },
          ],
        };
      },
    });

    await fixture.work(candidate, "failed_permanent");
    const generic = await fixture.observerPool.query(
      `SELECT state, reason_code, result_data
       FROM occ.controller_work WHERE idempotency_key = $1`,
      [candidate.idempotencyKey],
    );
    assert.deepEqual(generic.rows, [
      {
        state: "failed_permanent",
        reason_code: "INVALID_DRIVER_OBSERVATION",
        result_data: null,
      },
    ]);
    const inactive = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(inactive.activeRevisionId, undefined);
  },
);

test(
  "repository convergence exhaustion durably retires a returned incomplete runtime",
  requiresPostgres,
  async (context) => {
    const repository = repositoryBoundary();
    const fixture = await setup(context, { repoDriver: repository.driver });
    const owner = await fixture.agent("repository-convergence-retirement");
    const candidate = await fixture.revision(owner, 1, undefined, repository.snapshot);
    let stops = 0;
    const close = repository.driver.close;
    repository.driver.close = async (sessionId, signal) => {
      if (stops === 0) {
        throw new Error("repository close temporarily unavailable");
      }
      return close(sessionId, signal);
    };
    await delay(5);
    await fixture.start(
      {
        ...fixture.compute,
        async prepareRevision(revision, deploymentContext) {
          return {
            ...(await fixture.compute.prepareRevision(revision, deploymentContext)),
            ready: false,
          };
        },
        async stopRevision(revision) {
          assert.equal(revision.id, candidate.id);
          const source = await fixture.observerPool.query(
            "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
            [candidate.idempotencyKey],
          );
          assert.deepEqual(source.rows, [{ state: "failed_permanent", attempt_count: 1 }]);
          stops += 1;
          if (stops === 1) {
            // A credential-service outage must not delay the independent Compute stop.
            assert.equal((await repositoryAttempts(fixture, candidate))[0].phase, "closing");
            throw new Error("Compute termination still pending");
          }
          return fixture.compute.stopRevision(revision);
        },
      },
      () => {},
      1,
    );
    await fixture.work(candidate, "failed_permanent");
    await waitFor("the incomplete runtime's durable retirement to finish", async () => {
      await advanceCleanupRetries(fixture, candidate);
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:retire:%`],
      );
      return cleanup.rowCount === 1 && cleanup.rows[0].state === "succeeded" ? true : undefined;
    });
    assert.equal(stops, 2);
    assert.equal(repository.calls.filter(({ operation }) => operation === "open").length, 1);
    assert.deepEqual(
      (await repositoryAttempts(fixture, candidate)).map(({ phase }) => phase),
      ["disposed"],
    );
    const active = await fixture.state.read((view) =>
      view.agents.findAgent(fixture.namespace.id, owner.id),
    );
    assert.equal(active.activeRevisionId, undefined);
    const evidence = await fixture.observerPool.query(
      `SELECT details->>'reasonCode' AS code FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'`,
      [candidate.id],
    );
    assert.ok(evidence.rows.some(({ code }) => code === "CONVERGENCE_DEADLINE_EXCEEDED"));
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
    const releaseRetirement = Promise.withResolvers();
    // Release the held effect before fixture teardown joins the worker on failure.
    context.after(() => releaseRetirement.resolve());
    const fixture = await setup(context);
    const owner = await fixture.agent("stale-retirement");
    const first = await fixture.revision(owner, 1);
    const effects = [];
    const events = [];
    let retirements = 0;
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
      2,
    );
    const activation = await fixture.observerPool.query(
      `SELECT action FROM occ.audit_events
       WHERE resource_id = $1 AND action = 'openclaw.agents.lifecycle.activate'`,
      [second.id],
    );
    assert.equal(activation.rowCount, 1);
  },
);

for (const secretAuthMethod of ["api_key", "codex_pat"]) {
  test(
    `${secretAuthMethod} revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads`,
    requiresPostgres,
    async (context) => {
      const fixture = await setup(context, { secretAuthMethod });
      const owners = await Promise.all(
        ["allowed", "configuration-denied", "actor-secret-denied", "agent-secret-ungranted"].map(
          (name, index) =>
            fixture.agent(
              name,
              secretAuthMethod === "codex_pat" ? "dedicated" : "embedded",
              undefined,
              null,
              index !== 3,
            ),
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
}

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
  "revision dispatch never substitutes a later ChatGPT credential or reconfigured Backend for its admitted snapshot",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const provider = backendDefinition();
    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "credential-replaced",
    );
    await seedBackendBinding(fixture.observerPool, account);
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
    await seedBackendBinding(fixture.observerPool, workspaceAccount);
    const workspaceOwner = await fixture.agent(
      "workspace-replaced",
      "dedicated",
      workspaceAccount.id,
      provider.id,
    );
    const workspaceCandidate = await fixture.revision(workspaceOwner, 1);
    // Reconfiguring the selected Backend cannot move an admitted credential
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
      [backendDefinition({ workspaceId: changedWorkspace })],
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

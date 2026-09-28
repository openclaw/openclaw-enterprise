import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createControlledClock } from "../fixtures/repository-credentials/clock.mjs";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOccMetrics } from "../../apps/controller/src/metrics/index.ts";
import { PostgresMetricsSnapshot } from "../../packages/occ/src/index.ts";
import { encodeRepositoryCredentialSessionFiles } from "../../apps/controller/src/drivers/repo/github/credentials/client/config.ts";
import {
  authorizedPrincipal,
  cleanupBackendFixtures,
  createAccessTokenServiceAccount,
  createBackendWorkerDrivers,
  createBackendController,
  databaseUrl,
  ensureInstallation,
  poolWithOneBackendBindingReadFault,
  backendDefinition,
  requiresPostgres,
  seedBackendBinding,
  waitFor,
} from "../helpers/postgres-backend-state.mjs";

async function setup(
  context,
  { leaseDurationMs = 30_000, onHealthy, metrics, repoDriver, secretAuthMethod = "api_key" } = {},
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
  const observerPool = new Pool({ connectionString: databaseUrl, max: 8 });
  const createWorkerPool = () => new Pool({ connectionString: databaseUrl, max: 1 });
  const workerPool = createWorkerPool();
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
    listOptions() {
      return [];
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

test(
  "worker revalidates admitted repository selections through the concrete GitHub Driver and Unix control",
  { ...requiresPostgres, timeout: 30_000 },
  async (context) => {
    const fixture = await setup(context);
    const [
      { GitHubRepoDriver },
      { UnixRepositoryCredentialControlClient },
      { startRegistryCredentialServiceFixture },
      { createServer },
    ] = await Promise.all([
      import("../../apps/controller/src/drivers/repo/github/driver.ts"),
      import("../../apps/controller/src/backends/repository-credentials/control-client.ts"),
      import("../fixtures/repository-credentials/registry.mjs"),
      import("node:net"),
    ]);
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const clock = createControlledClock();
    const startedWall = clock.wallNow();
    const credentials = await startRegistryCredentialServiceFixture(context, {
      namespaceId: fixture.namespace.id,
      autoOpen: false,
      // Worker admission IDs use real wall time. Preserve that progress while
      // allowing this fixture's provider-retirement expiry to advance explicitly.
      clock: { ...clock, wallNow: () => Date.now() + clock.wallNow() - startedWall },
      gateway: { listen: `127.0.0.1:${port}` },
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
    await waitFor("the concrete session's durable cleanup to settle", async () =>
      (await repositoryAttempts(fixture, candidate))[0].phase === "disposed" ? true : undefined,
    );
    await waitFor("the concrete session's cleanup work to complete", async () => {
      const cleanup = await fixture.observerPool.query(
        `SELECT state FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      return cleanup.rowCount === 2 && cleanup.rows.every(({ state }) => state === "succeeded")
        ? true
        : undefined;
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
    // the service's eventual DISPOSED observation permits physical deletion.
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
    const deletion = await fixture.requestDeletion(pendingOwner);
    await waitFor("pending cleanup to defer deletion after Compute retirement", async () =>
      retired.includes(pendingRevision.id) &&
      events.some(
        (event) =>
          event.workId === deletion.idempotencyKey && event.code === "REPOSITORY_CLEANUP_PENDING",
      )
        ? true
        : undefined,
    );
    assert.equal(
      (await driver.status(pendingMaterial.sessionId, new AbortController().signal)).state,
      "CLOSED",
    );
    const [pendingAttempt] = await repositoryAttempts(fixture, pendingRevision);
    assert.equal(pendingAttempt.phase, "closing");
    assert.equal(pendingAttempt.liveRevisionId, pendingRevision.id);
    assert.equal(
      (
        await fixture.state.read((view) =>
          view.agents.findAgent(fixture.namespace.id, pendingOwner.id),
        )
      ).status,
      "deleting",
    );
    assert.equal(
      (
        await fixture.observerPool.query(
          "SELECT count(*)::integer AS count FROM occ.controller_work WHERE revision_id = $1 AND idempotency_key LIKE $2",
          [pendingRevision.id, `agent_revision:${pendingRevision.id}:repository_cleanup:%`],
        )
      ).rows[0].count,
      1,
    );
    await clock.advance(3_600_001);
    await waitFor("settled provider cleanup to release physical deletion", async () =>
      (await fixture.state.read((view) =>
        view.agents.findAgent(fixture.namespace.id, pendingOwner.id),
      )) === undefined
        ? true
        : undefined,
    );
    const settled = await fixture.state.read((view) =>
      view.repositorySessions.findAttempt(pendingAttempt.admissionId),
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
    // Keep unresolved evidence, but quiesce this stopped fixture's queue so
    // another test's worker cannot consume its cleanup or maintenance Work.
    await fixture.observerPool.query(
      `UPDATE occ.controller_work SET state = 'queued', claim_token = NULL,
       lease_expires_at = NULL, available_at = 'infinity'
       WHERE namespace_id = $1 AND state IN ('queued', 'claimed')`,
      [candidate.namespaceId],
    );
  },
);

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
        await fixture.observerPool.query(
          `UPDATE occ.controller_work SET state = 'queued', claim_token = NULL,
           lease_expires_at = NULL, available_at = 'infinity'
           WHERE namespace_id = $1 AND state IN ('queued', 'claimed')`,
          [candidate.namespaceId],
        );
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

      // A second queued observation models work already admitted before the
      // prior worker stopped. Retained evidence must fence that admission too.
      const another = {
        id: candidate.id,
        idempotencyKey: `agent_revision:${candidate.id}:maintenance:${Date.now()}`,
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
      await fixture.start(compute, () => {}, undefined, undefined, fixture.createWorkerPool());
      await fixture.work(another, "failed_permanent");
      await fixture.stop();
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
      // The worker is stopped. Preserve unresolved rows while removing only
      // this fixture's Work from subsequent tests' scheduling horizon.
      await fixture.observerPool.query(
        `UPDATE occ.controller_work SET state = 'queued', claim_token = NULL,
         lease_expires_at = NULL, available_at = 'infinity'
         WHERE namespace_id = $1 AND state IN ('queued', 'claimed')`,
        [candidate.namespaceId],
      );
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
      observed[0].map(({ kind, repositoryRef, sessionId }) => ({ kind, repositoryRef, sessionId })),
      initial.map(({ repositoryRef, sessionId }) => ({
        kind: "retained",
        repositoryRef,
        sessionId,
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
    assert.deepEqual(retained, observed[0][1]);
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
    unavailable = false;
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
    await waitFor("retirement to retry beyond the foreground's five attempts", async () =>
      stopped.length > 5 ? true : undefined,
    );
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
    await waitFor("the restarted worker to resume exact retirement", async () =>
      stopped.length > stopsBeforeRestart ? true : undefined,
    );
    unavailable = false;
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
      assert.ok(
        events.some(
          ({ event, workId, code }) =>
            event === "worker.completed" &&
            workId === stop.idempotencyKey &&
            code === "STOP_SUPERSEDED",
        ),
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
        `SELECT idempotency_key, state, actor_id FROM occ.controller_work
         WHERE revision_id = $1 AND idempotency_key LIKE $2`,
        [candidate.id, `agent_revision:${candidate.id}:repository_cleanup:%`],
      );
      assert.equal(cleanup.rowCount, 1);
      assert.equal(cleanup.rows[0].state, "claimed");
      assert.equal(cleanup.rows[0].actor_id, fixture.actor.id);
      cleanupKey = cleanup.rows[0].idempotency_key;

      // A separately configured queue can exhaust the original queued source
      // while its already-claimed session cleanup retains its own purpose.
      const recovery = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      assert.ok((await recovery.recoverStale()).exhaustedQueued >= 1);
      await fixture.work(candidate, "failed_permanent");
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
    // outcomes after integrating stop support with metrics instrumentation.
    const exposition = await metrics.exposition();
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
          `occ_reconciliation_attempts_total\\{[^\\n]*work_kind="agent_stop"[^\\n]*outcome="${outcome}"[^\\n]*\\} 1`,
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
    // Other Namespaces share this worker's queue. Their durable stop work must
    // drain without changing this candidate's preparation gate or observations.
    const foreign = await setup(context);
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
    const foreign = await setup(context);
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
    const foreign = await setup(context);
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
    const cleanup = { serviceAccountIds: [], agentIds: [], revisionIds: [] };

    const account = await createAccessTokenServiceAccount(
      fixture.state,
      fixture.namespace.id,
      "transient-provider-read",
    );
    cleanup.serviceAccountIds.push(account.id);
    await seedBackendBinding(fixture.observerPool, account);
    const owner = await fixture.agent(
      "transient-provider-read",
      "dedicated",
      account.id,
      provider.id,
    );
    cleanup.agentIds.push(owner.id);

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
      cleanup.revisionIds.push(candidate.id);

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
      await cleanupBackendFixtures(fixture.observerPool, fixture.namespace.id, cleanup);
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

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareFile } from "../../scripts/ci/prepare.mjs";
import {
  authorizedPrincipal,
  createBackendWorkerDrivers,
  createBackendController,
  ensureInstallation,
  requiresPostgres,
} from "./postgres-backend-state.mjs";
import { waitFor } from "./wait-for.mjs";

export const CREDENTIAL_GATEWAY_FIXTURE_ID = "credential-gateway-worker-fixture";

// One template per owning test file; importing this helper registers no tests or hooks.
export function createWorkerRevisionFixtures(testFile) {
  // Each test owns a database (Work claims span one), copied from one migrated template
  // per file rather than migrated again. Nothing connects to the template itself. A failed
  // template preparation is not cached: the next test retries it, and cleanup ignores it.
  let template;
  async function cleanup() {
    await (await template?.catch(() => undefined))?.cleanup();
  }

  async function prepareDatabase(context) {
    assert.ok(
      process.env.OPENCLAW_ENTERPRISE_CI_STATE,
      "Worker tests require an owned PostgreSQL fixture; see docs/testing/postgresql.md.",
    );
    const fixture = {
      lane: "postgres-application",
      file: fileURLToPath(testFile),
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
      import("./development.mjs"),
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
      {
        executionMode = "embedded",
        serviceAccountId,
        backendId = null,
        grantHarnessSecret = true,
        auth = "secret",
        nonModelSources = 0,
      } = {},
    ) {
      const id = `agt_${randomUUID()}`;
      // Tool sources are ready gateway-held tokens in the same Namespace as the Agent.
      const credentialSources = [];
      for (let index = 0; index < nonModelSources; index += 1) {
        const source = {
          id: `cs_${randomUUID()}`,
          namespaceId: namespace.id,
          name: `${label}-tool-${index}-${randomUUID()}`,
          type: "bearer-token",
          config: { host: `api-${index}.example.com`, env_var: `TOOL_TOKEN_${index}` },
          secrets: {},
          driverId: CREDENTIAL_GATEWAY_FIXTURE_ID,
          state: "registering",
          createdAt: new Date().toISOString(),
        };
        await state.transact(async (unit) => {
          await unit.credentialSources.createCredentialSource(source);
          await unit.credentialSources.markCredentialSourceReady(namespace.id, source.id);
        });
        credentialSources.push({ sourceId: source.id });
      }
      const configurationId = `cfg_${randomUUID()}`;
      let harnessAuth;
      if (auth === "runtime") {
        harnessAuth = { method: "runtime" };
      } else if (auth === "credential_source") {
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
        harnessAuth = {
          method: "codex_pat",
          source: { kind: "service_account", namespaceId: namespace.id, id: serviceAccountId },
        };
      }
      // The list holds every bound source: the Harness source first, then the others.
      const listedSources = [
        ...(harnessAuth.method === "credential_source" ? [{ sourceId: harnessAuth.sourceId }] : []),
        ...credentialSources,
      ];
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
          ...(listedSources.length === 0 ? {} : { credentialSources: listedSources }),
          executionMode,
          servicePrincipalId: `service-agent-${id}`,
          createdAt: new Date().toISOString(),
        });
      });
      const operatedSources = listedSources.map(({ sourceId }) => sourceId);
      if (operatedSources.length > 0) {
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
        for (const sourceId of operatedSources) {
          await observerPool.query(
            `INSERT INTO occ.iam_access_bindings
            (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, NULL, $4, 'credential_source', $5)`,
            [
              `binding-${randomUUID()}`,
              namespace.id,
              owner.servicePrincipalId,
              sourceRoleId,
              sourceId,
            ],
          );
        }
      }
      if (
        (harnessAuth.method === "api_key" || harnessAuth.method === "codex_pat") &&
        harnessAuth.source.kind === "secret" &&
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
      { harness, repositoryCredentials, actorId = actor.id, plugins } = {},
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
      } else if (
        owner.harnessAuth.method === "codex_pat" &&
        owner.harnessAuth.source.kind === "service_account"
      ) {
        const account = await state.read((view) =>
          view.serviceAccounts.findServiceAccount(namespace.id, owner.harnessAuth.source.id),
        );
        const backendBinding = await state.read((view) =>
          view.serviceAccounts.findServiceAccountBackendBinding(namespace.id, account.id),
        );
        harnessAuth = { ...owner.harnessAuth, credential: account.credential, backendBinding };
      } else {
        harnessAuth = { ...owner.harnessAuth, secretDriverId: secretDriver.id };
      }
      const credentialSources = [];
      for (const { sourceId } of owner.credentialSources ?? []) {
        const source = await state.read((view) =>
          view.credentialSources.findCredentialSource(namespace.id, sourceId),
        );
        credentialSources.push({
          sourceId,
          credentialGatewayId: source.driverId,
          sourceType: source.type,
        });
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
        ...(credentialSources.length === 0 ? {} : { credentialSources }),
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
      {
        emit = () => {},
        convergenceTimeoutMs,
        providers,
        pool = workerPool,
        transformDrivers = (drivers) => drivers,
      } = {},
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

    async function admitInitialRevision(
      label,
      { agent: agentOptions, revision: revisionOptions } = {},
    ) {
      const owner = await agent(label, agentOptions);
      const candidate = await revision(owner, 1, revisionOptions);
      return { owner, candidate };
    }

    function currentAgent(owner) {
      return state.read((view) => view.agents.findAgent(namespace.id, owner.id));
    }

    function activePointer(owner) {
      return observerPool.query(
        "SELECT active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = $2",
        [namespace.id, owner.id],
      );
    }

    function deploymentStatus(owner, candidate) {
      return controller.getDeploymentStatus(actor.id, namespace.id, owner.id, candidate.id);
    }

    function workResult(candidate) {
      return observerPool.query(
        "SELECT reason_code, result_data FROM occ.controller_work WHERE idempotency_key = $1",
        [candidate.idempotencyKey],
      );
    }

    function expireClaim(candidate, claimToken) {
      return observerPool.query(
        `UPDATE occ.controller_work
         SET lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE idempotency_key = $1 AND claim_token = $2::uuid`,
        [candidate.idempotencyKey, claimToken],
      );
    }

    async function copyActorGrants(actorId) {
      await observerPool.query(
        `INSERT INTO occ.iam_identities (id, kind, issuer, subject)
         SELECT $1, kind, issuer, $1 FROM occ.iam_identities WHERE id = $2`,
        [actorId, actor.id],
      );
      await observerPool.query(
        `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
         SELECT 'binding-' || gen_random_uuid(), namespace_id, $1, role_id,
                resource_kind, resource_id
         FROM occ.iam_access_bindings WHERE identity_subject_id = $2`,
        [actorId, actor.id],
      );
    }

    // Advance only this revision's queued observation, preserving its claim and actor.
    function advanceMaintenance(candidate) {
      return observerPool.query(
        `UPDATE occ.controller_work SET available_at = clock_timestamp()
         WHERE revision_id = $1 AND state = 'queued' AND idempotency_key LIKE $2
         RETURNING idempotency_key, actor_id, attempt_count`,
        [candidate.id, `agent_revision:${candidate.id}:maintenance:%`],
      );
    }

    return {
      expireClaim,
      copyActorGrants,
      admitInitialRevision,
      advanceMaintenance,
      currentAgent,
      activePointer,
      deploymentStatus,
      workResult,
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

  function revisionTest(name, run, options = {}) {
    test(name, { ...requiresPostgres, ...options }, async (context) => {
      const fixture = await setup(context);
      await run(fixture, context);
    });
  }

  return { setup, cleanup, revisionTest };
}

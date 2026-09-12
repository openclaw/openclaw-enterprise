import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  authorizedPrincipal,
  cleanupProviderFixtures,
  createAccessTokenServiceAccount,
  createProviderWorkerDrivers,
  databaseUrl,
  ensureInstallation,
  poolWithOneProviderBindingReadFault,
  providerDefinition,
  requiresPostgres,
  seedProviderBinding,
  waitFor,
} from "../helpers/postgres-provider-state.mjs";

async function setup(context, { leaseDurationMs = 30_000 } = {}) {
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
  const workerPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const state = new PostgresPlatformState(observerPool);
  const installation = await ensureInstallation(state, "revision-worker");
  const actor = authorizedPrincipal(await state.loadNativeIAMState());
  assert.ok(actor, "persisted IAM must contain an unrestricted Agent-deploy Principal");

  let worker;
  context.after(async () => {
    if (worker === undefined) await workerPool.end();
    else await worker.stop();
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

  async function agent(label, executionMode = "embedded", serviceAccountId, providerId = null) {
    const id = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    return state.transact(async (unit) => {
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
        ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
        executionMode,
        servicePrincipalId: `service-agent-${id}`,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async function revision(owner, number, harness) {
    const serviceAccount =
      owner.serviceAccountId === undefined
        ? undefined
        : await state.read((view) =>
            view.serviceAccounts.findServiceAccount(namespace.id, owner.serviceAccountId),
          );
    if (owner.serviceAccountId !== undefined) {
      assert.ok(
        serviceAccount,
        "the associated account must belong to the Agent's exact Namespace",
      );
      assert.ok(
        serviceAccount.credential,
        "the associated account must have a provider credential",
      );
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
      ...(serviceAccount === undefined
        ? {}
        : {
            serviceAccount: {
              id: serviceAccount.id,
              credential: serviceAccount.credential,
            },
          }),
      servicePrincipalId: owner.servicePrincipalId,
      createdAt: new Date().toISOString(),
    };
    const idempotencyKey = `agent_revision:${candidate.id}:reconcile`;
    await state.transactWithQueue(async (unit, queue) => {
      await unit.revisions.createRevision(candidate);
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

  function start(
    computeDriver,
    emit = () => {},
    convergenceTimeoutMs,
    providers,
    pool = workerPool,
  ) {
    const drivers =
      providers === undefined ? undefined : createProviderWorkerDrivers(computeDriver, providers);
    worker = createControllerWorker({
      pool,
      pollIntervalMs: 15,
      leaseDurationMs,
      maxAttempts: 5,
      ...(drivers === undefined ? { computeDriver } : { drivers }),
      ...(convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs }),
      emit,
    });
    return worker.start();
  }

  async function stop() {
    if (worker !== undefined) await worker.stop();
  }

  return {
    installation,
    actor,
    namespace,
    observerPool,
    state,
    compute,
    productionHarness: PRODUCTION_HARNESS_DESCRIPTOR,
    PostgresWorkQueue,
    agent,
    revision,
    work,
    start,
    stop,
    workerPool,
  };
}

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
        name === "ScopeViolationError" && /exact platform ownership or state/.test(message),
      "the PostgreSQL adapter must translate malformed snapshots rejected by its database constraint",
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
    const account = await fixture.state.transact((unit) =>
      unit.serviceAccounts.createServiceAccount({
        id: `sa_${randomUUID()}`,
        namespaceId: fixture.namespace.id,
        name: `revision-worker-account-${randomUUID()}`,
        credential: {
          kind: "api_key",
          secretRef: { name: "revision-worker-account-source", key: "api-key" },
        },
      }),
    );
    const owner = await fixture.agent("revoked-service-account", "embedded", account.id);
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
  "the revision worker rejects managed ServiceAccount provider mismatches before Compute",
  requiresPostgres,
  async (context) => {
    const fixture = await setup(context);
    const provider = providerDefinition();
    const cleanup = {
      serviceAccountIds: [],
      agentIds: [],
      revisionIds: [],
    };

    async function account(label) {
      const created = await createAccessTokenServiceAccount(
        fixture.state,
        fixture.namespace.id,
        label,
      );
      cleanup.serviceAccountIds.push(created.id);
      return created;
    }

    const [validAccount, missingAgentProviderAccount, missingIssuedCredentialAccount] =
      await Promise.all([account("valid"), account("missing-agent-provider"), account("unissued")]);
    await Promise.all([
      seedProviderBinding(fixture.observerPool, validAccount),
      seedProviderBinding(fixture.observerPool, missingAgentProviderAccount),
      seedProviderBinding(fixture.observerPool, missingIssuedCredentialAccount, {
        credentialIssued: false,
      }),
    ]);

    const [validOwner, missingAgentProviderOwner, missingIssuedCredentialOwner] = await Promise.all(
      [
        fixture.agent("valid-managed-provider", "dedicated", validAccount.id, provider.id),
        fixture.agent("missing-agent-provider", "dedicated", missingAgentProviderAccount.id, null),
        fixture.agent(
          "missing-issued-provider-credential",
          "dedicated",
          missingIssuedCredentialAccount.id,
          provider.id,
        ),
      ],
    );
    cleanup.agentIds.push(
      validOwner.id,
      missingAgentProviderOwner.id,
      missingIssuedCredentialOwner.id,
    );
    const [validRevision, missingAgentProviderRevision, missingIssuedCredentialRevision] =
      await Promise.all([
        fixture.revision(validOwner, 1),
        fixture.revision(missingAgentProviderOwner, 1),
        fixture.revision(missingIssuedCredentialOwner, 1),
      ]);
    cleanup.revisionIds.push(
      validRevision.id,
      missingAgentProviderRevision.id,
      missingIssuedCredentialRevision.id,
    );

    const effects = [];
    try {
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

      // These rows represent post-admission drift: the worker must defend the
      // effect boundary even if earlier API or Driver operations admitted stale
      // managed provider state.
      await Promise.all([
        fixture.work(validRevision, "succeeded"),
        fixture.work(missingAgentProviderRevision, "failed_permanent"),
        fixture.work(missingIssuedCredentialRevision, "failed_permanent"),
      ]);

      assert.deepEqual(effects, [
        { action: "bind", agentId: validOwner.id },
        { action: "prepare", revisionId: validRevision.id },
      ]);

      const active = await fixture.observerPool.query(
        "SELECT id, active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
        [
          fixture.namespace.id,
          [validOwner.id, missingAgentProviderOwner.id, missingIssuedCredentialOwner.id],
        ],
      );
      const activeByAgent = new Map(
        active.rows.map(({ id, active_revision_id }) => [id, active_revision_id]),
      );
      assert.equal(activeByAgent.get(validOwner.id), validRevision.id);
      assert.equal(activeByAgent.get(missingAgentProviderOwner.id), null);
      assert.equal(activeByAgent.get(missingIssuedCredentialOwner.id), null);

      const failures = await fixture.observerPool.query(
        `SELECT resource_id, details->>'reasonCode' AS reason_code
         FROM occ.audit_events
         WHERE resource_id = ANY($1::text[])
           AND action = 'reconcile'
           AND outcome = 'failure'
         ORDER BY resource_id`,
        [[missingAgentProviderRevision.id, missingIssuedCredentialRevision.id]],
      );
      assert.deepEqual(
        failures.rows.map(({ reason_code }) => reason_code),
        ["SERVICE_ACCOUNT_PROVIDER_MISMATCH", "SERVICE_ACCOUNT_PROVIDER_MISMATCH"],
      );
    } finally {
      await fixture.stop();
      await cleanupProviderFixtures(fixture.observerPool, fixture.namespace.id, cleanup);
    }
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
          if (row?.dependency_failures >= 1 && row.state !== "failed_permanent") return row;
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
    assert.deepEqual(effects, [
      { action: "prepare", revisionId: older.id },
      { action: "prepare", revisionId: newer.id },
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
          if (retirements === 1) await releaseRetirement.promise;
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

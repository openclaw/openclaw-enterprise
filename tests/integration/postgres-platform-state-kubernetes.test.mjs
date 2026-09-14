import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  adminEmail,
  admitted,
  cleanupKubernetesNamespaces,
  createConfiguration,
  createConfiguredAgent,
  databaseUrl,
  defaultAgentConfigurationValues,
  grantTenantAccess,
  pollUntil,
  request,
  requiresPostgresAndKubernetesConfiguration,
  startKubernetesController,
  startKubernetesWorker,
  stopController,
  updateConfiguration,
  waitForNamespaceReady,
} from "../helpers/postgres-platform-state.mjs";

test(
  "real OCC subprocesses retain Installation, Namespace, Agent, IAM, audit, and work after restart",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());

    const first = await startKubernetesController(context);
    const existing = await request(first, "GET", "/installation");
    let installation;
    if (existing.status === 200) {
      installation = existing.data;
    } else {
      assert.equal(existing.status, 404);
      const created = await request(first, "POST", "/installation/bootstrap", {
        name: "PostgreSQL restart integration",
      });
      assert.equal(created.status, 201);
      installation = created.data;
    }

    const namespace = await request(first, "POST", "/namespaces", {
      name: `restart-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    assert.equal(Object.hasOwn(namespace.data, "installationId"), false);
    cleanupKubernetesNamespaces(context, [namespace.data.id]);

    const worker = await startKubernetesWorker(context);
    await grantTenantAccess(context, namespace.data.id);
    const readyNamespace = await waitForNamespaceReady(first, namespace.data.id, worker);

    const { agent } = await createConfiguredAgent(
      first,
      namespace.data.id,
      `agent-${randomUUID()}`,
    );
    assert.equal(Object.hasOwn(agent, "installationId"), false);
    assert.equal(Object.hasOwn(agent, "servicePrincipalId"), false);
    assert.equal(agent.namespaceId, namespace.data.id);

    const persisted = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM occ.audit_events
         WHERE resource_id = $1 OR resource_id = $2 OR resource_id = $3) AS audit_events,
       (SELECT count(*)::integer FROM occ.controller_work
         WHERE namespace_id = $1) AS queued_operations,
       (SELECT count(*)::integer FROM occ.configurations
         WHERE namespace_id = $1 AND id = $3) AS configurations,
       (SELECT count(*)::integer FROM occ.iam_identities
         WHERE namespace_id = $1 AND agent_id = $2
           AND kind = 'service_principal') AS agent_service_principals`,
      [namespace.data.id, agent.id, agent.configurationId],
    );
    assert.ok(persisted.rows[0].audit_events >= 3);
    assert.equal(persisted.rows[0].queued_operations, 1);
    assert.equal(persisted.rows[0].configurations, 1);
    assert.equal(persisted.rows[0].agent_service_principals, 1);

    // The live worker can still produce unrelated lifecycle audit rows, such as
    // bootstrap Namespace convergence, so stop it before measuring this request.
    await stopController(worker.child);

    const auditBeforeUnauthenticatedRequest = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.audit_events",
    );
    const unauthenticated = await request(first, "GET", "/namespaces", undefined, {
      authenticated: false,
    });
    assert.equal(unauthenticated.status, 401);
    const auditAfterUnauthenticatedRequest = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.audit_events",
    );
    assert.equal(
      auditAfterUnauthenticatedRequest.rows[0].count,
      auditBeforeUnauthenticatedRequest.rows[0].count,
      "unauthenticated requests have no attributable actor and cannot write audit rows",
    );

    await stopController(first.child);
    const restarted = await startKubernetesController(context);

    const reloadedInstallation = await request(restarted, "GET", "/installation");
    assert.equal(reloadedInstallation.status, 200);
    assert.deepEqual(reloadedInstallation.data, installation);

    const reloadedNamespace = await request(restarted, "GET", `/namespaces/${namespace.data.id}`);
    assert.equal(reloadedNamespace.status, 200);
    assert.deepEqual(reloadedNamespace.data, readyNamespace);

    const reloadedAgent = await request(
      restarted,
      "GET",
      `/namespaces/${namespace.data.id}/agents/${agent.id}`,
    );
    assert.equal(reloadedAgent.status, 200);
    assert.deepEqual(reloadedAgent.data, agent);

    const duplicateBootstrap = await request(restarted, "POST", "/installation/bootstrap", {
      name: "Forbidden second Installation",
    });
    assert.equal(duplicateBootstrap.status, 409);
    const installations = await pool.query(
      "SELECT count(*)::integer AS count FROM occ.installation",
    );
    assert.equal(installations.rows[0].count, 1);
  },
);

test(
  "real OCC creates concurrent Namespace Agents and durably associates revisions with their owner",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const process = await startKubernetesController(context);

    const namespace = await request(process, "POST", "/namespaces", {
      name: `concurrent-agents-${randomUUID()}`,
    });
    assert.equal(namespace.status, 201);
    assert.equal(namespace.data.status, "provisioning");
    cleanupKubernetesNamespaces(context, [namespace.data.id]);

    const worker = await startKubernetesWorker(context);
    await grantTenantAccess(context, namespace.data.id);
    await waitForNamespaceReady(process, namespace.data.id, worker);

    const firstValues = { ...defaultAgentConfigurationValues, model: { id: "gpt-integration" } };
    const secondValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "gpt-integration-sibling" },
    };
    const [firstConfiguration, secondConfiguration] = await Promise.all([
      createConfiguration(process, namespace.data.id, firstValues),
      createConfiguration(process, namespace.data.id, secondValues),
    ]);
    const [first, second] = await Promise.all([
      request(process, "POST", `/namespaces/${namespace.data.id}/agents`, {
        name: `first-${randomUUID()}`,
        configurationId: firstConfiguration.id,
      }),
      request(process, "POST", `/namespaces/${namespace.data.id}/agents`, {
        name: `second-${randomUUID()}`,
        configurationId: secondConfiguration.id,
      }),
    ]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.data.id, second.data.id);
    assert.equal(first.data.namespaceId, namespace.data.id);
    assert.equal(second.data.namespaceId, namespace.data.id);
    assert.equal(Object.hasOwn(first.data, "servicePrincipalId"), false);
    assert.equal(Object.hasOwn(second.data, "servicePrincipalId"), false);

    const stillReady = await request(process, "GET", `/namespaces/${namespace.data.id}`);
    assert.equal(stillReady.status, 200);
    assert.equal(stillReady.data.status, "ready");
    const listed = await request(process, "GET", `/namespaces/${namespace.data.id}/agents`);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.data.map(({ id }) => id).sort(),
      [first.data.id, second.data.id].sort(),
    );

    const persistedAgents = await pool.query(
      `SELECT agent.id, agent.namespace_id, agent.execution_mode, agent.service_principal_id,
              identity.kind, identity.agent_id
       FROM occ.agents AS agent
       JOIN occ.iam_identities AS identity
         ON identity.id = agent.service_principal_id
        AND identity.namespace_id = agent.namespace_id
        AND identity.agent_id = agent.id
       WHERE agent.namespace_id = $1 ORDER BY agent.id`,
      [namespace.data.id],
    );
    assert.equal(persistedAgents.rowCount, 2);
    assert.deepEqual(
      persistedAgents.rows.map(({ id }) => id),
      [first.data.id, second.data.id].sort(),
    );
    assert.notEqual(
      persistedAgents.rows[0].service_principal_id,
      persistedAgents.rows[1].service_principal_id,
    );
    assert.ok(persistedAgents.rows.every(({ execution_mode }) => execution_mode === "embedded"));
    assert.ok(persistedAgents.rows.every(({ kind }) => kind === "service_principal"));

    const historyBefore = await request(
      process,
      "GET",
      `/namespaces/${namespace.data.id}/agents/${first.data.id}/revisions`,
    );
    assert.equal(historyBefore.status, 200);
    assert.deepEqual(historyBefore.data, []);

    const deployment = await request(
      process,
      "POST",
      `/namespaces/${namespace.data.id}/agents/${first.data.id}/deploy`,
    );
    assert.equal(deployment.status, 202);
    const revision = deployment.data;
    assert.equal(revision.namespaceId, namespace.data.id);
    assert.equal(revision.agentId, first.data.id);
    assert.equal(revision.revision, 1);
    assert.equal(revision.configurationId, firstConfiguration.id);
    assert.equal(revision.configurationKind, "agent");
    assert.equal(revision.configurationGeneration, 1);
    assert.deepEqual(revision.configuration, admitted(firstValues));
    assert.deepEqual(revision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(revision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });

    const activeAgent = await pollUntil(
      `independent worker to activate admitted revision ${revision.id}`,
      async () => {
        const current = await request(
          process,
          "GET",
          `/namespaces/${namespace.data.id}/agents/${first.data.id}`,
        );
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === revision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const [firstHistory, secondHistory] = await Promise.all([
      request(process, "GET", `/namespaces/${namespace.data.id}/agents/${first.data.id}/revisions`),
      request(
        process,
        "GET",
        `/namespaces/${namespace.data.id}/agents/${second.data.id}/revisions`,
      ),
    ]);
    assert.equal(firstHistory.status, 200);
    assert.equal(secondHistory.status, 200);
    assert.deepEqual(firstHistory.data, [revision]);
    assert.deepEqual(secondHistory.data, []);

    const actor = await pool.query(
      `SELECT identity.id
       FROM occ.iam_identities AS identity
       JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
       WHERE auth_user.email = $1`,
      [adminEmail],
    );
    assert.equal(actor.rowCount, 1);
    const principalId = actor.rows[0].id;

    const persistedRevision = await pool.query(
      `SELECT agent.id AS agent_id, agent.namespace_id, agent.active_revision_id,
              revision.id AS revision_id, revision.revision_number, revision.admitted_spec
       FROM occ.agents AS agent
       JOIN occ.agent_revisions AS revision
         ON revision.namespace_id = agent.namespace_id AND revision.agent_id = agent.id
       WHERE agent.namespace_id = $1 AND agent.id = $2`,
      [namespace.data.id, first.data.id],
    );
    assert.equal(persistedRevision.rowCount, 1);
    assert.equal(persistedRevision.rows[0].agent_id, first.data.id);
    assert.equal(persistedRevision.rows[0].namespace_id, namespace.data.id);
    assert.equal(persistedRevision.rows[0].revision_id, revision.id);
    assert.equal(Number(persistedRevision.rows[0].revision_number), 1);
    assert.deepEqual(persistedRevision.rows[0].admitted_spec, {
      configuration_id: revision.configurationId,
      configuration_kind: revision.configurationKind,
      configuration_generation: revision.configurationGeneration,
      draft_spec: admitted(firstValues),
      harness: revision.harness,
      compute: revision.compute,
    });
    assert.equal(persistedRevision.rows[0].active_revision_id, revision.id);
    assert.equal(activeAgent.activeRevisionId, revision.id);

    const revisionWork = await pool.query(
      `SELECT namespace_id, agent_id, revision_id, actor_id, state
       FROM occ.controller_work WHERE revision_id = $1`,
      [revision.id],
    );
    assert.deepEqual(revisionWork.rows, [
      {
        namespace_id: namespace.data.id,
        agent_id: first.data.id,
        revision_id: revision.id,
        actor_id: principalId,
        state: "succeeded",
      },
    ]);
  },
);

test(
  "independent PostgreSQL API and worker provision isolated Namespaces, activate admitted revisions, and tombstone deletion",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    const api = await startKubernetesController(context);

    const installation = await request(api, "GET", "/installation");
    if (installation.status === 404) {
      const created = await request(api, "POST", "/installation/bootstrap", {
        name: "Independent PostgreSQL worker integration",
      });
      assert.equal(created.status, 201);
    } else {
      assert.equal(installation.status, 200);
    }

    const [removed, retained] = await Promise.all([
      request(api, "POST", "/namespaces", { name: `worker-remove-${randomUUID()}` }),
      request(api, "POST", "/namespaces", { name: `worker-retain-${randomUUID()}` }),
    ]);
    for (const namespace of [removed, retained]) {
      assert.equal(namespace.status, 201);
      assert.equal(namespace.data.status, "provisioning");
      assert.equal(Object.hasOwn(namespace.data, "installationId"), false);
    }
    assert.notEqual(removed.data.id, retained.data.id);
    cleanupKubernetesNamespaces(context, [removed.data.id, retained.data.id]);

    const worker = await startKubernetesWorker(context);
    await Promise.all([
      grantTenantAccess(context, removed.data.id),
      grantTenantAccess(context, retained.data.id),
    ]);
    for (const namespace of [removed, retained]) {
      await waitForNamespaceReady(api, namespace.data.id, worker);
    }

    const { agent } = await createConfiguredAgent(
      api,
      retained.data.id,
      `worker-agent-${randomUUID()}`,
    );
    const preDeploymentWork = await pool.query(
      `SELECT idempotency_key FROM occ.controller_work
       WHERE namespace_id = $1 AND agent_id = $2`,
      [retained.data.id, agent.id],
    );
    assert.equal(preDeploymentWork.rowCount, 0, "Agent creation must not enqueue deployment work");

    const deployment = await request(
      api,
      "POST",
      `/namespaces/${retained.data.id}/agents/${agent.id}/deploy`,
    );
    assert.equal(deployment.status, 202);
    const revision = deployment.data;
    assert.deepEqual(revision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(revision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });

    await pollUntil(
      `independent worker to activate admitted revision ${revision.id}`,
      async () => {
        const current = await request(
          api,
          "GET",
          `/namespaces/${retained.data.id}/agents/${agent.id}`,
        );
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === revision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const deletion = await request(api, "DELETE", `/namespaces/${removed.data.id}`);
    assert.equal(deletion.status, 202);
    assert.equal(deletion.data.status, "deleting");

    const tombstone = await pollUntil(
      `Namespace ${removed.data.id} to receive its exact durable deletion tombstone`,
      async () => {
        const rows = await pool.query(
          "SELECT id, status, deleted_at FROM occ.namespaces WHERE id = $1",
          [removed.data.id],
        );
        assert.equal(rows.rowCount, 1);
        return rows.rows[0].deleted_at === null ? undefined : rows.rows[0];
      },
      { worker, timeoutMs: 60_000 },
    );
    assert.equal(tombstone.id, removed.data.id);
    assert.equal(tombstone.status, "deleting");
    assert.ok(tombstone.deleted_at instanceof Date);
    assert.equal((await request(api, "GET", `/namespaces/${removed.data.id}`)).status, 404);

    const unaffected = await request(api, "GET", `/namespaces/${retained.data.id}`);
    assert.equal(unaffected.status, 200);
    assert.equal(unaffected.data.id, retained.data.id);
    assert.equal(unaffected.data.status, "ready");

    const work = await pool.query(
      `SELECT namespace_id, namespace_target, state
       FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NULL
       ORDER BY namespace_id, namespace_target`,
      [[removed.data.id, retained.data.id]],
    );
    assert.deepEqual(
      work.rows.map(({ namespace_id, namespace_target, state }) => ({
        namespaceId: namespace_id,
        target: namespace_target,
        state,
      })),
      [
        { namespaceId: removed.data.id, target: "deleted", state: "succeeded" },
        { namespaceId: removed.data.id, target: "ready", state: "succeeded" },
        { namespaceId: retained.data.id, target: "ready", state: "succeeded" },
      ].sort((left, right) => {
        const owners = left.namespaceId.localeCompare(right.namespaceId);
        return owners === 0 ? left.target.localeCompare(right.target) : owners;
      }),
    );

    const admittedWork = await pool.query(
      `SELECT idempotency_key, state, attempt_count, claim_token,
              lease_expires_at, completed_at
       FROM occ.controller_work WHERE revision_id = $1`,
      [revision.id],
    );
    assert.equal(admittedWork.rowCount, 1);
    assert.equal(admittedWork.rows[0].idempotency_key, `agent_revision:${revision.id}:reconcile`);
    assert.equal(admittedWork.rows[0].state, "succeeded");
    assert.equal(admittedWork.rows[0].attempt_count, 1);
    assert.equal(admittedWork.rows[0].claim_token, null);
    assert.equal(admittedWork.rows[0].lease_expires_at, null);
    assert.ok(admittedWork.rows[0].completed_at instanceof Date);
  },
);

test(
  "PostgreSQL API and worker preserve immutable deployments, stable identities, and tenant isolation",
  requiresPostgresAndKubernetesConfiguration,
  async (context) => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    let api = await startKubernetesController(context);

    const existingInstallation = await request(api, "GET", "/installation");
    if (existingInstallation.status === 404) {
      const bootstrapped = await request(api, "POST", "/installation/bootstrap", {
        name: "Immutable revision integration",
      });
      assert.equal(bootstrapped.status, 201);
    } else {
      assert.equal(existingInstallation.status, 200);
    }

    const [firstNamespace, secondNamespace] = await Promise.all([
      request(api, "POST", "/namespaces", { name: `revision-tenant-a-${randomUUID()}` }),
      request(api, "POST", "/namespaces", { name: `revision-tenant-b-${randomUUID()}` }),
    ]);
    assert.equal(firstNamespace.status, 201);
    assert.equal(secondNamespace.status, 201);
    const namespaceA = firstNamespace.data.id;
    const namespaceB = secondNamespace.data.id;
    cleanupKubernetesNamespaces(context, [namespaceA, namespaceB]);

    const worker = await startKubernetesWorker(context);
    await Promise.all([
      grantTenantAccess(context, namespaceA),
      grantTenantAccess(context, namespaceB),
    ]);
    for (const namespaceId of [namespaceA, namespaceB]) {
      await waitForNamespaceReady(api, namespaceId, worker);
    }

    const originalConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-original" },
      tools: ["lookup"],
    };
    const [
      { configuration: primaryConfiguration, agent: primary },
      { agent: sibling },
      { agent: foreign },
      { agent: restricted },
    ] = await Promise.all([
      createConfiguredAgent(
        api,
        namespaceA,
        `revision-primary-${randomUUID()}`,
        originalConfigValues,
      ),
      createConfiguredAgent(api, namespaceA, `revision-sibling-${randomUUID()}`, {
        ...defaultAgentConfigurationValues,
        model: { id: "tenant-a-sibling" },
      }),
      createConfiguredAgent(api, namespaceB, `revision-foreign-${randomUUID()}`, {
        ...defaultAgentConfigurationValues,
        model: { id: "tenant-b" },
      }),
      createConfiguredAgent(api, namespaceA, `revision-restricted-${randomUUID()}`),
    ]);
    for (const created of [primary, sibling, foreign, restricted]) {
      assert.equal(Object.hasOwn(created, "servicePrincipalId"), false);
    }
    assert.equal(primary.configurationId, primaryConfiguration.id);

    const persistedConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-persisted" },
      tools: ["lookup", "search"],
    };
    const persistedConfiguration = await updateConfiguration(
      api,
      namespaceA,
      primaryConfiguration.id,
      persistedConfigValues,
    );
    assert.equal(persistedConfiguration.id, primaryConfiguration.id);
    assert.equal(persistedConfiguration.generation, 2);
    assert.deepEqual(persistedConfiguration.values, persistedConfigValues);

    const noMetadataEffects = await pool.query(
      `SELECT count(*)::integer AS count FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NOT NULL`,
      [[namespaceA, namespaceB]],
    );
    assert.equal(noMetadataEffects.rows[0].count, 0);

    const deniedTargetConfiguration = await createConfiguration(api, namespaceA, {
      ...defaultAgentConfigurationValues,
      model: { id: "unauthorized-update" },
    });
    await pool.query(
      `INSERT INTO occ.iam_restrictions
       (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $3, 'update', 'agent', $4, 'deny'),
              ($2, $3, 'deploy', 'agent', $4, 'deny')`,
      [
        `restriction-update-${randomUUID()}`,
        `restriction-deploy-${randomUUID()}`,
        namespaceA,
        restricted.id,
      ],
    );

    await stopController(api.child);
    api = await startKubernetesController(context);
    const afterRestart = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/configurations/${primaryConfiguration.id}`,
    );
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.generation, 2);
    assert.deepEqual(afterRestart.data.values, persistedConfigValues);

    const deniedUpdate = await request(
      api,
      "PATCH",
      `/namespaces/${namespaceA}/agents/${restricted.id}`,
      { configurationId: deniedTargetConfiguration.id },
    );
    assert.equal(deniedUpdate.status, 403);
    const deniedDeployment = await request(
      api,
      "POST",
      `/namespaces/${namespaceA}/agents/${restricted.id}/deploy`,
    );
    assert.equal(deniedDeployment.status, 403);
    const deniedMutation = await pool.query(
      `SELECT agent.configuration_id,
              (SELECT count(*)::integer FROM occ.agent_revisions WHERE agent_id = agent.id)
                AS revisions,
              (SELECT count(*)::integer FROM occ.controller_work WHERE agent_id = agent.id)
                AS work
       FROM occ.agents AS agent WHERE agent.id = $1`,
      [restricted.id],
    );
    assert.deepEqual(deniedMutation.rows, [
      { configuration_id: restricted.configurationId, revisions: 0, work: 0 },
    ]);

    const firstDeployment = await request(
      api,
      "POST",
      `/namespaces/${namespaceA}/agents/${primary.id}/deploy`,
    );
    assert.equal(firstDeployment.status, 202);
    const firstRevision = firstDeployment.data;
    assert.deepEqual(Object.keys(firstRevision).sort(), [
      "agentId",
      "compute",
      "configuration",
      "configurationGeneration",
      "configurationId",
      "configurationKind",
      "createdAt",
      "harness",
      "id",
      "namespaceId",
      "providerId",
      "revision",
    ]);
    assert.equal(firstRevision.namespaceId, namespaceA);
    assert.equal(firstRevision.agentId, primary.id);
    assert.equal(firstRevision.revision, 1);
    assert.equal(firstRevision.configurationId, primaryConfiguration.id);
    assert.equal(firstRevision.configurationKind, "agent");
    assert.equal(firstRevision.configurationGeneration, 2);
    assert.deepEqual(firstRevision.configuration, admitted(persistedConfigValues));
    assert.deepEqual(firstRevision.harness, { id: "openclaw", version: "1.0.0", mode: "embedded" });
    assert.deepEqual(firstRevision.compute, {
      id: "compute-kubernetes",
      implementation: "occ/kubernetes",
    });
    assert.equal(Object.hasOwn(firstRevision, "servicePrincipalId"), false);

    await pollUntil(
      `first revision ${firstRevision.id} to become active`,
      async () => {
        const current = await request(api, "GET", `/namespaces/${namespaceA}/agents/${primary.id}`);
        assert.equal(current.status, 200);
        return current.data.activeRevisionId === firstRevision.id ? current.data : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );

    const replacementConfigValues = {
      ...defaultAgentConfigurationValues,
      model: { id: "draft-replacement" },
      tools: ["replace"],
    };
    const replacement = await updateConfiguration(
      api,
      namespaceA,
      primaryConfiguration.id,
      replacementConfigValues,
    );
    assert.equal(replacement.generation, 3);

    const [secondDeployment, siblingDeployment, foreignDeployment] = await Promise.all([
      request(api, "POST", `/namespaces/${namespaceA}/agents/${primary.id}/deploy`),
      request(api, "POST", `/namespaces/${namespaceA}/agents/${sibling.id}/deploy`),
      request(api, "POST", `/namespaces/${namespaceB}/agents/${foreign.id}/deploy`),
    ]);
    for (const deployment of [secondDeployment, siblingDeployment, foreignDeployment]) {
      assert.equal(deployment.status, 202);
    }
    const secondRevision = secondDeployment.data;
    assert.equal(secondRevision.revision, 2);
    assert.notEqual(secondRevision.id, firstRevision.id);
    assert.equal(secondRevision.configurationId, primaryConfiguration.id);
    assert.equal(secondRevision.configurationGeneration, 3);
    assert.deepEqual(secondRevision.configuration, admitted(replacementConfigValues));

    for (const [namespaceId, agent, revision] of [
      [namespaceA, primary, secondRevision],
      [namespaceA, sibling, siblingDeployment.data],
      [namespaceB, foreign, foreignDeployment.data],
    ]) {
      await pollUntil(
        `Agent ${agent.id} to activate revision ${revision.id}`,
        async () => {
          const current = await request(
            api,
            "GET",
            `/namespaces/${namespaceId}/agents/${agent.id}`,
          );
          assert.equal(current.status, 200);
          return current.data.activeRevisionId === revision.id ? current.data : undefined;
        },
        { worker, timeoutMs: 60_000 },
      );
    }

    const history = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/agents/${primary.id}/revisions`,
    );
    assert.equal(history.status, 200);
    assert.deepEqual(history.data, [firstRevision, secondRevision]);
    const firstRevisionRead = await request(
      api,
      "GET",
      `/namespaces/${namespaceA}/agents/${primary.id}/revisions/${firstRevision.id}`,
    );
    assert.equal(firstRevisionRead.status, 200);
    assert.deepEqual(firstRevisionRead.data, firstRevision);
    const foreignRead = await request(
      api,
      "GET",
      `/namespaces/${namespaceB}/agents/${foreign.id}/revisions/${firstRevision.id}`,
    );
    assert.equal(foreignRead.status, 404);

    const persistedRevisions = await pool.query(
      `SELECT revision.id, revision.namespace_id, revision.agent_id,
              revision.revision_number, revision.admitted_spec,
              agent.service_principal_id
       FROM occ.agent_revisions AS revision
       JOIN occ.agents AS agent
         ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
       WHERE revision.agent_id = $1 ORDER BY revision.revision_number`,
      [primary.id],
    );
    assert.equal(persistedRevisions.rowCount, 2);
    assert.deepEqual(persistedRevisions.rows[0].admitted_spec, {
      configuration_id: firstRevision.configurationId,
      configuration_kind: firstRevision.configurationKind,
      configuration_generation: firstRevision.configurationGeneration,
      draft_spec: admitted(persistedConfigValues),
      harness: firstRevision.harness,
      compute: firstRevision.compute,
    });
    assert.deepEqual(persistedRevisions.rows[1].admitted_spec, {
      configuration_id: secondRevision.configurationId,
      configuration_kind: secondRevision.configurationKind,
      configuration_generation: secondRevision.configurationGeneration,
      draft_spec: admitted(replacementConfigValues),
      harness: secondRevision.harness,
      compute: secondRevision.compute,
    });
    assert.equal(
      persistedRevisions.rows[0].service_principal_id,
      persistedRevisions.rows[1].service_principal_id,
    );

    const identities = await pool.query(
      `SELECT namespace_id, agent_id, id FROM occ.iam_identities
       WHERE kind = 'service_principal' AND agent_id = ANY($1::text[])
       ORDER BY agent_id`,
      [[primary.id, sibling.id, foreign.id]],
    );
    assert.equal(identities.rowCount, 3);
    assert.equal(new Set(identities.rows.map(({ id }) => id)).size, 3);
    const primaryIdentity = identities.rows.find(({ agent_id }) => agent_id === primary.id);
    assert.equal(primaryIdentity.namespace_id, namespaceA);
    assert.equal(primaryIdentity.id, persistedRevisions.rows[0].service_principal_id);

    // Activation becomes visible before post-commit effects finish and the worker
    // completes its claim, so wait for the durable work state asserted below.
    const expectedRevisionIds = [
      firstRevision.id,
      secondRevision.id,
      siblingDeployment.data.id,
      foreignDeployment.data.id,
    ].sort();
    const work = await pollUntil(
      "the four admitted revision work items to succeed",
      async () => {
        const current = await pool.query(
          `SELECT namespace_id, agent_id, revision_id, idempotency_key, state
           FROM occ.controller_work WHERE agent_id = ANY($1::text[])
           ORDER BY agent_id, idempotency_key`,
          [[primary.id, sibling.id, foreign.id]],
        );
        assert.equal(current.rowCount, 4);
        assert.deepEqual(
          current.rows.map(({ revision_id }) => revision_id).sort(),
          expectedRevisionIds,
        );
        for (const item of current.rows) {
          assert.notEqual(
            item.state,
            "failed_permanent",
            `Revision ${item.revision_id} work failed permanently`,
          );
        }
        return current.rows.every(({ state }) => state === "succeeded") ? current : undefined;
      },
      { worker, timeoutMs: 60_000 },
    );
    assert.equal(work.rowCount, 4);
    for (const item of work.rows) {
      assert.equal(item.state, "succeeded");
      assert.equal(item.idempotency_key, `agent_revision:${item.revision_id}:reconcile`);
    }

    const namespaceWork = await pool.query(
      `SELECT namespace_id, namespace_target, state FROM occ.controller_work
       WHERE namespace_id = ANY($1::text[]) AND agent_id IS NULL`,
      [[namespaceA, namespaceB]],
    );
    assert.equal(namespaceWork.rowCount, 2);
    assert.ok(
      namespaceWork.rows.every(
        ({ namespace_target, state }) => namespace_target === "ready" && state === "succeeded",
      ),
    );

    const lifecycle = await pool.query(
      `SELECT resource_id, action, outcome, details
       FROM occ.audit_events
       WHERE resource_id = ANY($1::text[])
         AND action IN ('openclaw.agents.deploy', 'openclaw.agents.lifecycle.activate')
       ORDER BY occurred_at`,
      [[firstRevision.id, secondRevision.id]],
    );
    assert.equal(lifecycle.rowCount, 4);
    assert.ok(lifecycle.rows.every(({ outcome }) => outcome === "success"));
    const secondActivation = lifecycle.rows.find(
      ({ resource_id, action }) =>
        resource_id === secondRevision.id && action === "openclaw.agents.lifecycle.activate",
    );
    assert.equal(secondActivation.details.previousRevisionId, firstRevision.id);
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";

import type {
  ComputeDriver,
  PluginApprovers,
  PluginDesiredState,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorker } from "../../apps/controller/src/worker.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import {
  adminEmail,
  createDurableController,
  databaseUrl,
  pollUntil,
  startController,
} from "../helpers/postgres-platform-state.ts";

export async function persistPluginState(context: TestContext): Promise<void> {
  const [
    { Pool },
    { OCCPluginDriver },
    { createControllerWorker },
    { createDevelopmentComputeDriver },
    { PostgresPlatformState },
    { createTestConfigurationDriver },
    { createBackendWorkerDrivers },
  ] = await Promise.all([
    import("pg"),
    import("../../apps/controller/src/drivers/plugin/index.ts"),
    import("../../apps/controller/src/worker.ts"),
    import("../helpers/development.mjs"),
    import("../../packages/occ/src/state/postgres-state.ts"),
    import("../helpers/configuration-driver.ts"),
    import("../helpers/postgres-backend-state.mjs"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  await startController(context);

  const bootstrapState = new PostgresPlatformState(pool);
  const installation = await bootstrapState.loadInstallation();
  assert.ok(installation, "the real OCC subprocess must bootstrap the singleton Installation");
  const actor = await pool.query<{ id: unknown }>(
    `SELECT identity.id
     FROM occ.iam_identities AS identity
     JOIN occ."user" AS auth_user ON auth_user.id = identity.subject
     WHERE auth_user.email = $1`,
    [adminEmail],
  );
  assert.equal(actor.rowCount, 1);
  const principalId = actor.rows[0]?.id;
  assert.ok(typeof principalId === "string");

  const { controller, state, resolveHarness } = await createDurableController(pool);
  const configurationDriver = createTestConfigurationDriver({
    id: `configuration-plugin-${randomUUID()}`,
  });
  const { createTestSecretDriver } = await import("../helpers/secret-driver.mjs");
  const harnessSecretDriver = createTestSecretDriver();
  controller.registerDriver(harnessSecretDriver);
  controller.selectDriver("secret", harnessSecretDriver.id);
  const pluginDriver = new OCCPluginDriver();
  controller.registerDriver(configurationDriver);
  controller.selectDriver("configuration", configurationDriver.id);
  controller.registerDriver(pluginDriver);
  controller.selectDriver("plugin", pluginDriver.id);

  const namespace = await controller.createNamespace(principalId, {
    name: `postgres-plugin-${randomUUID()}`,
  });
  const configuration = await controller.createConfiguration(principalId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const replacementConfiguration = await controller.createConfiguration(principalId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { runtime: { revision: "replacement" } },
  });
  const initialPlugins: PluginDesiredState = {
    "occ-plugin:diffs": {
      enabled: true,
      approvers: [{ channel: "slack", id: "team:T123:user:U123" }],
      toolDefaults: { enabled: false, approval: "none" },
      tools: { diffs: { enabled: true, approvers: [] } },
    },
  };
  const malformedCreateAgentId = `agt_${randomUUID()}`;
  await assert.rejects(
    state.transact((unit) =>
      unit.agents.createAgent({
        id: malformedCreateAgentId,
        namespaceId: namespace.id,
        name: `postgres-plugin-malformed-agent-${randomUUID()}`,
        configurationId: configuration.id,
        backendId: null,
        harnessAuth: null,
        executionMode: "embedded",
        servicePrincipalId: `service-agent-${malformedCreateAgentId}`,
        pluginDriver: { id: pluginDriver.id, implementation: pluginDriver.implementation },
        plugins: {
          // @ts-expect-error An untyped writer can supply a retired approval value.
          "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "sometimes" } },
        },
        createdAt: new Date().toISOString(),
      }),
    ),
    { name: "ScopeViolationError" },
  );
  const malformedCreateRow = await pool.query("SELECT plugins FROM occ.agents WHERE id = $1", [
    malformedCreateAgentId,
  ]);
  assert.equal(malformedCreateRow.rowCount, 0);

  let escapedUnit: PlatformUnitOfWork | undefined;
  const agent = await controller.transact(async (unit) => {
    escapedUnit = unit;
    return controller.createAgent(principalId, {
      namespaceId: namespace.id,
      name: `postgres-plugin-agent-${randomUUID()}`,
      configurationId: configuration.id,
      plugins: initialPlugins,
      pluginApprovers: [],
    });
  });
  // An Agent mutation may share its caller's transaction, but the borrowed
  // handle cannot change that Agent after the controller publishes the result.
  assert.ok(escapedUnit);
  await assert.rejects(
    escapedUnit.agents.updateConfiguration(namespace.id, agent.id, replacementConfiguration.id),
    { name: "ScopeViolationError" },
  );
  const persistedAgent = await state.read((view) => view.agents.findAgent(namespace.id, agent.id));
  assert.ok(persistedAgent);
  assert.equal(persistedAgent.configurationId, configuration.id);
  assert.deepEqual(persistedAgent.pluginApprovers, []);
  const driverIdentity = { id: pluginDriver.id, implementation: pluginDriver.implementation };
  assert.deepEqual(persistedAgent.pluginDriver, driverIdentity);
  await assert.rejects(
    pool.query("UPDATE occ.agents SET plugin_driver = NULL WHERE id = $1", [agent.id]),
    { code: "23514", constraint: "agents_plugin_driver_selection" },
  );

  const storedSelection = await pool.query<{ plugins: unknown; plugin_approvers: unknown }>(
    "SELECT plugins, plugin_approvers FROM occ.agents WHERE id = $1",
    [agent.id],
  );
  assert.deepEqual(storedSelection.rows[0]?.plugins, initialPlugins);
  assert.deepEqual(storedSelection.rows[0]?.plugin_approvers, []);
  const stateBeforeFailure = await state.read((view) =>
    view.agents.findAgent(namespace.id, agent.id),
  );
  const auditBeforeFailure = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.audit_events",
  );
  const stagedAuditId = `aud_${randomUUID()}`;

  await assert.rejects(
    controller.transact(async (unit) => {
      await unit.audit.append({
        schemaVersion: 1,
        id: stagedAuditId,
        installationId: installation.id,
        namespaceId: namespace.id,
        occurredAt: new Date().toISOString(),
        source: "occ",
        kind: "mutation",
        actorId: principalId,
        actor: { principalId },
        action: "openclaw.agents.update",
        resource: { kind: "agent", id: agent.id, namespaceId: namespace.id },
        outcome: "success",
      });
      await unit.agents.updateConfiguration(
        namespace.id,
        agent.id,
        configuration.id,
        undefined,
        undefined,
        undefined,
        // @ts-expect-error An untyped update can supply an unsupported policy field.
        { "occ-plugin:diffs": { enabled: true, approvalMode: "always" } },
      );
    }),
    { name: "ScopeViolationError" },
  );

  const [stateAfterFailure, auditAfterFailure, stagedAudit] = await Promise.all([
    state.read((view) => view.agents.findAgent(namespace.id, agent.id)),
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM occ.audit_events"),
    pool.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM occ.audit_events WHERE id = $1",
      [stagedAuditId],
    ),
  ]);
  assert.ok(stateBeforeFailure && stateAfterFailure);
  assert.deepEqual(stateAfterFailure.plugins, stateBeforeFailure.plugins);
  assert.ok(auditBeforeFailure.rows[0] && auditAfterFailure.rows[0]);
  assert.equal(auditAfterFailure.rows[0].count, auditBeforeFailure.rows[0].count);
  assert.equal(stagedAudit.rows[0]?.count, 0);

  await controller.handleNamespaceLifecycle(principalId, namespace.id, "ready");
  const harnessSecret = await controller.createSecret(principalId, {
    namespaceId: namespace.id,
    name: `plugin-harness-${randomUUID()}`,
    value: "synthetic-persistence-key",
  });
  await controller.updateAgent(principalId, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: configuration.id,
    harnessAuth: {
      method: "api_key",
      source: { kind: "secret", namespaceId: namespace.id, id: harnessSecret.id },
    },
  });
  const harnessRoleId = `role-${randomUUID()}`;
  await pool.query(
    "INSERT INTO occ.iam_roles(id, namespace_id, name, permissions) VALUES($1, $2, $3, $4::jsonb)",
    [
      harnessRoleId,
      namespace.id,
      "Harness Secret consumer",
      JSON.stringify([{ action: "operate", resourceKind: "secret" }]),
    ],
  );
  await pool.query(
    "INSERT INTO occ.iam_access_bindings(id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id) VALUES($1, $2, $3, $4, 'secret', $5)",
    [
      `binding-${randomUUID()}`,
      namespace.id,
      agent.servicePrincipalId,
      harnessRoleId,
      harnessSecret.id,
    ],
  );
  const revision = await controller.deployAgent(
    principalId,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveHarness,
  );
  assert.ok(revision.plugins);
  assert.deepEqual(revision.plugins, {
    driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
    plugins: initialPlugins,
  });
  assert.deepEqual(revision.pluginApprovers, []);
  assert.equal(Object.hasOwn(revision.plugins, "artifacts"), false);
  const omittedPlugins = await controller.updateAgent(principalId, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: replacementConfiguration.id,
  });
  assert.deepEqual(omittedPlugins.plugins, initialPlugins);
  assert.deepEqual(omittedPlugins.pluginDriver, driverIdentity);
  assert.deepEqual(omittedPlugins.pluginApprovers, []);
  const replacementPlugins: PluginDesiredState = {
    "occ-plugin:diffs": {
      enabled: true,
      toolDefaults: { approval: "provider_default" },
      tools: { diffs: { approval: "none" } },
    },
  };
  const rawSlackApprovers: PluginApprovers = [
    { channel: "slack", id: "U456" },
    { channel: "slack", id: "W789" },
  ];
  const replacedPlugins = await controller.updateAgent(principalId, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: replacementConfiguration.id,
    plugins: replacementPlugins,
    pluginApprovers: rawSlackApprovers,
  });
  assert.deepEqual(replacedPlugins.plugins, replacementPlugins);
  assert.deepEqual(replacedPlugins.pluginDriver, driverIdentity);
  assert.deepEqual(replacedPlugins.pluginApprovers, rawSlackApprovers);
  const clearedPlugins = await controller.updateAgent(principalId, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: replacementConfiguration.id,
    plugins: {},
  });
  assert.deepEqual(clearedPlugins.plugins, {});
  assert.deepEqual(clearedPlugins.pluginApprovers, rawSlackApprovers);

  const [reloadedAgent, reloadedRevision] = await state.read(
    async (view) =>
      [
        await view.agents.findAgent(namespace.id, agent.id),
        await view.revisions.findRevision(namespace.id, agent.id, revision.id),
      ] as const,
  );
  assert.ok(reloadedAgent && reloadedRevision?.plugins);
  assert.deepEqual(reloadedAgent.plugins, {});
  assert.equal(reloadedAgent.pluginDriver, undefined);
  assert.deepEqual(reloadedRevision.plugins.driver, driverIdentity);
  assert.deepEqual(reloadedAgent.pluginApprovers, rawSlackApprovers);
  assert.deepEqual(reloadedRevision.plugins.plugins, initialPlugins);
  assert.deepEqual(reloadedRevision.pluginApprovers, []);

  const durableRevision = await pool.query<{
    admitted_spec: { plugins?: unknown; plugin_approvers?: unknown };
  }>("SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1", [revision.id]);
  assert.deepEqual(durableRevision.rows[0]?.admitted_spec.plugins, revision.plugins);
  assert.deepEqual(durableRevision.rows[0]?.admitted_spec.plugin_approvers, []);

  const pluginFreeRevision = await controller.deployAgent(
    principalId,
    { namespaceId: namespace.id, agentId: agent.id },
    resolveHarness,
  );
  assert.equal(Object.hasOwn(pluginFreeRevision, "plugins"), false);
  assert.deepEqual(pluginFreeRevision.pluginApprovers, rawSlackApprovers);

  const durablePluginFreeRevision = await pool.query<{
    admitted_spec: { plugins?: unknown; plugin_approvers?: unknown };
  }>("SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1", [pluginFreeRevision.id]);
  assert.deepEqual(
    durablePluginFreeRevision.rows[0]?.admitted_spec.plugin_approvers,
    rawSlackApprovers,
  );

  const workerPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let worker: ControllerWorker | undefined;
  let workerPoolClosed = false;
  context.after(async () => {
    if (workerPoolClosed) {
      return;
    }
    if (worker === undefined) {
      await workerPool.end();
    } else {
      await worker.stop();
    }
  });
  const developmentCompute: ComputeDriver = createDevelopmentComputeDriver();
  const observedRawApproverHandoffs: (PluginApprovers | undefined)[] = [];
  const observingCompute = {
    ...developmentCompute,
    async prepareRevision(candidate, deploymentContext) {
      if (candidate.id === pluginFreeRevision.id) {
        observedRawApproverHandoffs.push(candidate.pluginApprovers);
      }
      return developmentCompute.prepareRevision(candidate, deploymentContext);
    },
  } satisfies ComputeDriver;
  const workerDrivers = createBackendWorkerDrivers(observingCompute, [], {
    secretDriver: harnessSecretDriver,
  });
  worker = createControllerWorker({
    pool: workerPool,
    pollIntervalMs: 20,
    drivers: { ...workerDrivers, pluginDriver },
    emit() {},
  });
  await worker.start();
  await pollUntil("raw Slack approver AgentRevision deployment to reach Compute", async () => {
    const work = await pool.query<{ state: unknown }>(
      "SELECT state FROM occ.controller_work WHERE revision_id = $1",
      [pluginFreeRevision.id],
    );
    assert.equal(work.rowCount, 1);
    return work.rows[0]?.state === "succeeded" ? work.rows[0] : undefined;
  });
  await worker.stop();
  workerPoolClosed = true;
  worker = undefined;
  assert.deepEqual(observedRawApproverHandoffs, [rawSlackApprovers]);

  const clearedApprovers = await controller.updateAgent(principalId, {
    namespaceId: namespace.id,
    agentId: agent.id,
    configurationId: replacementConfiguration.id,
    pluginApprovers: null,
  });
  assert.equal(Object.hasOwn(clearedApprovers, "pluginApprovers"), false);
  const storedApprovers = await pool.query<{ plugin_approvers: unknown }>(
    "SELECT plugin_approvers FROM occ.agents WHERE id = $1",
    [agent.id],
  );
  assert.equal(storedApprovers.rows[0]?.plugin_approvers, null);

  const malformedPlugins = {
    ...revision.plugins,
    artifacts: {
      kind: "openclaw",
      configuration: {},
      installs: [
        {
          pluginId: "occ-plugin:diffs",
          nativeId: "diffs",
          version: "2026.8.2",
        },
      ],
    },
  };
  const malformedRevisionId = `rev_${randomUUID()}`;
  const revisionCountBeforeMalformed = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
    [agent.id],
  );
  await assert.rejects(
    state.transact((unit) =>
      unit.revisions.createRevision({
        ...revision,
        id: malformedRevisionId,
        revision: revision.revision + 1,
        plugins: malformedPlugins,
      }),
    ),
    { name: "ScopeViolationError" },
  );
  const revisionCountAfterMalformed = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM occ.agent_revisions WHERE agent_id = $1",
    [agent.id],
  );
  assert.ok(revisionCountBeforeMalformed.rows[0] && revisionCountAfterMalformed.rows[0]);
  assert.equal(
    revisionCountAfterMalformed.rows[0].count,
    revisionCountBeforeMalformed.rows[0].count,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
       SELECT $1, namespace_id, agent_id, revision_number + 1000, backend_id,
              jsonb_set(admitted_spec, '{plugins}', $2::jsonb, false), admitted_at
       FROM occ.agent_revisions WHERE id = $3`,
      [malformedRevisionId, JSON.stringify(malformedPlugins), revision.id],
    );
    const transactionState = new PostgresPlatformState({
      async connect() {
        return {
          async query(statement, parameters) {
            if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(statement)) {
              return { rows: [], rowCount: null };
            }
            return client.query(statement, parameters && [...parameters]);
          },
          release() {},
        };
      },
      async end() {},
    });
    await assert.rejects(
      transactionState.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, malformedRevisionId),
      ),
      { name: "DependencyUnavailableError" },
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

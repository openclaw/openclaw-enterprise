import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type { Static } from "typebox";

import type { ControllerAuth } from "../../apps/controller/src/auth/index.ts";
import type {
  AgentCallerPermissionsResponse,
  AgentListResponse,
  AgentReadWire,
  AgentRevision,
  AgentRevisionListResponse,
  AgentRevisionReadWire,
  AgentRevisionSummaryWire,
  AgentRevisionWire,
  NamespaceResponse,
  PluginDesiredState,
} from "../../packages/contracts/src/index.ts";
import { PersistedStateInvalidError, type PlatformReadView } from "../../packages/occ/src/index.ts";
import {
  adminEmail,
  createConfiguredAgent,
  createDurableController,
  databaseUrl,
  defaultAgentConfigurationValues,
  request,
  startController,
} from "../helpers/postgres-platform-state.ts";
import { callerDenied } from "../helpers/refusal-text.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

export async function browseUnreadableState(context: TestContext): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const api = await startController(context);
  const { state } = await createDurableController(pool);
  const namespace = await request<NamespaceResponse["data"]>(api, "POST", "/namespaces", {
    name: `unreadable-configuration-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201);
  const namespaceId = namespace.data.id;
  const plugins: PluginDesiredState = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "provider_default" } },
  };
  const configurationValues = defaultAgentConfigurationValues;
  const { agent, configuration } = await createConfiguredAgent(
    api,
    namespaceId,
    "Unreadable saved configuration",
    configurationValues,
  );
  assert.deepEqual(configuration.values, configurationValues);
  // Kubernetes Compute never deploys runtime authentication, so Agent save refuses it; store
  // it as an older release did, to match the revisions seeded below.
  await pool.query(
    "UPDATE occ.agents SET harness_auth = $3::jsonb WHERE namespace_id = $1 AND id = $2",
    [namespaceId, agent.id, JSON.stringify({ method: "runtime" })],
  );
  const { agent: healthyAgent } = await createConfiguredAgent(
    api,
    namespaceId,
    "Healthy saved configuration",
  );
  const agentPath = `/namespaces/${namespaceId}/agents/${agent.id}`;
  const revisionPath = `${agentPath}/revisions`;

  // Seed an admitted snapshot through its persistence owner. This test proves
  // browsing saved state, not Compute execution or runtime readiness.
  const revision = await state.transact((unit) =>
    unit.revisions.createRevision({
      id: `rev_${randomUUID()}`,
      namespaceId,
      agentId: agent.id,
      revision: 1,
      backendId: null,
      gatewayManagedMode: agent.gatewayManagedMode,
      configurationId: configuration.id,
      configurationKind: "agent",
      configurationGeneration: 1,
      configuration: configurationValues,
      harness: {
        id: "openclaw",
        version: "1.0.0",
        mode: "embedded",
        overrides: {},
        configuration: {},
      },
      compute: {
        id: "compute-local-development",
        implementation: "deterministic-local-development",
      },
      executionAdmission: { version: 2, mode: "unprotected" },
      harnessAuth: { method: "runtime" },
      servicePrincipalId: agent.servicePrincipalId,
      plugins: { driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" }, plugins },
      createdAt: new Date().toISOString(),
    }),
  );
  // Preserve a normal queued deployment record for the healthy snapshot, so
  // CLI status enrichment remains observable without executing a workload.
  const actor = (await state.loadNativeIAMState()).identities.find(
    (identity) => identity.kind === "principal",
  );
  assert.ok(actor);
  await state.transact((unit) =>
    unit.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId,
      resourceId: revision.id,
      actorId: actor.id,
    }),
  );
  const healthyRevision = await request<AgentRevisionReadWire>(
    api,
    "GET",
    `${revisionPath}/${revision.id}`,
  );
  assert.equal(healthyRevision.status, 200);
  assert.ok(!("configurationReadError" in healthyRevision.data));
  assert.ok(revision.plugins);

  // A previously accepted approval enum survives in PostgreSQL after the
  // application contract changes. Preserve the valid immutable snapshot.
  const malformedPlugins = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "prompt" } },
  };
  await pool.query(
    "UPDATE occ.agents SET plugins = $2::jsonb, plugin_driver = $3::jsonb WHERE id = $1",
    [agent.id, JSON.stringify(malformedPlugins), JSON.stringify(revision.plugins.driver)],
  );
  const malformedRevisionId = `rev_${randomUUID()}`;
  await pool.query(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
     SELECT $1, namespace_id, agent_id, revision_number + 1, backend_id,
            jsonb_set(admitted_spec, '{plugins,plugins}', $2::jsonb, false), admitted_at
     FROM occ.agent_revisions WHERE id = $3`,
    [malformedRevisionId, JSON.stringify(malformedPlugins), revision.id],
  );
  const readError = { code: "SAVED_CONFIGURATION_UNREADABLE", field: "plugins" } as const;
  const { plugins: _plugins, harnessAuth: _harnessAuth, ...agentMetadata } = agent;
  const degradedAgent = {
    ...agentMetadata,
    configurationReadError: readError,
  } satisfies AgentReadWire;
  const degradedRevision = {
    id: malformedRevisionId,
    namespaceId,
    agentId: agent.id,
    revision: 2,
    backendId: null,
    createdAt: healthyRevision.data.createdAt,
    configurationReadError: readError,
  } satisfies AgentRevisionReadWire;

  const listed = await request<AgentListResponse["data"]>(
    api,
    "GET",
    `/namespaces/${namespaceId}/agents`,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.data.length, 2);
  assert.deepEqual(
    listed.data.find(({ id }) => id === agent.id),
    degradedAgent,
  );
  assert.deepEqual(
    listed.data.find(({ id }) => id === healthyAgent.id),
    healthyAgent,
  );
  const detail = await request(api, "GET", agentPath);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data, degradedAgent);
  // An Agent update checks the sources its saved settings bind, which this Agent's unreadable
  // settings do not show: the sources answer stays false, even for a caller with every grant.
  const permissions = await request<Static<typeof AgentCallerPermissionsResponse>["data"]>(
    api,
    "GET",
    `${agentPath}/permissions`,
  );
  assert.equal(permissions.status, 200);
  assert.equal(permissions.data.update, true);
  assert.equal(permissions.data.configurationRead, true);
  assert.equal(permissions.data.agentSourcesOperate, false);

  // The list carries summaries, newest first. It never decodes a snapshot, so the
  // unreadable revision lists like any other; its exact read reports the error.
  const revisionSummary = (
    item: AgentRevisionWire,
    deploymentStatus: AgentRevisionSummaryWire["deploymentStatus"],
  ): AgentRevisionSummaryWire => ({
    id: item.id,
    namespaceId: item.namespaceId,
    agentId: item.agentId,
    revision: item.revision,
    backendId: item.backendId,
    configurationId: item.configurationId,
    configurationGeneration: item.configurationGeneration,
    harness: item.harness,
    createdAt: item.createdAt,
    deploymentStatus,
    deploymentErrorCode: null,
  });
  // The planted revision has no deployment work; the deployed one is queued.
  const revisions = await request<AgentRevisionListResponse["data"]>(api, "GET", revisionPath);
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, [
    revisionSummary({ ...healthyRevision.data, id: malformedRevisionId, revision: 2 }, null),
    revisionSummary(healthyRevision.data, "queued"),
  ]);
  const validDetail = await request(api, "GET", `${revisionPath}/${revision.id}`);
  assert.equal(validDetail.status, 200);
  assert.deepEqual(validDetail.data, healthyRevision.data);
  const invalidDetail = await request(api, "GET", `${revisionPath}/${malformedRevisionId}`);
  assert.equal(invalidDetail.status, 200);
  assert.deepEqual(invalidDetail.data, degradedRevision);

  // The compiled CLI consumes the same supported metadata/error variants over
  // the shipped API's real HTTP listener. A retired saved enum is not a runtime.
  const cliDirectory = await temporaryDirectory(context, "oce-cli-browsing-");
  const cli = join(cliDirectory, "occ");
  const execute = promisify(execFile);
  await execute("go", ["build", "-trimpath", "-o", cli, "./cmd/occ"]);
  const principal = (await state.loadNativeIAMState()).identities.find(
    (identity) =>
      identity.kind === "service_principal" &&
      identity.namespaceId === undefined &&
      identity.agentId === undefined,
  );
  assert.ok(principal);
  const key = await request<Awaited<ReturnType<ControllerAuth["createServiceKey"]>>>(
    api,
    "POST",
    "/api/auth/service-keys",
    {
      servicePrincipalId: principal.id,
      name: "metadata-browsing-proof",
      expiresIn: 86400,
    },
  );
  assert.equal(key.status, 201);
  const keyFile = join(cliDirectory, "service-key.json");
  const cliArguments = [
    "--url",
    api.origin,
    "--service-key-file",
    keyFile,
    "--namespace",
    namespaceId,
  ];
  try {
    await writeFile(keyFile, JSON.stringify({ data: key.data }), { mode: 0o600 });
    for (const command of [
      ["agent", "get", agent.id],
      ["agent", "list"],
      ["agent", "revisions", agent.id],
    ]) {
      const table = await execute(cli, [...cliArguments, ...command]);
      const structured = await execute(cli, [...cliArguments, ...command, "--output", "json"]);
      const decoded: unknown = JSON.parse(structured.stdout);
      const records: readonly unknown[] = Array.isArray(decoded) ? decoded : [decoded];
      if (command[1] === "revisions") {
        // Revision summaries carry no saved settings, so no read error either. The CLI
        // keeps each deployment status OCC listed, though the Agent's settings are unreadable.
        assert.ok(table.stdout.includes(malformedRevisionId));
        assert.match(table.stdout, /queued/u);
        assert.equal(structured.stderr, "");
        assert.deepEqual(
          records.map((record) => {
            assert.ok(
              typeof record === "object" &&
                record !== null &&
                "id" in record &&
                "deploymentStatus" in record,
            );
            return { id: record.id, deploymentStatus: record.deploymentStatus };
          }),
          revisions.data.map(({ id, deploymentStatus }) => ({ id, deploymentStatus })),
        );
        continue;
      }
      assert.match(table.stdout, /CONFIGURATION ERROR/u);
      assert.match(table.stdout, /SAVED_CONFIGURATION_UNREADABLE \(plugins\)/u);
      assert.ok(
        records.some((record) => {
          if (
            typeof record !== "object" ||
            record === null ||
            !("configurationReadError" in record)
          ) {
            return false;
          }
          const error = record.configurationReadError;
          return (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === readError.code
          );
        }),
      );
    }
    // A readable Agent can still have an unreadable historical snapshot. The list never
    // decodes it, so the CLI lists it beside its healthy sibling without a strict read.
    await pool.query("UPDATE occ.agents SET plugins = $2::jsonb WHERE id = $1", [
      agent.id,
      JSON.stringify(plugins),
    ]);
    const history = await execute(cli, [...cliArguments, "agent", "revisions", agent.id]);
    assert.equal(history.stderr, "");
    assert.ok(history.stdout.includes(revision.id));
    assert.match(history.stdout, /queued/u);
    assert.ok(history.stdout.includes(malformedRevisionId));
  } finally {
    try {
      await pool.query("UPDATE occ.agents SET plugins = $2::jsonb WHERE id = $1", [
        agent.id,
        JSON.stringify(malformedPlugins),
      ]);
    } finally {
      assert.equal(
        (await request(api, "DELETE", `/api/auth/service-keys/${key.data.id}`)).status,
        200,
      );
    }
  }

  // Browsing must not admit partially decoded records to mutation or runtime
  // paths, and a failed edit must not turn unreadable plugin state into {}.
  const strictReads: readonly ((view: PlatformReadView) => Promise<unknown>)[] = [
    (view) => view.agents.findAgent(namespaceId, agent.id),
    (view) => view.agents.listAgents(namespaceId),
    (view) => view.revisions.findRevision(namespaceId, agent.id, malformedRevisionId),
    (view) => view.revisions.listRevisions(namespaceId, agent.id),
  ];
  for (const read of strictReads) {
    await assert.rejects(state.read(read), { name: "DependencyUnavailableError" });
  }
  const beforeMutation = await pool.query(
    `SELECT plugins,
            (SELECT count(*)::integer FROM occ.agent_revisions WHERE agent_id = $1) AS revisions,
            (SELECT count(*)::integer FROM occ.controller_work WHERE agent_id = $1) AS work
     FROM occ.agents WHERE id = $1`,
    [agent.id],
  );
  for (const [method, path, body] of [
    ["PATCH", agentPath, { configurationId: configuration.id }],
    ["POST", `${agentPath}/deploy`, undefined],
  ] as const) {
    const rejected = await request(api, method, path, body);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.error?.code, "DEPENDENCY_UNAVAILABLE");
    assert.equal(rejected.data, undefined);
  }
  const afterMutation = await pool.query(
    `SELECT plugins,
            (SELECT count(*)::integer FROM occ.agent_revisions WHERE agent_id = $1) AS revisions,
            (SELECT count(*)::integer FROM occ.controller_work WHERE agent_id = $1) AS work
     FROM occ.agents WHERE id = $1`,
    [agent.id],
  );
  assert.deepEqual(afterMutation.rows, beforeMutation.rows);

  // The degraded response has the same exact-resource IAM boundary as a
  // healthy response; neither metadata nor decode errors may leak on denial.
  for (const [resourceKind, kindLabel, resourceId, listPath, detailPath, visible] of [
    [
      "agent_revision",
      "AgentRevision",
      malformedRevisionId,
      revisionPath,
      `${revisionPath}/${malformedRevisionId}`,
      [revisionSummary(healthyRevision.data, "queued")],
    ],
    ["agent", "Agent", agent.id, `/namespaces/${namespaceId}/agents`, agentPath, [healthyAgent]],
  ] as const) {
    await pool.query(
      `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
       VALUES ($1, $2, 'read', $3, $4, 'deny')`,
      [`restriction-${randomUUID()}`, namespaceId, resourceKind, resourceId],
    );
    const filtered = await request(api, "GET", listPath);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.data, visible);
    const denied = await request(api, "GET", detailPath);
    assert.equal(denied.status, 403);
    // The Restriction reads as any missing grant on the ID the path named.
    assert.deepEqual(denied.error, {
      code: "FORBIDDEN",
      message: callerDenied(`${kindLabel} read`, `${kindLabel} ${resourceId}`),
    });
    assert.equal(denied.data, undefined);
  }
}

export async function selectNativeAdminRevision(context: TestContext): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  const api = await startController(context);
  const { controller, state } = await createDurableController(pool);
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
  const namespace = await request<NamespaceResponse["data"]>(api, "POST", "/namespaces", {
    name: `native-admin-successor-${randomUUID()}`,
  });
  assert.equal(namespace.status, 201);
  const namespaceId = namespace.data.id;
  const configurationValues = defaultAgentConfigurationValues;
  const { agent, configuration } = await createConfiguredAgent(
    api,
    namespaceId,
    "Native admin successor",
    configurationValues,
  );
  assert.deepEqual(configuration.values, configurationValues);
  // Kubernetes Compute never deploys runtime authentication, so Agent save refuses it; store
  // it as an older release did, to match the revisions seeded below.
  await pool.query(
    "UPDATE occ.agents SET harness_auth = $3::jsonb WHERE namespace_id = $1 AND id = $2",
    [namespaceId, agent.id, JSON.stringify({ method: "runtime" })],
  );
  const plugins: PluginDesiredState = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "provider_default" } },
  };
  // A previously accepted approval enum that the current contract no longer decodes.
  const malformedPlugins = {
    "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "prompt" } },
  };
  const createRevision = (revision: number) =>
    state.transact((unit) =>
      unit.revisions.createRevision({
        id: `rev_${randomUUID()}`,
        namespaceId,
        agentId: agent.id,
        revision,
        backendId: null,
        gatewayManagedMode: agent.gatewayManagedMode,
        configurationId: configuration.id,
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: configurationValues,
        harness: {
          id: "openclaw",
          version: "1.0.0",
          mode: "embedded",
          overrides: {},
          configuration: {},
        },
        compute: {
          id: "compute-local-development",
          implementation: "deterministic-local-development",
        },
        executionAdmission: { version: 2, mode: "unprotected" },
        harnessAuth: { method: "runtime" },
        servicePrincipalId: agent.servicePrincipalId,
        plugins: { driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" }, plugins },
        createdAt: new Date().toISOString(),
      }),
    );
  // Revisions are immutable to the application role, so seed unreadable rows as copies.
  const insertUnreadable = async (template: Pick<AgentRevision, "id">, revision: number) => {
    const id = `rev_${randomUUID()}`;
    await pool.query(
      `INSERT INTO occ.agent_revisions
         (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
       SELECT $1, namespace_id, agent_id, $2, backend_id,
              jsonb_set(admitted_spec, '{plugins,plugins}', $4::jsonb, false), admitted_at
       FROM occ.agent_revisions WHERE id = $3`,
      [id, revision, template.id, JSON.stringify(malformedPlugins)],
    );
    return id;
  };
  const active = await createRevision(2);
  await insertUnreadable(active, 1);
  await pool.query("UPDATE occ.agents SET active_revision_id = $2 WHERE id = $1", [
    agent.id,
    active.id,
  ]);

  // An unreadable older snapshot must not make a healthy active revision unavailable.
  const selection = await controller.getAdministerableActiveAgentRevision(
    principalId,
    namespaceId,
    agent.id,
  );
  assert.equal(selection.revision.id, active.id);
  assert.equal(selection.successor, undefined);

  // Only the newest later revision is decoded strictly, and it fails closed when unreadable.
  const newer = await createRevision(3);
  const withSuccessor = await controller.getAdministerableActiveAgentRevision(
    principalId,
    namespaceId,
    agent.id,
  );
  assert.equal(withSuccessor.successor?.id, newer.id);
  await insertUnreadable(active, 4);
  await assert.rejects(
    controller.getAdministerableActiveAgentRevision(principalId, namespaceId, agent.id),
    { name: "DependencyUnavailableError" },
  );
}

export async function refuseUnreadableDeployment(context: TestContext): Promise<void> {
  const [
    { Pool },
    { createTestConfigurationDriver },
    { createTestSecretDriver },
    { requestFailure },
  ] = await Promise.all([
    import("pg"),
    import("../helpers/configuration-driver.ts"),
    import("../helpers/secret-driver.mjs"),
    import("../../apps/controller/src/http/errors.ts"),
  ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  await startController(context);
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
  const { controller, resolveHarness } = await createDurableController(pool);
  for (const driver of [
    createTestConfigurationDriver({ id: `configuration-unreadable-${randomUUID()}` }),
    createTestSecretDriver(),
  ]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }

  const namespace = await controller.createNamespace(principalId, {
    name: `unreadable-history-${randomUUID()}`,
  });
  await controller.handleNamespaceLifecycle(principalId, namespace.id, "ready");
  const configuration = await controller.createConfiguration(principalId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const agent = await controller.createAgent(principalId, {
    namespaceId: namespace.id,
    name: `unreadable-history-agent-${randomUUID()}`,
    configurationId: configuration.id,
  });
  const harnessSecret = await controller.createSecret(principalId, {
    namespaceId: namespace.id,
    name: `unreadable-history-harness-${randomUUID()}`,
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
  const deploy = () =>
    controller.deployAgent(
      principalId,
      { namespaceId: namespace.id, agentId: agent.id },
      resolveHarness,
    );
  const first = await deploy();
  assert.equal(first.revision, 1);

  // Revisions are immutable to the application role, so seed the unreadable one as a copy
  // carrying a previously accepted plugin approval enum the current contract no longer decodes.
  await pool.query(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
     SELECT $1, namespace_id, agent_id, 2, backend_id,
            jsonb_set(admitted_spec, '{plugins}', $2::jsonb, true), admitted_at
     FROM occ.agent_revisions WHERE id = $3`,
    [
      `rev_${randomUUID()}`,
      JSON.stringify({
        driver: { id: "occ-plugin", implementation: "occ/openclaw-plugin" },
        plugins: { "occ-plugin:diffs": { enabled: true, toolDefaults: { approval: "prompt" } } },
      }),
      first.id,
    ],
  );
  const counts = () =>
    pool
      .query<{ revisions: number; work: number }>(
        `SELECT (SELECT count(*)::integer FROM occ.agent_revisions WHERE agent_id = $1) AS revisions,
                (SELECT count(*)::integer FROM occ.controller_work WHERE agent_id = $1) AS work`,
        [agent.id],
      )
      .then(({ rows }) => {
        const result = rows[0];
        assert.ok(result);
        return result;
      });
  const before = await counts();
  assert.equal(before.revisions, 2);
  assert.ok(before.work > 0, "the first deployment queued its work");

  // The worker decodes every earlier revision to stop or retire it, so admission must too.
  const refusal = await deploy().then(
    () => assert.fail("deployment was admitted"),
    (error: unknown) => error,
  );
  assert.ok(refusal instanceof PersistedStateInvalidError);
  assert.ok("field" in refusal);
  assert.equal(refusal.name, "DependencyUnavailableError");
  assert.equal(refusal.field, "plugins");
  assert.equal(refusal.message, "Persisted AgentRevision plugin state is invalid.");
  assert.equal(requestFailure(refusal).status, 503);
  assert.deepEqual(await counts(), before);
}

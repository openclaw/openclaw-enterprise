import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type { TestContext } from "node:test";
import type { PoolClient } from "pg";

import type { PermissionAction } from "../../packages/contracts/src/index.ts";
import type { PlatformReadView } from "../../packages/occ/src/index.ts";
import {
  databaseUrl,
  verifyPlatformStateStoreContract,
} from "../helpers/postgres-platform-state.ts";

export async function verifyPostgresStateConformance(context: TestContext) {
  const [{ DatabaseError, Pool }, { PostgresPlatformState }, { NativeIAMDriver }] =
    await Promise.all([
      import("pg"),
      import("../../packages/occ/src/state/postgres-state.ts"),
      import("../../packages/iam/src/index.ts"),
    ]);
  const pool = new Pool({ connectionString: databaseUrl });
  context.after(() => pool.end());
  // The database is authoritative for admitted credential-source login modes. PAT
  // revisions must persist; unknown modes and secret bytes must still fail validation.
  const sourceSnapshot = {
    method: "credential_source",
    sourceId: `cs_${randomUUID()}`,
    credentialGatewayId: "credential-gateway",
    sourceType: "codex-pat",
    loginMode: "codex_pat",
  };
  for (const [snapshot, expected] of [
    [sourceSnapshot, true],
    [{ ...sourceSnapshot, loginMode: "unsupported" }, false],
    [{ ...sourceSnapshot, accessToken: "synthetic-forbidden-value" }, false],
  ] as const) {
    const result = await pool.query<Record<string, unknown>>(
      "SELECT occ.harness_auth_is_valid($1::jsonb, $2, true) AS valid",
      [JSON.stringify(snapshot), `ns_${randomUUID()}`],
    );
    assert.equal(result.rows[0]?.valid, expected);
  }
  const state = new PostgresPlatformState(pool);
  const installation = await state.loadInstallation();
  assert.ok(installation, "the prior API integration must bootstrap the sole Installation");

  const fixture = await verifyPlatformStateStoreContract(state, { installation });
  const durable = await pool.query(
    `SELECT
     (SELECT count(*)::integer FROM occ.agent_revisions WHERE id = $1) AS revisions,
     (SELECT count(*)::integer FROM occ.audit_events WHERE id = $2) AS audit_events,
     (SELECT count(*)::integer FROM occ.controller_work WHERE revision_id = $1) AS operations,
     (SELECT count(*)::integer FROM occ.namespaces
       WHERE id = $3 AND deleted_at IS NOT NULL) AS tombstones`,
    [fixture.revision.id, fixture.audit.id, fixture.lifecycleNamespace.id],
  );
  assert.deepEqual(durable.rows[0], {
    revisions: 1,
    audit_events: 1,
    operations: 1,
    tombstones: 1,
  });

  // The limited application role can insert Agents, so the database must reject
  // caller-selected running intent instead of relying on repository defaults.
  await assert.rejects(
    pool.query(
      `INSERT INTO occ.agents
         (id, namespace_id, name, configuration_id, backend_id, execution_mode,
          service_principal_id, desired_runtime_state, created_at)
       SELECT $1, namespace_id, $2, configuration_id, backend_id, execution_mode,
              $3, 'running', clock_timestamp()
       FROM occ.agents WHERE namespace_id = $4 AND id = $5`,
      [
        `agt_${randomUUID()}`,
        `Invalid running Agent ${randomUUID()}`,
        `service-agent-${randomUUID()}`,
        fixture.agent.namespaceId,
        fixture.agent.id,
      ],
    ),
    (error) =>
      error instanceof DatabaseError &&
      error.code === "23514" &&
      error.constraint === "agent_initial_runtime_state_is_valid",
  );

  const durableAccount = await pool.query(
    "SELECT id, namespace_id, name, credential " + "FROM occ.service_accounts WHERE id = $1",
    [fixture.serviceAccount.id],
  );
  assert.deepEqual(durableAccount.rows, [
    {
      id: fixture.serviceAccount.id,
      namespace_id: fixture.serviceAccountNamespace.id,
      name: fixture.serviceAccount.name,
      credential: fixture.serviceAccount.credential,
    },
  ]);

  // Prove exact source scope at the actual SQL boundary, independent of OCC admission.
  for (const [binding, code, constraint] of [
    [
      {
        method: "api_key",
        source: {
          ...fixture.agent.harnessAuth.source,
          namespaceId: fixture.serviceAccountNamespace.id,
        },
      },
      "23514",
      "agents_harness_auth_valid",
    ],
    [
      {
        method: "api_key",
        source: { kind: "secret", namespaceId: fixture.namespace.id, id: `sec_${randomUUID()}` },
      },
      "23503",
      "agents_harness_auth_secret_owner",
    ],
    [
      {
        method: "codex_pat",
        source: {
          kind: "service_account",
          namespaceId: fixture.namespace.id,
          id: fixture.serviceAccount.id,
        },
      },
      "23503",
      "agents_harness_auth_service_account_owner",
    ],
    [
      { ...fixture.agent.harnessAuth, value: "sentinel-not-a-reference" },
      "23514",
      "agents_harness_auth_valid",
    ],
    ["api_key", "23514", "agents_harness_auth_valid"],
  ] as const) {
    await assert.rejects(
      pool.query("UPDATE occ.agents SET harness_auth = $1::jsonb WHERE id = $2", [
        JSON.stringify(binding),
        fixture.agent.id,
      ]),
      (error) =>
        error instanceof DatabaseError && error.code === code && error.constraint === constraint,
    );
  }
  const reloadedAgent = await state.read((view) =>
    view.agents.findAgent(fixture.namespace.id, fixture.agent.id),
  );
  assert.ok(reloadedAgent);
  assert.deepEqual(reloadedAgent.harnessAuth, fixture.agent.harnessAuth);
  for (const [offset, invalid] of [
    null,
    "api_key",
    false,
    2,
    {},
    { ...fixture.revision.harnessAuth, secretDriverId: "" },
    { ...fixture.revision.harnessAuth, secretValue: "sentinel-not-a-reference" },
  ].entries()) {
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
      (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
      SELECT $1, namespace_id, agent_id, $2, backend_id,
        jsonb_set(admitted_spec, '{harness_auth}', $3::jsonb), admitted_at
      FROM occ.agent_revisions WHERE id = $4`,
        [`rev_${randomUUID()}`, 1000 + offset, JSON.stringify(invalid), fixture.revision.id],
      ),
      (error) =>
        error instanceof DatabaseError &&
        error.code === "23514" &&
        error.constraint === "agent_revisions_admitted_snapshot",
    );
  }

  const sandboxDriverId = "openshell-sandbox";
  const sandboxRevision = await state.transact((unit) =>
    unit.revisions.createRevision({
      ...fixture.revision,
      id: `rev_${randomUUID()}`,
      revision: fixture.revision.revision + 1,
      sandboxDriverId,
    }),
  );
  const reloadedSandboxRevision = await state.read((unit) =>
    unit.revisions.findRevision(
      sandboxRevision.namespaceId,
      sandboxRevision.agentId,
      sandboxRevision.id,
    ),
  );
  assert.ok(reloadedSandboxRevision);
  assert.equal(reloadedSandboxRevision.sandboxDriverId, sandboxDriverId);
  assert.equal(Object.isFrozen(reloadedSandboxRevision), true);
  const durableSandboxRevision = await pool.query<Record<string, unknown>>(
    "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
    [sandboxRevision.id],
  );
  const admittedSpec = durableSandboxRevision.rows[0]?.admitted_spec;
  assert.ok(
    typeof admittedSpec === "object" &&
      admittedSpec !== null &&
      "sandbox_driver_id" in admittedSpec,
  );
  assert.equal(admittedSpec.sandbox_driver_id, sandboxDriverId);
  assert.equal(Object.hasOwn(admittedSpec, "sandbox"), false);

  // The database accepts only a nonempty SandboxDriver identity, not descriptors or blank values.
  for (const [offset, invalid] of [null, "", " ", 1, { id: sandboxDriverId }].entries()) {
    await assert.rejects(
      pool.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, $3,
                jsonb_set(admitted_spec, '{sandbox_driver_id}', $1::jsonb, true), admitted_at
         FROM occ.agent_revisions WHERE id = $4`,
        [
          JSON.stringify(invalid),
          `rev_${randomUUID()}`,
          sandboxRevision.revision + 100 + offset,
          sandboxRevision.id,
        ],
      ),
      (error) =>
        error instanceof DatabaseError &&
        error.code === "23514" &&
        error.constraint === "agent_revisions_admitted_snapshot",
    );
  }

  // The database, not adapter-only validation, rejects malformed or cross-scope credential JSON.
  for (const invalid of [
    null,
    {},
    { kind: "api_key", secretRef: { name: "valid-source" } },
    { kind: "bearer", secretRef: { name: "valid-source", key: "api-key" } },
    { kind: "api_key", secretRef: { name: "INVALID", key: "api-key" } },
    ...["../token", ".", ".."].map((key) => ({
      kind: "api_key",
      secretRef: { name: "valid-source", key },
    })),
    {
      kind: "api_key",
      secretRef: { name: "valid-source", key: "api-key", namespace: "another-tenant" },
    },
    {
      kind: "api_key",
      secretRef: { name: "valid-source", key: "api-key" },
      token: "plaintext-must-not-persist",
    },
  ]) {
    await assert.rejects(
      pool.query("UPDATE occ.service_accounts SET credential = $1::jsonb WHERE id = $2", [
        JSON.stringify(invalid),
        fixture.serviceAccount.id,
      ]),
      (error) =>
        error instanceof DatabaseError &&
        error.code === "23514" &&
        error.constraint === "service_accounts_credential_valid",
    );
  }

  const accountPrivileges = await pool.query(
    "SELECT " +
      "has_table_privilege(current_user, 'occ.service_accounts', 'SELECT') AS can_read, " +
      "has_table_privilege(current_user, 'occ.service_accounts', 'INSERT') AS can_insert, " +
      "has_table_privilege(current_user, 'occ.service_accounts', 'DELETE') AS can_delete, " +
      "has_column_privilege(current_user, 'occ.service_accounts', 'credential', 'UPDATE') " +
      "AS can_update_credential, " +
      "has_column_privilege(current_user, 'occ.service_accounts', 'id', 'UPDATE') " +
      "AS can_update_identity, " +
      "has_column_privilege(current_user, 'occ.service_accounts', 'namespace_id', 'UPDATE') " +
      "AS can_update_owner",
  );
  assert.deepEqual(accountPrivileges.rows, [
    {
      can_read: true,
      can_insert: true,
      can_delete: true,
      can_update_credential: true,
      can_update_identity: false,
      can_update_owner: false,
    },
  ]);

  const principalId = `principal-${randomUUID()}`;
  const groupId = `group-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  const sharedRoleId = `role-${randomUUID()}`;
  const bindingId = `binding-${randomUUID()}`;
  const agentBindingId = `binding-${randomUUID()}`;
  const restrictionId = `restriction-${randomUUID()}`;
  const accountRoleId = "role-" + randomUUID();
  const accountBindingId = "binding-" + randomUUID();
  const accountCreationBindingId = "binding-" + randomUUID();
  const accountRestrictionId = "restriction-" + randomUUID();
  const platformActions: PermissionAction[] = [
    "create",
    "read",
    "update",
    "delete",
    "deploy",
    "operate",
    "administer",
  ];
  const siblingId = `agt_${randomUUID()}`;
  const sibling = await state.transact((unit) =>
    unit.agents.createAgent({
      id: siblingId,
      namespaceId: fixture.namespace.id,
      name: `Sibling ${randomUUID()}`,
      configurationId: fixture.configuration.id,
      backendId: null,
      harnessAuth: null,
      executionMode: "embedded",
      desiredRuntimeState: "stopped",
      status: "active",
      servicePrincipalId: `service-agent-${siblingId}`,
      createdAt: new Date().toISOString(),
    }),
  );
  await state.seedNativeIAM({
    identities: [
      {
        id: principalId,
        kind: "principal",
        issuer: `postgres-platform-${randomUUID()}`,
        subject: `principal-${randomUUID()}`,
      },
    ],
    groups: [
      {
        id: groupId,
        namespaceId: fixture.namespace.id,
        name: `Operators ${randomUUID()}`,
      },
    ],
    memberships: [
      {
        namespaceId: fixture.namespace.id,
        groupId,
        principalId,
      },
    ],
    roles: [
      {
        id: roleId,
        namespaceId: fixture.namespace.id,
        name: `Reader ${randomUUID()}`,
        permissions: [{ action: "read", resourceKind: "agent" }],
      },
      {
        id: sharedRoleId,
        namespaceId: fixture.namespace.id,
        name: `Agent operators ${randomUUID()}`,
        permissions: platformActions.map((action) => ({ action, resourceKind: "agent" })),
      },
      {
        id: accountRoleId,
        namespaceId: fixture.serviceAccountNamespace.id,
        name: "Exact account access " + randomUUID(),
        permissions: [
          { action: "create", resourceKind: "service_account" },
          { action: "read", resourceKind: "service_account" },
          { action: "update", resourceKind: "service_account" },
        ],
      },
    ],
    bindings: [
      {
        id: bindingId,
        namespaceId: fixture.namespace.id,
        subjectKind: "group",
        subjectId: groupId,
        roleId,
        resourceKind: "agent",
        resourceId: fixture.agent.id,
      },
      {
        id: `binding-${randomUUID()}`,
        namespaceId: fixture.namespace.id,
        subjectKind: "identity",
        subjectId: principalId,
        roleId: sharedRoleId,
      },
      {
        id: accountBindingId,
        namespaceId: fixture.serviceAccountNamespace.id,
        subjectKind: "identity",
        subjectId: principalId,
        roleId: accountRoleId,
        resourceKind: "service_account",
        resourceId: fixture.serviceAccount.id,
      },
      {
        id: accountCreationBindingId,
        namespaceId: fixture.serviceAccountNamespace.id,
        subjectKind: "identity",
        subjectId: principalId,
        roleId: accountRoleId,
        resourceKind: "service_account",
        resourceId: fixture.serviceAccountNamespace.id,
      },
    ],
    restrictions: [
      {
        id: restrictionId,
        namespaceId: fixture.namespace.id,
        action: "deploy",
        resourceKind: "agent",
        resourceId: fixture.agent.id,
        effect: "deny",
      },
      {
        id: accountRestrictionId,
        namespaceId: fixture.serviceAccountNamespace.id,
        action: "update",
        resourceKind: "service_account",
        resourceId: fixture.serviceAccount.id,
        effect: "deny",
      },
    ],
  });
  await pool.query(
    `INSERT INTO occ.iam_access_bindings
     (id, namespace_id, identity_subject_id, role_id)
     VALUES ($1, $2, $3, $4)`,
    [agentBindingId, fixture.namespace.id, fixture.agent.servicePrincipalId, sharedRoleId],
  );

  const reopened = new PostgresPlatformState(pool);
  await reopened.read(async (view) => {
    const revision = await view.revisions.findRevision(
      fixture.namespace.id,
      fixture.agent.id,
      fixture.revision.id,
    );
    assert.deepEqual(revision, fixture.revision);
  });
  const reloadedIAM = await reopened.loadNativeIAMState(installation.id);
  assert.deepEqual(
    reloadedIAM.identities.find(({ id }) => id === fixture.agent.servicePrincipalId),
    {
      id: fixture.agent.servicePrincipalId,
      kind: "service_principal",
      namespaceId: fixture.namespace.id,
      agentId: fixture.agent.id,
    },
    "The Agent service principal and its exact owner survive a PostgreSQL restart.",
  );
  assert.ok(reloadedIAM.identities.every((identity) => !Object.hasOwn(identity, "installationId")));
  assert.ok(reloadedIAM.groups.some(({ id }) => id === groupId));
  assert.ok(
    reloadedIAM.memberships.some(
      ({ groupId: storedGroupId, principalId: storedPrincipalId }) =>
        storedGroupId === groupId && storedPrincipalId === principalId,
    ),
  );
  assert.ok(
    reloadedIAM.bindings.some(({ id, subjectKind }) => id === bindingId && subjectKind === "group"),
  );
  assert.ok(
    reloadedIAM.bindings.some(
      ({ id, subjectId }) =>
        id === agentBindingId && subjectId === fixture.agent.servicePrincipalId,
    ),
  );
  assert.ok(reloadedIAM.restrictions.some(({ id }) => id === restrictionId));
  assert.ok(
    reloadedIAM.bindings.some(
      ({ id, resourceKind, resourceId }) =>
        id === accountBindingId &&
        resourceKind === "service_account" &&
        resourceId === fixture.serviceAccount.id,
    ),
  );
  assert.ok(
    reloadedIAM.bindings.some(
      ({ id, resourceKind, resourceId }) =>
        id === accountCreationBindingId &&
        resourceKind === "service_account" &&
        resourceId === fixture.serviceAccountNamespace.id,
    ),
  );
  assert.ok(
    reloadedIAM.restrictions.some(
      ({ id, resourceKind }) => id === accountRestrictionId && resourceKind === "service_account",
    ),
  );

  const iam = new NativeIAMDriver(reopened);
  assert.equal(
    (
      await iam.authorize({
        principalId,
        action: "create",
        resource: {
          kind: "service_account",
          id: fixture.serviceAccountNamespace.id,
          namespaceId: fixture.serviceAccountNamespace.id,
        },
      })
    ).allowed,
    true,
    "An exact persisted collection binding authorizes ServiceAccount creation.",
  );
  assert.equal(
    (
      await iam.authorize({
        principalId,
        action: "read",
        resource: {
          kind: "service_account",
          id: fixture.serviceAccount.id,
          namespaceId: fixture.serviceAccountNamespace.id,
        },
      })
    ).allowed,
    true,
    "An exact persisted account binding grants only the named account.",
  );
  assert.equal(
    (
      await iam.authorize({
        principalId,
        action: "update",
        resource: {
          kind: "service_account",
          id: fixture.serviceAccount.id,
          namespaceId: fixture.serviceAccountNamespace.id,
        },
      })
    ).allowed,
    false,
    "An exact persisted account Restriction overrides its granted update.",
  );
  for (const identityId of [principalId, fixture.agent.servicePrincipalId]) {
    for (const action of platformActions) {
      const ownAgentDecision = await iam.authorize({
        principalId: identityId,
        action,
        resource: {
          kind: "agent",
          id: fixture.agent.id,
          namespaceId: fixture.namespace.id,
        },
      });
      assert.equal(
        ownAgentDecision.allowed,
        action !== "deploy",
        `${identityId} should receive its granted ${action} action unless an exact Restriction denies it`,
      );

      const siblingDecision = await iam.authorize({
        principalId: identityId,
        action,
        resource: { kind: "agent", id: sibling.id, namespaceId: fixture.namespace.id },
      });
      assert.equal(
        siblingDecision.allowed,
        true,
        `${identityId} should receive its granted ${action} action for a same-Namespace sibling`,
      );
    }

    const foreignNamespaceDecision = await iam.authorize({
      principalId: identityId,
      action: "read",
      resource: {
        kind: "agent",
        id: `agt_${randomUUID()}`,
        namespaceId: `ns_${randomUUID()}`,
      },
    });
    assert.equal(foreignNamespaceDecision.allowed, false);
  }

  // Finding 1323 (bughunt-69): 64 revisions and 64 Presets of about 0.9 MB each. Full lists
  // decoded every document (8-10 s on two CPUs); summaries read none into the API, and a
  // summary page opens each row's snapshot once in the database for three top-level fields.
  const large = JSON.stringify(
    Object.fromEntries(Array.from({ length: 70_000 }, (_, i) => [`k${i}`, "v"])),
  );
  await pool.query(
    `INSERT INTO occ.agent_revisions
       (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
     SELECT 'rev_' || gen_random_uuid(), namespace_id, agent_id, 5000 + n, backend_id,
            jsonb_set(admitted_spec, '{draft_spec,env}', jsonb_build_object('vars', $2::jsonb)),
            admitted_at
     FROM occ.agent_revisions, generate_series(1, 64) AS n WHERE id = $1`,
    [fixture.revision.id, large],
  );
  await pool.query(
    `INSERT INTO occ.presets (id, namespace_id, name, template, created_at)
     SELECT 'pre_' || gen_random_uuid(), $1, 'Heavy preset ' || n,
            jsonb_build_object('configuration',
              jsonb_build_object('values', jsonb_build_object('env', $2::jsonb))),
            clock_timestamp()
     FROM generate_series(1, 64) AS n`,
    [fixture.namespace.id, large],
  );
  // The bound counts the bytes the database sends for one read, which a slow or busy runner
  // does not change: a list that reads the full documents receives about 64 x 0.9 MB, a
  // summary list a few hundred bytes a row. Every pool client this read checks out is counted.
  const received = async <T>(read: (view: PlatformReadView) => Promise<T>) => {
    const sockets = new Map<Socket, number>();
    const acquired = (client: PoolClient) => {
      // pg exposes the active stream at runtime, including its byte counter.
      assert.ok("connection" in client, "expected an acquired pg client connection");
      const connection = client.connection;
      assert.ok(typeof connection === "object" && connection !== null && "stream" in connection);
      const socket = connection.stream;
      assert.ok(socket instanceof Socket, "expected the pg connection to use a Node socket");
      if (!sockets.has(socket)) {
        sockets.set(socket, socket.bytesRead);
      }
    };
    pool.on("acquire", acquired);
    try {
      const started = performance.now();
      const result = await state.read(read);
      const ms = Math.round(performance.now() - started);
      let bytes = 0;
      for (const [socket, before] of sockets) {
        bytes += socket.bytesRead - before;
      }
      return { result, bytes, ms };
    } finally {
      pool.off("acquire", acquired);
    }
  };
  const revisionPage = await received((view) =>
    view.revisions.pageRevisionSummaries(fixture.namespace.id, fixture.agent.id, {
      limit: 100,
    }),
  );
  const heavyRevisions = revisionPage.result.revisions.filter(({ revision }) => revision > 5000);
  assert.deepEqual(
    heavyRevisions.slice(0, 2).map(({ revision }) => revision),
    [5064, 5063],
  );
  assert.equal(heavyRevisions.length, 64);
  assert.equal(heavyRevisions[0]?.harness.mode, fixture.revision.harness.mode);
  const presetSummaries = await received((view) =>
    view.presets.listPresetSummaries(fixture.namespace.id),
  );
  assert.ok(presetSummaries.result.length >= 64);
  const measured = (read: { bytes: number; ms: number }) => `${read.bytes} bytes in ${read.ms} ms`;
  context.diagnostic(
    `64 x 0.9 MB: revision summary page ${measured(revisionPage)}, Preset summaries ${measured(presetSummaries)}`,
  );
  // Less than one stored document: neither list may carry a single snapshot or template.
  // PostgreSQL's jsonb text is longer than the compact `large`, so one document exceeds this.
  assert.ok(
    revisionPage.bytes > 0 && revisionPage.bytes < large.length,
    `revision summary page received ${measured(revisionPage)}`,
  );
  assert.ok(
    presetSummaries.bytes > 0 && presetSummaries.bytes < large.length,
    `Preset summaries received ${measured(presetSummaries)}`,
  );
  // Later starts in this database seed default Presets, which reads full templates.
  await pool.query(
    "DELETE FROM occ.presets WHERE namespace_id = $1 AND name LIKE 'Heavy preset %'",
    [fixture.namespace.id],
  );
}

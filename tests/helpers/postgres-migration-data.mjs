import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { catalogDigest, migrationCatalog } from "../../scripts/migration-catalog.mjs";
import { assertCredentialSchemaPrivileges } from "./credential-source-owner-upgrade.ts";
import { historyReceipts } from "./postgres-migration-history.mjs";

const canonicalManifest = new URL("../../migrations/meta/_canonical-history.json", import.meta.url);
const legacyExecutionAdmission = { version: 2, mode: "unprotected" };

/**
 * @param {{app: import("pg").Client, migrator: import("pg").Client}} db
 * @param {Awaited<ReturnType<typeof historyReceipts>>} previous
 */
export async function assertCompletedHistory(db, previous = []) {
  const manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  const receipts = await historyReceipts(db.migrator);
  assert.equal(receipts.length, manifest.entries.length);
  await assertCredentialSchemaPrivileges(db.app);
  assert.deepEqual(receipts.slice(0, previous.length), previous);
  const providerEntries = manifest.compatibleLineages.providerCompleted.entries;
  const providerLineage = [...providerEntries, ...manifest.entries.slice(providerEntries.length)];
  const expectedEntries =
    previous.length >= providerEntries.length && receiptsMatchEntries(previous, providerLineage)
      ? providerLineage
      : manifest.entries;
  assert.deepEqual(
    receipts.map(({ hash, created_at }) => [hash, Number(created_at)]),
    expectedEntries.map(({ sha256, when }) => [sha256, when]),
  );
  assert.equal(catalogDigest(await migrationCatalog(db.migrator)), manifest.catalogs.completed);
  // Pre-existing Agents receive one empty owned policy and keep delegated editing disabled.
  const policies = await db.app.query(`SELECT bool_and(
    NOT agent.sandbox_policy_editing AND policy.namespace_id=agent.namespace_id
    AND policy.version=1 AND policy.document->'additions'='[]'::jsonb
  ) AS valid, count(policy.id)::integer AS policies, count(agent.id)::integer AS agents
  FROM occ.agents agent LEFT JOIN occ.sandbox_policies policy ON policy.agent_id=agent.id`);
  assert.notEqual(policies.rows[0].valid, false);
  assert.equal(policies.rows[0].policies, policies.rows[0].agents);

  assert.equal(
    (
      await db.app.query(
        "SELECT count(*)::integer AS count FROM occ.agents WHERE repository_access IS NOT NULL",
      )
    ).rows[0].count,
    0,
    "migration must not invent inheritance intent for existing Agent bindings",
  );
  assert.equal(
    catalogDigest(await migrationCatalog(db.migrator, "drizzle")),
    manifest.ledgerCatalogs.completed,
  );
  assert.deepEqual(
    (
      await db.migrator.query(`SELECT p.oid::pg_catalog.regprocedure::text AS identity,
      pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.proconfig,
      pg_catalog.has_function_privilege('occ_app',p.oid,'EXECUTE') AS app_execute,
      pg_catalog.has_function_privilege('public',p.oid,'EXECUTE') AS public_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='occ' AND p.prosecdef ORDER BY identity`)
    ).rows,
    [
      ["occ.check_connection_registration_scope()", false, "search_path=pg_catalog, pg_temp"],
      // The app records a standing execution; only the Agent lifecycle trigger can close it.
      ["occ.close_repository_standing_execution()", false],
      ["occ.create_agent_sandbox_policy()", false, "search_path=pg_catalog, occ"],
      ["occ.finalize_agent_deletion(text,text,text,uuid)", true],
      ["occ.hold_account_administration_policy(text)", true],
      ["occ.record_repository_standing_execution(text,text,text,text,text)", true],
      ["occ.remove_sandbox_policy_access()", false, "search_path=pg_catalog, occ"],
      ["occ.retry_failed_agent_deletion(text,text,text,text)", true],
      ["occ.retry_failed_namespace_deletion(text,text,text)", true],
      // The Agent trigger keeps the credential-source join table exact; occ_app cannot write it.
      ["occ.sync_agent_credential_sources()", false],
      ["occ.validate_access_binding_scope()", false],
      ["occ.validate_group_membership()", false],
      ["occ.validate_restriction_scope()", false],
    ].map(([identity, app_execute, searchPath = "search_path=pg_catalog, occ, pg_temp"]) => ({
      identity,
      owner: "occ_migrator",
      proconfig: [searchPath],
      app_execute,
      public_execute: false,
    })),
  );
}

function receiptsMatchEntries(receipts, entries) {
  return receipts.every(
    (receipt, index) =>
      entries[index] !== undefined &&
      receipt.hash === entries[index].sha256 &&
      Number(receipt.created_at) === entries[index].when,
  );
}

export async function seedCanonicalAgent(
  db,
  namespace,
  { computeAdmission, executionAdmission, harnessSettings },
) {
  const configuration = `cfg_${randomUUID()}`;
  const agent = `agt_${randomUUID()}`;
  const revision = `rev_${randomUUID()}`;
  const servicePrincipal = `service-agent-${agent}`;
  await db.app.query(
    "INSERT INTO occ.namespaces(id,name,status,created_at) VALUES($1,$2,'ready',now())",
    [namespace, `migration-${randomUUID()}`],
  );
  // A real admitted snapshot exercises the repository migration's replacement
  // constraint. Agent and ServicePrincipal ownership is checked at commit.
  await db.app.query("BEGIN");
  try {
    await db.app.query(
      "INSERT INTO occ.configurations(id,namespace_id,kind,generation,created_at) VALUES($1,$2,'agent',1,now())",
      [configuration, namespace],
    );
    await db.app.query(
      "INSERT INTO occ.iam_identities(id,namespace_id,agent_id,kind) VALUES($1,$2,$3,'service_principal')",
      [servicePrincipal, namespace, agent],
    );
    await db.app.query(
      "INSERT INTO occ.agents(id,namespace_id,name,configuration_id,backend_id,execution_mode,service_principal_id,created_at) VALUES($1,$2,$3,$4,NULL,'dedicated',$5,now())",
      [agent, namespace, `agent-${randomUUID()}`, configuration, servicePrincipal],
    );
    await db.app.query(
      "INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at) VALUES($1,$2,$3,1,$4,NULL,now())",
      [
        revision,
        namespace,
        agent,
        {
          configuration_id: configuration,
          configuration_kind: "agent",
          configuration_generation: 1,
          draft_spec: {},
          harness: {
            id: "codex",
            version: "1.0.0",
            mode: "dedicated",
            ...(harnessSettings ? { overrides: {}, configuration: {} } : {}),
          },
          harness_auth: { method: "runtime" },
          ...(executionAdmission
            ? { execution_admission: { version: 2, mode: "unprotected" } }
            : {}),
          compute: {
            id: "kubernetes",
            implementation: "test",
            ...(computeAdmission ? { admission: `public-github-read:v1:${"a".repeat(64)}` } : {}),
          },
        },
      ],
    );
    await db.app.query("COMMIT");
  } catch (error) {
    await db.app.query("ROLLBACK");
    throw error;
  }
  return { agent, revision };
}

/** @param {{app: import("pg").Client}} db */
export async function seedCanonicalData(
  db,
  {
    preset = false,
    computeAdmission = false,
    executionAdmission = false,
    harnessSettings = false,
  } = {},
) {
  const installation = `ins_${randomUUID()}`;
  const namespace = `ns_${randomUUID()}`;
  await db.app.query(
    "INSERT INTO occ.installation(id,name,created_at) VALUES($1,'Migration fixture',now())",
    [installation],
  );
  await seedCanonicalAgent(db, namespace, {
    computeAdmission,
    executionAdmission,
    harnessSettings,
  });
  await db.app.query(
    `INSERT INTO occ.controller_work(idempotency_key,namespace_id,namespace_target,actor_id,state,available_at,completed_at,reason_code,created_at,updated_at)
    VALUES($1,$2,'ready','migration-fixture','succeeded',now(),now(),'NAMESPACE_READY',now(),now())`,
    [`work-${randomUUID()}`, namespace],
  );
  await db.app.query(
    `INSERT INTO occ.audit_events(id,occurred_at,kind,actor_id,action,namespace_id,resource_kind,resource_id,outcome,details)
    VALUES($1,now(),'mutation','migration-fixture','reconcile',$2,'namespace',$2,'success','{"reasonCode":"NAMESPACE_READY"}')`,
    [`aud_${randomUUID()}`, namespace],
  );
  // Stored human sign-in state: a password method, an external method holding
  // provider tokens, and a live session. Later auth migrations alter these tables.
  const user = `usr_${randomUUID()}`;
  await db.app.query(
    `INSERT INTO occ."user"(id,name,email,email_verified,created_at,updated_at)
    VALUES($1,'Migration fixture',$2,true,now(),now())`,
    [user, `migration-${randomUUID()}@example.test`],
  );
  await db.app.query(
    `INSERT INTO occ.account(id,account_id,provider_id,user_id,password,created_at,updated_at)
    VALUES($1,$2,'credential',$2,'fixture-password-hash',now(),now())`,
    [`acc_${randomUUID()}`, user],
  );
  await db.app.query(
    `INSERT INTO occ.account(id,account_id,provider_id,user_id,access_token,refresh_token,id_token,
      access_token_expires_at,refresh_token_expires_at,scope,created_at,updated_at)
    VALUES($1,$2,'oidc',$3,'fixture-access','fixture-refresh','fixture-id',
      now()+interval '1 hour',now()+interval '1 day','openid email',now(),now())`,
    [`acc_${randomUUID()}`, `subject-${randomUUID()}`, user],
  );
  await db.app.query(
    `INSERT INTO occ.session(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id)
    VALUES($1,now()+interval '1 day',$2,now(),now(),'127.0.0.1','migration-fixture',$3)`,
    [`ses_${randomUUID()}`, `token-${randomUUID()}`, user],
  );
  if (preset) {
    await db.app.query(
      "INSERT INTO occ.presets(id,namespace_id,name,template,created_at) VALUES($1,$2,'Migration preset',$3,now())",
      [
        `pre_${randomUUID()}`,
        namespace,
        {
          agent: { name: "Preset Agent", executionMode: "dedicated" },
          configuration: { values: {} },
        },
      ],
    );
  }
  return namespace;
}

// Every pre-existing Agent must stay readable through the application adapter after
// the upgrade: createRevision decodes the earlier revisions, and the worker's reconcile,
// stop, retire and delete paths all go through findRevision or listRevisions.
/** @param {{app: import("pg").Client, migrator: import("pg").Client, migrationUrl: string}} db */
export async function assertUpgradedRevisionReadable(db) {
  const { PostgresPlatformState } = await import("../../packages/occ/src/state/postgres-state.ts");
  const application = new URL(db.migrationUrl);
  application.username = "occ_app";
  application.password = "occ-app-local";
  const seeded = (await db.app.query("SELECT namespace_id, agent_id, id FROM occ.agent_revisions"))
    .rows;
  assert.equal(seeded.length, 1);
  const { namespace_id: namespaceId, agent_id: agentId, id } = seeded[0];
  const pool = new pg.Pool({ connectionString: application.toString(), max: 1 });
  try {
    const state = new PostgresPlatformState(pool);
    const found = await state.read((view) => view.revisions.findRevision(namespaceId, agentId, id));
    assert.equal(found?.id, id, "findRevision must decode the pre-upgrade revision");
    assert.deepEqual(found.executionAdmission, legacyExecutionAdmission);
    assert.equal(found.egressPlan, undefined);
    assert.equal(Object.hasOwn(found, "networkEgressMode"), false);
    const listed = await state.read((view) => view.revisions.listRevisions(namespaceId, agentId));
    assert.deepEqual(
      listed.map((revision) => [revision.id, revision.executionAdmission]),
      [[id, legacyExecutionAdmission]],
      "listRevisions must decode the pre-upgrade revision",
    );
  } finally {
    await pool.end();
  }
  // The decision is now proven for every stored row, not only for new writers.
  assert.deepEqual(
    (
      await db.migrator.query(
        `SELECT convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid='occ.agent_revisions'::pg_catalog.regclass AND conname='agent_revisions_execution_admission'`,
      )
    ).rows,
    [{ convalidated: true }],
  );
  // The recorded decision stays immutable: the migrator's row rewrite is closed again and
  // the application role never held UPDATE, so an unprotected revision cannot later claim
  // protection or an egress plan.
  await assert.rejects(
    db.migrator.query(
      `UPDATE occ.agent_revisions
       SET admitted_spec = admitted_spec || '{"execution_admission":{"version":2,"mode":"protected"}}'::jsonb
       WHERE id=$1`,
      [id],
    ),
    (error) => error.code === "55000",
  );
  assert.equal(
    (
      await db.app.query(
        "SELECT has_table_privilege(current_user,'occ.agent_revisions','UPDATE') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );
  // New rows still fail closed: no snapshot may omit its decision, and a decision that
  // claims protection without the protected plan and reader marker is inconsistent.
  const revisionId = `rev_${randomUUID()}`;
  // A new writer supplies the current Harness shape while the old row stays unchanged.
  const currentSpec = `jsonb_set(admitted_spec, '{harness}', (admitted_spec->'harness') || '{"overrides":{},"configuration":{}}'::jsonb)`;
  const insertRevision = (rewrite, ...parameters) =>
    db.app.query(
      `INSERT INTO occ.agent_revisions(id,namespace_id,agent_id,revision_number,admitted_spec,backend_id,admitted_at)
       SELECT $1, namespace_id, agent_id, 2, ${rewrite}, NULL, now() FROM occ.agent_revisions WHERE id=$2`,
      [revisionId, id, ...parameters],
    );
  const invalidAdmission = (error) =>
    error.code === "23514" && error.constraint === "agent_revisions_execution_admission";
  for (const rewrite of [
    `${currentSpec} - 'execution_admission'`,
    `${currentSpec} || '{"execution_admission":{"version":2,"mode":"protected"}}'::jsonb`,
  ]) {
    await assert.rejects(insertRevision(rewrite), invalidAdmission);
  }

  // Draft-only protected v2 must fail even with a scoped plan and matching reader marker.
  const plan = { execution: { namespaceId, agentId, revisionId }, routes: [] };
  const insertProtectedV2 = (egressPlan) =>
    insertRevision(
      `jsonb_set(${currentSpec}, '{harness_auth,protectedExecutionVersion}', '2'::jsonb)
       || jsonb_build_object('execution_admission', '{"version":2,"mode":"protected"}'::jsonb,
                             'egress_plan', $3::jsonb)`,
      egressPlan,
    );
  await assert.rejects(insertProtectedV2(plan), invalidAdmission);
  await assert.rejects(
    insertProtectedV2({ ...plan, repositoryGitAuthorization: "online-request" }),
    invalidAdmission,
  );
  assert.equal(
    (await db.app.query("SELECT count(*)::integer AS count FROM occ.agent_revisions")).rows[0]
      .count,
    1,
  );
}

/**
 * @param {{app: import("pg").Client}} db
 * @returns {Promise<Record<string, unknown[]>>}
 */
export async function canonicalData(db) {
  const result = { presets: [] };
  const migrationOwnedColumns = {
    account: ["authentication_version", "identity_only"],
    agents: [
      "repository_bindings",
      "repository_access",
      "harness_auth_credential_source_id",
      "plugin_approvers",
      "plugin_driver",
      "credential_sources",
      "sandbox_policy_editing",
      "gateway_managed_mode",
    ],
    agent_revisions: ["gateway_managed_mode"],
    controller_work: ["work_kind"],
  };
  const hasPresets =
    (await db.app.query("SELECT to_regclass('occ.presets') AS relation")).rows[0].relation !== null;
  for (const table of [
    "installation",
    "namespaces",
    "configurations",
    "agents",
    "agent_revisions",
    "controller_work",
    "audit_events",
    "iam_identities",
    "iam_roles",
    "iam_groups",
    "iam_group_memberships",
    "iam_access_bindings",
    "iam_restrictions",
    "user",
    "account",
    "session",
    ...(hasPresets ? ["presets"] : []),
  ]) {
    const { rows } = await db.app.query(
      // New migration-owned compatibility columns may be defaulted onto
      // existing rows; every previously stored field must remain identical.
      `SELECT to_jsonb(t) - $1::pg_catalog.text[] AS value FROM occ."${table}" t ORDER BY to_jsonb(t)::pg_catalog.text`,
      [migrationOwnedColumns[table] ?? []],
    );
    // A null mode represents a pre-mode row. Keep any assigned mode in the comparison.
    result[table] =
      table === "agent_revisions"
        ? rows.map(({ value }) => {
            const { network_egress_mode: mode, ...revision } = value;
            return { value: mode === null ? revision : value };
          })
        : rows;
  }
  return result;
}

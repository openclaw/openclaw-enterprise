import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";

/** Exercise real main source metadata and Secret relationships before owner admission exists. */
export async function discardRetiredGatewaySourcesAcrossCutover(
  app: pg.Client,
  namespaceId: string,
) {
  const secretId = `sec_${randomUUID()}`;
  await app.query(
    `INSERT INTO occ.secrets(id,namespace_id,name,driver_id,backend_namespace_name,backend_name,backend_key,backend_uid,created_at)
     VALUES($1,$2,'Source upgrade secret','secrets','fixture','source-upgrade','value',$3,now())`,
    [secretId, namespaceId, randomUUID()],
  );
  const ids: string[] = [];
  for (const [type, field] of [
    ["openai", "api_key"],
    ["codex-pat", "access_token"],
    ["codex-oauth", undefined],
  ] as const) {
    const id = `cs_${randomUUID()}`;
    ids.push(id);
    await app.query(
      `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at)
       VALUES($1,$2,$3,$3,'{}','external-gateway','ready',clock_timestamp())`,
      [id, namespaceId, type],
    );
    if (field) {
      await app.query(
        `INSERT INTO occ.credential_source_secrets(namespace_id,credential_source_id,field,secret_id)
         VALUES($1,$2,$3,$4)`,
        [namespaceId, id, field, secretId],
      );
    }
  }
  const readSecret = () =>
    app.query("SELECT to_jsonb(s) AS secret FROM occ.secrets s WHERE id = $1", [secretId]);
  const before = await readSecret();
  assert.equal(before.rows.length, 1);
  return async function assertOwnershipAfterUpgrade() {
    assert.deepEqual(
      (await app.query("SELECT id FROM occ.credential_sources WHERE id = ANY($1)", [ids])).rows,
      [],
      "retired Gateway Sources are discarded",
    );
    assert.deepEqual(
      (
        await app.query(
          "SELECT secret_id FROM occ.credential_source_secrets WHERE credential_source_id = ANY($1)",
          [ids],
        )
      ).rows,
      [],
    );
    assert.deepEqual(
      (await readSecret()).rows,
      before.rows,
      "Source retirement preserves the Namespace Secret",
    );
    // A stale writer must fail rather than implicitly select a source owner.
    await assert.rejects(
      app.query(
        `INSERT INTO occ.credential_sources(id,namespace_id,name,type,config,driver_id,state,created_at)
         VALUES($1,$2,'unspecified owner','openai','{}','external-gateway','ready',now())`,
        [`cs_${randomUUID()}`, namespaceId],
      ),
      { code: "23502", column: "owner_capability" },
    );
  };
}

/** Effective privileges include role membership and default ACLs, not just explicit grants. */
export async function assertCredentialSchemaPrivileges(app: pg.Client) {
  const tables = [
    ["egress_installations", "installation,retired"],
    ["egress_rejected_material", ""],
    ["egress_send_receipts", "authorized_dispatch,outcome,observation,settled,feedback"],
    ["prepared_github_families", "admission,enabled,next_check_at,worker_claim"],
    [
      "prepared_github_attempts",
      "state,custody,material_version,provider_expires_at,usable_until,sealed,started_at",
    ],
    ["prepared_repository_git_uses", ""],
    ["prepared_repository_draft_pulls", "outcome,projection,settled_at"],
    // The operation fence can advance; settlement role, target and revision identity cannot.
    [
      "credential_deliveries",
      "fence,worker_instance,adopted_at,updated_at,desired,observed,material_version,preparation_attempt_id,target_material_version,target_preparation_attempt_id,write_pending,blocked,retained_policy_hash,operation_fence",
    ],
    // Policy requests and recipient identities stay fixed while request/ack progress advances.
    [
      "credential_delivery_reductions",
      "request_id,expected_version,observed_generation,policy_observed",
    ],
  ] as const;
  for (const [table, mutable] of tables) {
    // The migration security test leaves a hostile pg_temp.text domain on this connection.
    const result = await app.query(
      `SELECT pg_get_userbyid(c.relowner) = 'occ_migrator' AS owned,
         has_table_privilege(current_user,c.oid,'SELECT') AS readable,
         has_table_privilege(current_user,c.oid,'INSERT') AS insertable,
         has_table_privilege(current_user,c.oid,'UPDATE') AS update_all,
         has_table_privilege(current_user,c.oid,'DELETE') AS deletable,
         has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncatable,
         array_agg(a.attname::pg_catalog.text ORDER BY a.attname)
           FILTER (WHERE has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')) AS mutable
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
       WHERE c.oid=$1::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped
       GROUP BY c.oid,c.relowner`,
      [`occ.${table}`],
    );
    assert.deepEqual(
      result.rows,
      [
        {
          owned: true,
          readable: true,
          insertable: true,
          update_all: false,
          deletable: false,
          truncatable: false,
          mutable: mutable ? mutable.split(",").sort() : null,
        },
      ],
      `${table} must expose only its required receipt transitions`,
    );
  }
  assert.deepEqual(
    (
      await app.query(`SELECT to_regclass('occ.openshell_git_routes') AS obsolete,
        to_regclass('occ.protected_repository_git_recipients') AS obsolete_recipients`)
    ).rows,
    [{ obsolete: null, obsolete_recipients: null }],
  );
}

/** A different PostgreSQL failure must not satisfy the injected rollback scenario. */
export function assertInjectedMigrationRollback(error: unknown) {
  assert.ok(error instanceof Error);
  const failure = error.cause ?? error;
  assert.ok(failure instanceof Error);
  assert.ok("code" in failure);
  assert.equal(failure.code, "55000");
  assert.equal(failure.message, "migration rollback fixture");
}

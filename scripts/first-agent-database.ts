import { createHash } from "node:crypto";

type Database = (sql: string, variables: Record<string, string>) => Promise<string>;

type SecretGrant = {
  installationId: string;
  namespaceId: string;
  agentId: string;
  secretId: string;
  actorId: string;
};

const grantErrors = new Map([
  [
    "actor_not_verified",
    "The local bootstrap Service Principal is not an Installation administrator.",
  ],
  [
    "ownership_not_verified",
    "The Agent and Secret could not be verified in the ready local Namespace.",
  ],
  ["secret_operate_denied", "An IAM Restriction denies Agent access to this Secret."],
  ["grant_conflict", "The local database could not verify or create the exact Agent Secret grant."],
]);

export async function findFirstAgentSecret(
  database: Database,
  namespaceId: string,
  secretName: string,
): Promise<string | undefined> {
  const result = await database(
    `SELECT secret.id
       FROM occ.secrets AS secret
       JOIN occ.namespaces AS namespace ON namespace.id = secret.namespace_id
      WHERE namespace.id = :'namespace_id'
        AND namespace.deleted_at IS NULL
        AND namespace.status <> 'deleting'
        AND secret.name = :'secret_name';`,
    { namespace_id: namespaceId, secret_name: secretName },
  );
  const ids = result.trim().split(/\r?\n/u).filter(Boolean);
  const [id] = ids;
  if (id === undefined) {
    return undefined;
  }
  if (ids.length !== 1 || !/^sec_[a-f\d-]+$/u.test(id)) {
    throw new Error("The local database returned an unexpected Secret lookup result.");
  }
  return id;
}

export async function grantFirstAgentSecret(
  database: Database,
  { installationId, namespaceId, agentId, secretId, actorId }: SecretGrant,
): Promise<"granted"> {
  const suffix = createHash("sha256").update(agentId).update("\0").update(secretId).digest("hex");
  const result = await database(
    String.raw`BEGIN;
     SELECT pg_advisory_xact_lock(
       hashtextextended(concat_ws(':', 'local-first-agent', :'agent_id', :'secret_id'), 0)
     );

     WITH actor AS MATERIALIZED (
       SELECT principal.id
         FROM occ.installation AS installation
         JOIN occ.iam_identities AS principal ON principal.id = :'actor_id'
         JOIN occ.iam_access_bindings AS binding ON binding.identity_subject_id = principal.id
         JOIN occ.iam_roles AS role ON role.id = binding.role_id
        WHERE installation.id = :'installation_id'
          AND principal.kind = 'service_principal'
          AND principal.namespace_id IS NULL AND principal.agent_id IS NULL
          AND starts_with(binding.id, 'binding_bootstrap_service_admin_')
          AND binding.namespace_id IS NULL AND binding.group_subject_id IS NULL
          AND ((binding.resource_kind IS NULL AND binding.resource_id IS NULL)
            OR (binding.resource_kind = 'installation' AND binding.resource_id = installation.id))
          AND role.namespace_id IS NULL
          AND role.permissions @> '[{"action":"administer","resourceKind":"installation"}]'::jsonb
          AND NOT EXISTS (
            SELECT 1 FROM occ.iam_restrictions AS restriction
             WHERE restriction.namespace_id IS NULL AND restriction.action = 'administer'
               AND restriction.resource_kind = 'installation'
               AND (restriction.resource_id IS NULL OR restriction.resource_id = installation.id)
          )
        LIMIT 1
        FOR SHARE OF installation, principal, binding, role
     ), target AS MATERIALIZED (
       SELECT principal.id AS service_principal_id
         FROM occ.namespaces AS namespace
         JOIN occ.agents AS agent ON agent.namespace_id = namespace.id
         JOIN occ.iam_identities AS principal
           ON principal.id = agent.service_principal_id
          AND principal.namespace_id = namespace.id AND principal.agent_id = agent.id
          AND principal.kind = 'service_principal'
         JOIN occ.secrets AS secret ON secret.namespace_id = namespace.id
        WHERE namespace.id = :'namespace_id' AND namespace.status = 'ready'
          AND namespace.deleted_at IS NULL AND agent.id = :'agent_id' AND secret.id = :'secret_id'
        FOR SHARE OF namespace, agent, principal, secret
     ), permission_denied AS MATERIALIZED (
       SELECT 1 FROM occ.iam_restrictions AS restriction
        WHERE (restriction.namespace_id IS NULL OR restriction.namespace_id = :'namespace_id')
          AND restriction.action = 'operate' AND restriction.resource_kind = 'secret'
          AND (restriction.resource_id IS NULL OR restriction.resource_id = :'secret_id')
     ), collision AS MATERIALIZED (
       SELECT 1 FROM occ.iam_roles AS role
        WHERE role.id = :'role_id'
          AND (role.namespace_id IS DISTINCT FROM :'namespace_id'
            OR role.permissions <> '[{"action":"operate","resourceKind":"secret"}]'::jsonb)
       UNION ALL
       SELECT 1 FROM occ.iam_access_bindings AS binding
        WHERE binding.id = :'binding_id'
          AND (binding.namespace_id IS DISTINCT FROM :'namespace_id'
            OR binding.identity_subject_id IS DISTINCT FROM (SELECT service_principal_id FROM target)
            OR binding.group_subject_id IS NOT NULL OR binding.role_id <> :'role_id'
            OR binding.resource_kind IS DISTINCT FROM 'secret'
            OR binding.resource_id IS DISTINCT FROM :'secret_id')
     ), authorized AS MATERIALIZED (
       SELECT target.service_principal_id, actor.id AS actor_id
         FROM target CROSS JOIN actor
        WHERE NOT EXISTS (SELECT 1 FROM permission_denied)
          AND NOT EXISTS (SELECT 1 FROM collision)
     ), existing_binding AS MATERIALIZED (
       SELECT binding.id FROM occ.iam_access_bindings AS binding
         JOIN occ.iam_roles AS role ON role.id = binding.role_id
         JOIN authorized ON authorized.service_principal_id = binding.identity_subject_id
        WHERE binding.namespace_id = :'namespace_id' AND binding.group_subject_id IS NULL
          AND binding.resource_kind = 'secret' AND binding.resource_id = :'secret_id'
          AND role.namespace_id = :'namespace_id'
          AND role.permissions = '[{"action":"operate","resourceKind":"secret"}]'::jsonb
     ), inserted_role AS (
       INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
       SELECT :'role_id', :'namespace_id', 'Local first Agent Secret access',
              '[{"action":"operate","resourceKind":"secret"}]'::jsonb
         FROM authorized
        WHERE NOT EXISTS (SELECT 1 FROM existing_binding)
          AND NOT EXISTS (SELECT 1 FROM occ.iam_roles WHERE id = :'role_id')
       ON CONFLICT (id) DO NOTHING
       RETURNING id
     ), grant_role AS MATERIALIZED (
       SELECT id FROM inserted_role
       UNION ALL
       SELECT id FROM occ.iam_roles WHERE id = :'role_id'
     ), inserted_binding AS (
       INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
       SELECT :'binding_id', :'namespace_id', authorized.service_principal_id, NULL,
              grant_role.id, 'secret', :'secret_id'
         FROM authorized CROSS JOIN grant_role
        WHERE NOT EXISTS (SELECT 1 FROM existing_binding)
       ON CONFLICT (id) DO NOTHING
       RETURNING identity_subject_id
     ), recorded_audit AS (
       INSERT INTO occ.audit_events
         (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
          outcome, details)
       SELECT 'aud_' || gen_random_uuid()::text, clock_timestamp(), 'mutation', authorized.actor_id,
              'administer', :'namespace_id', 'secret', :'secret_id', 'success',
              jsonb_build_object('source', 'local-first-agent', 'agentId', :'agent_id',
                'servicePrincipalId', inserted_binding.identity_subject_id)
         FROM inserted_binding CROSS JOIN authorized
       RETURNING id
     ), outcome AS (
       SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM actor) THEN 'actor_not_verified'
         WHEN NOT EXISTS (SELECT 1 FROM target) THEN 'ownership_not_verified'
         WHEN EXISTS (SELECT 1 FROM permission_denied) THEN 'secret_operate_denied'
         WHEN EXISTS (SELECT 1 FROM collision) THEN 'grant_conflict'
         WHEN EXISTS (SELECT 1 FROM existing_binding) OR EXISTS (SELECT 1 FROM recorded_audit)
           THEN 'granted'
         ELSE 'grant_conflict'
       END AS status
     )
     SELECT status AS first_agent_status, status = 'granted' AS first_agent_should_commit
       FROM outcome
     \gset
     \if :first_agent_should_commit
       COMMIT;
     \else
       ROLLBACK;
     \endif
     SELECT :'first_agent_status';`,
    {
      installation_id: installationId,
      namespace_id: namespaceId,
      agent_id: agentId,
      secret_id: secretId,
      actor_id: actorId,
      role_id: `role_local_first_agent_secret_${suffix}`,
      binding_id: `binding_local_first_agent_secret_${suffix}`,
    },
  );
  const status = result.trim();
  if (status === "granted") {
    return status;
  }
  throw new Error(
    grantErrors.get(status) ?? "The local database returned an unexpected IAM grant result.",
  );
}

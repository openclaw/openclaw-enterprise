-- Protected static inputs are opt-in for existing sources. NULL preserves the
-- legacy gateway's approved copy; it must never be reinterpreted as a live Secret.
ALTER TABLE occ.credential_sources ADD COLUMN egress jsonb;
--> statement-breakpoint
CREATE FUNCTION occ.egress_ref_is_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['id', 'generation'] AND (value - 'id' - 'generation') = '{}'::jsonb
    AND jsonb_typeof(value->'id') = 'string' AND length(value->>'id') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'generation') = 'number' AND (value->>'generation') ~ '^[1-9][0-9]{0,14}$', false)
$$;
--> statement-breakpoint
CREATE FUNCTION occ.static_egress_source_is_valid(value jsonb, owner_namespace text, owner_source text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['key', 'schemaVersion', 'adoption', 'materialRefId', 'secret', 'secretDriver', 'sender', 'resolver', 'retention']
    AND (value - 'key' - 'schemaVersion' - 'adoption' - 'materialRefId' - 'secret' - 'secretDriver' - 'sender' - 'resolver' - 'retention') = '{}'::jsonb
    AND value->'schemaVersion' = '1'::jsonb AND value->>'adoption' = 'live' AND value->>'retention' = 'none'
    AND jsonb_typeof(value->'materialRefId') = 'string' AND length(value->>'materialRefId') BETWEEN 1 AND 200
    AND jsonb_typeof(value->'key') = 'object'
    AND (value->'key') ?& ARRAY['installationId', 'namespaceId', 'source', 'backend', 'provider']
    AND ((value->'key') - 'installationId' - 'namespaceId' - 'source' - 'backend' - 'provider') = '{}'::jsonb
    AND (value->'key'->>'installationId') ~ '^ins_[0-9a-f-]{36}$'
    AND value->'key'->>'namespaceId' = owner_namespace AND value->'key'->'source'->>'id' = owner_source
    AND occ.egress_ref_is_valid(value->'key'->'source') AND occ.egress_ref_is_valid(value->'key'->'backend') AND occ.egress_ref_is_valid(value->'key'->'provider')
    AND jsonb_typeof(value->'secret') = 'object'
    AND (value->'secret') ?& ARRAY['kind', 'namespaceId', 'id'] AND ((value->'secret') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
    AND value->'secret'->>'kind' = 'secret' AND value->'secret'->>'namespaceId' = owner_namespace
    AND (value->'secret'->>'id') ~ '^sec_[0-9a-f-]{36}$'
    AND occ.egress_ref_is_valid(value->'secretDriver') AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver'), false)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_ref_is_valid(jsonb), occ.static_egress_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.egress_installations (
  sender_id text NOT NULL,
  sandbox_id text NOT NULL,
  namespace_id text NOT NULL,
  revision_id text NOT NULL,
  agent_id text NOT NULL,
  installation jsonb NOT NULL,
  PRIMARY KEY (sender_id, sandbox_id),
  UNIQUE (namespace_id, revision_id),
  FOREIGN KEY (namespace_id, agent_id, revision_id) REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CHECK (length(sender_id) BETWEEN 1 AND 200 AND length(sandbox_id) BETWEEN 1 AND 200),
  CHECK (COALESCE(installation->'sender'->>'id' = sender_id
    AND installation->>'sandboxId' = sandbox_id
    AND installation->'plan'->'execution'->>'namespaceId' = namespace_id
    AND installation->'plan'->'execution'->>'revisionId' = revision_id
    AND installation->'plan'->'execution'->>'agentId' = agent_id, false))
);

--> statement-breakpoint
-- A provider rejection fences the selected store-qualified version across restart
-- and rereads. Rotation to a new version does not inherit the old rejection.
CREATE TABLE occ.egress_rejected_material (
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON DELETE CASCADE,
  secret_driver_id text NOT NULL,
  material_id text NOT NULL,
  material_version text NOT NULL,
  PRIMARY KEY (namespace_id, secret_driver_id, material_id, material_version),
  CHECK (length(secret_driver_id) > 0 AND length(material_id) > 0 AND length(material_version) > 0)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON occ.egress_installations, occ.egress_rejected_material TO occ_app;
--> statement-breakpoint
-- Strip the protected reader marker only from an object. A JSON scalar must fail
-- the snapshot constraint (23514), not raise an error from the JSON deletion operator.
ALTER TABLE occ.agent_revisions
  DROP CONSTRAINT agent_revisions_admitted_snapshot,
  ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
    (admitted_spec ?& ARRAY[
      'configuration_id', 'configuration_kind', 'configuration_generation',
      'draft_spec', 'harness', 'compute', 'harness_auth'
    ])
    AND (admitted_spec
      - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
      - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id' - 'sandbox_policy'
      - 'secret_driver_id' - 'secret_bindings' - 'harness_auth' - 'credential_sources' - 'plugins' - 'plugin_approvers'
      - 'repository_credentials' - 'egress_plan' - 'execution_admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
    AND (admitted_spec->>'configuration_id') ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
    AND (admitted_spec->>'configuration_kind') = 'agent'
    AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
    AND (admitted_spec->>'configuration_generation')::numeric BETWEEN 1 AND 9007199254740991
    AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
    AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
    AND jsonb_typeof(admitted_spec->'harness') = 'object'
    AND ((admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode'])
    AND ((admitted_spec->'harness') - 'id' - 'version' - 'mode') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
    AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
    AND jsonb_typeof(admitted_spec->'compute') = 'object'
    AND ((admitted_spec->'compute') ?& ARRAY['id', 'implementation'])
    AND ((admitted_spec->'compute') - 'id' - 'implementation' - 'admission') = '{}'::jsonb
    AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
    AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
    AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
    AND (
      NOT ((admitted_spec->'compute') ? 'admission')
      OR (jsonb_typeof(admitted_spec #> '{compute,admission}') = 'string'
          AND char_length(admitted_spec #>> '{compute,admission}') BETWEEN 1 AND 1024
          AND (admitted_spec #>> '{compute,admission}') ~ '^[ -~]+$')
    )
    AND (
      NOT (admitted_spec ? 'sandbox_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_driver_id')
      OR (
        jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
        AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
      )
    )
    AND (
      NOT (admitted_spec ? 'secret_bindings')
      OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
    )
    AND CASE WHEN jsonb_typeof(admitted_spec->'harness_auth') = 'object' THEN
      occ.harness_auth_is_valid((admitted_spec->'harness_auth') - 'protectedExecutionVersion', namespace_id, true)
    ELSE false END
    AND (
      NOT (admitted_spec ? 'repository_credentials')
      OR occ.repository_credentials_are_valid(admitted_spec->'repository_credentials')
    )
    AND (
      NOT (admitted_spec ? 'plugins')
      OR jsonb_typeof(admitted_spec->'plugins') = 'object'
    )
    AND (
      NOT (admitted_spec ? 'plugin_approvers')
      OR (jsonb_typeof(admitted_spec->'plugin_approvers') = 'array'
          AND jsonb_array_length(admitted_spec->'plugin_approvers') <= 64)
    )
    AND (
      NOT (admitted_spec ? 'credential_sources')
      OR occ.credential_source_snapshots_are_valid(admitted_spec->'credential_sources')
    )
  );


--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_egress_scope CHECK (
  NOT (admitted_spec ? 'egress_plan') OR COALESCE(
    jsonb_typeof(admitted_spec->'egress_plan') = 'object'
    AND admitted_spec->'egress_plan'->'execution'->>'namespaceId' = namespace_id
    AND admitted_spec->'egress_plan'->'execution'->>'agentId' = agent_id
    AND admitted_spec->'egress_plan'->'execution'->>'revisionId' = id
    AND jsonb_typeof(admitted_spec->'egress_plan'->'routes') = 'array',
    false)
);
--> statement-breakpoint
-- Require a decision on every new write. In this transaction we record the actual
-- unprotected admission of earlier revisions, restore immutability, then validate all rows.
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_execution_admission CHECK (
  COALESCE(
    jsonb_typeof(admitted_spec->'execution_admission') = 'object'
    AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
    AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
    AND admitted_spec->'execution_admission'->'version' = '2'::jsonb
    AND (
      (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
        AND NOT (admitted_spec ? 'egress_plan')
        AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
      OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
        AND admitted_spec ? 'egress_plan'
        AND admitted_spec #> '{harness_auth,protectedExecutionVersion}' = '2'::jsonb)
    ), false)
) NOT VALID;
--> statement-breakpoint
DROP TRIGGER agent_revisions_are_immutable ON occ.agent_revisions;
--> statement-breakpoint
UPDATE occ.agent_revisions
SET admitted_spec = admitted_spec || '{"execution_admission":{"version":2,"mode":"unprotected"}}'::jsonb
WHERE NOT (admitted_spec ? 'execution_admission')
  AND NOT (admitted_spec ? 'egress_plan')
  AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion');
--> statement-breakpoint
CREATE TRIGGER agent_revisions_are_immutable
BEFORE UPDATE ON occ.agent_revisions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
-- Recognize a freshly consented, Agent-isolated repository metadata grant. No rows or grants are rewritten.
CREATE FUNCTION occ.egress_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT occ.static_egress_source_is_valid(value, owner_namespace, owner_source) OR COALESCE(
    jsonb_typeof(value) = 'object'
    AND value ?& fields AND value - fields = '{}'::jsonb
    AND value->'schemaVersion' = '2'::jsonb AND value->>'adoption' = 'prepared' AND value->>'retention' = 'none'
    AND value->>'origin' ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
    AND jsonb_typeof(key) = 'object' AND key ?& keys AND key - keys = '{}'::jsonb
    AND key->>'installationId' ~ '^ins_[0-9a-f-]{36}$'
    AND key->>'namespaceId' = owner_namespace AND key->'source'->>'id' = owner_source
    AND occ.egress_ref_is_valid(key->'source') AND occ.egress_ref_is_valid(key->'backend')
    AND key->'provider' = '{"id":"github-app-metadata","generation":1}'::jsonb
    AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver')
    AND jsonb_typeof(grant_value) = 'object' AND grant_value ?& grants AND grant_value - grants = '{}'::jsonb
    AND grant_value->>'kind' = 'github_repository_metadata' AND grant_value->>'profile' = 'metadata-read'
    AND grant_value->>'appId' ~ '^[1-9][0-9]*$' AND grant_value->>'installationId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repositoryId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repository' ~ '^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$'
    AND grant_value->>'repository' !~ '/[.]{1,2}$'
    AND grant_value->>'isolationId' ~ '^agt_[0-9a-f-]{36}$',
    false)
  FROM (SELECT value->'key' AS key, value->'grant' AS grant_value,
    ARRAY['key','schemaVersion','adoption','retention','sender','resolver','origin','grant'] AS fields,
    ARRAY['installationId','namespaceId','source','backend','provider'] AS keys,
    ARRAY['kind','appId','installationId','repositoryId','repository','isolationId','profile'] AS grants) source
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
-- Explicit consent to one protected repository identity read. Never migrate a credentialed grant.
CREATE FUNCTION occ.credential_free_metadata_source_is_valid(value jsonb, owner_namespace text, owner_source text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    value ?& fields AND value - fields = '{}'::jsonb
    AND value->'schemaVersion' = '3'::jsonb AND value->>'retention' = 'none' AND value->>'adoption' = 'credential_free'
    AND value->>'origin' ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
    AND key ?& keys AND key - keys = '{}'::jsonb
    AND key->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND key->>'namespaceId' = owner_namespace
    AND key #>> '{source,id}' = owner_source AND occ.egress_ref_is_valid(key->'source')
    AND occ.egress_ref_is_valid(key->'backend')
    AND key->'provider' = '{"id":"credential-free-repository-metadata","generation":1}'::jsonb
    AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver')
    AND grant_value ?& grants AND grant_value - grants = '{}'::jsonb
    AND grant_value->>'kind' = 'credential_free_repository_metadata' AND grant_value->>'profile' = 'metadata-read'
    AND grant_value->>'isolationId' ~ '^agt_[0-9a-f-]{36}$' AND grant_value->>'repositoryId' ~ '^[1-9][0-9]*$'
    AND grant_value->>'repository' ~ '^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$'
    AND grant_value->>'repository' !~ '/[.]{1,2}$',
    false)
  FROM (SELECT value->'key' AS key, value->'grant' AS grant_value,
    ARRAY['key','schemaVersion','adoption','retention','sender','resolver','origin','grant'] AS fields,
    ARRAY['installationId','namespaceId','source','backend','provider'] AS keys,
    ARRAY['kind','profile','isolationId','repositoryId','repository'] AS grants) source
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.credential_free_metadata_source_is_valid(jsonb, text, text) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.credential_sources
  ADD CONSTRAINT credential_sources_egress_valid CHECK (CASE WHEN type = 'credential-free-repository-metadata' THEN
      config->'authority' = '"execution"'::jsonb
      AND config->'agent_id' = egress #> '{grant,isolationId}' AND config->'origin' = egress->'origin'
      AND config->'repository_id' = egress #> '{grant,repositoryId}' AND config->'repository' = egress #> '{grant,repository}'
      AND occ.credential_free_metadata_source_is_valid(egress, namespace_id, id)
    ELSE egress IS NULL OR occ.egress_source_is_valid(egress, namespace_id, id) END IS TRUE);
--> statement-breakpoint

GRANT UPDATE (egress) ON occ.credential_sources TO occ_app;
--> statement-breakpoint
-- This evidence can identify a committed selection; it is never the credential or a permit to use it.
-- Static and prepared receipts both retain attempts whose outcome is uncertain.
CREATE FUNCTION occ.egress_receipt_material_is_valid(material jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT material->>'kind' = 'static' OR COALESCE(
    material->>'kind' = 'prepared_github' AND material ?& fields AND material - fields = '{}'::jsonb
    AND src ?& source_fields AND src - source_fields = '{}'::jsonb
    AND src->>'installationId' ~ '^ins_[0-9a-f-]{36}$' AND length(src->>'namespaceId') > 0
    AND occ.egress_ref_is_valid(src->'source') AND occ.egress_ref_is_valid(src->'backend')
    AND src->'provider' = '{"id":"github-app-metadata","generation":1}'::jsonb
    AND occ.egress_ref_is_valid(material->'binding') AND occ.egress_ref_is_valid(material->'family')
    AND material->>'grantHash' ~ '^[0-9a-f]{64}$' AND material->>'isolationId' ~ '^agt_[0-9a-f-]{36}$'
    AND jsonb_typeof(material->'ownerEpoch') = 'number' AND material->>'ownerEpoch' ~ '^[1-9][0-9]*$'
    AND NOT EXISTS (SELECT FROM unnest(ARRAY['inputVersion','preparationAttemptId','materialId','materialVersion']) AS t(k)
      WHERE jsonb_typeof(material->k) IS DISTINCT FROM 'string' OR length(material->>k) NOT BETWEEN 1 AND 1024)
    AND material->>'usableUntil' ~ 'Z$' AND material->>'providerExpiresAt' ~ 'Z$'
    AND (material->>'usableUntil')::timestamptz <= (material->>'providerExpiresAt')::timestamptz, false)
  FROM (SELECT material->'source' AS src, ARRAY['installationId','namespaceId','source','backend','provider'] AS source_fields,
    ARRAY['kind','source','binding','grantHash','isolationId','family','ownerEpoch','inputVersion','preparationAttemptId',
          'materialId','materialVersion','providerExpiresAt','usableUntil'] AS fields) evidence
$$;
--> statement-breakpoint

-- Bind this prepared receipt to the same execution isolation, enrolled installation, stream and reply custody.
CREATE FUNCTION occ.prepared_github_dispatch_matches(dispatch jsonb, material jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    dispatch ?& dispatch_fields AND dispatch - dispatch_fields = '{}'::jsonb
    AND assoc ?& assoc_fields AND assoc - assoc_fields = '{}'::jsonb
    AND peer ?& peer_fields AND peer - peer_fields = '{}'::jsonb
    AND exec ?& exec_fields AND exec - exec_fields = '{}'::jsonb
    AND peer->>'peerKeyId' ~ '^[A-Za-z0-9_-]{43}$' AND occ.egress_ref_is_valid(peer->'plan')
    AND peer->>'policyHash' ~ '^[0-9a-f]{64}$' AND peer->>'authorityScope' = 'execution'
    AND assoc->>'exchangeId' ~ '^[0-9a-f]{64}$' AND assoc->>'responseId' ~ '^[0-9a-f]{64}$'
    AND assoc->>'custodyId' ~ '^[0-9a-f]{64}$'
    AND length(peer->>'sandboxId') > 0 AND length(peer->>'configurationId') > 0
    AND exec->>'namespaceId' = material->'source'->>'namespaceId' AND exec->>'agentId' = material->>'isolationId'
    AND NOT EXISTS (SELECT FROM unnest(exec_fields) AS t(k)
      WHERE jsonb_typeof(exec->k) IS DISTINCT FROM 'string' OR length(exec->>k) NOT BETWEEN 1 AND 1024)
    AND dispatch->>'requestDigest' ~ '^[0-9a-f]{64}$' AND dispatch->>'injectionDigest' ~ '^[0-9a-f]{64}$',
    false)
  FROM (SELECT dispatch->'association' AS assoc, dispatch #> '{association,installation}' AS peer,
      dispatch #> '{association,execution}' AS exec,
      ARRAY['association','requestDigest','injectionDigest','authorizedAt','sendStartBy'] AS dispatch_fields,
      ARRAY['execution','installation','exchangeId','responseId','custodyId'] AS assoc_fields,
      ARRAY['sandboxId','instanceId','configurationId','peerKeyId','policyHash','authorityScope','plan'] AS peer_fields,
      ARRAY['installationId','namespaceId','agentId','servicePrincipalId','revisionId','executionId'] AS exec_fields) association
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.egress_receipt_material_is_valid(jsonb), occ.prepared_github_dispatch_matches(jsonb,jsonb) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.egress_send_receipts (
  sender_id text NOT NULL CONSTRAINT egress_send_receipts_check_0 CHECK (length(sender_id) > 0),
  sender_generation bigint NOT NULL CONSTRAINT egress_send_receipts_check_1 CHECK (sender_generation > 0),
  instance_id text NOT NULL CONSTRAINT egress_send_receipts_check_2 CHECK (length(instance_id) > 0),
  use_id text NOT NULL CONSTRAINT egress_send_receipts_check_3 CHECK (length(use_id) > 0),
  attempt_id text NOT NULL CONSTRAINT egress_send_receipts_check_4 CHECK (length(attempt_id) > 0),
  binding jsonb NOT NULL CONSTRAINT egress_send_receipts_check_5 CHECK (jsonb_typeof(binding) = 'object'),
  authorized_dispatch jsonb,
  observation jsonb,
  outcome jsonb NOT NULL CONSTRAINT egress_send_receipts_check_6 CHECK (jsonb_typeof(outcome) = 'object'),
  settled boolean NOT NULL DEFAULT false,
  feedback text CONSTRAINT egress_send_receipts_check_7 CHECK (feedback = 'fenced'),
  PRIMARY KEY (sender_id, sender_generation, instance_id, use_id, attempt_id),
  CONSTRAINT egress_send_receipts_check_8 CHECK ((binding->'sender'->>'id' = sender_id
      AND (binding->'sender'->>'generation')::bigint = sender_generation
      AND binding->>'instanceId' = instance_id
      AND binding->>'useId' = use_id AND binding->>'attemptId' = attempt_id
      AND length(binding->>'deadlineAt') > 0
      AND jsonb_typeof(binding->'material') IN ('object', 'null')) IS TRUE),
  CONSTRAINT egress_send_receipts_check_9 CHECK ((
    (outcome->>'kind' = 'refused' AND outcome->'dispatched' = 'false'::jsonb AND settled)
    OR (outcome->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
        AND outcome->>'dispatch' = 'confirmed' AND settled)
    OR (outcome->>'kind' = 'uncertain' AND outcome->>'dispatch' = 'possible')
  ) IS TRUE),
  CONSTRAINT egress_send_receipts_check_10 CHECK (outcome->>'kind' <> 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_11 CHECK (outcome->>'kind' <> 'response_blocked' OR (outcome->>'code' = 'response_policy') IS TRUE),
  CONSTRAINT egress_send_receipts_check_12 CHECK (outcome->>'kind' NOT IN ('response', 'provider_rejected')
    OR ((outcome->>'status')::integer BETWEEN 100 AND 599) IS TRUE),
  CONSTRAINT egress_send_receipts_check_13 CHECK (observation IS NULL OR (jsonb_typeof(observation) = 'object'
    AND observation->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
    AND observation->>'dispatch' = 'confirmed'
    AND CASE WHEN observation->>'kind' = 'response_blocked'
      THEN observation->>'code' = 'response_policy'
      ELSE (observation->>'status')::integer BETWEEN 100 AND 599 END) IS TRUE),
  CONSTRAINT egress_send_receipts_check_14 CHECK (observation->>'kind' IS DISTINCT FROM 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_15 CHECK (observation IS NULL OR NOT settled OR outcome = observation OR outcome->>'kind' = 'uncertain'),
  CONSTRAINT egress_send_receipts_check_16 CHECK (feedback IS NULL OR ((observation IS NOT NULL OR (settled AND outcome->>'dispatch' = 'confirmed'))
    AND occ.egress_receipt_material_is_valid(binding->'material')) IS TRUE),
  CONSTRAINT egress_send_receipts_check_17 CHECK (authorized_dispatch IS NULL OR (
    jsonb_typeof(authorized_dispatch) = 'object'
    AND authorized_dispatch #>> '{association,installation,instanceId}' = instance_id
    AND authorized_dispatch #>> '{association,execution,installationId}' = binding #>> '{material,source,installationId}'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz > (authorized_dispatch->>'authorizedAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (authorized_dispatch->>'authorizedAt')::timestamptz + interval '1 second'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz
    AND CASE WHEN binding #>> '{material,kind}' = 'no_material_required' THEN
      (binding->'material') - ARRAY['kind','source','binding','grantHash','isolationId'] = '{}'::jsonb
      AND binding #>> '{material,grantHash}' ~ '^[0-9a-f]{64}$'
      AND occ.egress_ref_is_valid(binding #> '{material,binding}')
      AND binding #> '{material,source,provider}' = '{"id":"credential-free-repository-metadata","generation":1}'::jsonb
      AND occ.egress_ref_is_valid(binding #> '{material,source,source}') AND occ.egress_ref_is_valid(binding #> '{material,source,backend}')
      AND binding #>> '{material,source,namespaceId}' = authorized_dispatch #>> '{association,execution,namespaceId}'
      AND occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material')
      AND authorized_dispatch->>'injectionDigest' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    ELSE occ.egress_receipt_material_is_valid(binding->'material')
      AND (binding #>> '{material,kind}' = 'static' OR occ.prepared_github_dispatch_matches(authorized_dispatch, binding->'material'))
      AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding #>> '{material,usableUntil}')::timestamptz
      AND length(authorized_dispatch #>> '{association,exchangeId}') > 0 AND length(authorized_dispatch #>> '{association,responseId}') > 0
      AND length(authorized_dispatch #>> '{association,custodyId}') > 0 AND length(authorized_dispatch->>'requestDigest') = 64
      AND length(authorized_dispatch->>'injectionDigest') = 64
    END) IS TRUE)
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (authorized_dispatch, outcome, observation, settled, feedback) ON occ.egress_send_receipts TO occ_app;
--> statement-breakpoint
-- Only explicit prepared sources enroll. Keep the family and its attempt receipts after
-- withdrawal: an unavailable issuer or a lost commit must not turn into another issuance.
CREATE TABLE occ.prepared_github_families (
  source_id text PRIMARY KEY,
  source jsonb NOT NULL,
  issuer jsonb NOT NULL,
  admission jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  worker_claim uuid,
  CONSTRAINT prepared_github_families_check CHECK ((source #>> '{key,source,id}' = source_id AND (
  (source->>'adoption' = 'prepared' AND source #>> '{grant,profile}' = 'metadata-read'
   AND admission->>'familyId' = source_id AND jsonb_typeof(issuer->'backendRef') = 'object')
  OR
  (source->>'adoption' = 'prepared_repository_git' AND source_id = 'repository-git:' || (source #>> '{session,admissionId}')
   AND ((source #>> '{grant,profile}' = 'git-ref-write' AND NOT (source->'grant' ? 'pullRequestBase'))
       OR (source #>> '{grant,profile}' = 'git-ref-draft-pr' AND length(source #>> '{grant,pullRequestBase}') > 0))
   AND source #>> '{grant,pushRef}' LIKE 'refs/heads/%'
   AND admission->>'familyId' = source_id AND admission->'grant' = source->'grant'
   AND source #>> '{grant,id}' = source #>> '{session,grant,grantId}'
   AND source #>> '{grant,repositoryId}' = source #>> '{session,grant,repositoryId}'
   AND source #>> '{grant,isolationId}' = source #>> '{session,revisionId}'
   AND issuer = '{"kind":"worker-mounted-github-app-key"}'::jsonb)
)) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX prepared_github_families_due ON occ.prepared_github_families(next_check_at) WHERE enabled;
--> statement-breakpoint
CREATE TABLE occ.prepared_github_attempts (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES occ.prepared_github_families(source_id),
  admission jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('issuing', 'committed', 'quarantined')),
  custody text NOT NULL DEFAULT 'intent' CHECK (custody IN
    ('intent', 'current', 'retire', 'revoking', 'revoked', 'unknown')),
  -- version is generated by custody, independent of the provider and secret bytes.
  material_version uuid UNIQUE,
  provider_expires_at timestamptz,
  usable_until timestamptz,
  sealed bytea,
  CHECK (custody <> 'current' OR (state = 'committed' AND sealed IS NOT NULL
    AND material_version IS NOT NULL AND usable_until IS NOT NULL
    AND provider_expires_at IS NOT NULL AND usable_until <= provider_expires_at)),
  CHECK ((sealed IS NOT NULL) = (custody IN ('current','retire','revoking','unknown')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX prepared_github_current ON occ.prepared_github_attempts(source_id) WHERE custody = 'current';
--> statement-breakpoint
CREATE INDEX prepared_github_attempts_family ON occ.prepared_github_attempts(source_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON occ.prepared_github_families, occ.prepared_github_attempts TO occ_app;
--> statement-breakpoint
-- Existence is a possible credential disclosure, not a Git outcome. Reusing its exchange ID fails.
CREATE TABLE occ.prepared_repository_git_uses (
  exchange_id uuid PRIMARY KEY,
  admission_id text NOT NULL REFERENCES occ.repository_session_attempts(admission_id),
  attempt_id uuid NOT NULL REFERENCES occ.prepared_github_attempts(id),
  material_version uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('advertise-upload-pack','upload-pack','advertise-receive-pack','receive-pack')),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  send_start_by timestamptz NOT NULL
);
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.prepared_repository_git_uses TO occ_app;
--> statement-breakpoint
-- One admitted draft per explicitly selected grant (repository, review ref and base).
-- No expiry, retry, cascading deletion, or result from an untrusted caller.
CREATE TABLE occ.prepared_repository_draft_pulls (
  grant_id text PRIMARY KEY,
  operation_id uuid NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  admission_id text NOT NULL REFERENCES occ.repository_session_attempts(admission_id),
  attempt_id uuid NOT NULL REFERENCES occ.prepared_github_attempts(id),
  material_version uuid NOT NULL,
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  scope jsonb NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  send_start_by timestamptz NOT NULL,
  settled_at timestamptz,
  outcome text NOT NULL DEFAULT 'outcome_unknown'
    CHECK (outcome IN ('created', 'not-submitted', 'outcome_unknown')),
  projection jsonb,
  CHECK ((outcome = 'created') = (projection IS NOT NULL)),
  CHECK (settled_at IS NOT NULL OR outcome = 'outcome_unknown')
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(outcome, projection, settled_at)
ON occ.prepared_repository_draft_pulls TO occ_app;
--> statement-breakpoint
-- A revision's OpenShell Git route as the worker that prepared it last verified it: the
-- identity and custody facts a restarted or replacement worker needs to re-observe the
-- installation and re-adopt the route instead of requiring a new revision (finding 2128).
-- Never token material: the material is read again from prepared custody through the
-- normal preparation path. `fence` names the adoption; every write by the worker that
-- holds a route carries its fence, so a worker whose fence is stale writes nothing and
-- stops using the route. `write_pending` outlives a worker that stopped mid-write: the
-- outcome of that provider write is unknown, and the next worker tombstones the route.
-- `blocked` is the tombstone; a blocked route is never adopted again.
CREATE TABLE occ.openshell_git_routes (
  revision_id text PRIMARY KEY REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  workspace text NOT NULL,
  sandbox text NOT NULL,
  binding_id text NOT NULL CHECK (binding_id ~ '^[A-Za-z0-9_-]{32}$'),
  fence bigint NOT NULL DEFAULT 1 CHECK (fence >= 1),
  worker_instance uuid NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider_id text,
  profile_version text CHECK (profile_version ~ '^[1-9][0-9]*$'),
  provider_resource_version text CHECK (provider_resource_version ~ '^[1-9][0-9]*$'),
  credential_state text CHECK (credential_state IN ('bootstrap', 'active')),
  material_expires_at timestamptz,
  material_version uuid,
  preparation_attempt_id uuid,
  observed jsonb,
  write_pending text CHECK (write_pending IN ('bootstrap', 'rotate')),
  blocked text,
  CHECK ((provider_id IS NULL) = (profile_version IS NULL)
    AND (provider_id IS NULL) = (provider_resource_version IS NULL)
    AND (provider_id IS NULL) = (credential_state IS NULL)),
  CHECK ((credential_state = 'active') = (material_expires_at IS NOT NULL)),
  CHECK ((material_version IS NULL) = (preparation_attempt_id IS NULL)),
  CHECK (observed IS NULL OR (jsonb_typeof(observed) = 'object'
    AND observed ?& ARRAY['workspace', 'sandbox', 'sandboxId', 'executionId', 'provider',
      'providerId', 'providerResourceVersion', 'profileVersion', 'credentialState',
      'attachmentEpoch', 'providerEnvRevision', 'configRevision', 'policyHash',
      'supervisorSessionId', 'processInstanceId', 'networkInstanceId']
    AND (observed - ARRAY['workspace', 'sandbox', 'sandboxId', 'executionId', 'provider',
      'providerId', 'providerResourceVersion', 'profileVersion', 'credentialState',
      'attachmentEpoch', 'providerEnvRevision', 'configRevision', 'policyHash',
      'supervisorSessionId', 'processInstanceId', 'networkInstanceId']) = '{}'::jsonb))
);
--> statement-breakpoint
CREATE INDEX openshell_git_routes_namespace ON occ.openshell_git_routes (namespace_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence, worker_instance, adopted_at, updated_at, provider_id,
  profile_version, provider_resource_version, credential_state, material_expires_at,
  material_version, preparation_attempt_id, observed, write_pending, blocked)
ON occ.openshell_git_routes TO occ_app;

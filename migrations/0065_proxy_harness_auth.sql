-- Retain Gateway snapshots unchanged; Proxy snapshots freeze their exact egress owner.
CREATE OR REPLACE FUNCTION occ.harness_auth_is_valid(binding jsonb, owner_namespace text, resolved boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    jsonb_typeof(binding) = 'object'
    AND jsonb_typeof(binding->'method') = 'string'
    AND CASE
      WHEN binding->>'method' = 'runtime' THEN binding = '{"method":"runtime"}'::jsonb
      WHEN binding->>'method' IN ('api_key', 'codex_pat')
        AND binding #>> '{source,kind}' = 'secret' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source' - CASE WHEN resolved THEN 'secretDriverId' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'secret'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (jsonb_typeof(binding->'secretDriverId') = 'string' AND btrim(binding->>'secretDriverId') <> ''))
      WHEN binding->>'method' = 'codex_pat' THEN
        (binding ?& ARRAY['method', 'source'])
        AND (binding - 'method' - 'source'
          - CASE WHEN resolved THEN 'credential' ELSE 'method' END
          - CASE WHEN resolved THEN 'backendBinding' ELSE 'method' END) = '{}'::jsonb
        AND jsonb_typeof(binding->'source') = 'object'
        AND ((binding->'source') ?& ARRAY['kind', 'namespaceId', 'id'])
        AND ((binding->'source') - 'kind' - 'namespaceId' - 'id') = '{}'::jsonb
        AND binding #>> '{source,kind}' = 'service_account'
        AND binding #>> '{source,namespaceId}' = owner_namespace
        AND (binding #>> '{source,id}') ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND (NOT resolved OR (
          jsonb_typeof(binding->'credential') = 'object'
          AND ((binding->'credential') ?& ARRAY['kind', 'secretRef'])
          AND ((binding->'credential') - 'kind' - 'secretRef') = '{}'::jsonb
          AND binding #>> '{credential,kind}' = 'access_token'
          AND jsonb_typeof(binding #> '{credential,secretRef}') = 'object'
          AND ((binding #> '{credential,secretRef}') ?& ARRAY['name', 'key'])
          AND ((binding #> '{credential,secretRef}') - 'name' - 'key') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{credential,secretRef,name}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,name}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,name}') ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
          AND jsonb_typeof(binding #> '{credential,secretRef,key}') = 'string'
          AND char_length(binding #>> '{credential,secretRef,key}') BETWEEN 1 AND 253
          AND (binding #>> '{credential,secretRef,key}') ~ '^[-._a-zA-Z0-9]+$'
          AND (binding #>> '{credential,secretRef,key}') NOT IN ('.', '..')
          AND jsonb_typeof(binding->'backendBinding') = 'object'
          AND ((binding->'backendBinding') ?& ARRAY['backendId', 'driverId', 'workspaceId', 'credentialIssued'])
          AND ((binding->'backendBinding') - 'backendId' - 'driverId' - 'workspaceId' - 'credentialIssued') = '{}'::jsonb
          AND jsonb_typeof(binding #> '{backendBinding,backendId}') = 'string'
          AND btrim(binding #>> '{backendBinding,backendId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,driverId}') = 'string'
          AND btrim(binding #>> '{backendBinding,driverId}') <> ''
          AND jsonb_typeof(binding #> '{backendBinding,workspaceId}') = 'string'
          AND btrim(binding #>> '{backendBinding,workspaceId}') <> ''
          AND binding #> '{backendBinding,credentialIssued}' = 'true'::jsonb
        ))
      WHEN binding->>'method' = 'credential_source' THEN
        (binding ?& ARRAY['method', 'sourceId'])
        AND jsonb_typeof(binding->'sourceId') = 'string'
        AND (binding->>'sourceId') ~ '^cs_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND CASE WHEN resolved THEN
          (CASE WHEN binding ? 'credentialProxyId' THEN
            (binding - 'method' - 'sourceId' - 'credentialProxyId' - 'sourceType' - 'loginMode' - 'egress') = '{}'::jsonb
            AND jsonb_typeof(binding->'credentialProxyId') = 'string'
            AND btrim(binding->>'credentialProxyId') <> ''
            AND occ.egress_source_is_valid(binding->'egress', owner_namespace, binding->>'sourceId')
          ELSE
            (binding - 'method' - 'sourceId' - 'credentialGatewayId' - 'sourceType' - 'loginMode') = '{}'::jsonb
            AND jsonb_typeof(binding->'credentialGatewayId') = 'string'
            AND btrim(binding->>'credentialGatewayId') <> ''
          END)
          AND jsonb_typeof(binding->'sourceType') = 'string'
          AND (binding->>'sourceType') ~ '^[a-z][a-z0-9-]{0,63}$'
          AND jsonb_typeof(binding->'loginMode') = 'string'
          AND binding->>'loginMode' IN ('api_key', 'codex_pat', 'chatgptAuthTokens')
        ELSE (binding - 'method' - 'sourceId') = '{}'::jsonb END
      ELSE false
    END, false);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.verified_source_identity_is_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    jsonb_typeof(p) = 'object'
    AND p ?& fields AND p - fields = '{}'::jsonb
    AND p->'source' = value->'key'
    AND p->'secret' = value->'secret'
    AND p->'secretDriver' = value->'secretDriver'
    AND p->'materialRefId' = value->'materialRefId'
    AND jsonb_typeof(p->'materialId') = 'string' AND p->>'materialId' ~ '^[!-~]{1,200}$'
    AND jsonb_typeof(p->'materialVersion') = 'string' AND p->>'materialVersion' ~ '^[!-~]{1,200}$'
    AND jsonb_typeof(p->'subject') = 'string' AND p->>'subject' ~ '^[a-zA-Z0-9_-]{1,128}$'
    AND jsonb_typeof(p->'issuer') = 'string' AND p->>'issuer' ~ '^https://[a-z0-9.-]+/[a-zA-Z0-9/_-]+$'
    AND length(regexp_replace(p->>'issuer', '^https://[a-z0-9.-]+/', '')) BETWEEN 1 AND 400
    AND jsonb_typeof(p->'origin') = 'string' AND p->>'origin' ~ '^https://[a-z0-9.-]+$', false)
  FROM (SELECT value->'verifiedIdentity' AS p,
    ARRAY['source','materialRefId','secret','secretDriver','materialId','materialVersion','issuer','subject','origin'] AS fields) proof
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.static_egress_source_is_valid(value jsonb, owner_namespace text, owner_source text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['key', 'schemaVersion', 'adoption', 'materialRefId', 'secret', 'secretDriver', 'sender', 'resolver', 'retention']
    AND (value - 'key' - 'schemaVersion' - 'adoption' - 'materialRefId' - 'secret' - 'secretDriver' - 'sender' - 'resolver' - 'retention' - 'verifiedIdentity') = '{}'::jsonb
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
    AND (NOT (value ? 'verifiedIdentity') OR occ.verified_source_identity_is_valid(value))
    AND occ.egress_ref_is_valid(value->'secretDriver') AND occ.egress_ref_is_valid(value->'sender') AND occ.egress_ref_is_valid(value->'resolver'), false)
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.verified_source_identity_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions
  ADD CONSTRAINT agent_revisions_execution_admission CHECK (COALESCE(
        jsonb_typeof(admitted_spec->'execution_admission') = 'object'
        AND (admitted_spec->'execution_admission') ?& ARRAY['version', 'mode']
        AND ((admitted_spec->'execution_admission') - 'version' - 'mode') = '{}'::jsonb
        AND (
          (admitted_spec->'execution_admission'->>'mode' = 'unprotected'
            AND admitted_spec #> '{execution_admission,version}' = '2'::jsonb
            AND NOT (admitted_spec ? 'egress_plan')
            AND NOT ((admitted_spec->'harness_auth') ? 'protectedExecutionVersion'))
          OR (admitted_spec->'execution_admission'->>'mode' = 'protected'
            AND admitted_spec ? 'egress_plan'
            AND admitted_spec #> '{harness_auth,protectedExecutionVersion}'
              = admitted_spec #> '{execution_admission,version}'
            AND (
                admitted_spec #>> '{execution_admission,version}' IN ('3','4','5','6','7','8')
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('7','8')
                  THEN admitted_spec #> '{egress_plan,policyReductionVersion}' = '2'::jsonb
                  ELSE NOT (admitted_spec->'egress_plan' ? 'policyReductionVersion') OR
                    (admitted_spec #>> '{execution_admission,version}' = '3' AND admitted_spec #> '{egress_plan,policyReductionVersion}' = '1'::jsonb) END
                AND ((admitted_spec #>> '{execution_admission,version}') IN ('4','5','6','7','8'))
                  = ((admitted_spec->'egress_plan') ? 'repositoryGit')
                AND (NOT ((admitted_spec->'egress_plan') ? 'repositoryGit')
                  OR (jsonb_typeof(admitted_spec->'repository_credentials')='object'
                    AND admitted_spec #> '{egress_plan,repositoryGit}' = admitted_spec->'repository_credentials'))
                AND CASE WHEN admitted_spec #>> '{execution_admission,version}' IN ('5','8')
                    THEN admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'online-request'
                    WHEN admitted_spec #>> '{execution_admission,version}' = '6' THEN
                      admitted_spec #>> '{egress_plan,repositoryGitAuthorization}' = 'request-hook-observed'
                      AND admitted_spec #>> '{egress_plan,repositoryGit,bindings,0,profile}' = 'github-installation'
                      AND jsonb_array_length(admitted_spec #> '{egress_plan,repositoryGit,bindings}') = 1
                    ELSE NOT ((admitted_spec->'egress_plan') ? 'repositoryGitAuthorization') END
                AND
                jsonb_typeof(admitted_spec #> '{egress_plan,driver}') = 'object'
                AND length(admitted_spec #>> '{egress_plan,driver,id}') > 0
                AND length(admitted_spec #>> '{egress_plan,driver,implementation}') > 0
                AND admitted_spec #>> '{egress_plan,driver,configurationId}' ~ '^[0-9a-f]{64}$'
              ))
        ), false)) NOT VALID;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions VALIDATE CONSTRAINT agent_revisions_execution_admission;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.guard_standing_repository_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE version integer; credentials jsonb; predecessor occ.repository_session_attempts; ceiling bigint; now_ms bigint;
BEGIN
 IF TG_OP='UPDATE' AND NEW.broker_protocol<>OLD.broker_protocol THEN
   RAISE EXCEPTION 'Repository session authority is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.phase NOT IN ('opening','open') THEN RETURN NEW; END IF;
 SELECT admitted_spec->'repository_credentials', (admitted_spec #>> '{execution_admission,version}')::int
 INTO credentials,version FROM occ.agent_revisions
 WHERE id=NEW.revision_id AND namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id;
 IF ((NEW.broker_protocol=2) IS DISTINCT FROM (version IN (4,5,6,7,8))) THEN
   RAISE EXCEPTION 'Repository session requires its admitted sender' USING ERRCODE='23514';
 END IF;
 IF NOT coalesce(credentials ? 'standingApprovalId',false) THEN
   IF NEW.predecessor_admission_id IS NULL THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Finite repository admission cannot succeed another session' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM occ.agents WHERE id=NEW.agent_id AND namespace_id=NEW.namespace_id
   AND status='active' AND desired_runtime_state='running' FOR SHARE;
 IF NOT FOUND OR NOT occ.repository_standing_approval_is_current(credentials,NEW.namespace_id,NEW.agent_id) THEN
   RAISE EXCEPTION 'Standing repository session requires current approval and running Agent' USING ERRCODE='23514';
 END IF;
 IF NEW.predecessor_admission_id IS NOT NULL THEN
   IF (TG_OP='INSERT' AND NEW.broker_protocol NOT IN (2,3))
     OR NOT occ.repository_standing_execution_is_current(credentials,NEW.namespace_id,NEW.agent_id,NEW.revision_id)
     OR NOT EXISTS (SELECT FROM occ.repository_standing_executions
          WHERE revision_id=NEW.revision_id AND fingerprint=NEW.execution_fingerprint AND NOT closed) THEN
     RAISE EXCEPTION 'Repository successor requires the same current standing execution' USING ERRCODE='23514';
   END IF;
   IF TG_OP='INSERT' THEN
     SELECT s.* INTO predecessor FROM occ.repository_session_attempts s LEFT JOIN occ.repository_broker_receipts b USING (admission_id)
       WHERE s.admission_id=NEW.predecessor_admission_id AND s.phase='disposed' AND s.broker_protocol=NEW.broker_protocol
         AND (CASE WHEN NEW.broker_protocol=2 THEN b.admission_id IS NULL
                   ELSE b.state='disposed' AND b.session_id=s.session_id END);
     IF NOT FOUND THEN RAISE EXCEPTION 'Repository predecessor disposal is unconfirmed' USING ERRCODE='23514'; END IF;
     SELECT (scope->>'maximumSessionDurationSeconds')::bigint INTO ceiling FROM occ.repository_standing_approvals
       WHERE id=credentials->>'standingApprovalId' AND revoked_at IS NULL;
     now_ms := floor(extract(epoch FROM clock_timestamp())*1000);
     IF (NEW.namespace_id,NEW.agent_id,NEW.revision_id,NEW.cleanup_context) IS DISTINCT FROM
        (predecessor.namespace_id,predecessor.agent_id,predecessor.revision_id,predecessor.cleanup_context)
       OR ceiling IS NULL OR NEW.duration_seconds>ceiling OR NEW.deadline_wall_ms<=greatest(predecessor.deadline_wall_ms,now_ms)
       OR NEW.deadline_wall_ms>least(now_ms,extract(epoch FROM NEW.created_at)*1000)+NEW.duration_seconds*1000 THEN
       RAISE EXCEPTION 'Repository successor exceeds its admitted scope or session duration' USING ERRCODE='23514';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END; $$;

-- Rename the current owner without changing instance, Source, Client, or custody identities.
ALTER TABLE occ.token_service_instances RENAME TO credential_service_instances;
ALTER TABLE occ.credential_sources RENAME COLUMN token_service_instance_id TO credential_service_instance_id;
ALTER TABLE occ.oauth_clients RENAME COLUMN token_service_instance_id TO credential_service_instance_id;
--> statement-breakpoint
DO $$
DECLARE
  item record;
  definitions jsonb;
  definition text;
  routine regprocedure;
BEGIN
  -- PostgreSQL updates dependent column references, but does not rename constraint names.
  FOR item IN
    SELECT conrelid::regclass AS relation, conname
    FROM pg_constraint
    WHERE connamespace = 'occ'::regnamespace AND conname LIKE '%token_service%'
    ORDER BY conrelid, conname
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', item.relation, item.conname,
      replace(item.conname, 'token_service', 'credential_service'));
  END LOOP;

  -- Save and remove only checks that contain the serialized owner name or JSON keys.
  SELECT jsonb_agg(jsonb_build_object('relation', conrelid::regclass::text, 'name', conname,
    'definition', pg_get_constraintdef(oid, false)) ORDER BY conrelid, conname)
    INTO definitions
  FROM pg_constraint
  WHERE connamespace = 'occ'::regnamespace AND contype = 'c'
    AND pg_get_constraintdef(oid, false) ~ '(token_service|tokenService|TokenService|token-service)';
  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) AS checks(relation text, name text, definition text)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', item.relation, item.name);
  END LOOP;

  -- Function bodies are stored as text, so PostgreSQL cannot update their identifiers.
  FOREACH routine IN ARRAY ARRAY[
    'occ.harness_auth_is_valid(jsonb,text,boolean)'::regprocedure,
    'occ.credential_source_snapshots_are_valid(jsonb)'::regprocedure,
    'occ.reject_managed_source_secret()'::regprocedure,
    'occ.guard_sandbox_repository_policy_revision()'::regprocedure,
    'occ.standalone_credential_deployment_is_valid(jsonb,text)'::regprocedure,
    'occ.guard_source_consent()'::regprocedure,
    'occ.guard_service_account_credential_source()'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(routine);
    EXECUTE replace(replace(replace(replace(definition,
      'TokenService', 'CredentialService'), 'tokenService', 'credentialService'),
      'token_service', 'credential_service'), 'token-service', 'credential-service');
  END LOOP;

  ALTER TABLE occ.credential_sources DISABLE TRIGGER credential_source_metadata_is_immutable;
  UPDATE occ.credential_sources SET owner_capability = 'credential_service'
    WHERE owner_capability = 'token_service';
  ALTER TABLE occ.credential_sources ENABLE TRIGGER credential_source_metadata_is_immutable;

  -- The migrator rewrites immutable snapshots inside this transaction.
  ALTER TABLE occ.agent_revisions DISABLE TRIGGER agent_revisions_are_immutable;
  WITH gateway AS (
    SELECT id, CASE WHEN admitted_spec ? 'gateway_token_service_instance_id'
      THEN (admitted_spec - 'gateway_token_service_instance_id') || jsonb_build_object(
        'gateway_credential_service_instance_id', admitted_spec->'gateway_token_service_instance_id')
      ELSE admitted_spec END AS spec
    FROM occ.agent_revisions
  ), auth AS (
    SELECT id, CASE WHEN spec->'harness_auth' ? 'tokenServiceInstanceId'
      THEN jsonb_set(spec, '{harness_auth}', ((spec->'harness_auth') - 'tokenServiceInstanceId')
        || jsonb_build_object('credentialServiceInstanceId', spec #> '{harness_auth,tokenServiceInstanceId}'))
      ELSE spec END AS spec FROM gateway
  ), snapshots AS (
    SELECT id, CASE WHEN jsonb_path_exists(spec->'credential_sources', '$[*] ? (exists(@.tokenServiceInstanceId))')
      THEN jsonb_set(spec, '{credential_sources}', (
        SELECT jsonb_agg(CASE WHEN snapshot ? 'tokenServiceInstanceId'
          THEN (snapshot - 'tokenServiceInstanceId') || jsonb_build_object(
            'credentialServiceInstanceId', snapshot->'tokenServiceInstanceId')
          ELSE snapshot END ORDER BY position)
        FROM jsonb_array_elements(spec->'credential_sources') WITH ORDINALITY AS entries(snapshot, position)))
      ELSE spec END AS spec FROM auth
  )
  UPDATE occ.agent_revisions AS revision SET admitted_spec = snapshots.spec
    FROM snapshots WHERE revision.id = snapshots.id AND revision.admitted_spec IS DISTINCT FROM snapshots.spec;
  ALTER TABLE occ.agent_revisions ENABLE TRIGGER agent_revisions_are_immutable;

  UPDATE occ.authentication_states SET binding = (binding - 'tokenServiceInstanceId')
    || jsonb_build_object('credentialServiceInstanceId', binding->'tokenServiceInstanceId')
    WHERE kind = 'device_authorization' AND binding ? 'tokenServiceInstanceId';

  FOR item IN SELECT * FROM jsonb_to_recordset(definitions) AS checks(relation text, name text, definition text)
  LOOP
    definition := replace(replace(replace(replace(item.definition,
      'TokenService', 'CredentialService'), 'tokenService', 'credentialService'),
      'token_service', 'credential_service'), 'token-service', 'credential-service');
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', item.relation, item.name, definition);
  END LOOP;
END $$;

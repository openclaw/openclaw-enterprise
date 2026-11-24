-- A PAT Source may change owner only after every ordinary serving or dispatch use has settled.
CREATE FUNCTION occ.codex_pat_source_adoption_is_settled(p_namespace text, p_source text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, occ, pg_temp AS $$
  SELECT NOT (
    EXISTS (SELECT 1 FROM occ.agents WHERE namespace_id=p_namespace AND harness_auth_credential_source_id=p_source)
    OR EXISTS (SELECT 1 FROM occ.agent_credential_sources WHERE namespace_id=p_namespace AND credential_source_id=p_source)
    OR EXISTS (
      SELECT 1 FROM occ.agent_revisions r JOIN occ.agents a
        ON (a.namespace_id,a.id,a.active_revision_id)=(r.namespace_id,r.agent_id,r.id)
      WHERE r.namespace_id=p_namespace AND (
        (r.admitted_spec #>> '{harness_auth,method}'='credential_source' AND r.admitted_spec #>> '{harness_auth,sourceId}'=p_source)
        OR r.admitted_spec->'credential_sources' @> jsonb_build_array(jsonb_build_object('sourceId',p_source))))
    OR EXISTS (
      SELECT 1 FROM occ.controller_work w JOIN occ.agent_revisions r
        ON (r.namespace_id,r.agent_id,r.id)=(w.namespace_id,w.agent_id,w.revision_id)
      WHERE w.namespace_id=p_namespace AND w.state IN ('queued','claimed') AND (
        (r.admitted_spec #>> '{harness_auth,method}'='credential_source' AND r.admitted_spec #>> '{harness_auth,sourceId}'=p_source)
        OR r.admitted_spec->'credential_sources' @> jsonb_build_array(jsonb_build_object('sourceId',p_source))))
    OR EXISTS (SELECT 1 FROM occ.agent_provisioning_work WHERE namespace_id=p_namespace AND status IN ('queued','running')
      AND plan #>> '{harnessAuth,method}'='credential_source' AND plan #>> '{harnessAuth,sourceId}'=p_source)
    OR EXISTS (SELECT 1 FROM occ.credential_withdrawals WHERE namespace_id=p_namespace AND credential_source_id=p_source AND state='pending')
    OR EXISTS (
      SELECT 1 FROM occ.egress_installations i JOIN occ.agent_revisions r
        ON (r.namespace_id,r.agent_id,r.id)=(i.namespace_id,i.agent_id,i.revision_id)
      WHERE i.namespace_id=p_namespace AND NOT i.retired AND (
        (r.admitted_spec #>> '{harness_auth,method}'='credential_source' AND r.admitted_spec #>> '{harness_auth,sourceId}'=p_source)
        OR r.admitted_spec->'credential_sources' @> jsonb_build_array(jsonb_build_object('sourceId',p_source))))
    OR EXISTS (SELECT 1 FROM occ.egress_send_receipts WHERE authorized_dispatch IS NOT NULL AND NOT settled
      AND binding #>> '{material,kind}' IN ('static','prepared_github','prepared_token')
      AND binding #>> '{material,source,namespaceId}'=p_namespace AND binding #>> '{material,source,source,id}'=p_source)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.codex_pat_source_adoption_is_settled(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.codex_pat_source_adoption_is_settled(text,text) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.codex_pat_source_transition_is_valid(previous occ.credential_sources, proposed occ.credential_sources)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ, pg_temp AS $$
  SELECT COALESCE(
    (previous).id=(proposed).id AND (previous).namespace_id=(proposed).namespace_id
    AND (previous).name=(proposed).name AND (previous).created_at=(proposed).created_at
    AND (previous).owner_capability='credential_gateway' AND (previous).type='codex-pat'
    AND (previous).state='ready' AND (previous).driver_id IS NOT NULL AND (previous).token_service_instance_id IS NULL
    AND (previous).egress IS NULL AND (previous).connection_template_id IS NULL
    AND (proposed).owner_capability='token_service' AND (proposed).type='static' AND (proposed).state='ready'
    AND (proposed).driver_id IS NULL AND (proposed).token_service_instance_id IS NOT NULL
    AND (proposed).egress IS NULL AND (proposed).connection_template_id IS NULL
    AND (proposed).config='{"provider_preset":"codex-pat"}'::jsonb, false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.codex_pat_source_transition_is_valid(occ.credential_sources,occ.credential_sources) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.codex_pat_source_transition_is_valid(occ.credential_sources,occ.credential_sources) TO occ_app;
--> statement-breakpoint
DROP TRIGGER credential_source_metadata_is_immutable ON occ.credential_sources;
CREATE TRIGGER credential_source_metadata_is_immutable
BEFORE UPDATE OF id,namespace_id,name,created_at ON occ.credential_sources
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
CREATE TRIGGER credential_source_owner_transition_is_restricted
BEFORE UPDATE OF type,driver_id,owner_capability ON occ.credential_sources
FOR EACH ROW WHEN (NOT occ.codex_pat_source_transition_is_valid(OLD,NEW)) EXECUTE FUNCTION occ.reject_row_mutation();
DROP TRIGGER credential_source_instance_is_immutable ON occ.credential_sources;
CREATE TRIGGER credential_source_instance_is_immutable
BEFORE UPDATE OF token_service_instance_id ON occ.credential_sources
FOR EACH ROW WHEN (NEW.token_service_instance_id IS DISTINCT FROM OLD.token_service_instance_id
  AND NOT occ.codex_pat_source_transition_is_valid(OLD,NEW)) EXECUTE FUNCTION occ.reject_row_mutation();
DROP TRIGGER credential_source_config_requires_managed_owner ON occ.credential_sources;
CREATE TRIGGER credential_source_config_requires_managed_owner
BEFORE UPDATE OF config ON occ.credential_sources
FOR EACH ROW WHEN (NEW.config IS DISTINCT FROM OLD.config AND NOT (
  (OLD.token_service_instance_id IS NOT NULL AND NEW.state='ready' AND OLD.state IN ('registering','ready'))
  OR occ.codex_pat_source_transition_is_valid(OLD,NEW))) EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.adopt_codex_pat_source(p_namespace text,p_source text,p_gateway text,p_secret text,p_instance text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, occ, pg_temp AS $$
DECLARE
  source_row occ.credential_sources%ROWTYPE;
  secret_count integer;
BEGIN
  SELECT * INTO source_row FROM occ.credential_sources
    WHERE namespace_id=p_namespace AND id=p_source FOR UPDATE;
  IF NOT FOUND OR source_row.owner_capability<>'credential_gateway' OR source_row.type<>'codex-pat'
    OR source_row.state<>'ready' OR source_row.driver_id IS DISTINCT FROM p_gateway OR source_row.egress IS NOT NULL
    OR source_row.token_service_instance_id IS NOT NULL OR source_row.connection_template_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM occ.namespaces WHERE id=p_namespace AND status='ready' AND deleted_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM occ.token_service_instances WHERE id=p_instance)
    OR NOT occ.codex_pat_source_adoption_is_settled(p_namespace,p_source) THEN RETURN false; END IF;
  SELECT count(*) INTO secret_count FROM occ.credential_source_secrets WHERE namespace_id=p_namespace AND credential_source_id=p_source;
  IF secret_count<>1 OR NOT EXISTS (SELECT 1 FROM occ.credential_source_secrets WHERE namespace_id=p_namespace
    AND credential_source_id=p_source AND field='access_token' AND secret_id=p_secret) THEN RETURN false; END IF;
  DELETE FROM occ.credential_source_secrets WHERE namespace_id=p_namespace AND credential_source_id=p_source
    AND field='access_token' AND secret_id=p_secret;
  IF NOT FOUND THEN RAISE EXCEPTION 'The Source credential input changed during adoption'; END IF;
  UPDATE occ.credential_sources SET owner_capability='token_service',type='static',driver_id=NULL,
    token_service_instance_id=p_instance,config='{"provider_preset":"codex-pat"}'::jsonb
    WHERE namespace_id=p_namespace AND id=p_source;
  IF NOT FOUND THEN RAISE EXCEPTION 'The Source changed during adoption'; END IF;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.adopt_codex_pat_source(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.adopt_codex_pat_source(text,text,text,text,text) TO occ_app;

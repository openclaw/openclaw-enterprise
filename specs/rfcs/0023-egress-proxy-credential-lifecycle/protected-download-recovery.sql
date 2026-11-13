-- Proposed migration for protected download approvals and recovery.
-- The production migration journal does not include this proposal.
CREATE FUNCTION occ.sandbox_policy_legacy_is_valid(document jsonb, id text, namespace_id text, agent_id text, version integer) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(
  jsonb_typeof(document) = 'object' AND document ?& ARRAY['id','namespaceId','agentId','version','additions']
  AND document - 'id' - 'namespaceId' - 'agentId' - 'version' - 'additions' - 'application' - 'applied' = '{}'::jsonb
  AND document->>'id' = id AND id = 'sbp_' || substring(agent_id FROM 5)
  AND document->>'namespaceId' = namespace_id AND document->>'agentId' = agent_id
  AND document->'version' = to_jsonb(version) AND version > 0
  AND occ.sandbox_network_grants_are_valid(document->'additions')
  AND (NOT (document ? 'application') OR (
    jsonb_typeof(document->'application') = 'object'
    AND document->'application' ?& ARRAY['id','revisionId','policyVersion','snapshot','state','requestedBy','requestedAt']
    AND (document->'application') - 'id' - 'revisionId' - 'policyVersion' - 'snapshot' - 'state' - 'requestedBy' - 'requestedAt' - 'expectedProviderVersion' - 'providerVersion' - 'reason' = '{}'::jsonb
    AND document#>>'{application,id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND document#>>'{application,revisionId}' ~ '^rev_[0-9a-f-]{36}$'
    AND jsonb_typeof(document#>'{application,requestedBy}') = 'string'
    AND char_length(document#>>'{application,requestedBy}') > 0
    AND jsonb_typeof(document#>'{application,requestedAt}') = 'string'
    AND document#>>'{application,requestedAt}' ~ '^\d{4}-\d{2}-\d{2}T'
    AND document#>>'{application,state}' IN ('pending','applied','failed')
    AND document#>'{application,policyVersion}' = to_jsonb(version)
    AND jsonb_typeof(document#>'{application,snapshot}') = 'object'
    AND document#>'{application,snapshot,additions}' = document->'additions'
    AND document#>'{application,snapshot,version}' = to_jsonb(version)
    AND document#>'{application,snapshot}' ?& ARRAY['driverId','implementation','version','defaults','additions']
    AND (document#>'{application,snapshot}') - 'driverId' - 'implementation' - 'version' - 'defaults' - 'additions' = '{}'::jsonb
    AND jsonb_typeof(document#>'{application,snapshot,defaults}') = 'object'
    AND jsonb_typeof(document#>'{application,snapshot,driverId}') = 'string'
    AND jsonb_typeof(document#>'{application,snapshot,implementation}') = 'string'
    AND (NOT (document->'application' ? 'expectedProviderVersion') OR (jsonb_typeof(document#>'{application,expectedProviderVersion}') = 'string' AND char_length(document#>>'{application,expectedProviderVersion}') BETWEEN 1 AND 256))
    AND (document#>>'{application,state}' <> 'applied' OR (jsonb_typeof(document#>'{application,providerVersion}') = 'string' AND char_length(document#>>'{application,providerVersion}') > 0))
  ))
  AND (NOT (document ? 'applied') OR (
    jsonb_typeof(document->'applied') = 'object'
    AND document->'applied' ?& ARRAY['revisionId','policyVersion','providerVersion','appliedAt']
    AND (document->'applied') - 'revisionId' - 'policyVersion' - 'providerVersion' - 'appliedAt' = '{}'::jsonb
    AND document#>>'{applied,revisionId}' ~ '^rev_[0-9a-f-]{36}$'
    AND jsonb_typeof(document#>'{applied,policyVersion}') = 'number'
    AND (document#>>'{applied,policyVersion}')::numeric BETWEEN 1 AND version
    AND mod((document#>>'{applied,policyVersion}')::numeric,1) = 0
    AND jsonb_typeof(document#>'{applied,providerVersion}') = 'string'
    AND char_length(document#>>'{applied,providerVersion}') > 0
    AND jsonb_typeof(document#>'{applied,appliedAt}') = 'string'
  )), false) $$;

CREATE FUNCTION occ.download_destinations_are_valid(entries jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE destination jsonb; host_name text; object_path text;
BEGIN
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(entries) > 32 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT e) FROM jsonb_array_elements(entries) e) <> jsonb_array_length(entries) THEN RETURN false; END IF;
  FOR destination IN SELECT * FROM jsonb_array_elements(entries) LOOP
    IF jsonb_typeof(destination) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT (destination ?& ARRAY['scheme','host','port'])
      OR destination - ARRAY['scheme','host','port','path'] <> '{}'::jsonb
      OR jsonb_typeof(destination->'host') IS DISTINCT FROM 'string'
      OR ((destination->'scheme' = '"https"' AND destination->'port' = '443'::jsonb)
       OR (destination->'scheme' = '"http"' AND destination->'port' = '80'::jsonb)) IS NOT TRUE THEN RETURN false; END IF;
    host_name := destination->>'host';
    IF octet_length(host_name) > 253 OR host_name COLLATE "C" !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,58}[a-z0-9])$'
      OR host_name COLLATE "C" ~ '\.(arpa|internal|local|localdomain[46]?|localhost|lan|home|corp|intranet|private|svc|onion|test|invalid|example|alt)$' THEN RETURN false; END IF;
    IF destination ? 'path' THEN
      object_path := destination->>'path';
      IF jsonb_typeof(destination->'path') IS DISTINCT FROM 'string' OR octet_length(object_path) > 2048
        OR object_path COLLATE "C" !~ '^(/[A-Za-z0-9._~+:@-]+)+$' OR object_path ~ '/\.{1,2}(/|$)' THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- OCC orders the complete ASCII URL, including the port and optional object path.
CREATE FUNCTION occ.download_destinations_with_entry(entries jsonb, destination jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
 SELECT jsonb_agg(e ORDER BY ((e->>'scheme') || '://' || (e->>'host') || ':' ||
   (e->>'port') || coalesce(e->>'path','')) COLLATE "C")
 FROM jsonb_array_elements(entries || jsonb_build_array(destination)) e
$$;

-- Apply the explicit edit to one starting set. The writer checks Installation
-- delegation. Storage can infer the claimed retained coverage from both results.
CREATE FUNCTION occ.project_download_destinations(entries jsonb, op text, destination jsonb, delegation jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
 SELECT CASE
   WHEN op IN ('enable','approve-and-enable') THEN
     CASE WHEN EXISTS (SELECT FROM jsonb_array_elements(entries) e WHERE e=destination) THEN entries
       ELSE occ.download_destinations_with_entry(entries,destination) END
   ELSE (SELECT coalesce(jsonb_agg(e ORDER BY ord),'[]') FROM jsonb_array_elements(entries) WITH ORDINALITY t(e,ord)
     WHERE CASE WHEN op='disable' THEN e<>destination
       ELSE (destination<>e AND destination<>e-'path') OR EXISTS (
         SELECT FROM jsonb_array_elements(delegation) scope WHERE scope=e OR scope=e-'path') END)
 END
$$;

CREATE FUNCTION occ.protected_download_projections_valid(a jsonb, durable jsonb, approved jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
 WITH inputs AS (SELECT a->>'action' op, a->'destination' d, a->'priorApprovedDownloadDestinations' approvals,
   a->'priorDesiredDownloadDestinations' prior, a->'previousDownloadDestinations' original,
   a->'desiredDownloadDestinations' target, a->>'state'='failed' AND a->>'writeState'='prepared' restored),
 ceiling AS (SELECT *, CASE op
   WHEN 'withdraw-approval' THEN occ.project_download_destinations(approvals,'disable',d,'[]')
   WHEN 'approve-and-enable' THEN occ.project_download_destinations(approvals,'enable',d,'[]')
   ELSE approvals END AS remaining FROM inputs),
 -- Only retained entries within the withdrawal imply Installation coverage.
 projections AS (SELECT *, remaining || coalesce((
   SELECT jsonb_agg(e) FROM jsonb_array_elements(target || CASE WHEN restored THEN '[]'::jsonb ELSE durable END) e
   WHERE d=e OR d=e-'path'
 ), '[]'::jsonb) AS delegation FROM ceiling)
 SELECT (op<>'withdraw-approval' OR remaining<>approvals)
   AND target=occ.project_download_destinations(original,op,d,delegation)
   AND CASE WHEN restored THEN durable=prior AND approved=approvals
     ELSE approved=remaining AND durable=occ.project_download_destinations(prior,op,d,delegation) END
 FROM projections
$$;

CREATE FUNCTION occ.protected_download_fence_valid(f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 WITH peer AS (SELECT f->'peer' p, f#>'{peer,repositoryGitRecipient}' r)
 SELECT coalesce(jsonb_typeof(f)='object' AND f - ARRAY['sandboxId','instanceId','configurationId','peer','installationLimitsHash','providerResourceVersion','policyVersion','sourcePolicyHash','effectivePolicyHash']='{}'
 AND (SELECT bool_and(jsonb_typeof(f->k)='string' AND octet_length(f->>k) BETWEEN 1 AND 256 AND (f->>k) COLLATE "C" ~ '^[A-Za-z0-9._:-]+$')
      FROM unnest(ARRAY['sandboxId','instanceId','configurationId','providerResourceVersion']) k)
 AND f ?& ARRAY['sandboxId','instanceId','configurationId','peer','installationLimitsHash','providerResourceVersion','policyVersion','sourcePolicyHash','effectivePolicyHash']
 AND jsonb_typeof(f->'installationLimitsHash')='string' AND (f->>'installationLimitsHash') ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(p)='object' AND
 (CASE WHEN p ? 'keyId' THEN p-'keyId'='{}' AND jsonb_typeof(p->'keyId')='string' AND (p->>'keyId') COLLATE "C"  ~ '^[A-Za-z0-9._:-]+$' AND octet_length(p->>'keyId') BETWEEN 1 AND 256
 ELSE p-'repositoryGitRecipient'='{}' AND jsonb_typeof(r)='object'
   AND r ?& ARRAY['providerId','attachmentEpoch','processInstanceId','networkInstanceId']
   AND r-ARRAY['providerId','attachmentEpoch','processInstanceId','networkInstanceId','deliveryProfile','authorization','observedHook']='{}'
   AND (SELECT bool_and(jsonb_typeof(r->k)='string' AND octet_length(r->>k) BETWEEN 1 AND 256 AND (r->>k) COLLATE "C" ~ '^[A-Za-z0-9._:-]+$')
        FROM unnest(ARRAY['providerId','attachmentEpoch','processInstanceId','networkInstanceId']) k)
   AND (NOT r ? 'deliveryProfile' OR r->>'deliveryProfile' IN ('github_installation','github_repository'))
   AND (CASE WHEN r->>'authorization'='request-hook-observed' THEN r->>'deliveryProfile'='github_installation'
       AND jsonb_typeof(r->'observedHook')='object' AND (r->'observedHook')-ARRAY['startupId','observationId']='{}'
       AND jsonb_typeof(r#>'{observedHook,startupId}')='string' AND r#>>'{observedHook,startupId}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       AND jsonb_typeof(r#>'{observedHook,observationId}')='string' AND r#>>'{observedHook,observationId}' ~ '^[0-9a-f]{64}$'
       ELSE NOT r ? 'observedHook' AND (NOT r ? 'authorization' OR r->>'authorization'='online-request') END)
 END)
 AND jsonb_typeof(f->'policyVersion')='number' AND (f->>'policyVersion') ~ '^[1-9][0-9]{0,15}$'
 AND f->'policyVersion' <= '4294967295'::jsonb
 AND jsonb_typeof(f->'sourcePolicyHash')='string' AND (f->>'sourcePolicyHash') ~ '^[0-9a-f]{64}$'
 AND jsonb_typeof(f->'effectivePolicyHash')='string' AND (f->>'effectivePolicyHash') ~ '^[0-9a-f]{64}$', false) FROM peer
$$;

CREATE OR REPLACE FUNCTION occ.sandbox_policy_is_valid(document jsonb,id text,namespace_id text,agent_id text,version integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE legacy jsonb;
 a jsonb:=document->'application'; r jsonb:=document->'applied'; w jsonb:=a->'acknowledgedWrite';
BEGIN
 IF jsonb_typeof(document) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 legacy:=document - ARRAY['approvedDownloadDestinations','downloadDestinations'];
 IF (document ? 'downloadDestinations' AND NOT occ.download_destinations_are_valid(document->'downloadDestinations'))
 OR (document ? 'approvedDownloadDestinations' AND NOT occ.download_destinations_are_valid(document->'approvedDownloadDestinations')) THEN RETURN false; END IF;
 IF a->>'kind'='protected_downloads' THEN
   IF (jsonb_typeof(a)='object'
    AND a ?& ARRAY['id','revisionId','policyVersion','state','requestedBy','requestedAt','action','destination','priorDesiredDownloadDestinations','priorApprovedDownloadDestinations','previousDownloadDestinations','desiredDownloadDestinations','expected','desiredSourcePolicyHash','writeState']
    AND a - ARRAY['kind','id','revisionId','policyVersion','state','requestedBy','requestedAt','action','destination','priorDesiredDownloadDestinations','priorApprovedDownloadDestinations','previousDownloadDestinations','desiredDownloadDestinations','expected','desiredSourcePolicyHash','writeState','acknowledgedWrite','providerVersion','reason']='{}'
    AND (a->>'id') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND (a->>'revisionId') ~ '^rev_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND a->'policyVersion'=to_jsonb(version)
    AND jsonb_typeof(a->'requestedBy')='string' AND octet_length(a->>'requestedBy') BETWEEN 1 AND 512
    AND pg_input_is_valid(a->>'requestedAt','timestamptz') AND jsonb_typeof(a->'requestedAt')='string' AND (a->>'requestedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
    AND jsonb_typeof(a->'desiredSourcePolicyHash')='string' AND (a->>'desiredSourcePolicyHash') ~ '^[0-9a-f]{64}$'
    AND a->>'action' IN ('enable','approve-and-enable','disable','withdraw-approval')
    AND occ.download_destinations_are_valid(jsonb_build_array(a->'destination'))
    AND occ.download_destinations_are_valid(a->'priorDesiredDownloadDestinations')
    AND occ.download_destinations_are_valid(a->'priorApprovedDownloadDestinations')
    AND occ.download_destinations_are_valid(a->'previousDownloadDestinations')
    AND occ.download_destinations_are_valid(a->'desiredDownloadDestinations')
    AND occ.protected_download_fence_valid(a->'expected')
    AND a->>'writeState' IN ('prepared','dispatched')
    AND a->>'state' IN ('pending','failed','applied')
    AND (a->>'state'='failed')=(a ? 'reason') AND (a->>'state'='applied')=(a ? 'providerVersion')
    AND (NOT (a ? 'reason') OR (jsonb_typeof(a->'reason')='string' AND (a->>'reason') ~ '^[A-Z][A-Z0-9_]{0,127}$'))
    AND (a->>'state'<>'applied' OR (jsonb_typeof(a->'providerVersion')='string' AND a->>'writeState'='dispatched'))
    AND (w IS NULL OR (a->>'writeState'='dispatched' AND jsonb_typeof(w)='object'
      AND w - ARRAY['state','operationId','sandboxId','policyVersion','sourcePolicyHash']='{}'
      AND w->>'state'='committed' AND w->'operationId'=a->'id' AND w->'sandboxId'=a#>'{expected,sandboxId}' AND w->'sourcePolicyHash'=a->'desiredSourcePolicyHash'
      AND jsonb_typeof(w->'policyVersion')='number' AND (w->>'policyVersion') ~ '^[1-9][0-9]{0,15}$'
      AND w->'policyVersion' <= '4294967295'::jsonb AND w->'policyVersion' > a#>'{expected,policyVersion}'
      AND jsonb_typeof(w->'sourcePolicyHash')='string' AND (w->>'sourcePolicyHash') ~ '^[0-9a-f]{64}$'))) IS NOT TRUE THEN RETURN false; END IF;
   IF NOT occ.protected_download_projections_valid(a,coalesce(document->'downloadDestinations','[]'),coalesce(document->'approvedDownloadDestinations','[]')) THEN RETURN false; END IF;
   legacy:=legacy-'application';
 END IF;
 IF r->>'kind'='protected_downloads' THEN
   IF (jsonb_typeof(r)='object' AND r - ARRAY['kind','revisionId','policyVersion','providerVersion','appliedAt','operationId','confirmedDownloadDestinations','fence']='{}'
     AND (r->>'operationId') ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
     AND jsonb_typeof(r->'policyVersion')='number' AND r->'policyVersion' <= to_jsonb(version) AND r->'policyVersion' >= '1'::jsonb AND (r->>'policyVersion') ~ '^[1-9][0-9]*$'
     AND r->>'providerVersion'=r#>>'{fence,policyVersion}' AND occ.download_destinations_are_valid(r->'confirmedDownloadDestinations') AND occ.protected_download_fence_valid(r->'fence')
     AND pg_input_is_valid(r->>'appliedAt','timestamptz') AND r->>'appliedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$') IS NOT TRUE THEN RETURN false; END IF;
   legacy:=jsonb_set(legacy,'{applied}',r-ARRAY['kind','operationId','confirmedDownloadDestinations','fence']);
 END IF;
 RETURN occ.sandbox_policy_legacy_is_valid(legacy,id,namespace_id,agent_id,version) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION occ.sandbox_policy_legacy_is_valid(jsonb,text,text,text,integer),occ.download_destinations_are_valid(jsonb),occ.download_destinations_with_entry(jsonb,jsonb),occ.project_download_destinations(jsonb,text,jsonb,jsonb),occ.protected_download_projections_valid(jsonb,jsonb,jsonb),occ.protected_download_fence_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.sandbox_policy_legacy_is_valid(jsonb,text,text,text,integer),occ.download_destinations_are_valid(jsonb),occ.download_destinations_with_entry(jsonb,jsonb),occ.project_download_destinations(jsonb,text,jsonb,jsonb),occ.protected_download_projections_valid(jsonb,jsonb,jsonb),occ.protected_download_fence_valid(jsonb) TO occ_app;
ALTER TABLE occ.controller_work ADD COLUMN protected_download_recovery jsonb;
CREATE INDEX controller_work_protected_download_recovery_idx ON occ.controller_work(idempotency_key)
  WHERE protected_download_recovery IS NOT NULL;

-- Only the original terminal, correctly attributed SandboxPolicy operation is a recovery owner.
CREATE FUNCTION occ.protected_download_recovery_payload(doc jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('version',1,'operationId',a->'id','revisionId',a->'revisionId',
   'policyVersion',a->'policyVersion','action',a->'action','destination',a->'destination',
   'expected',a->'expected','previous',a->'previousDownloadDestinations',
   'desired',a->'desiredDownloadDestinations','desiredSourcePolicyHash',a->'desiredSourcePolicyHash')
   || CASE WHEN a ? 'acknowledgedWrite' THEN jsonb_build_object('acknowledgedWrite',a->'acknowledgedWrite') ELSE '{}'::jsonb END
   || CASE WHEN doc ? 'applied' THEN jsonb_build_object('priorConfirmation',doc->'applied') ELSE '{}'::jsonb END
 FROM (SELECT doc->'application' AS a) head
 WHERE a->>'kind'='protected_downloads' AND a->>'state'='failed' AND a->>'writeState'='dispatched'
$$;
CREATE FUNCTION occ.can_retain_protected_download_recovery(ns text,agent text,key text,actor text,payload jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS (
   SELECT FROM occ.controller_work w JOIN occ.sandbox_policies p USING(namespace_id,agent_id)
   WHERE w.namespace_id=ns AND w.agent_id=agent AND w.idempotency_key=key AND w.actor_id=actor
     AND w.state='failed_permanent' AND w.work_kind='lifecycle' AND w.revision_id IS NULL
     AND w.namespace_target IS NULL AND w.agent_target='sandbox_policy'
     AND key='agent:'||agent||':reconcile:sandbox_policy:'||(p.document#>>'{application,id}')
     AND p.document#>>'{application,requestedBy}'=actor AND occ.protected_download_recovery_payload(p.document)=payload
     AND (w.protected_download_recovery IS NULL OR w.protected_download_recovery=payload))
$$;
CREATE FUNCTION occ.preserve_protected_download_recovery(ns text,agent text,key text,actor text,payload jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM 1 FROM occ.controller_work w WHERE w.idempotency_key=key AND w.agent_id=agent AND w.namespace_id=ns FOR UPDATE;
 IF NOT FOUND OR NOT occ.can_retain_protected_download_recovery(ns,agent,key,actor,payload) THEN RETURN false; END IF;
 UPDATE occ.controller_work SET protected_download_recovery=payload WHERE idempotency_key=key;
 RETURN true;
END $$;
-- The repository verifies the authenticated disposition and writes sanitized audit in the same transaction.
CREATE FUNCTION occ.clear_protected_download_recovery(ns text,agent text,key text,actor text,payload jsonb)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 WITH cleared AS (
   UPDATE occ.controller_work w SET protected_download_recovery=NULL
   WHERE w.namespace_id=ns AND w.agent_id=agent AND w.idempotency_key=key AND w.actor_id=actor
     AND w.state='failed_permanent' AND w.protected_download_recovery=payload
     AND EXISTS (SELECT FROM occ.sandbox_policies p WHERE (p.namespace_id,p.agent_id)=(ns,agent)
       AND p.document#>>'{application,id}' IS DISTINCT FROM payload->>'operationId')
   RETURNING 1)
 SELECT EXISTS(SELECT FROM cleared)
$$;

-- Existing table-wide INSERT privileges must not allow self-issued recovery evidence.
CREATE FUNCTION occ.guard_protected_download_recovery_work() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.protected_download_recovery IS NOT NULL THEN
   RAISE EXCEPTION 'Cannot enqueue private recovery evidence' USING ERRCODE='23514';
 ELSIF TG_OP='UPDATE' AND OLD.protected_download_recovery IS NOT NULL AND
   (NEW.state,NEW.idempotency_key,NEW.namespace_id,NEW.agent_id,NEW.actor_id,NEW.agent_target,NEW.revision_id,NEW.work_kind,NEW.namespace_target)
    IS DISTINCT FROM
   (OLD.state,OLD.idempotency_key,OLD.namespace_id,OLD.agent_id,OLD.actor_id,OLD.agent_target,OLD.revision_id,OLD.work_kind,OLD.namespace_target) THEN
   RAISE EXCEPTION 'Cannot reopen or reassign retained work' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_protected_download_recovery_work BEFORE INSERT OR UPDATE ON occ.controller_work
 FOR EACH ROW EXECUTE FUNCTION occ.guard_protected_download_recovery_work();
-- A preserved record and superseding head commit together. The application performs
-- both writes under its Agent lock. A standalone preservation cannot commit.
CREATE FUNCTION occ.require_protected_download_supersession() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS (SELECT FROM occ.sandbox_policies p WHERE (p.namespace_id,p.agent_id)=(NEW.namespace_id,NEW.agent_id)
       AND p.document#>>'{application,id}'=NEW.protected_download_recovery->>'operationId') THEN
   RAISE EXCEPTION 'Original work preservation requires atomic supersession' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_protected_download_supersession AFTER UPDATE OF protected_download_recovery ON occ.controller_work
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (OLD.protected_download_recovery IS NULL AND NEW.protected_download_recovery IS NOT NULL)
 EXECUTE FUNCTION occ.require_protected_download_supersession();
REVOKE ALL ON FUNCTION occ.require_protected_download_supersession() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.protected_download_recovery_payload(jsonb),occ.can_retain_protected_download_recovery(text,text,text,text,jsonb),
 occ.preserve_protected_download_recovery(text,text,text,text,jsonb),occ.clear_protected_download_recovery(text,text,text,text,jsonb),
 occ.guard_protected_download_recovery_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.protected_download_recovery_payload(jsonb),occ.can_retain_protected_download_recovery(text,text,text,text,jsonb),
 occ.preserve_protected_download_recovery(text,text,text,text,jsonb),occ.clear_protected_download_recovery(text,text,text,text,jsonb) TO occ_app;

CREATE OR REPLACE FUNCTION occ.guard_sandbox_policy_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
 a jsonb:=NEW.document->'application'; prev jsonb:=OLD.document->'application';
 receipt jsonb:=NEW.document->'applied'; prior jsonb:=OLD.document->'applied';
 previously jsonb:=coalesce(OLD.document->'downloadDestinations','[]'); desired jsonb:=coalesce(NEW.document->'downloadDestinations','[]');
 approvals jsonb:=coalesce(OLD.document->'approvedDownloadDestinations','[]'); approved jsonb:=coalesce(NEW.document->'approvedDownloadDestinations','[]');
 live boolean;
BEGIN
 IF (OLD.document ? 'approvedDownloadDestinations' AND NOT NEW.document ? 'approvedDownloadDestinations')
 OR (OLD.document ? 'downloadDestinations' AND NOT NEW.document ? 'downloadDestinations')
 OR (prev->>'state'='pending' AND a IS NULL)
 OR (NEW.version=OLD.version AND prev->>'kind'='protected_downloads' AND prev->>'state'<>'pending' AND a IS DISTINCT FROM prev)
 THEN RAISE EXCEPTION 'Cannot erase protected state, discard pending work or rewrite terminal operation' USING ERRCODE='23514'; END IF;

 IF a->>'kind'='protected_downloads' THEN
   IF NEW.version=OLD.version AND NEW.document=OLD.document THEN RETURN NEW; END IF;
   IF NOT occ.sandbox_policy_is_valid(NEW.document,NEW.id,NEW.namespace_id,NEW.agent_id,NEW.version) THEN
     RAISE EXCEPTION 'Invalid protected operation document' USING ERRCODE='23514'; END IF;
   SELECT EXISTS (SELECT FROM occ.agents g JOIN occ.agent_revisions v ON (v.namespace_id,v.agent_id,v.id)=(g.namespace_id,g.id,g.active_revision_id)
     WHERE (g.namespace_id,g.id)=(NEW.namespace_id,NEW.agent_id) AND v.id=a->>'revisionId'
     AND v.admitted_spec#>>'{execution_admission,mode}'='protected') INTO live;
   IF NEW.version=OLD.version+1 THEN
     IF EXISTS (SELECT FROM occ.controller_work w WHERE w.namespace_id=NEW.namespace_id AND w.agent_id=NEW.agent_id
         AND w.protected_download_recovery IS NOT NULL AND
         (w.protected_download_recovery->'revisionId'=a->'revisionId'
          OR w.protected_download_recovery#>'{expected,sandboxId}'=a#>'{expected,sandboxId}'
          OR w.protected_download_recovery#>'{expected,instanceId}'=a#>'{expected,instanceId}')) THEN
       RAISE EXCEPTION 'Cannot reuse an unresolved original target' USING ERRCODE='23514'; END IF;
     IF prev->>'kind'='protected_downloads' AND prev->>'state'='failed' AND prev->>'writeState'='dispatched' THEN
       IF NOT EXISTS (SELECT FROM occ.controller_work w WHERE w.namespace_id=OLD.namespace_id AND w.agent_id=OLD.agent_id
         AND w.idempotency_key='agent:'||OLD.agent_id||':reconcile:sandbox_policy:'||(prev->>'id')
         AND w.actor_id=prev->>'requestedBy' AND w.state='failed_permanent'
         AND w.protected_download_recovery=occ.protected_download_recovery_payload(OLD.document)) THEN
         RAISE EXCEPTION 'Missing original fenced recovery evidence' USING ERRCODE='23514'; END IF;
       previously:=prev->'priorDesiredDownloadDestinations'; approvals:=prev->'priorApprovedDownloadDestinations';
     END IF;
     IF NOT live OR a->>'state'<>'pending' OR a->>'writeState'<>'prepared' OR a ? 'acknowledgedWrite'
       OR prev->>'state'='pending'
       OR a->'priorDesiredDownloadDestinations' IS DISTINCT FROM previously OR a->'priorApprovedDownloadDestinations' IS DISTINCT FROM approvals
       OR a->'id' IS NOT DISTINCT FROM prev->'id' OR a->'id' IS NOT DISTINCT FROM prior->'operationId'
       OR receipt IS DISTINCT FROM prior OR NEW.document->'additions' IS DISTINCT FROM OLD.document->'additions'
       OR (CASE WHEN prior->>'kind'='protected_downloads' AND prior->'revisionId'=a->'revisionId'

         THEN (prior->'fence')-'installationLimitsHash' IS DISTINCT FROM (a->'expected')-'installationLimitsHash' OR prior->'confirmedDownloadDestinations' IS DISTINCT FROM a->'previousDownloadDestinations'
         ELSE a->'previousDownloadDestinations'<>'[]'::jsonb END)
     THEN RAISE EXCEPTION 'Invalid protected admission or prior evidence' USING ERRCODE='23514'; END IF;
     IF previously=desired AND approvals=approved AND a->'previousDownloadDestinations'=a->'desiredDownloadDestinations' THEN
       RAISE EXCEPTION 'Protected action has no effect' USING ERRCODE='23514'; END IF;
   ELSIF NEW.version=OLD.version THEN
     IF prev->>'kind' IS DISTINCT FROM 'protected_downloads' OR prev->>'state' IS DISTINCT FROM 'pending'
       OR (NEW.document - ARRAY['application','applied','downloadDestinations','approvedDownloadDestinations']) IS DISTINCT FROM (OLD.document - ARRAY['application','applied','downloadDestinations','approvedDownloadDestinations'])
       OR ((desired IS DISTINCT FROM previously OR approved IS DISTINCT FROM approvals)
           AND NOT (a->>'state'='failed' AND a->>'writeState'='prepared'))
       OR (a-ARRAY['state','reason','providerVersion','acknowledgedWrite','writeState']) IS DISTINCT FROM (prev-ARRAY['state','reason','providerVersion','acknowledgedWrite','writeState'])
       OR (prev ? 'acknowledgedWrite' AND prev->'acknowledgedWrite' IS DISTINCT FROM a->'acknowledgedWrite')
       OR (prev->>'writeState'='dispatched' AND a->>'writeState'<>'dispatched' AND a->>'state'<>'failed')
       OR (prev->>'writeState'='prepared' AND a->>'writeState'='dispatched' AND (NOT live OR a->>'state'<>'pending' OR a ? 'acknowledgedWrite'))
     THEN RAISE EXCEPTION 'Invalid protected checkpoint or application identity' USING ERRCODE='23514'; END IF;
     IF a->>'state'='applied' THEN
       IF (live AND receipt->>'kind'='protected_downloads' AND receipt->'operationId'=a->'id'
         AND receipt->'revisionId'=a->'revisionId' AND receipt->'policyVersion'=a->'policyVersion'
         AND receipt->'providerVersion'=a->'providerVersion' AND receipt->'confirmedDownloadDestinations'=a->'desiredDownloadDestinations'
         AND ((receipt->'fence')-ARRAY['configurationId','providerResourceVersion','policyVersion','sourcePolicyHash','effectivePolicyHash'])=((a->'expected')-ARRAY['configurationId','providerResourceVersion','policyVersion','sourcePolicyHash','effectivePolicyHash'])
         AND receipt#>'{fence,policyVersion}'>a#>'{expected,policyVersion}' AND receipt#>'{fence,providerResourceVersion}'<>a#>'{expected,providerResourceVersion}'
         AND (a ? 'acknowledgedWrite' AND a#>'{acknowledgedWrite,sourcePolicyHash}'=receipt#>'{fence,sourcePolicyHash}' AND a#>'{acknowledgedWrite,policyVersion}'=receipt#>'{fence,policyVersion}')) IS NOT TRUE
       THEN RAISE EXCEPTION 'Confirmation must match live target, write and resulting policy' USING ERRCODE='23514'; END IF;
     ELSIF receipt IS DISTINCT FROM prior THEN RAISE EXCEPTION 'Cannot replace prior confirmation' USING ERRCODE='23514'; END IF;
   ELSE RAISE EXCEPTION 'Invalid protected policy version' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF NEW.document->'downloadDestinations' IS DISTINCT FROM OLD.document->'downloadDestinations'
   OR NEW.document->'approvedDownloadDestinations' IS DISTINCT FROM OLD.document->'approvedDownloadDestinations'
   OR (prev->>'kind'='protected_downloads' AND (prev->>'state'='pending' OR (prev->>'state'='failed' AND prev->>'writeState'='dispatched')))
   OR (receipt IS DISTINCT FROM prior AND (receipt->>'kind'='protected_downloads' OR prev->>'state' IS DISTINCT FROM 'pending'))
 THEN RAISE EXCEPTION 'Protected state requires protected admission or confirmation' USING ERRCODE='23514'; END IF;
  IF NEW.version NOT IN (OLD.version, OLD.version + 1)
    OR (NEW.version = OLD.version AND NEW.document->'additions' IS DISTINCT FROM OLD.document->'additions')
    OR (NEW.version <> OLD.version AND (OLD.document#>>'{application,state}' = 'pending' OR NEW.document ? 'application')) THEN
    RAISE EXCEPTION 'Invalid sandbox policy version transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.document ? 'application' THEN
    IF NOT EXISTS (SELECT 1 FROM occ.agent_revisions WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id AND id = NEW.document#>>'{application,revisionId}') THEN
      RAISE EXCEPTION 'Sandbox policy application revision has a different owner' USING ERRCODE = '23514';
    END IF;
    IF NEW.document#>>'{application,id}' = OLD.document#>>'{application,id}' THEN
      IF (NEW.document->'application') - 'state' - 'expectedProviderVersion' - 'providerVersion' - 'reason'
          IS DISTINCT FROM (OLD.document->'application') - 'state' - 'expectedProviderVersion' - 'providerVersion' - 'reason'
        OR (OLD.document#>>'{application,expectedProviderVersion}' IS NOT NULL AND NEW.document#>>'{application,expectedProviderVersion}' IS DISTINCT FROM OLD.document#>>'{application,expectedProviderVersion}')
        OR (OLD.document#>>'{application,state}' <> 'pending' AND NEW.document->'application' IS DISTINCT FROM OLD.document->'application') THEN
        RAISE EXCEPTION 'Sandbox policy application identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.document#>>'{application,state}' = 'pending' OR NEW.document#>>'{application,state}' <> 'pending' OR NEW.document->'application' ? 'expectedProviderVersion' THEN
      RAISE EXCEPTION 'Invalid sandbox policy application transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.document->'applied' IS DISTINCT FROM OLD.document->'applied' AND (
    NEW.document#>>'{application,state}' IS DISTINCT FROM 'applied'
    OR NEW.document#>'{applied,policyVersion}' IS DISTINCT FROM NEW.document#>'{application,policyVersion}'
    OR NEW.document#>'{applied,revisionId}' IS DISTINCT FROM NEW.document#>'{application,revisionId}'
    OR NEW.document#>'{applied,providerVersion}' IS DISTINCT FROM NEW.document#>'{application,providerVersion}'
  ) THEN
    RAISE EXCEPTION 'Applied policy requires confirmed application evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

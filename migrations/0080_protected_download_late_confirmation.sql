CREATE OR REPLACE FUNCTION occ.guard_sandbox_policy_update() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
 a jsonb:=NEW.document->'application'; prev jsonb:=OLD.document->'application';
 receipt jsonb:=NEW.document->'applied'; prior jsonb:=OLD.document->'applied';
 previously jsonb:=coalesce(OLD.document->'downloadDestinations','[]'); desired jsonb:=coalesce(NEW.document->'downloadDestinations','[]');
 approvals jsonb:=coalesce(OLD.document->'approvedDownloadDestinations','[]'); approved jsonb:=coalesce(NEW.document->'approvedDownloadDestinations','[]');
 live boolean;
 late_confirmation boolean:=false;
BEGIN
 -- A read can confirm the original dispatch after its work reaches terminal failure.
 IF (NEW.version=OLD.version
     AND prev->>'kind'='protected_downloads'
     AND prev->>'state'='failed' AND prev->>'writeState'='dispatched'
     AND a->>'kind'='protected_downloads'
     AND a->>'state'='applied' AND a->>'writeState'='dispatched'
     AND (NEW.document-ARRAY['application','applied'])=(OLD.document-ARRAY['application','applied'])
     AND occ.can_retain_protected_download_recovery(
       OLD.namespace_id,OLD.agent_id,'agent:'||OLD.agent_id||':reconcile:sandbox_policy:'||(prev->>'id'),
       prev->>'requestedBy',occ.protected_download_recovery_payload(OLD.document))) IS TRUE THEN
   PERFORM 1 FROM occ.agents g
   JOIN occ.agent_revisions v ON (v.namespace_id,v.agent_id,v.id)=(g.namespace_id,g.id,g.active_revision_id)
   WHERE (g.namespace_id,g.id)=(OLD.namespace_id,OLD.agent_id) AND v.id=prev->>'revisionId'
     AND g.status='active' AND g.desired_runtime_state='running'
     AND v.admitted_spec#>>'{execution_admission,mode}'='protected'
   FOR SHARE OF g;
   late_confirmation:=FOUND;
 END IF;

 IF (OLD.document ? 'approvedDownloadDestinations' AND NOT NEW.document ? 'approvedDownloadDestinations')
 OR (OLD.document ? 'downloadDestinations' AND NOT NEW.document ? 'downloadDestinations')
 OR (prev->>'state'='pending' AND a IS NULL)
 OR (NEW.version=OLD.version AND prev->>'kind'='protected_downloads' AND prev->>'state'<>'pending'
     AND a IS DISTINCT FROM prev AND NOT late_confirmation)
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
     IF prev->>'kind' IS DISTINCT FROM 'protected_downloads' OR (prev->>'state' IS DISTINCT FROM 'pending' AND NOT late_confirmation)
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
--> statement-breakpoint
CREATE INDEX sandbox_policies_protected_download_confirmation_idx ON occ.sandbox_policies(agent_id,namespace_id)
  WHERE document#>>'{application,kind}'='protected_downloads'
    AND document#>>'{application,state}'='failed'
    AND document#>>'{application,writeState}'='dispatched';

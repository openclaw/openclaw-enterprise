-- Common delivery ownership is independent of the selected transport. Old provider
-- receipts stay in their original table as history; current writers use this owner.
CREATE TABLE occ.credential_deliveries (
  revision_id text NOT NULL REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
  binding_id text NOT NULL CHECK (binding_id <> ''),
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  fence bigint NOT NULL DEFAULT 1 CHECK (fence >= 1),
  worker_instance uuid NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  desired jsonb CHECK (jsonb_typeof(desired) = 'object'),
  observed jsonb CHECK (jsonb_typeof(observed) = 'object'),
  material_version uuid,
  preparation_attempt_id uuid,
  target_material_version uuid,
  target_preparation_attempt_id uuid,
  write_pending text CHECK (write_pending IN ('bootstrap','rotate')),
  blocked text,
  retained_policy_hash text CHECK (retained_policy_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (revision_id,binding_id),
  UNIQUE (revision_id,target),
  CHECK ((material_version IS NULL) = (preparation_attempt_id IS NULL)),
  CHECK ((target_material_version IS NULL) = (target_preparation_attempt_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX credential_deliveries_namespace ON occ.credential_deliveries(namespace_id);
--> statement-breakpoint
-- Drain in-flight writes before copying either receipt. Hold the lock until the old
-- writer is fenced, so an accepted detach cannot become a new send opportunity.
LOCK TABLE occ.openshell_git_routes IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO occ.credential_deliveries
  (revision_id,binding_id,namespace_id,agent_id,target,fence,worker_instance,adopted_at,updated_at,
   desired,observed,material_version,preparation_attempt_id,write_pending,blocked,retained_policy_hash)
SELECT revision_id,binding_id,namespace_id,agent_id,
       jsonb_build_object('transport','openshell-repository-git/v1','workspace',workspace,'sandbox',sandbox),
       fence,worker_instance,adopted_at,updated_at,
       CASE WHEN provider_id IS NOT NULL THEN jsonb_build_object('providerId',provider_id,
         'profileVersion',profile_version,'resourceVersion',provider_resource_version,
         'credentialState',credential_state,'expiresAt',coalesce(to_char(material_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'')) END,
       observed,material_version,preparation_attempt_id,write_pending,blocked,retained_launch_hash
FROM occ.openshell_git_routes;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence,worker_instance,adopted_at,updated_at,desired,observed,
  material_version,preparation_attempt_id,target_material_version,target_preparation_attempt_id,write_pending,blocked,retained_policy_hash)
ON occ.credential_deliveries TO occ_app;
--> statement-breakpoint
-- OCC owns reduction intent and its accepted-work identity independently of provider
-- transport. Recipient and material identify the original installation, never authority
-- to release it again. A request with no observed generation has an unknown outcome.
CREATE TABLE occ.credential_delivery_reductions (
  revision_id text NOT NULL REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
  binding_id text NOT NULL CHECK (binding_id <> ''),
  fence bigint NOT NULL CHECK (fence >= 1),
  recipient jsonb NOT NULL CHECK (jsonb_typeof(recipient) = 'object'),
  material_version uuid NOT NULL,
  retained_policy_hash text NOT NULL CHECK (retained_policy_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid,
  expected_version text CHECK (expected_version <> ''),
  observed_generation text CHECK (observed_generation <> ''),
  PRIMARY KEY (revision_id, binding_id),
  FOREIGN KEY (revision_id,binding_id) REFERENCES occ.credential_deliveries(revision_id,binding_id) ON DELETE CASCADE,
  CHECK ((request_id IS NULL) = (expected_version IS NULL)),
  CHECK (observed_generation IS NULL OR request_id IS NOT NULL)
);
--> statement-breakpoint
-- Carry forward accepted operations without clearing unknown outcomes or recreating
-- an install. The original route remains the owner of its provider-specific receipt.
INSERT INTO occ.credential_delivery_reductions
  (revision_id,binding_id,fence,recipient,material_version,retained_policy_hash,
   request_id,expected_version,observed_generation)
SELECT revision_id,binding_id,fence,observed,material_version,retained_launch_hash,
       detach_request_id,detach_resource_version,detached_epoch
FROM occ.openshell_git_routes
WHERE blocked IN ('repository_expired','withdrawn') AND observed IS NOT NULL
  AND material_version IS NOT NULL AND retained_launch_hash IS NOT NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(request_id,expected_version,observed_generation)
ON occ.credential_delivery_reductions TO occ_app;
--> statement-breakpoint
-- Fence former readers as well as writers. The copied delivery keeps its original
-- state; an old process cannot treat this historical receipt as live authority.
UPDATE occ.openshell_git_routes SET blocked=coalesce(blocked,'worker_replaced');
--> statement-breakpoint
-- A former worker must fail closed instead of advancing a historical copy.
REVOKE INSERT, UPDATE ON occ.openshell_git_routes FROM occ_app;
REVOKE UPDATE(fence,worker_instance,adopted_at,updated_at,provider_id,profile_version,
  provider_resource_version,credential_state,material_expires_at,material_version,
  preparation_attempt_id,observed,write_pending,blocked,retained_launch_hash,
  detach_request_id,detach_resource_version,detached_epoch)
ON occ.openshell_git_routes FROM occ_app;

-- Delivery receipts survive execution cleanup; the live reference never grants authority.
CREATE TABLE occ.credential_deliveries (
  revision_id text NOT NULL,
  live_revision_id text REFERENCES occ.agent_revisions(id) ON DELETE SET NULL,
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
  settlement text NOT NULL CHECK (settlement IN ('snapshot','witness')),
  operation_fence bigint NOT NULL DEFAULT 1 CHECK (operation_fence >= 1),
  write_pending text CHECK (write_pending IN ('bootstrap','rotate')),
  blocked text,
  retained_policy_hash text CHECK (retained_policy_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (revision_id,binding_id),
  UNIQUE (revision_id,target),
  -- The single-column FK clears liveness during cleanup; this deferred FK retains
  -- the exact live owner constraint until that action has completed.
  FOREIGN KEY (namespace_id,agent_id,live_revision_id)
    REFERENCES occ.agent_revisions(namespace_id,agent_id,id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT credential_deliveries_live_revision_check CHECK (live_revision_id IS NULL OR live_revision_id = revision_id),
  CHECK ((material_version IS NULL) = (preparation_attempt_id IS NULL)),
  CHECK ((target_material_version IS NULL) = (target_preparation_attempt_id IS NULL)),
  CONSTRAINT credential_deliveries_rotation_target_check CHECK (write_pending IS DISTINCT FROM 'rotate' OR target_material_version IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX credential_deliveries_namespace ON occ.credential_deliveries(namespace_id);
--> statement-breakpoint
REVOKE ALL ON occ.credential_deliveries FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence,worker_instance,adopted_at,updated_at,desired,observed,
  material_version,preparation_attempt_id,target_material_version,target_preparation_attempt_id,write_pending,blocked,retained_policy_hash,operation_fence)
ON occ.credential_deliveries TO occ_app;
--> statement-breakpoint
-- A consumed request without an observed generation stays unknown across worker loss.
CREATE TABLE occ.credential_delivery_reductions (
  revision_id text NOT NULL,
  binding_id text NOT NULL CHECK (binding_id <> ''),
  fence bigint NOT NULL CHECK (fence >= 1),
  recipient jsonb CHECK (jsonb_typeof(recipient) = 'object'),
  material_version uuid,
  retained_policy_hash text CHECK (retained_policy_hash ~ '^[a-f0-9]{64}$'),
  request_id uuid,
  expected_version text CHECK (expected_version <> ''),
  observed_generation text CHECK (observed_generation <> ''),
  policy_request jsonb,
  policy_observed jsonb,
  delivery_binding_id text GENERATED ALWAYS AS
    (CASE WHEN policy_request IS NULL THEN binding_id END) STORED,
  PRIMARY KEY (revision_id, binding_id),
  FOREIGN KEY (revision_id,delivery_binding_id) REFERENCES occ.credential_deliveries(revision_id,binding_id) ON DELETE CASCADE,
  CONSTRAINT credential_delivery_reductions_policy_check CHECK (CASE WHEN policy_request IS NULL THEN
    recipient IS NOT NULL AND material_version IS NOT NULL AND retained_policy_hash IS NOT NULL AND policy_observed IS NULL
  ELSE COALESCE(
    recipient IS NULL AND material_version IS NULL AND retained_policy_hash IS NULL
    AND policy_request->>'version' IN ('1','2')
    AND policy_request->>'operationId' = request_id::text
    AND policy_request #>> '{expected,plan,execution,revisionId}' = revision_id
    AND policy_request #>> '{expected,plan,generation}' = expected_version
    AND jsonb_typeof(policy_request #> '{retained,routes}') = 'array'
    AND (policy_observed IS NULL OR (
      policy_observed->'plan' = policy_request->'retained'
      AND policy_observed #>> '{plan,generation}' = observed_generation)), false)
  END),
  CHECK ((request_id IS NULL) = (expected_version IS NULL)),
  CHECK (observed_generation IS NULL OR request_id IS NOT NULL)
);
--> statement-breakpoint
REVOKE ALL ON occ.credential_delivery_reductions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(request_id,expected_version,observed_generation,policy_observed)
ON occ.credential_delivery_reductions TO occ_app;

--> statement-breakpoint
CREATE FUNCTION occ.require_live_credential_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.live_revision_id IS NULL THEN
    RAISE EXCEPTION 'Credential delivery requires a live revision at creation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credential_deliveries_live_insert BEFORE INSERT ON occ.credential_deliveries
FOR EACH ROW EXECUTE FUNCTION occ.require_live_credential_delivery();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_live_credential_delivery() FROM PUBLIC, occ_app;

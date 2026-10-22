-- Delivery identity belongs to the exact admitted Agent revision.
CREATE TABLE occ.credential_deliveries (
  revision_id text NOT NULL,
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
  FOREIGN KEY (namespace_id, agent_id, revision_id) REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON DELETE CASCADE,
  CHECK ((material_version IS NULL) = (preparation_attempt_id IS NULL)),
  CHECK ((target_material_version IS NULL) = (target_preparation_attempt_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX credential_deliveries_namespace ON occ.credential_deliveries(namespace_id);
--> statement-breakpoint
REVOKE ALL ON occ.credential_deliveries FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence,worker_instance,adopted_at,updated_at,desired,observed,
  material_version,preparation_attempt_id,target_material_version,target_preparation_attempt_id,write_pending,blocked,retained_policy_hash)
ON occ.credential_deliveries TO occ_app;
--> statement-breakpoint
-- A consumed request without an observed generation stays unknown across worker loss.
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
REVOKE ALL ON occ.credential_delivery_reductions FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(request_id,expected_version,observed_generation)
ON occ.credential_delivery_reductions TO occ_app;
--> statement-breakpoint
-- The registered Driver may have installed material even when its reply is lost.
CREATE TABLE occ.protected_repository_git_recipients (
  revision_id text PRIMARY KEY REFERENCES occ.agent_revisions(id) ON DELETE CASCADE,
  installation jsonb NOT NULL,
  fence bigint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'observed',
  attempt_id uuid,
  material_version uuid,
  FOREIGN KEY (attempt_id, material_version) REFERENCES occ.prepared_github_attempts(id, material_version),
  CHECK (fence >= 1 AND state IN ('observed', 'installing', 'installed')
    AND (state = 'observed') = (attempt_id IS NULL)
    AND (attempt_id IS NULL) = (material_version IS NULL)
    AND (installation#>>'{plan,execution,revisionId}' = revision_id) IS TRUE)
);
--> statement-breakpoint
REVOKE ALL ON occ.protected_repository_git_recipients FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE(fence, state, attempt_id, material_version)
ON occ.protected_repository_git_recipients TO occ_app;

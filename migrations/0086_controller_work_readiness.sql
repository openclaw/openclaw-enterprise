-- Only a fresh owned readiness deferral can enable queued model authorization.
-- Existing work deliberately remains ineligible; audit history is not authority.
ALTER TABLE occ.controller_work
  ADD COLUMN readiness_deferred boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT controller_work_readiness_deferred_owner CHECK (
    NOT readiness_deferred OR (
      state = 'queued' AND work_kind = 'lifecycle'
      AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL
      AND idempotency_key = 'agent_revision:' || revision_id || ':reconcile'
    )
  );
--> statement-breakpoint
GRANT UPDATE (readiness_deferred) ON occ.controller_work TO occ_app;

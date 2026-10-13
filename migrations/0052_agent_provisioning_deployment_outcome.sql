ALTER TABLE occ.agent_provisioning_work
  DROP CONSTRAINT agent_provisioning_failed_before_handoff,
  ADD CONSTRAINT agent_provisioning_admitted_revision_status_valid CHECK (
    revision_id IS NULL OR status IN ('running', 'succeeded', 'failed')
  );

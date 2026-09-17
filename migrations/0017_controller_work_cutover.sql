ALTER TABLE occ.controller_work ADD COLUMN cutover_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE occ.controller_work ADD COLUMN cutover_expected_active_revision_id text;
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD CONSTRAINT controller_work_cutover_expected_revision_owner
  FOREIGN KEY (namespace_id, agent_id, cutover_expected_active_revision_id)
  REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE occ.controller_work ADD CONSTRAINT controller_work_cutover_revision_state CHECK (
  (cutover_started_at IS NULL AND cutover_expected_active_revision_id IS NULL)
  OR (
    cutover_started_at IS NOT NULL
    AND
    state IN ('queued', 'claimed')
    AND revision_id IS NOT NULL
    AND agent_id IS NOT NULL
    AND completed_at IS NULL
  )
);
--> statement-breakpoint
GRANT UPDATE (
  cutover_started_at,
  cutover_expected_active_revision_id
) ON occ.controller_work TO occ_app;

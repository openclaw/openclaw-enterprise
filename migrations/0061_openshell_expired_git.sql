-- A hash binds the launch minus Git, model provider identity and the exact supervisor Pod.
-- No launch contents or credential. The old route fence (blocked IS NULL) closes before the
-- conditional detach. A send with an unknown outcome is observed, never automatically repeated.
ALTER TABLE occ.openshell_git_routes
  ADD COLUMN retained_launch_hash text CHECK (retained_launch_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN detach_request_id uuid,
  ADD COLUMN detach_resource_version text CHECK (detach_resource_version ~ '^[1-9][0-9]*$'),
  ADD COLUMN detached_epoch text,
  ADD CONSTRAINT openshell_git_routes_detach_check CHECK (
    (detach_request_id IS NULL) = (detach_resource_version IS NULL)
    AND (detached_epoch IS NULL OR (detach_request_id IS NOT NULL AND detached_epoch <> ''))
    AND (detach_request_id IS NULL OR
      (retained_launch_hash IS NOT NULL AND blocked IS NOT NULL AND blocked IN ('repository_expired', 'withdrawn')))
  );
--> statement-breakpoint
GRANT UPDATE(retained_launch_hash, detach_request_id, detach_resource_version, detached_epoch)
ON occ.openshell_git_routes TO occ_app;

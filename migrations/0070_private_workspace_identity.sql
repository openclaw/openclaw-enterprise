-- Extend the closed immutable revision snapshot; existing snapshots remain unchanged.
DO $$ DECLARE definition text; updated text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = 'occ.agent_revisions'::regclass AND conname = 'agent_revisions_admitted_snapshot';
  updated := replace(definition, '- ''sandbox_driver_id''::text',
    '- ''sandbox_driver_id''::text - ''private_workspace_identity''::text');
  IF updated IS NULL OR updated = definition THEN
    RAISE EXCEPTION 'Agent revision snapshot constraint could not be extended';
  END IF;
  ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
  EXECUTE 'ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot ' || updated;
END $$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_private_workspace_identity CHECK (
  NOT (admitted_spec ? 'private_workspace_identity') OR COALESCE(
        admitted_spec ? 'sandbox_driver_id'
        AND jsonb_typeof(admitted_spec->'private_workspace_identity') = 'object'
        AND (admitted_spec->'private_workspace_identity') ?& ARRAY['uid', 'gid', 'placement']
        AND ((admitted_spec->'private_workspace_identity') - 'uid' - 'gid' - 'placement') = '{}'::jsonb
        AND CASE WHEN jsonb_typeof(admitted_spec #> '{private_workspace_identity,uid}') = 'number'
          AND jsonb_typeof(admitted_spec #> '{private_workspace_identity,gid}') = 'number' THEN
          (admitted_spec #>> '{private_workspace_identity,uid}')::numeric BETWEEN 1 AND 4294967294
          AND mod((admitted_spec #>> '{private_workspace_identity,uid}')::numeric, 1) = 0
          AND (admitted_spec #>> '{private_workspace_identity,gid}')::numeric BETWEEN 1 AND 4294967294
          AND mod((admitted_spec #>> '{private_workspace_identity,gid}')::numeric, 1) = 0
          ELSE false END
        AND jsonb_typeof(admitted_spec #> '{private_workspace_identity,placement}') = 'string'
        AND btrim(admitted_spec #>> '{private_workspace_identity,placement}') <> '', false)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM occ.service_account_driver_bindings) THEN
    RAISE EXCEPTION
      'Provider migration requires managed ServiceAccount bindings to be cleaned up before cutover'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_revisions
  ) THEN
    RAISE EXCEPTION
      'Provider migration requires AgentRevisions to be recreated with explicit provider_id storage'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE occ.agents ADD COLUMN provider_id text;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_provider_id_valid CHECK (
  provider_id IS NULL OR (
    char_length(provider_id) BETWEEN 1 AND 200
    AND provider_id = btrim(provider_id)
    AND provider_id !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
DROP TRIGGER service_account_driver_binding_identity_is_immutable
ON occ.service_account_driver_bindings;
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings ADD COLUMN provider_id text NOT NULL;
--> statement-breakpoint
ALTER TABLE occ.service_account_driver_bindings
  ADD CONSTRAINT service_account_driver_bindings_provider_id_valid CHECK (
    char_length(provider_id) BETWEEN 1 AND 200 AND provider_id = btrim(provider_id)
  );
--> statement-breakpoint
CREATE TRIGGER service_account_driver_binding_identity_is_immutable
BEFORE UPDATE OF service_account_id, namespace_id, provider_id, driver_id,
  external_account_id, workspace_id
ON occ.service_account_driver_bindings
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD COLUMN provider_id text;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_provider_id_valid CHECK (
  provider_id IS NULL OR (
    char_length(provider_id) BETWEEN 1 AND 200
    AND provider_id = btrim(provider_id)
    AND provider_id !~ '[[:cntrl:]]'
  )
);
--> statement-breakpoint
GRANT UPDATE (provider_id) ON occ.agents TO occ_app;

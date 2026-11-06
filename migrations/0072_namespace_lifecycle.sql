CREATE TABLE occ.namespace_lifecycle (
  namespace_id text PRIMARY KEY REFERENCES occ.namespaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  lifecycle_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  compute_driver_id text,
  compute_implementation text,
  revision integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT namespace_lifecycle_revision_valid CHECK (revision >= 0),
  CONSTRAINT namespace_lifecycle_data_object CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT namespace_lifecycle_data_limit CHECK (octet_length(data::text) <= 65536),
  CONSTRAINT namespace_lifecycle_driver_complete CHECK (
    (compute_driver_id IS NULL AND compute_implementation IS NULL) OR (
      compute_driver_id IS NOT NULL AND compute_implementation IS NOT NULL
      AND char_length(btrim(compute_driver_id)) BETWEEN 1 AND 200
      AND char_length(btrim(compute_implementation)) BETWEEN 1 AND 200
    )
  ),
  CONSTRAINT namespace_lifecycle_initial_state CHECK (
    (revision = 0 AND data = '{}'::jsonb)
    OR (revision > 0 AND compute_driver_id IS NOT NULL)
  )
);
--> statement-breakpoint
-- No backfill: an existing Namespace does not establish that no effects were attempted.
CREATE FUNCTION occ.reserve_namespace_lifecycle() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, occ AS $$
BEGIN
  INSERT INTO occ.namespace_lifecycle(namespace_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER namespace_lifecycle_is_reserved AFTER INSERT ON occ.namespaces
FOR EACH ROW EXECUTE FUNCTION occ.reserve_namespace_lifecycle();
--> statement-breakpoint
CREATE FUNCTION occ.guard_namespace_lifecycle_update() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, occ AS $$
BEGIN
  IF NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
    OR NEW.lifecycle_id IS DISTINCT FROM OLD.lifecycle_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.compute_driver_id IS NOT NULL AND (
      NEW.compute_driver_id IS DISTINCT FROM OLD.compute_driver_id
      OR NEW.compute_implementation IS DISTINCT FROM OLD.compute_implementation
    ))
    OR NOT (
      (NEW.revision = OLD.revision + 1 AND NEW.compute_driver_id IS NOT NULL)
      OR (OLD.revision = 0 AND NEW.revision = 0 AND NEW.data = OLD.data
        AND OLD.compute_driver_id IS NULL AND NEW.compute_driver_id IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'Invalid Namespace lifecycle transition' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER namespace_lifecycle_transition_valid BEFORE UPDATE ON occ.namespace_lifecycle
FOR EACH ROW EXECUTE FUNCTION occ.guard_namespace_lifecycle_update();
--> statement-breakpoint
REVOKE ALL ON occ.namespace_lifecycle FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.namespace_lifecycle TO occ_app;
--> statement-breakpoint
GRANT UPDATE (compute_driver_id,compute_implementation,revision,data) ON occ.namespace_lifecycle TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reserve_namespace_lifecycle(), occ.guard_namespace_lifecycle_update() FROM PUBLIC;

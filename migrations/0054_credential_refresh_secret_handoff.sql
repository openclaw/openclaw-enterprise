-- Last-committed handoff IDs are replay evidence, not live Secret references.
-- No Secret foreign key: deletion of bootstrap material must leave these IDs intact.
CREATE FUNCTION occ.credential_source_handoff_ids_are_valid(ids jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  field text;
  value jsonb;
  count integer := 0;
BEGIN
  IF jsonb_typeof(ids) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOR field, value IN SELECT * FROM jsonb_each(ids) LOOP
    count := count + 1;
    IF count > 16 OR field !~ '^[a-z][a-z0-9_]{0,63}$'
      OR jsonb_typeof(value) IS DISTINCT FROM 'string'
      OR (value #>> '{}') !~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.credential_source_handoff_ids_are_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.credential_source_handoff_ids_are_valid(jsonb) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.credential_source_handoffs (
  namespace_id text NOT NULL,
  credential_source_id text PRIMARY KEY,
  secret_ids jsonb NOT NULL,
  CONSTRAINT credential_source_handoffs_source_owner
    FOREIGN KEY (namespace_id, credential_source_id)
    REFERENCES occ.credential_sources(namespace_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT credential_source_handoffs_ids_valid
    CHECK (occ.credential_source_handoff_ids_are_valid(secret_ids))
);
--> statement-breakpoint
CREATE TRIGGER credential_source_handoffs_owner_is_immutable
BEFORE UPDATE OF namespace_id, credential_source_id ON occ.credential_source_handoffs
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
-- Seed only actual ready-source bindings. No row means unavailable history, not an
-- empty successful handoff. Catalog classification stays in OCC; static bindings remain live.
INSERT INTO occ.credential_source_handoffs (namespace_id, credential_source_id, secret_ids)
SELECT cs.namespace_id, cs.id, jsonb_object_agg(css.field, css.secret_id)
FROM occ.credential_sources cs
JOIN occ.credential_source_secrets css
  ON css.namespace_id = cs.namespace_id AND css.credential_source_id = cs.id
WHERE cs.state = 'ready'
GROUP BY cs.namespace_id, cs.id;
--> statement-breakpoint
REVOKE ALL ON occ.credential_source_handoffs FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.credential_source_handoffs TO occ_app;
--> statement-breakpoint
GRANT UPDATE (secret_ids) ON occ.credential_source_handoffs TO occ_app;
--> statement-breakpoint
-- OCC releases only the exact source's bindings after definite refresh success.
GRANT DELETE ON occ.credential_source_secrets TO occ_app;

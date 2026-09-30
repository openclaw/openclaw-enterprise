CREATE TABLE occ.creation_requests (
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  actor_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text COLLATE "C" NOT NULL,
  fingerprint text NOT NULL,
  resource_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, actor_id, operation, idempotency_key),
  CONSTRAINT creation_requests_actor_length CHECK (char_length(actor_id) BETWEEN 1 AND 200),
  CONSTRAINT creation_requests_key_valid CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT creation_requests_fingerprint_valid CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT creation_requests_result_valid CHECK (
    (operation = 'createConfiguration' AND resource_id ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (operation = 'createAgent' AND resource_id ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  )
);
--> statement-breakpoint
-- Validate ownership at insertion, while retaining the receipt after deletion.
CREATE FUNCTION occ.validate_creation_request_result() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM occ.namespaces WHERE id = NEW.namespace_id AND deleted_at IS NULL)
    OR (NEW.operation = 'createConfiguration' AND NOT EXISTS (
      SELECT 1 FROM occ.configurations WHERE namespace_id = NEW.namespace_id AND id = NEW.resource_id
    ))
    OR (NEW.operation = 'createAgent' AND NOT EXISTS (
      SELECT 1 FROM occ.agents WHERE namespace_id = NEW.namespace_id AND id = NEW.resource_id
    )) THEN
    RAISE EXCEPTION 'creation request requires an owned result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER creation_requests_result_owner BEFORE INSERT ON occ.creation_requests
FOR EACH ROW EXECUTE FUNCTION occ.validate_creation_request_result();
--> statement-breakpoint
CREATE TRIGGER creation_requests_immutable BEFORE UPDATE ON occ.creation_requests
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.creation_requests FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.creation_requests TO occ_app;

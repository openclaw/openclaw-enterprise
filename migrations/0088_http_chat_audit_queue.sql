-- Keep HTTP chat evidence durable while the audit ledger is unavailable.
CREATE TABLE occ.http_chat_audit_queue (
  LIKE occ.audit_events INCLUDING CONSTRAINTS,
  PRIMARY KEY (id),
  installation_id text NOT NULL REFERENCES occ.installation(id),
  retry_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT http_chat_audit_queue_action CHECK ((
    (kind = 'api_request' AND action = 'openclaw.api.request.admitted'
     AND details->>'operationId' = 'chatWithAgent'
     AND resource_kind = 'installation' AND resource_id = installation_id)
    OR
    (kind = 'mutation' AND resource_kind = 'agent' AND namespace_id IS NOT NULL
     AND action IN ('openclaw.agents.chat.admitted', 'openclaw.agents.chat.completed',
                    'openclaw.agents.chat.interrupted', 'openclaw.agents.chat.failed'))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX http_chat_audit_queue_retry_idx ON occ.http_chat_audit_queue (retry_at, id);
--> statement-breakpoint
CREATE FUNCTION occ.guard_http_chat_audit_queue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF octet_length(row_to_json(NEW)::text) > 8192 THEN
      RAISE EXCEPTION 'HTTP chat audit event exceeds its size limit'
        USING ERRCODE = '53400', CONSTRAINT = 'http_chat_audit_queue_event_size';
    END IF;
    -- Each producer must see inserts committed while it waited for this lock.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'HTTP chat audit queue inserts require READ COMMITTED';
    END IF;
    PERFORM pg_advisory_xact_lock(1868785005, 1667785076);
    IF (SELECT count(*) FROM occ.http_chat_audit_queue) >= 4096 THEN
      RAISE EXCEPTION 'HTTP chat audit queue is full'
        USING ERRCODE = '53400', CONSTRAINT = 'http_chat_audit_queue_capacity';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.audit_events AS e WHERE e.id = OLD.id
      AND e.occurred_at = OLD.occurred_at AND e.kind = OLD.kind
      AND e.actor_id = OLD.actor_id AND e.action = OLD.action
      AND e.namespace_id IS NOT DISTINCT FROM OLD.namespace_id
      AND e.resource_kind = OLD.resource_kind AND e.resource_id = OLD.resource_id
      AND e.outcome = OLD.outcome AND e.details IS NOT DISTINCT FROM OLD.details
  ) THEN
    RAISE EXCEPTION 'HTTP chat evidence must reach the audit ledger before removal'
      USING ERRCODE = '23514', CONSTRAINT = 'http_chat_audit_queue_delivery';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER http_chat_audit_queue_guard
BEFORE INSERT OR DELETE ON occ.http_chat_audit_queue FOR EACH ROW
EXECUTE FUNCTION occ.guard_http_chat_audit_queue();
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_http_chat_audit_queue() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON occ.http_chat_audit_queue FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (retry_at), DELETE ON occ.http_chat_audit_queue TO occ_app;

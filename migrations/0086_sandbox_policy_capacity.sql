-- Retain all grant-shape checks while raising the finite persistence capacity.
CREATE OR REPLACE FUNCTION occ.sandbox_network_grants_are_valid(grants jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE grant_entry jsonb; range_entry jsonb;
BEGIN
  IF jsonb_typeof(grants) IS DISTINCT FROM 'array' OR jsonb_array_length(grants) > 16384 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT entry->>'id') FROM jsonb_array_elements(grants) entry) <> jsonb_array_length(grants) THEN RETURN false; END IF;
  FOR grant_entry IN SELECT * FROM jsonb_array_elements(grants) LOOP
    IF NOT (grant_entry ?& ARRAY['id','binary','host','ports'])
      OR grant_entry - 'id' - 'binary' - 'host' - 'ports' <> '{}'::jsonb
      OR jsonb_typeof(grant_entry->'id') <> 'string' OR grant_entry->>'id' !~ '^[a-z][a-z0-9-]{0,47}$'
      OR jsonb_typeof(grant_entry->'binary') <> 'string' OR char_length(grant_entry->>'binary') NOT BETWEEN 2 AND 512
      OR grant_entry->>'binary' !~ '^/[^[:space:][:cntrl:]]+$'
      OR grant_entry->>'binary' ~ '//|/\.{1,2}(/|$)|/$'
      OR jsonb_typeof(grant_entry->'host') <> 'string' OR char_length(grant_entry->>'host') > 253
      OR grant_entry->>'host' !~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'
      OR jsonb_typeof(grant_entry->'ports') <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(grant_entry->'ports') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
    FOR range_entry IN SELECT * FROM jsonb_array_elements(grant_entry->'ports') LOOP
      IF NOT (range_entry ?& ARRAY['from','to']) OR range_entry - 'from' - 'to' <> '{}'::jsonb
        OR jsonb_typeof(range_entry->'from') <> 'number' OR jsonb_typeof(range_entry->'to') <> 'number'
        OR (range_entry->>'from')::numeric NOT BETWEEN 1 AND 65535 OR (range_entry->>'to')::numeric NOT BETWEEN 1 AND 65535
        OR mod((range_entry->>'from')::numeric,1) <> 0 OR mod((range_entry->>'to')::numeric,1) <> 0
        OR (range_entry->>'from')::numeric > (range_entry->>'to')::numeric THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
ALTER TABLE occ.sandbox_policies
  DROP CONSTRAINT sandbox_policies_document_valid,
  ADD CONSTRAINT sandbox_policies_document_valid
    CHECK (occ.sandbox_policy_is_valid(document,id,namespace_id,agent_id,version));

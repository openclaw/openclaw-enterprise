ALTER TABLE occ.agents ADD COLUMN predecessor_replacement jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_predecessor_replacement_valid CHECK (
  predecessor_replacement IS NULL OR (
    jsonb_typeof(predecessor_replacement) = 'object'
    AND predecessor_replacement ?& ARRAY['predecessorRevisionId', 'candidateRevisionId', 'phase', 'startedAt']
    AND predecessor_replacement->>'phase' IN ('pre-stop', 'stopping')
    AND (predecessor_replacement->>'phase' <> 'stopping' OR predecessor_replacement ? 'stoppingAt')
  ) IS TRUE
);
--> statement-breakpoint
GRANT UPDATE (predecessor_replacement) ON occ.agents TO occ_app;

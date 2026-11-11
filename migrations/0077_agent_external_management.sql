ALTER TABLE occ.agents ADD COLUMN external_management jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_external_management_valid CHECK (
  external_management IS NULL OR (
    jsonb_typeof(external_management) = 'object'
    AND external_management ?& ARRAY['sourceId','principalId','version','suspended','released']
    AND (external_management - 'sourceId' - 'principalId' - 'version' - 'suspended' - 'released' - 'request') = '{}'::jsonb
    AND jsonb_typeof(external_management->'sourceId') = 'string'
    AND char_length(external_management->>'sourceId') BETWEEN 1 AND 512
    AND external_management->>'sourceId' ~ '^[A-Za-z0-9][A-Za-z0-9._:/~-]*$'
    AND jsonb_typeof(external_management->'principalId') = 'string'
    AND char_length(external_management->>'principalId') BETWEEN 1 AND 256
    AND jsonb_typeof(external_management->'version') = 'number'
    AND external_management->>'version' ~ '^[1-9][0-9]{0,15}$'
    AND external_management->'version' <= '9007199254740991'::jsonb
    AND jsonb_typeof(external_management->'suspended') = 'boolean'
    AND jsonb_typeof(external_management->'released') = 'boolean'
    AND (
      NOT (external_management ? 'request') OR (
        jsonb_typeof(external_management->'request') = 'object'
        AND (external_management->'request') ?& ARRAY['key','fingerprint','sourceGeneration']
        AND ((external_management->'request') - 'key' - 'fingerprint' - 'revisionId' - 'sourceGeneration' - 'retryNonce') = '{}'::jsonb
        AND jsonb_typeof(external_management #> '{request,sourceGeneration}') = 'number'
        AND external_management #>> '{request,sourceGeneration}' ~ '^[1-9][0-9]{0,15}$'
        AND external_management #> '{request,sourceGeneration}' <= '9007199254740991'::jsonb
        AND (NOT ((external_management->'request') ? 'retryNonce') OR (
          jsonb_typeof(external_management #> '{request,retryNonce}') = 'string'
          AND char_length(external_management #>> '{request,retryNonce}') BETWEEN 1 AND 128
        ))
        AND jsonb_typeof(external_management #> '{request,key}') = 'string'
        AND char_length(external_management #>> '{request,key}') BETWEEN 1 AND 128
        AND jsonb_typeof(external_management #> '{request,fingerprint}') = 'string'
        AND external_management #>> '{request,fingerprint}' ~ '^[a-f0-9]{64}$'
        AND (NOT ((external_management->'request') ? 'revisionId') OR (
          jsonb_typeof(external_management #> '{request,revisionId}') = 'string'
          AND external_management #>> '{request,revisionId}' ~ '^rev_[a-f0-9-]{36}$'
        ))
      )
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX agents_external_management_owner_unique
  ON occ.agents ((external_management->>'principalId'), (external_management->>'sourceId'))
  WHERE external_management IS NOT NULL;
--> statement-breakpoint
GRANT UPDATE (external_management) ON occ.agents TO occ_app;

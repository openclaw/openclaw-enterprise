ALTER TABLE occ.controller_work
ADD COLUMN reason_code text,
ADD COLUMN result_data jsonb;
--> statement-breakpoint
ALTER TABLE occ.controller_work
DROP CONSTRAINT controller_work_completion_state,
ADD CONSTRAINT controller_work_completion_state CHECK (
  (
    state IN ('succeeded', 'failed_permanent')
    AND completed_at IS NOT NULL
    AND reason_code IS NOT NULL
  )
  OR (
    state NOT IN ('succeeded', 'failed_permanent')
    AND completed_at IS NULL
    AND reason_code IS NULL
    AND result_data IS NULL
  )
),
ADD CONSTRAINT controller_work_reason_code_length CHECK (
  reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 64
),
ADD CONSTRAINT controller_work_result_data_state CHECK (
  result_data IS NULL
  OR (
    jsonb_typeof(result_data) = 'object'
    AND (
      (
        state = 'failed_permanent'
        AND reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
        AND result_data ? 'timeoutMs'
        AND (result_data - 'timeoutMs') = '{}'::jsonb
        AND jsonb_typeof(result_data->'timeoutMs') = 'number'
        AND (result_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
        AND (result_data->>'timeoutMs')::numeric <= 9007199254740991
      )
      OR (
        state = 'succeeded'
        AND reason_code IN ('REVISION_ACTIVATED', 'REVISION_ALREADY_ACTIVE')
        AND result_data ? 'warnings'
        AND (result_data - 'warnings') = '{}'::jsonb
        AND jsonb_typeof(result_data->'warnings') = 'array'
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*] ? (@.type() != "object" || !(exists(@.code)) || !(exists(@.pluginId)) || @.code.type() != "string" || @.pluginId.type() != "string" || !(@.code == "PLUGIN_INSTALL_FAILED" || @.code == "PLUGIN_AUTH_REQUIRED") || !(@.pluginId like_regex "^[A-Za-z0-9._~:@-]{1,253}$"))'
        )
        AND NOT jsonb_path_exists(
          result_data,
          '$.warnings[*].keyvalue() ? (@.key != "code" && @.key != "pluginId")'
        )
      )
    )
  )
);
--> statement-breakpoint
GRANT UPDATE (
  reason_code,
  result_data
) ON occ.controller_work TO occ_app;

ALTER TABLE occ.controller_work
ADD COLUMN reason_code text,
ADD COLUMN error_data jsonb,
ADD COLUMN plugin_warnings jsonb;
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
    AND error_data IS NULL
    AND plugin_warnings IS NULL
  )
),
ADD CONSTRAINT controller_work_reason_code_length CHECK (
  reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 64
),
ADD CONSTRAINT controller_work_error_data_state CHECK (
  error_data IS NULL
  OR (
    state = 'failed_permanent'
    AND jsonb_typeof(error_data) = 'object'
    AND octet_length(error_data::text) <= 4096
    AND (
      reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
      AND error_data ? 'timeoutMs'
      AND (error_data - 'timeoutMs') = '{}'::jsonb
      AND jsonb_typeof(error_data->'timeoutMs') = 'number'
      AND (error_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
      AND (error_data->>'timeoutMs')::numeric <= 9007199254740991
    )
  )
),
ADD CONSTRAINT controller_work_plugin_warnings_state CHECK (
  plugin_warnings IS NULL
  OR (
    state = 'succeeded'
    AND jsonb_typeof(plugin_warnings) = 'array'
  )
);
--> statement-breakpoint
GRANT UPDATE (
  reason_code,
  error_data,
  plugin_warnings
) ON occ.controller_work TO occ_app;

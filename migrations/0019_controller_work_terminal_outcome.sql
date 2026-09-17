ALTER TABLE occ.controller_work
ADD COLUMN reason_code text,
ADD COLUMN error_data jsonb,
ADD COLUMN receipt_id text,
ADD COLUMN receipt_acknowledged_at timestamptz;
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
    AND receipt_id IS NULL
    AND receipt_acknowledged_at IS NULL
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
      (
        reason_code IN ('PLUGIN_INSTALL_FAILED', 'PLUGIN_AUTH_REQUIRED')
        AND error_data ? 'pluginId'
        AND (error_data - 'pluginId') = '{}'::jsonb
        AND jsonb_typeof(error_data->'pluginId') = 'string'
        AND char_length(error_data->>'pluginId') BETWEEN 1 AND 253
      )
      OR (
        reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
        AND error_data ? 'timeoutMs'
        AND (error_data - 'timeoutMs') = '{}'::jsonb
        AND jsonb_typeof(error_data->'timeoutMs') = 'number'
        AND (error_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
        AND (error_data->>'timeoutMs')::numeric <= 9007199254740991
      )
    )
  )
),
ADD CONSTRAINT controller_work_receipt_id_length CHECK (
  receipt_id IS NULL OR char_length(receipt_id) BETWEEN 1 AND 512
),
ADD CONSTRAINT controller_work_receipt_ack_state CHECK (
  receipt_acknowledged_at IS NULL
  OR (
    state IN ('succeeded', 'failed_permanent')
    AND receipt_id IS NOT NULL
  )
);
--> statement-breakpoint
GRANT UPDATE (
  reason_code,
  error_data,
  receipt_id,
  receipt_acknowledged_at
) ON occ.controller_work TO occ_app;

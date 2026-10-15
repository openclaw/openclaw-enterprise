-- A deployment ended by a held startup model-probe failure keeps that runtime
-- failure and, when the runtime classified it, its cause (a closed kind and a
-- short detail token), so the API, console and CLI can say why the check failed.
ALTER TABLE occ.controller_work
DROP CONSTRAINT controller_work_result_data_state,
ADD CONSTRAINT controller_work_result_data_state CHECK (
  result_data IS NULL
  OR (
    jsonb_typeof(result_data) = 'object'
    AND (
      (
        state = 'failed_permanent'
        AND reason_code = 'CONVERGENCE_DEADLINE_EXCEEDED'
        AND result_data ? 'timeoutMs'
        AND (result_data - 'timeoutMs' - 'runtimeFailure') = '{}'::jsonb
        AND jsonb_typeof(result_data->'timeoutMs') = 'number'
        AND (result_data->>'timeoutMs') ~ '^[1-9][0-9]{0,15}$'
        AND (result_data->>'timeoutMs')::numeric <= 9007199254740991
        AND (
          NOT (result_data ? 'runtimeFailure')
          OR (
            jsonb_typeof(result_data->'runtimeFailure') = 'object'
            AND (result_data->'runtimeFailure') ?& ARRAY['component', 'check', 'checkedAt', 'code']
            AND ((result_data->'runtimeFailure') - 'component' - 'check' - 'checkedAt' - 'code') = '{}'::jsonb
            AND jsonb_typeof(result_data #> '{runtimeFailure,component}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,component}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,component}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(result_data #> '{runtimeFailure,check}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,check}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,check}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
            AND jsonb_typeof(result_data #> '{runtimeFailure,checkedAt}') = 'string'
            AND occ.iso_timestamp_is_valid(result_data #>> '{runtimeFailure,checkedAt}')
            AND jsonb_typeof(result_data #> '{runtimeFailure,code}') = 'string'
            AND char_length(result_data #>> '{runtimeFailure,code}') BETWEEN 1 AND 64
            AND (result_data #>> '{runtimeFailure,code}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
          )
        )
      )
      OR (
        state = 'failed_permanent'
        AND reason_code = 'RUNTIME_MODEL_PROBE_FAILED'
        AND result_data ? 'runtimeFailure'
        AND (result_data - 'runtimeFailure') = '{}'::jsonb
        AND jsonb_typeof(result_data->'runtimeFailure') = 'object'
        AND (result_data->'runtimeFailure') ?& ARRAY['component', 'check', 'checkedAt', 'code']
        AND ((result_data->'runtimeFailure') - 'component' - 'check' - 'checkedAt' - 'code' - 'cause') = '{}'::jsonb
        AND jsonb_typeof(result_data #> '{runtimeFailure,component}') = 'string'
        AND (result_data #>> '{runtimeFailure,component}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
        AND jsonb_typeof(result_data #> '{runtimeFailure,check}') = 'string'
        AND (result_data #>> '{runtimeFailure,check}') ~ '^[A-Za-z0-9._~:@-]{1,64}$'
        AND jsonb_typeof(result_data #> '{runtimeFailure,checkedAt}') = 'string'
        AND occ.iso_timestamp_is_valid(result_data #>> '{runtimeFailure,checkedAt}')
        AND jsonb_typeof(result_data #> '{runtimeFailure,code}') = 'string'
        AND (result_data #>> '{runtimeFailure,code}') = 'MODEL_PROBE_FAILED'
        AND (
          NOT ((result_data->'runtimeFailure') ? 'cause')
          OR (
            jsonb_typeof(result_data #> '{runtimeFailure,cause}') = 'object'
            AND (result_data #> '{runtimeFailure,cause}') ? 'kind'
            AND ((result_data #> '{runtimeFailure,cause}') - 'kind' - 'detail') = '{}'::jsonb
            AND jsonb_typeof(result_data #> '{runtimeFailure,cause,kind}') = 'string'
            AND (result_data #>> '{runtimeFailure,cause,kind}') IN ('PROCESS_EXIT', 'PROBE_STATUS', 'INVALID_OUTPUT', 'WRAPPER_ERROR')
            AND (
              NOT ((result_data #> '{runtimeFailure,cause}') ? 'detail')
              OR (
                jsonb_typeof(result_data #> '{runtimeFailure,cause,detail}') = 'string'
                AND (result_data #>> '{runtimeFailure,cause,detail}') ~ '^[A-Za-z0-9_-]{1,32}$'
              )
            )
          )
        )
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

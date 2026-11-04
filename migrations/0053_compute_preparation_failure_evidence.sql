CREATE FUNCTION occ.compute_preparation_failure_is_valid(evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  pod jsonb;
  container jsonb;
  field text;
  value jsonb;
BEGIN
  IF (jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY['workload', 'reason', 'observedAt', 'startedAt', 'finishedAt', 'pods']
    AND evidence - ARRAY['workload', 'reason', 'observedAt', 'startedAt', 'finishedAt', 'pods'] = '{}'::jsonb
    AND jsonb_typeof(evidence->'workload') = 'object'
    AND (evidence->'workload') ?& ARRAY['kind', 'name', 'uid', 'namespace']
    AND (evidence->'workload') - ARRAY['kind', 'name', 'uid', 'namespace'] = '{}'::jsonb
    AND evidence->>'reason' IN ('retry_limit', 'deadline', 'unknown')
    AND jsonb_typeof(evidence->'pods') = 'array') IS DISTINCT FROM TRUE THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(evidence->'pods') > 4 THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['kind', 'name', 'uid', 'namespace'] LOOP
    value := evidence->'workload'->field;
    IF (jsonb_typeof(value) = 'string' AND char_length(value #>> '{}') BETWEEN 1 AND 253
      AND (value #>> '{}') ~ '^[A-Za-z0-9._-]+$') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['observedAt', 'startedAt', 'finishedAt'] LOOP
    value := evidence->field;
    IF field <> 'observedAt' AND value = 'null'::jsonb THEN CONTINUE; END IF;
    IF (jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ 'Z$'
      AND occ.iso_timestamp_is_valid(value #>> '{}')) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
  END LOOP;
  FOR pod IN SELECT * FROM jsonb_array_elements(evidence->'pods') LOOP
    IF (jsonb_typeof(pod) = 'object' AND pod ?& ARRAY['name', 'uid', 'phase', 'scheduling', 'containers']
      AND pod - ARRAY['name', 'uid', 'phase', 'scheduling', 'containers'] = '{}'::jsonb
      AND pod->>'phase' IN ('Pending', 'Running', 'Succeeded', 'Failed', 'Unknown')
      AND pod->>'scheduling' IN ('pending', 'scheduled', 'unschedulable', 'unknown')
      AND jsonb_typeof(pod->'containers') = 'array') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    IF jsonb_array_length(pod->'containers') > 16 THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['name', 'uid'] LOOP
      value := pod->field;
      IF (jsonb_typeof(value) = 'string' AND char_length(value #>> '{}') BETWEEN 1 AND 253
        AND (value #>> '{}') ~ '^[A-Za-z0-9._-]+$') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    END LOOP;
    FOR container IN SELECT * FROM jsonb_array_elements(pod->'containers') LOOP
      IF (jsonb_typeof(container) = 'object'
        AND container ?& ARRAY['name', 'kind', 'state', 'reason', 'exitCode', 'startedAt', 'finishedAt']
        AND container - ARRAY['name', 'kind', 'state', 'reason', 'exitCode', 'startedAt', 'finishedAt'] = '{}'::jsonb
        AND jsonb_typeof(container->'name') = 'string'
        AND char_length(container->>'name') BETWEEN 1 AND 253
        AND container->>'name' ~ '^[A-Za-z0-9._-]+$'
        AND container->>'kind' IN ('init', 'main')
        AND container->>'state' IN ('waiting', 'running', 'terminated', 'unknown')
        AND (container->'reason' = 'null'::jsonb OR container->>'reason' IN (
          'Completed', 'Error', 'OOMKilled', 'ContainerCannotRun', 'StartError', 'ImagePullBackOff',
          'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError',
          'ContainerCreating', 'PodInitializing'))) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
      value := container->'exitCode';
      IF value <> 'null'::jsonb THEN
        IF (jsonb_typeof(value) = 'number' AND (value #>> '{}') ~ '^-?[0-9]{1,10}$') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
        IF (value #>> '{}')::bigint NOT BETWEEN -2147483648 AND 2147483647 THEN RETURN false; END IF;
      END IF;
      FOREACH field IN ARRAY ARRAY['startedAt', 'finishedAt'] LOOP
        value := container->field;
        IF value = 'null'::jsonb THEN CONTINUE; END IF;
        IF (jsonb_typeof(value) = 'string' AND (value #>> '{}') ~ 'Z$'
          AND occ.iso_timestamp_is_valid(value #>> '{}')) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.compute_preparation_failure_is_valid(jsonb) TO occ_app;

--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_result_data_state,
  ADD CONSTRAINT controller_work_result_data_state CHECK (
result_data IS NULL OR (
        jsonb_typeof(result_data) = 'object'
        AND (
          (
            state = 'failed_permanent'
            AND reason_code IN ('HARNESS_CREDENTIAL_BOOTSTRAP_FAILED', 'HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT')
            AND (result_data - 'preparation') = '{}'::jsonb
            AND occ.compute_preparation_failure_is_valid(result_data->'preparation')
          )
          OR
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

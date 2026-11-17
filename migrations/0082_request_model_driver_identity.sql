-- The request-model admission check must validate JSON types before reading text.
CREATE OR REPLACE FUNCTION occ.request_model_plan_is_valid(plan jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    plan->>'authorization' = 'online-request'
    AND NOT (plan ? 'harnessCredentialSource')
    AND NOT (plan ? 'policyReductionVersion')
    AND jsonb_typeof(plan #> '{driver,id}') = 'string'
    AND jsonb_typeof(plan #> '{driver,implementation}') = 'string'
    AND jsonb_typeof(plan #> '{driver,configurationId}') = 'string'
    AND CASE WHEN jsonb_typeof(plan->'routes') = 'array' THEN
      jsonb_array_length(plan->'routes') > 0
      AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(plan->'routes') AS route
        WHERE route #>> '{binding,grant,kind}' IS DISTINCT FROM 'inference'
          OR jsonb_typeof(route #> '{binding,source,source,id}') IS DISTINCT FROM 'string'
          OR length(route #>> '{binding,source,source,id}') = 0
      )
      AND (SELECT count(DISTINCT route #>> '{binding,source,source,id}') = 1
           FROM jsonb_array_elements(plan->'routes') AS route)
    ELSE false END,
    false)
$$;

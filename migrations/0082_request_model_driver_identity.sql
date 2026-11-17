-- The request-model admission check must validate JSON types before reading text.
CREATE OR REPLACE FUNCTION occ.request_model_plan_is_valid(plan jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  -- Match the whitespace removed by the runtime's String.prototype.trim().
  WITH trim_space AS (
    SELECT U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' AS chars
  )
  SELECT COALESCE(
    plan->>'authorization' = 'online-request'
    AND NOT (plan ? 'harnessCredentialSource')
    AND NOT (plan ? 'policyReductionVersion')
    AND jsonb_typeof(plan #> '{driver,id}') = 'string'
    AND jsonb_typeof(plan #> '{driver,implementation}') = 'string'
    AND btrim(plan #>> '{driver,id}', trim_space.chars) <> ''
    AND btrim(plan #>> '{driver,implementation}', trim_space.chars) <> ''
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
  FROM trim_space
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM occ.agent_revisions
    WHERE admitted_spec #>> '{execution_admission,version}' IN ('8', '9')
      AND NOT occ.request_model_plan_is_valid(admitted_spec->'egress_plan')
  ) THEN
    RAISE EXCEPTION 'A stored request-model admission is invalid under the exact Driver identity check.'
      USING ERRCODE = '23514', CONSTRAINT = 'agent_revisions_execution_admission';
  END IF;
END
$$;

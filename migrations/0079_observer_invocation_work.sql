ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_kind_valid,
  ADD CONSTRAINT controller_work_kind_valid CHECK (
    work_kind IN ('lifecycle', 'provisioning', 'observer')
  );
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK (
    (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NOT NULL
      AND namespace_target IN ('ready', 'deleted') AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NOT NULL
      AND agent_target IN ('stopped', 'deleted'))
    OR (work_kind = 'lifecycle' AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL
      AND (agent_target IS NULL OR agent_target = 'credentials_withdrawn'))
    OR (work_kind = 'provisioning' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
    OR (work_kind = 'lifecycle' AND agent_id IS NULL AND revision_id IS NULL
      AND namespace_target IS NULL AND agent_target IS NULL
      AND idempotency_key ~ '^agent_revision:rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:repository_cleanup:(retire:)?[0-9a-f]{64}$')
    OR (work_kind = 'observer' AND agent_id IS NOT NULL AND revision_id IS NOT NULL
      AND namespace_target IS NULL AND agent_target IS NULL)
  );
--> statement-breakpoint
CREATE FUNCTION occ.observer_invocation_qualification_is_valid(qualification jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(qualification) = 'object'
    AND qualification ?& ARRAY[
      'qualificationId', 'backendVersion', 'imageQualificationId',
      'evidenceContractId', 'securityProfileId', 'maximumDurationMs',
      'maximumCapturedRecords', 'maximumEncodedOutputBytes',
      'maximumCancellationGraceMs'
    ]
    AND qualification - ARRAY[
      'qualificationId', 'backendVersion', 'imageQualificationId',
      'evidenceContractId', 'securityProfileId', 'maximumDurationMs',
      'maximumCapturedRecords', 'maximumEncodedOutputBytes',
      'maximumCancellationGraceMs'
    ] = '{}'::jsonb
    AND jsonb_typeof(qualification->'qualificationId') = 'string'
    AND char_length(qualification->>'qualificationId') BETWEEN 1 AND 512
    AND qualification->>'qualificationId' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(qualification->'backendVersion') = 'string'
    AND char_length(qualification->>'backendVersion') BETWEEN 1 AND 512
    AND qualification->>'backendVersion' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(qualification->'imageQualificationId') = 'string'
    AND char_length(qualification->>'imageQualificationId') BETWEEN 1 AND 512
    AND qualification->>'imageQualificationId' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(qualification->'evidenceContractId') = 'string'
    AND char_length(qualification->>'evidenceContractId') BETWEEN 1 AND 512
    AND qualification->>'evidenceContractId' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(qualification->'securityProfileId') = 'string'
    AND char_length(qualification->>'securityProfileId') BETWEEN 1 AND 512
    AND qualification->>'securityProfileId' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(qualification->'maximumDurationMs') = 'number'
    AND (qualification->>'maximumDurationMs') ~ '^[1-9][0-9]{0,15}$'
    AND (qualification->>'maximumDurationMs')::numeric <= 9007199254740991
    AND jsonb_typeof(qualification->'maximumCapturedRecords') = 'number'
    AND (qualification->>'maximumCapturedRecords') ~ '^[1-9][0-9]{0,15}$'
    AND (qualification->>'maximumCapturedRecords')::numeric <= 9007199254740991
    AND jsonb_typeof(qualification->'maximumEncodedOutputBytes') = 'number'
    AND (qualification->>'maximumEncodedOutputBytes') ~ '^[1-9][0-9]{0,15}$'
    AND (qualification->>'maximumEncodedOutputBytes')::numeric <= 9007199254740991
    AND jsonb_typeof(qualification->'maximumCancellationGraceMs') = 'number'
    AND (qualification->>'maximumCancellationGraceMs') ~ '^[1-9][0-9]{0,15}$'
    AND (qualification->>'maximumCancellationGraceMs')::numeric <= 9007199254740991,
    false
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_invocation_qualification_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_invocation_plan_is_valid(plan jsonb, qualification jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    occ.observer_invocation_qualification_is_valid(qualification)
    AND jsonb_typeof(plan) = 'object'
    AND plan ?& ARRAY[
      'qualificationId', 'backendVersion', 'image', 'observationScope',
      'limits', 'cancellation', 'evidenceDestination', 'cleanupPolicy',
      'securityProfile'
    ]
    AND plan - ARRAY[
      'qualificationId', 'backendVersion', 'image', 'observationScope',
      'limits', 'cancellation', 'evidenceDestination', 'cleanupPolicy',
      'securityProfile'
    ] = '{}'::jsonb
    AND jsonb_typeof(plan->'qualificationId') = 'string'
    AND plan->>'qualificationId' = qualification->>'qualificationId'
    AND jsonb_typeof(plan->'backendVersion') = 'string'
    AND char_length(plan->>'backendVersion') BETWEEN 1 AND 512
    AND plan->>'backendVersion' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND plan->>'backendVersion' = qualification->>'backendVersion'
    AND jsonb_typeof(plan->'image') = 'object'
    AND (plan->'image') ?& ARRAY['reference', 'digest', 'qualificationId']
    AND (plan->'image') - ARRAY['reference', 'digest', 'qualificationId'] = '{}'::jsonb
    AND jsonb_typeof(plan #> '{image,reference}') = 'string'
    AND char_length(plan #>> '{image,reference}') BETWEEN 1 AND 512
    AND (plan #>> '{image,reference}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(plan #> '{image,digest}') = 'string'
    AND (plan #>> '{image,digest}') ~ '^sha256:[a-f0-9]{64}$'
    AND right(plan #>> '{image,reference}', char_length(plan #>> '{image,digest}') + 1)
      = '@' || (plan #>> '{image,digest}')
    AND jsonb_typeof(plan #> '{image,qualificationId}') = 'string'
    AND char_length(plan #>> '{image,qualificationId}') BETWEEN 1 AND 512
    AND (plan #>> '{image,qualificationId}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND plan #>> '{image,qualificationId}' = qualification->>'imageQualificationId'
    AND jsonb_typeof(plan->'observationScope') = 'object'
    AND (plan->'observationScope') ?& ARRAY['kind', 'interfaceName', 'filterIdentity']
    AND (plan->'observationScope') - ARRAY['kind', 'interfaceName', 'filterIdentity'] = '{}'::jsonb
    AND plan #>> '{observationScope,kind}' = 'dns'
    AND jsonb_typeof(plan #> '{observationScope,interfaceName}') = 'string'
    AND char_length(plan #>> '{observationScope,interfaceName}') BETWEEN 1 AND 64
    AND (plan #>> '{observationScope,interfaceName}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(plan #> '{observationScope,filterIdentity}') = 'string'
    AND char_length(plan #>> '{observationScope,filterIdentity}') BETWEEN 1 AND 512
    AND (plan #>> '{observationScope,filterIdentity}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(plan->'limits') = 'object'
    AND (plan->'limits') ?& ARRAY[
      'maximumDurationMs', 'maximumCapturedRecords', 'maximumEncodedOutputBytes'
    ]
    AND (plan->'limits') - ARRAY[
      'maximumDurationMs', 'maximumCapturedRecords', 'maximumEncodedOutputBytes'
    ] = '{}'::jsonb
    AND jsonb_typeof(plan #> '{limits,maximumDurationMs}') = 'number'
    AND (plan #>> '{limits,maximumDurationMs}') ~ '^[1-9][0-9]{0,15}$'
    AND (plan #>> '{limits,maximumDurationMs}')::numeric
      <= (qualification->>'maximumDurationMs')::numeric
    AND jsonb_typeof(plan #> '{limits,maximumCapturedRecords}') = 'number'
    AND (plan #>> '{limits,maximumCapturedRecords}') ~ '^[1-9][0-9]{0,15}$'
    AND (plan #>> '{limits,maximumCapturedRecords}')::numeric
      <= (qualification->>'maximumCapturedRecords')::numeric
    AND jsonb_typeof(plan #> '{limits,maximumEncodedOutputBytes}') = 'number'
    AND (plan #>> '{limits,maximumEncodedOutputBytes}') ~ '^[1-9][0-9]{0,15}$'
    AND (plan #>> '{limits,maximumEncodedOutputBytes}')::numeric
      <= (qualification->>'maximumEncodedOutputBytes')::numeric
    AND jsonb_typeof(plan->'cancellation') = 'object'
    AND (plan->'cancellation') ?& ARRAY['kind', 'gracePeriodMs']
    AND (plan->'cancellation') - ARRAY['kind', 'gracePeriodMs'] = '{}'::jsonb
    AND plan #>> '{cancellation,kind}' = 'claim_abort'
    AND jsonb_typeof(plan #> '{cancellation,gracePeriodMs}') = 'number'
    AND (plan #>> '{cancellation,gracePeriodMs}') ~ '^[1-9][0-9]{0,15}$'
    AND (plan #>> '{cancellation,gracePeriodMs}')::numeric
      <= (qualification->>'maximumCancellationGraceMs')::numeric
    AND jsonb_typeof(plan->'evidenceDestination') = 'object'
    AND (plan->'evidenceDestination') ?& ARRAY['contractId', 'destinationId']
    AND (plan->'evidenceDestination') - ARRAY['contractId', 'destinationId'] = '{}'::jsonb
    AND jsonb_typeof(plan #> '{evidenceDestination,contractId}') = 'string'
    AND char_length(plan #>> '{evidenceDestination,contractId}') BETWEEN 1 AND 512
    AND (plan #>> '{evidenceDestination,contractId}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND plan #>> '{evidenceDestination,contractId}' = qualification->>'evidenceContractId'
    AND jsonb_typeof(plan #> '{evidenceDestination,destinationId}') = 'string'
    AND char_length(plan #>> '{evidenceDestination,destinationId}') BETWEEN 1 AND 512
    AND (plan #>> '{evidenceDestination,destinationId}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND plan->>'cleanupPolicy' = 'observer_first'
    AND jsonb_typeof(plan->'securityProfile') = 'object'
    AND (plan->'securityProfile') ?& ARRAY['profileId', 'capabilities', 'privileged']
    AND (plan->'securityProfile') - ARRAY['profileId', 'capabilities', 'privileged'] = '{}'::jsonb
    AND jsonb_typeof(plan #> '{securityProfile,profileId}') = 'string'
    AND char_length(plan #>> '{securityProfile,profileId}') BETWEEN 1 AND 512
    AND (plan #>> '{securityProfile,profileId}') ~ '^[A-Za-z0-9._~:@/-]+$'
    AND plan #>> '{securityProfile,profileId}' = qualification->>'securityProfileId'
    AND plan #> '{securityProfile,capabilities}' = '[]'::jsonb
    AND plan #> '{securityProfile,privileged}' = 'false'::jsonb,
    false
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_invocation_plan_is_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_invocation_timestamp_is_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT value ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$'
    AND occ.iso_timestamp_is_valid(value);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_invocation_timestamp_is_valid(text) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_target_resolution_is_valid(evidence jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY[
      'targetContainerId', 'namespaceNetworkId', 'targetIdentity', 'observedAt'
    ]
    AND evidence - ARRAY[
      'targetContainerId', 'namespaceNetworkId', 'targetIdentity', 'observedAt'
    ] = '{}'::jsonb
    AND jsonb_typeof(evidence->'targetContainerId') = 'string'
    AND evidence->>'targetContainerId' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(evidence->'namespaceNetworkId') = 'string'
    AND evidence->>'namespaceNetworkId' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(evidence->'targetIdentity') = 'string'
    AND char_length(evidence->>'targetIdentity') BETWEEN 1 AND 512
    AND evidence->>'targetIdentity' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND jsonb_typeof(evidence->'observedAt') = 'string'
    AND occ.observer_invocation_timestamp_is_valid(evidence->>'observedAt'),
    false
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_target_resolution_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_container_evidence_is_valid(evidence jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY['observerContainerId', 'createdAt']
    AND evidence - ARRAY['observerContainerId', 'createdAt'] = '{}'::jsonb
    AND jsonb_typeof(evidence->'observerContainerId') = 'string'
    AND evidence->>'observerContainerId' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(evidence->'createdAt') = 'string'
    AND occ.observer_invocation_timestamp_is_valid(evidence->>'createdAt'),
    false
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_container_evidence_is_valid(jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_readiness_evidence_is_valid(evidence jsonb, plan jsonb, progress jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(evidence) = 'object'
    AND evidence ?& ARRAY['targetContainerId', 'interfaceName', 'filterIdentity', 'readyAt']
    AND evidence - ARRAY['targetContainerId', 'interfaceName', 'filterIdentity', 'readyAt'] = '{}'::jsonb
    AND jsonb_typeof(evidence->'targetContainerId') = 'string'
    AND evidence->>'targetContainerId' ~ '^[a-f0-9]{64}$'
    AND evidence->>'targetContainerId' = progress #>> '{targetResolution,targetContainerId}'
    AND jsonb_typeof(evidence->'interfaceName') = 'string'
    AND char_length(evidence->>'interfaceName') BETWEEN 1 AND 64
    AND evidence->>'interfaceName' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND evidence->>'interfaceName' = plan #>> '{observationScope,interfaceName}'
    AND jsonb_typeof(evidence->'filterIdentity') = 'string'
    AND char_length(evidence->>'filterIdentity') BETWEEN 1 AND 512
    AND evidence->>'filterIdentity' ~ '^[A-Za-z0-9._~:@/-]+$'
    AND evidence->>'filterIdentity' = plan #>> '{observationScope,filterIdentity}'
    AND jsonb_typeof(evidence->'readyAt') = 'string'
    AND occ.observer_invocation_timestamp_is_valid(evidence->>'readyAt'),
    false
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_readiness_evidence_is_valid(jsonb, jsonb, jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_terminal_evidence_is_valid(evidence jsonb, plan jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  started_at timestamptz;
  deadline_at timestamptz;
  stopped_at timestamptz;
  completed_at timestamptz;
  maximum_duration numeric;
  maximum_records numeric;
  maximum_bytes numeric;
  captured_records numeric;
  encoded_bytes numeric;
BEGIN
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR NOT evidence ?& ARRAY[
      'startedAt', 'captureDeadlineAt', 'captureStoppedAt', 'terminalCompletedAt',
      'startOutcome', 'stopOutcome', 'boundsReached', 'capturedRecordCount',
      'encodedOutputBytes'
    ]
    OR evidence - ARRAY[
      'startedAt', 'captureDeadlineAt', 'captureStoppedAt', 'terminalCompletedAt',
      'startOutcome', 'stopOutcome', 'boundsReached', 'capturedRecordCount',
      'encodedOutputBytes'
    ] <> '{}'::jsonb
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'startedAt')
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'captureDeadlineAt')
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'captureStoppedAt')
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'terminalCompletedAt')
    OR jsonb_typeof(evidence->'startOutcome') IS DISTINCT FROM 'string'
    OR evidence->>'startOutcome' NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    OR jsonb_typeof(evidence->'stopOutcome') IS DISTINCT FROM 'string'
    OR evidence->>'stopOutcome' NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    OR jsonb_typeof(evidence->'boundsReached') IS DISTINCT FROM 'array'
    OR jsonb_typeof(evidence->'capturedRecordCount') IS DISTINCT FROM 'number'
    OR (evidence->>'capturedRecordCount') !~ '^(0|[1-9][0-9]{0,15})$'
    OR jsonb_typeof(evidence->'encodedOutputBytes') IS DISTINCT FROM 'number'
    OR (evidence->>'encodedOutputBytes') !~ '^(0|[1-9][0-9]{0,15})$'
    OR jsonb_typeof(plan #> '{limits,maximumDurationMs}') IS DISTINCT FROM 'number'
    OR (plan #>> '{limits,maximumDurationMs}') !~ '^[1-9][0-9]{0,15}$'
    OR jsonb_typeof(plan #> '{limits,maximumCapturedRecords}') IS DISTINCT FROM 'number'
    OR (plan #>> '{limits,maximumCapturedRecords}') !~ '^[1-9][0-9]{0,15}$'
    OR jsonb_typeof(plan #> '{limits,maximumEncodedOutputBytes}') IS DISTINCT FROM 'number'
    OR (plan #>> '{limits,maximumEncodedOutputBytes}') !~ '^[1-9][0-9]{0,15}$'
  THEN
    RETURN false;
  END IF;

  IF jsonb_array_length(evidence->'boundsReached') > 3
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(evidence->'boundsReached') AS bound(value)
      WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
        OR value #>> '{}' NOT IN ('duration', 'record_count', 'encoded_output')
    )
    OR (
      SELECT count(*) <> count(DISTINCT value)
      FROM jsonb_array_elements_text(evidence->'boundsReached') AS bound(value)
    )
  THEN
    RETURN false;
  END IF;

  started_at := (evidence->>'startedAt')::timestamptz;
  deadline_at := (evidence->>'captureDeadlineAt')::timestamptz;
  stopped_at := (evidence->>'captureStoppedAt')::timestamptz;
  completed_at := (evidence->>'terminalCompletedAt')::timestamptz;
  maximum_duration := (plan #>> '{limits,maximumDurationMs}')::numeric;
  maximum_records := (plan #>> '{limits,maximumCapturedRecords}')::numeric;
  maximum_bytes := (plan #>> '{limits,maximumEncodedOutputBytes}')::numeric;
  captured_records := (evidence->>'capturedRecordCount')::numeric;
  encoded_bytes := (evidence->>'encodedOutputBytes')::numeric;

  RETURN deadline_at = started_at + maximum_duration * interval '1 millisecond'
    AND stopped_at BETWEEN started_at AND deadline_at
    AND completed_at >= stopped_at
    AND captured_records <= maximum_records
    AND encoded_bytes <= maximum_bytes
    AND ((evidence->'boundsReached') ? 'duration') = (stopped_at = deadline_at)
    AND ((evidence->'boundsReached') ? 'record_count') = (captured_records = maximum_records)
    AND ((evidence->'boundsReached') ? 'encoded_output') = (encoded_bytes = maximum_bytes);
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_terminal_evidence_is_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_cleanup_evidence_is_valid(evidence jsonb, plan jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  termination_at timestamptz;
  grace_at timestamptz;
  removal_at timestamptz;
  absence_at timestamptz;
  maximum_grace numeric;
BEGIN
  IF jsonb_typeof(evidence) IS DISTINCT FROM 'object'
    OR NOT evidence ?& ARRAY[
      'terminationRequestedAt', 'graceDeadline', 'forceRemovalOutcome',
      'absenceVerifiedAt', 'targetTeardownAuthorized'
    ]
    OR evidence - ARRAY[
      'terminationRequestedAt', 'graceDeadline', 'forceRemovalOutcome',
      'removalCompletedAt', 'absenceVerifiedAt', 'targetTeardownAuthorized'
    ] <> '{}'::jsonb
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'terminationRequestedAt')
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'graceDeadline')
    OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'absenceVerifiedAt')
    OR jsonb_typeof(evidence->'forceRemovalOutcome') IS DISTINCT FROM 'string'
    OR evidence->>'forceRemovalOutcome' NOT IN ('not_required', 'removed')
    OR evidence->'targetTeardownAuthorized' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(plan #> '{cancellation,gracePeriodMs}') IS DISTINCT FROM 'number'
    OR (plan #>> '{cancellation,gracePeriodMs}') !~ '^[1-9][0-9]{0,15}$'
  THEN
    RETURN false;
  END IF;

  termination_at := (evidence->>'terminationRequestedAt')::timestamptz;
  grace_at := (evidence->>'graceDeadline')::timestamptz;
  absence_at := (evidence->>'absenceVerifiedAt')::timestamptz;
  maximum_grace := (plan #>> '{cancellation,gracePeriodMs}')::numeric;

  IF grace_at < termination_at
    OR grace_at > termination_at + maximum_grace * interval '1 millisecond'
  THEN
    RETURN false;
  END IF;

  IF evidence->>'forceRemovalOutcome' = 'removed' THEN
    IF NOT evidence ? 'removalCompletedAt'
      OR NOT occ.observer_invocation_timestamp_is_valid(evidence->>'removalCompletedAt')
    THEN
      RETURN false;
    END IF;
    removal_at := (evidence->>'removalCompletedAt')::timestamptz;
    RETURN removal_at >= grace_at AND absence_at >= removal_at;
  END IF;

  RETURN NOT evidence ? 'removalCompletedAt' AND absence_at >= termination_at;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_cleanup_evidence_is_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
CREATE FUNCTION occ.observer_invocation_progress_is_valid(progress jsonb, plan jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
BEGIN
  IF jsonb_typeof(progress) IS DISTINCT FROM 'object'
    OR progress - ARRAY['targetResolution', 'observer', 'readiness', 'terminal', 'cleanup']
      <> '{}'::jsonb
  THEN
    RETURN false;
  END IF;

  IF progress ? 'targetResolution'
    AND NOT occ.observer_target_resolution_is_valid(progress->'targetResolution')
  THEN
    RETURN false;
  END IF;

  IF progress ? 'observer' THEN
    IF NOT progress ? 'targetResolution'
      OR NOT occ.observer_container_evidence_is_valid(progress->'observer')
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'readiness' THEN
    IF NOT progress ? 'targetResolution'
      OR NOT progress ? 'observer'
      OR NOT occ.observer_readiness_evidence_is_valid(progress->'readiness', plan, progress)
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'terminal' THEN
    IF NOT progress ? 'observer'
      OR NOT occ.observer_terminal_evidence_is_valid(progress->'terminal', plan)
    THEN
      RETURN false;
    END IF;
  END IF;

  IF progress ? 'cleanup' THEN
    IF NOT progress ? 'terminal'
      OR NOT occ.observer_cleanup_evidence_is_valid(progress->'cleanup', plan)
    THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.observer_invocation_progress_is_valid(jsonb, jsonb) TO occ_app;
--> statement-breakpoint
CREATE TABLE occ.observer_invocations (
  work_id text PRIMARY KEY,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  request_fingerprint text NOT NULL,
  target_role text NOT NULL,
  status text NOT NULL,
  completed_phase text NOT NULL,
  qualification jsonb NOT NULL,
  plan jsonb NOT NULL,
  progress jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT observer_invocations_work_owner
    FOREIGN KEY (work_id)
    REFERENCES occ.controller_work(idempotency_key)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT observer_invocations_revision_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT observer_invocation_request_unique
    UNIQUE (namespace_id, actor_id, request_id),
  CONSTRAINT observer_invocation_status_valid CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT observer_invocation_phase_valid CHECK (
    completed_phase IN (
      'admitted', 'target_resolved', 'observer_created', 'ready', 'terminal', 'cleanup'
    )
  ),
  CONSTRAINT observer_invocation_target_role_valid CHECK (
    target_role IN ('agent', 'gateway')
  ),
  CONSTRAINT observer_invocation_identifiers_valid CHECK (
    work_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
    AND namespace_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
    AND agent_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
    AND revision_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
    AND actor_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
    AND request_id ~ '^[A-Za-z0-9._~:@/-]{1,200}$'
  ),
  CONSTRAINT observer_invocation_fingerprint_valid CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT observer_invocation_documents_valid CHECK (
    occ.observer_invocation_qualification_is_valid(qualification)
    AND occ.observer_invocation_plan_is_valid(plan, qualification)
    AND occ.observer_invocation_progress_is_valid(progress, plan)
  ),
  CONSTRAINT observer_invocation_phase_progress_valid CHECK (
    CASE completed_phase
      WHEN 'admitted' THEN progress = '{}'::jsonb
      WHEN 'target_resolved' THEN progress ? 'targetResolution'
        AND NOT progress ?| ARRAY['observer', 'readiness', 'terminal', 'cleanup']
      WHEN 'observer_created' THEN progress ?& ARRAY['targetResolution', 'observer']
        AND NOT progress ?| ARRAY['readiness', 'terminal', 'cleanup']
      WHEN 'ready' THEN progress ?& ARRAY['targetResolution', 'observer', 'readiness']
        AND NOT progress ?| ARRAY['terminal', 'cleanup']
      WHEN 'terminal' THEN progress ? 'terminal' AND NOT progress ? 'cleanup'
      WHEN 'cleanup' THEN progress ?& ARRAY['terminal', 'cleanup']
      ELSE false
    END
  ),
  CONSTRAINT observer_invocation_status_phase_valid CHECK (
    (completed_phase = 'admitted' AND status = 'queued')
    OR (completed_phase IN ('target_resolved', 'observer_created', 'ready', 'terminal')
      AND status IN ('queued', 'running'))
    OR (completed_phase = 'cleanup' AND status IN ('succeeded', 'failed', 'cancelled'))
  ),
  CONSTRAINT observer_invocation_terminal_outcome_valid CHECK (
    completed_phase <> 'cleanup'
    OR (status = 'succeeded' AND progress #>> '{terminal,stopOutcome}' = 'succeeded')
    OR (status = 'cancelled' AND progress #>> '{terminal,stopOutcome}' = 'cancelled')
    OR (status = 'failed'
      AND progress #>> '{terminal,stopOutcome}' IN ('failed', 'timed_out'))
  )
);
--> statement-breakpoint
CREATE INDEX observer_invocations_revision_history
ON occ.observer_invocations(namespace_id, agent_id, revision_id, created_at, work_id);
--> statement-breakpoint
CREATE FUNCTION occ.validate_observer_invocation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_phase_rank integer;
  new_phase_rank integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = NEW.work_id
      AND work.work_kind = 'observer'
      AND work.namespace_id = NEW.namespace_id
      AND work.agent_id = NEW.agent_id
      AND work.revision_id = NEW.revision_id
      AND work.actor_id = NEW.actor_id
      AND work.namespace_target IS NULL
      AND work.agent_target IS NULL
  ) THEN
    RAISE EXCEPTION 'observer invocation must match its exact controller work owner'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal observer invocation is immutable' USING ERRCODE = '23514';
    END IF;

    IF NEW.work_id IS DISTINCT FROM OLD.work_id
      OR NEW.namespace_id IS DISTINCT FROM OLD.namespace_id
      OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
      OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
      OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
      OR NEW.request_id IS DISTINCT FROM OLD.request_id
      OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
      OR NEW.target_role IS DISTINCT FROM OLD.target_role
      OR NEW.qualification IS DISTINCT FROM OLD.qualification
      OR NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'observer invocation accepted identity and authority are immutable'
        USING ERRCODE = '23514';
    END IF;

    old_phase_rank := CASE OLD.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'target_resolved' THEN 1
      WHEN 'observer_created' THEN 2
      WHEN 'ready' THEN 3
      WHEN 'terminal' THEN 4
      WHEN 'cleanup' THEN 5
    END;
    new_phase_rank := CASE NEW.completed_phase
      WHEN 'admitted' THEN 0
      WHEN 'target_resolved' THEN 1
      WHEN 'observer_created' THEN 2
      WHEN 'ready' THEN 3
      WHEN 'terminal' THEN 4
      WHEN 'cleanup' THEN 5
    END;
    IF new_phase_rank < old_phase_rank THEN
      RAISE EXCEPTION 'observer invocation progress is monotonic' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_each(OLD.progress) AS prior(key, value)
      WHERE NOT NEW.progress ? prior.key OR NEW.progress->prior.key IS DISTINCT FROM prior.value
    ) THEN
      RAISE EXCEPTION 'observer invocation evidence is append-only' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER observer_invocation_is_valid
BEFORE INSERT OR UPDATE ON occ.observer_invocations
FOR EACH ROW EXECUTE FUNCTION occ.validate_observer_invocation();
--> statement-breakpoint
REVOKE ALL ON occ.observer_invocations FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.observer_invocations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (
  status,
  completed_phase,
  progress,
  updated_at
) ON occ.observer_invocations TO occ_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.finalize_agent_deletion(
  p_namespace_id text,
  p_agent_id text,
  p_idempotency_key text,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, occ, pg_temp
AS $$
DECLARE
  v_service_principal_id text;
  v_actor_id text;
  v_attempt_count integer;
BEGIN
  SELECT work.actor_id, work.attempt_count
    INTO v_actor_id, v_attempt_count
  FROM occ.controller_work AS work
  WHERE work.idempotency_key = p_idempotency_key
    AND work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NULL
    AND work.agent_target = 'deleted'
    AND work.work_kind = 'lifecycle'
    AND work.state = 'claimed'
    AND work.claim_token = p_claim_token
    AND work.lease_expires_at > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM namespace.id FROM occ.namespaces AS namespace
  WHERE namespace.id = p_namespace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT agent.service_principal_id
    INTO v_service_principal_id
  FROM occ.agents AS agent
  WHERE agent.namespace_id = p_namespace_id
    AND agent.id = p_agent_id
    AND agent.status = 'deleting'
    AND agent.desired_runtime_state = 'stopped'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM attempt.admission_id FROM occ.repository_session_attempts AS attempt
  WHERE attempt.namespace_id = p_namespace_id AND attempt.agent_id = p_agent_id
  ORDER BY attempt.revision_id, attempt.admission_id FOR UPDATE;

  -- Revalidate lease time after every potentially blocking ownership lock.
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work AS work
    WHERE work.idempotency_key = p_idempotency_key AND work.claim_token = p_claim_token
      AND work.state = 'claimed' AND work.lease_expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.agent_provisioning_work AS provisioning
    JOIN occ.controller_work AS work ON work.idempotency_key = provisioning.work_id
    WHERE provisioning.namespace_id = p_namespace_id
      AND provisioning.agent_id = p_agent_id
      AND (
        (
          provisioning.progress ? 'pendingEffect'
          AND NOT (
            provisioning.progress ? 'effectReceipt'
            AND provisioning.progress->'effectReceipt'->>'kind' =
              provisioning.progress->'pendingEffect'->>'kind'
            AND provisioning.progress->'effectReceipt'->>'owner' =
              provisioning.progress->'pendingEffect'->>'owner'
            AND provisioning.progress->'effectReceipt'->>'targetId' =
              provisioning.progress->'pendingEffect'->>'targetId'
          )
        )
        OR (
          provisioning.progress ? 'effectReceipt'
          AND NOT (provisioning.progress ? 'pendingEffect')
        )
        OR provisioning.status IN ('queued', 'running')
        OR work.state IN ('queued', 'claimed')
      )
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM occ.observer_invocations AS invocation
    JOIN occ.controller_work AS work ON work.idempotency_key = invocation.work_id
    WHERE invocation.namespace_id = p_namespace_id
      AND invocation.agent_id = p_agent_id
      AND (
        work.state IN ('queued', 'claimed')
        OR invocation.status IN ('queued', 'running')
        OR invocation.completed_phase <> 'cleanup'
        OR NOT (invocation.progress ?& ARRAY['terminal', 'cleanup'])
        OR invocation.progress #> '{cleanup,targetTeardownAuthorized}' IS DISTINCT FROM 'true'::jsonb
      )
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE occ.repository_session_attempts SET live_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id
    AND live_revision_id IS NOT NULL;

  UPDATE occ.controller_work AS work
  SET agent_id = NULL,
      revision_id = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE work.namespace_id = p_namespace_id
    AND work.agent_id = p_agent_id
    AND work.revision_id IS NOT NULL
    AND work.namespace_target IS NULL
    AND work.agent_target IS NULL
    AND work.revision_id ~ '^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND work.idempotency_key ~ (
      '^agent_revision:' || work.revision_id ||
      ':repository_cleanup:(retire:)?[0-9a-f]{64}$'
    );

  UPDATE occ.agents
  SET active_revision_id = NULL
  WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  DELETE FROM occ.iam_access_bindings AS binding
  WHERE binding.identity_subject_id = v_service_principal_id
    OR (binding.resource_kind = 'agent' AND binding.resource_id = p_agent_id)
    OR (binding.resource_kind = 'agent_revision' AND binding.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.iam_restrictions AS restriction
  WHERE (restriction.resource_kind = 'agent' AND restriction.resource_id = p_agent_id)
    OR (restriction.resource_kind = 'agent_revision' AND restriction.resource_id IN (
      SELECT revision.id FROM occ.agent_revisions AS revision
      WHERE revision.namespace_id = p_namespace_id AND revision.agent_id = p_agent_id
    ));

  DELETE FROM occ.apikey WHERE reference_id = v_service_principal_id;
  DELETE FROM occ.controller_work AS work
  USING occ.agent_provisioning_work AS provisioning
  WHERE work.idempotency_key = provisioning.work_id
    AND provisioning.namespace_id = p_namespace_id
    AND provisioning.agent_id = p_agent_id
    AND work.work_kind = 'provisioning';
  DELETE FROM occ.controller_work AS work
  USING occ.observer_invocations AS invocation
  WHERE work.idempotency_key = invocation.work_id
    AND invocation.namespace_id = p_namespace_id
    AND invocation.agent_id = p_agent_id
    AND invocation.completed_phase = 'cleanup'
    AND invocation.status IN ('succeeded', 'failed', 'cancelled')
    AND invocation.progress ?& ARRAY['terminal', 'cleanup']
    AND invocation.progress #> '{cleanup,targetTeardownAuthorized}' = 'true'::jsonb
    AND work.work_kind = 'observer';
  DELETE FROM occ.agent_revisions
    WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  DELETE FROM occ.iam_identities
    WHERE id = v_service_principal_id
      AND namespace_id = p_namespace_id
      AND agent_id = p_agent_id
      AND kind = 'service_principal';
  DELETE FROM occ.agents
    WHERE namespace_id = p_namespace_id AND id = p_agent_id;

  INSERT INTO occ.audit_events (
    id, occurred_at, kind, actor_id, action, namespace_id,
    resource_kind, resource_id, outcome, details
  ) VALUES (
    'aud_' || pg_catalog.gen_random_uuid()::text,
    pg_catalog.clock_timestamp(),
    'mutation',
    v_actor_id,
    'openclaw.agents.lifecycle.delete',
    p_namespace_id,
    'agent',
    p_agent_id,
    'success',
    pg_catalog.jsonb_build_object(
      'reasonCode', 'AGENT_DELETED',
      'attemptCount', v_attempt_count
    )
  );

  DELETE FROM occ.controller_work
  WHERE namespace_id = p_namespace_id AND agent_id = p_agent_id;
  RETURN true;
END;
$$;

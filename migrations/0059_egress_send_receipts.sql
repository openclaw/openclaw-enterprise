CREATE TABLE occ.egress_send_receipts (
  sender_id text NOT NULL CONSTRAINT egress_send_receipts_check_0 CHECK (length(sender_id) > 0),
  sender_generation bigint NOT NULL CONSTRAINT egress_send_receipts_check_1 CHECK (sender_generation > 0),
  instance_id text NOT NULL CONSTRAINT egress_send_receipts_check_2 CHECK (length(instance_id) > 0),
  use_id text NOT NULL CONSTRAINT egress_send_receipts_check_3 CHECK (length(use_id) > 0),
  attempt_id text NOT NULL CONSTRAINT egress_send_receipts_check_4 CHECK (length(attempt_id) > 0),
  binding jsonb NOT NULL CONSTRAINT egress_send_receipts_check_5 CHECK (jsonb_typeof(binding) = 'object'),
  authorized_dispatch jsonb,
  observation jsonb,
  outcome jsonb NOT NULL CONSTRAINT egress_send_receipts_check_6 CHECK (jsonb_typeof(outcome) = 'object'),
  settled boolean NOT NULL DEFAULT false,
  feedback text CONSTRAINT egress_send_receipts_check_7 CHECK (feedback = 'fenced'),
  PRIMARY KEY (sender_id, sender_generation, instance_id, use_id, attempt_id),
  CONSTRAINT egress_send_receipts_check_8 CHECK ((binding->'sender'->>'id' = sender_id
      AND (binding->'sender'->>'generation')::bigint = sender_generation
      AND binding->>'instanceId' = instance_id
      AND binding->>'useId' = use_id AND binding->>'attemptId' = attempt_id
      AND length(binding->>'deadlineAt') > 0
      AND jsonb_typeof(binding->'material') IN ('object', 'null')) IS TRUE),
  CONSTRAINT egress_send_receipts_check_9 CHECK ((
    (outcome->>'kind' = 'refused' AND outcome->'dispatched' = 'false'::jsonb AND settled)
    OR (outcome->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
        AND outcome->>'dispatch' = 'confirmed' AND settled)
    OR (outcome->>'kind' = 'uncertain' AND outcome->>'dispatch' = 'possible')
  ) IS TRUE),
  CONSTRAINT egress_send_receipts_check_10 CHECK (outcome->>'kind' <> 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_11 CHECK (outcome->>'kind' <> 'response_blocked' OR (outcome->>'code' = 'response_policy') IS TRUE),
  CONSTRAINT egress_send_receipts_check_12 CHECK (outcome->>'kind' NOT IN ('response', 'provider_rejected')
    OR ((outcome->>'status')::integer BETWEEN 100 AND 599) IS TRUE),
  CONSTRAINT egress_send_receipts_check_13 CHECK (observation IS NULL OR (jsonb_typeof(observation) = 'object'
    AND observation->>'kind' IN ('response', 'provider_rejected', 'response_blocked')
    AND observation->>'dispatch' = 'confirmed'
    AND CASE WHEN observation->>'kind' = 'response_blocked'
      THEN observation->>'code' = 'response_policy'
      ELSE (observation->>'status')::integer BETWEEN 100 AND 599 END) IS TRUE),
  CONSTRAINT egress_send_receipts_check_14 CHECK (observation->>'kind' IS DISTINCT FROM 'provider_rejected' OR feedback IS NOT DISTINCT FROM 'fenced'),
  CONSTRAINT egress_send_receipts_check_15 CHECK (observation IS NULL OR NOT settled OR outcome = observation OR outcome->>'kind' = 'uncertain'),
  CONSTRAINT egress_send_receipts_check_16 CHECK (feedback IS NULL OR ((observation IS NOT NULL OR (settled AND outcome->>'dispatch' = 'confirmed'))
    AND binding->'material'->>'kind' = 'static') IS TRUE),
  CONSTRAINT egress_send_receipts_check_17 CHECK (authorized_dispatch IS NULL OR (jsonb_typeof(authorized_dispatch) = 'object'
    AND binding->'material'->>'kind' = 'static'
    AND authorized_dispatch->'association'->'installation'->>'instanceId' = instance_id
    AND authorized_dispatch->'association'->'execution'->>'installationId' = binding->'material'->'source'->>'installationId'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz > (authorized_dispatch->>'authorizedAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (authorized_dispatch->>'authorizedAt')::timestamptz + interval '1 second'
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->>'deadlineAt')::timestamptz
    AND (authorized_dispatch->>'sendStartBy')::timestamptz <= (binding->'material'->>'usableUntil')::timestamptz
    AND length(authorized_dispatch->'association'->>'exchangeId') > 0
    AND length(authorized_dispatch->'association'->>'responseId') > 0
    AND length(authorized_dispatch->'association'->>'custodyId') > 0
    AND length(authorized_dispatch->>'requestDigest') = 64
    AND length(authorized_dispatch->>'injectionDigest') = 64) IS TRUE)
);

GRANT SELECT, INSERT, UPDATE (authorized_dispatch, outcome, observation, settled, feedback) ON occ.egress_send_receipts TO occ_app;

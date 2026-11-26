-- Retire settled legacy Proxy Source metadata without changing admitted revisions.
DO $$
BEGIN
  IF EXISTS (
    WITH legacy AS (
      SELECT namespace_id, id FROM occ.credential_sources
      WHERE owner_capability = 'credential_proxy'
    ), referenced_revisions AS (
      SELECT r.namespace_id, r.admitted_spec
      FROM occ.agent_revisions r
      WHERE EXISTS (
        SELECT FROM occ.agents a
        WHERE (a.namespace_id, a.id, a.active_revision_id) = (r.namespace_id, r.agent_id, r.id)
      ) OR EXISTS (
        SELECT FROM occ.controller_work w
        WHERE (w.namespace_id, w.agent_id, w.revision_id) = (r.namespace_id, r.agent_id, r.id)
          AND w.state IN ('queued', 'claimed')
      ) OR EXISTS (
        SELECT FROM occ.egress_installations i
        WHERE (i.namespace_id, i.agent_id, i.revision_id) = (r.namespace_id, r.agent_id, r.id)
          AND NOT i.retired
      )
    )
    -- The legacy Proxy can own a protected execution even without Sources or routes.
    SELECT 1 FROM referenced_revisions r WHERE r.admitted_spec ? 'egress_plan'
    UNION ALL
    SELECT 1 FROM legacy s WHERE
      EXISTS (
        SELECT FROM referenced_revisions r WHERE r.namespace_id = s.namespace_id AND (
          (r.admitted_spec #>> '{harness_auth,method}' = 'credential_source'
            AND r.admitted_spec #>> '{harness_auth,sourceId}' = s.id)
          OR r.admitted_spec->'credential_sources' @> jsonb_build_array(jsonb_build_object('sourceId', s.id))
          OR jsonb_path_exists(r.admitted_spec, '$.egress_plan.routes[*].binding.source.source.id ? (@ == $id)',
            jsonb_build_object('id', s.id))
        )
      ) OR EXISTS (
        SELECT FROM occ.egress_installations i
        WHERE i.namespace_id = s.namespace_id AND NOT i.retired
          AND jsonb_path_exists(i.installation, '$.plan.routes[*].binding.source.source.id ? (@ == $id)',
            jsonb_build_object('id', s.id))
      ) OR EXISTS (
        SELECT FROM occ.agent_provisioning_work w WHERE w.namespace_id = s.namespace_id
          AND w.status IN ('queued', 'running') AND (
            (w.plan #>> '{harnessAuth,method}' = 'credential_source' AND w.plan #>> '{harnessAuth,sourceId}' = s.id)
            OR w.plan->'credentialSources' @> jsonb_build_array(jsonb_build_object('sourceId', s.id))
          )
      ) OR EXISTS (
        SELECT FROM occ.credential_withdrawals w
        WHERE (w.namespace_id, w.credential_source_id) = (s.namespace_id, s.id) AND w.state = 'pending'
      ) OR EXISTS (
        SELECT FROM occ.egress_send_receipts r WHERE r.authorized_dispatch IS NOT NULL AND NOT r.settled
          AND r.binding #>> '{material,source,namespaceId}' = s.namespace_id
          AND r.binding #>> '{material,source,source,id}' = s.id
      ) OR EXISTS (
        SELECT FROM occ.prepared_github_families f
        WHERE f.source_id = s.id AND f.source #>> '{key,namespaceId}' = s.namespace_id
          AND (f.enabled OR f.worker_claim IS NOT NULL OR EXISTS (
            SELECT FROM occ.prepared_github_attempts a
            WHERE a.source_id = f.source_id
              AND a.custody NOT IN ('revoked', 'expired', 'not_issued')
          ))
      )
  ) THEN
    RAISE EXCEPTION 'Legacy Proxy Source retirement requires stopping active delivery and settling pending work'
      USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
WITH legacy AS (
  SELECT namespace_id, id FROM occ.credential_sources WHERE owner_capability = 'credential_proxy'
)
UPDATE occ.agents a
SET harness_auth = CASE
      WHEN EXISTS (
        SELECT FROM legacy s WHERE (s.namespace_id, s.id) =
          (a.namespace_id, a.harness_auth_credential_source_id)
      ) THEN NULL ELSE a.harness_auth END,
    credential_sources = (
      SELECT jsonb_agg(binding ORDER BY position)
      FROM jsonb_array_elements(a.credential_sources) WITH ORDINALITY AS selected(binding, position)
      WHERE NOT EXISTS (
        SELECT FROM legacy s WHERE (s.namespace_id, s.id) =
          (a.namespace_id, binding->>'sourceId')
      )
    )
WHERE EXISTS (
  SELECT FROM occ.agent_credential_sources chosen JOIN legacy s
    ON (chosen.namespace_id, chosen.credential_source_id) = (s.namespace_id, s.id)
  WHERE (chosen.namespace_id, chosen.agent_id) = (a.namespace_id, a.id)
);
--> statement-breakpoint
DELETE FROM occ.iam_access_bindings b USING occ.credential_sources s
  WHERE s.owner_capability = 'credential_proxy' AND b.resource_kind = 'credential_source'
    AND (b.namespace_id, b.resource_id) = (s.namespace_id, s.id);
--> statement-breakpoint
DELETE FROM occ.credential_sources WHERE owner_capability = 'credential_proxy';

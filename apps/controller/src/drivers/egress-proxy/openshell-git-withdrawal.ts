import type { CredentialDeliveryReduction, PostgresClient } from "@openclaw-enterprise/occ";

interface OnlineGitWithdrawalReceipt extends Omit<CredentialDeliveryReduction, "materialVersion"> {
  readonly materialVersion: string | null;
  readonly preparationAttemptId: string | null;
}

/** The caller holds the original delivery row lock in this transaction, before this statement. */
export async function withdrawOnlineGitRoute(
  client: PostgresClient,
  identity: OnlineGitWithdrawalReceipt,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE occ.credential_deliveries r
     SET blocked='withdrawn',
         updated_at=CASE WHEN r.blocked='withdrawn' THEN r.updated_at ELSE clock_timestamp() END
     WHERE r.revision_id=$1 AND r.binding_id=$2 AND r.fence=$3
       AND r.observed=$4::jsonb AND r.material_version IS NOT DISTINCT FROM $5::uuid
       AND r.preparation_attempt_id IS NOT DISTINCT FROM $7::uuid AND r.retained_policy_hash=$6
       AND r.live_revision_id=r.revision_id AND r.settlement='snapshot' AND r.write_pending IS NULL
       AND (r.blocked IS NULL OR r.blocked IN ('repository_expired','withdrawn'))
       AND EXISTS (
         SELECT FROM occ.controller_work deployed
         WHERE (deployed.namespace_id,deployed.agent_id,deployed.revision_id) =
               (r.namespace_id,r.agent_id,r.revision_id)
           AND deployed.idempotency_key = 'agent_revision:' || r.revision_id || ':reconcile'
           AND deployed.agent_target IS NULL AND deployed.namespace_target IS NULL
           AND deployed.state = 'succeeded'
           AND deployed.reason_code IN ('REVISION_ACTIVATED','REVISION_ALREADY_ACTIVE')
       )
       AND NOT EXISTS (
         SELECT FROM occ.credential_delivery_reductions d
         WHERE (d.revision_id,d.binding_id)=(r.revision_id,r.binding_id)
           AND NOT (
             d.fence=$3 AND d.recipient IS NOT DISTINCT FROM $4::jsonb
             AND d.material_version IS NOT DISTINCT FROM $5
             AND d.retained_policy_hash IS NOT DISTINCT FROM $6
             AND d.request_id IS NULL AND d.expected_version IS NULL
             AND d.observed_generation IS NULL AND d.policy_request IS NULL AND d.policy_observed IS NULL
           )
       )`,
    [
      identity.revisionId,
      identity.bindingId,
      identity.fence,
      JSON.stringify(identity.recipient),
      identity.materialVersion,
      identity.retainedPolicyHash,
      identity.preparationAttemptId,
    ],
  );
  return result.rowCount === 1;
}

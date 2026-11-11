import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";

/**
 * The committed release installation (p) and the independently observed Git route (r).
 * Bind the recipient that enforcement actually identified, not similarly named IDs from
 * different protocols. Provider resource, credential and control-session versions may rotate.
 */
export const admittedAuthorization = "p.installation #>> '{plan,repositoryGitAuthorization}'";
export const recipientAuthorization =
  "p.installation #>> '{enforcement,repositoryGitRecipient,authorization}'";
export const peerKey = "p.installation #>> '{enforcement,peerKeyId}'";
// v4 requires its original peer-bound recipient. v5 requires an explicit online recipient,
// without inventing a peer key that the sender neither possessed nor proved.
const matchingAuthorization = `(CASE WHEN p.installation->'plan' ? 'repositoryGitAuthorization'
  THEN ${admittedAuthorization} = 'online-request'
    AND ${recipientAuthorization} = 'online-request' AND ${peerKey} IS NULL
  ELSE ${recipientAuthorization} IS NULL AND nullif(btrim(${peerKey}), '') IS NOT NULL END)`;
// Repository execution releases contain exactly one binding. Both the signed release and the
// independently observed recipient must explicitly name installation delivery; absence means narrow.
export const recipient = "p.installation#>'{enforcement,repositoryGitRecipient}'";
export const releasedGitProfile = `CASE
  WHEN ${recipient}->>'deliveryProfile' = 'github_installation' THEN 'github-installation'
  WHEN ${recipient}->>'deliveryProfile' = 'github_repository' THEN 'github-repository'
  WHEN NOT (${recipient} ? 'deliveryProfile') THEN 'git-write'
  END`;
export const registeredGitSelection = `p.installation#>>'{plan,repositoryGit,bindings,0,profile}' = ${releasedGitProfile}
  AND (jsonb_array_length(p.installation#>'{plan,repositoryGit,bindings}')=1 OR
    (${recipient}->>'deliveryProfile'='github_repository' AND NOT EXISTS (SELECT FROM jsonb_array_elements(p.installation#>'{plan,repositoryGit,bindings}') b WHERE b->>'profile'<>'github-repository'))) AND ${matchingAuthorization}`;

/** Bound by the host with SET LOCAL in every custody transaction, never by a sender request. */
export const selectedRepositoryGitDriver = "current_setting('occ.repository_git_driver')::jsonb";
export const repositoryGitOwnerPredicate = `f.source #> '{session,credentialProxyExecution,driver}' = ${selectedRepositoryGitDriver}`;

export const legacyAdoption = "prepared_repository_git";
export const protectedGitAdoption = "credential_proxy_repository_git";
export const selectedGitAdoption = "credential_proxy_github_repository";
export const installationGitAdoption = "credential_proxy_github_installation";
export const repositoryGitDeliveryTransport = "registered-repository-git/v1";

// The broker owns only its recorded admission, session and generation; the receipt remains after disposal.
export const repositoryGitBrokerOwnerPredicate = `EXISTS (
  SELECT FROM occ.repository_session_attempts s JOIN occ.repository_broker_receipts b USING (admission_id)
  WHERE s.broker_protocol IN (1,3) AND s.session_id=b.session_id
    AND (s.admission_id,s.revision_id,b.session_id,b.generation::text) =
      (f.source#>>'{session,admissionId}',f.source#>>'{session,revisionId}',
       f.source#>>'{session,sessionId}',f.source#>>'{session,brokerGeneration}')
)`;

/**
 * One row for a selected-repository grant, derived from its immutable admission.
 * Missing/ended members remain in the LEFT JOIN so all_current cannot silently
 * authorize a subset. The active-binding unique index gives at most one session
 * per member. Identities fence material across replacement; they are not authority.
 * The caller owns locks and must re-read this projection after acquiring them.
 */
export function selectedRepositoryGrantSql(admissionId: string): string {
  return `SELECT revision.admitted_spec#>'{repository_credentials,bindings}' AS bindings,
    jsonb_agg(jsonb_build_object('repositoryRef',member->>'repositoryRef',
      'admissionId',session.admission_id,'sessionId',session.session_id)
      ORDER BY member->>'repositoryRef') AS member_sessions,
    bool_and(session.session_id IS NOT NULL
      AND clock_timestamp() < to_timestamp(session.deadline_wall_ms / 1000.0)
      AND (agent.repository_bindings @> jsonb_build_array(jsonb_build_object(
        'repositoryRef',member->>'repositoryRef','profile',member->>'profile'))) IS TRUE
    ) AS all_current
  FROM occ.repository_session_attempts anchor
  JOIN occ.agent_revisions revision ON (revision.namespace_id,revision.agent_id,revision.id)=
    (anchor.namespace_id,anchor.agent_id,anchor.revision_id)
  JOIN occ.agents agent ON (agent.namespace_id,agent.id)=(anchor.namespace_id,anchor.agent_id)
  CROSS JOIN LATERAL jsonb_array_elements(revision.admitted_spec#>'{repository_credentials,bindings}') member
  LEFT JOIN occ.repository_session_attempts session ON
    (session.namespace_id,session.agent_id,session.revision_id,session.live_revision_id)=
      (anchor.namespace_id,anchor.agent_id,anchor.revision_id,anchor.revision_id)
    AND session.repository_ref=member->>'repositoryRef'
    AND session.cleanup_context->'binding'=member
    AND session.cleanup_context->'driver'=revision.admitted_spec#>'{repository_credentials,driver}'
    AND session.broker_protocol=2 AND session.phase='open'
  WHERE anchor.admission_id=${admissionId}
    AND anchor.cleanup_context#>>'{binding,profile}'='github-repository'
  GROUP BY revision.admitted_spec`;
}

/** Absence of a sender's evidence denies use. Only OCC's positive end of this admission retires it. */
export const repositoryGitAdmissionEnded = `EXISTS (
  SELECT FROM occ.repository_session_attempts s
  WHERE (s.admission_id,s.revision_id,s.session_id) =
    (f.source#>>'{session,admissionId}',f.source#>>'{session,revisionId}',f.source#>>'{session,sessionId}')
    AND (s.phase IN ('closing','disposed','invalidated') OR s.live_revision_id IS NULL
      OR to_timestamp(s.deadline_wall_ms / 1000.0) <= clock_timestamp()
      OR (f.source->>'adoption'='${selectedGitAdoption}' AND EXISTS (
        SELECT FROM (${selectedRepositoryGrantSql("s.admission_id")}) grant_state
        WHERE grant_state.all_current IS NOT TRUE
          OR grant_state.bindings IS DISTINCT FROM f.source#>'{session,bindings}'
          OR grant_state.member_sessions IS DISTINCT FROM f.source#>'{session,memberSessions}'))
      OR EXISTS (SELECT FROM occ.repository_standing_executions e
        WHERE e.revision_id=s.revision_id AND e.closed)
      OR EXISTS (SELECT FROM occ.repository_standing_approvals a
        WHERE a.id=f.source#>>'{session,standingApprovalId}' AND a.revoked_at IS NOT NULL)
      OR EXISTS (SELECT FROM occ.agents g WHERE (g.namespace_id,g.id)=(s.namespace_id,s.agent_id)
        AND (g.active_revision_id IS DISTINCT FROM s.revision_id OR g.desired_runtime_state <> 'running')))
  )`;

/** Alongside matchingAuthorization, require the policy and every stable recipient identity. */
export const validRecipient = [
  "instanceId",
  "configurationId",
  "policyHash",
  ...repositoryGitRecipientFields.map((field) => "repositoryGitRecipient," + field),
]
  .map((path) => `nullif(btrim(p.installation#>>'{enforcement,${path}}'), '') IS NOT NULL`)
  .join(" AND ");

/**
 * The host selects its actual durable observer, never by a Driver's name or a request field.
 * Custody owns the surrounding transaction and the joins to OCC authority and committed material.
 */
export interface RepositoryGitRecipientEvidence {
  /** Join r to the session, then compare r with the release installation p. */
  readonly join: string;
  readonly released: string;
  /** Under FOR SHARE of r and p: match (revisionId, fence, observed) and optionally (attemptId, version). */
  readonly observed: string;
  readonly installed: string;
}

const registeredObservation = `SELECT FROM occ.credential_deliveries WHERE revision_id=$1 AND fence=$2
    AND binding_id=$3::jsonb#>>'{plan,execution,executionId}'
    AND target=jsonb_build_object('transport','${repositoryGitDeliveryTransport}','installation',$3::jsonb)
    AND settlement='witness' AND live_revision_id IS NOT NULL AND blocked IS NULL AND write_pending IS NULL`;
export const registeredGitRecipientEvidence: RepositoryGitRecipientEvidence = Object.freeze({
  join: `occ.credential_deliveries r USING(namespace_id,agent_id,revision_id)`,
  released: `p.installation=r.target->'installation'
    AND r.target->>'transport'='${repositoryGitDeliveryTransport}'
    AND r.binding_id=p.installation#>>'{plan,execution,executionId}'
    AND r.settlement='witness' AND r.live_revision_id IS NOT NULL AND r.blocked IS NULL AND r.write_pending IS NULL
    AND ${registeredGitSelection}`,
  observed: registeredObservation,
  installed: `${registeredObservation} AND preparation_attempt_id=$4 AND material_version=$5`,
});

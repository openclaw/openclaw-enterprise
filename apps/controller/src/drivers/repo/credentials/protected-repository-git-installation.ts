import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";

/**
 * The committed release installation (p) and the independently observed Git route (r).
 * Bind the recipient that enforcement actually identified, not similarly named IDs from
 * different protocols. Provider resource, credential and control-session versions may rotate.
 */
const admittedAuthorization = "p.installation #>> '{plan,repositoryGitAuthorization}'";
const recipientAuthorization =
  "p.installation #>> '{enforcement,repositoryGitRecipient,authorization}'";
const peerKey = "p.installation #>> '{enforcement,peerKeyId}'";
// v4 requires its original peer-bound recipient. v5 requires an explicit online recipient,
// without inventing a peer key that the sender neither possessed nor proved.
const matchingAuthorization = `(CASE WHEN p.installation->'plan' ? 'repositoryGitAuthorization'
  THEN ${admittedAuthorization} = 'online-request'
    AND ${recipientAuthorization} = 'online-request' AND ${peerKey} IS NULL
  ELSE ${recipientAuthorization} IS NULL AND nullif(btrim(${peerKey}), '') IS NOT NULL END)`;
// Repository execution releases contain exactly one binding. Both the signed release and the
// independently observed recipient must explicitly name installation delivery; absence means narrow.
const recipient = "p.installation#>'{enforcement,repositoryGitRecipient}'";
export const releasedGitProfile = `CASE
  WHEN ${recipient}->>'deliveryProfile' = 'github_installation' THEN 'github-installation'
  WHEN NOT (${recipient} ? 'deliveryProfile') THEN 'git-write'
  END`;
export const registeredGitSelection = `p.installation#>>'{plan,repositoryGit,bindings,0,profile}' = ${releasedGitProfile}
  AND jsonb_array_length(p.installation#>'{plan,repositoryGit,bindings}')=1 AND ${matchingAuthorization}`;

// The route stores the observed provider name, id, resource and profile versions. Its owner
// verifies the complete profile, not just this name. Keep the installed observation schema and
// existing narrow names; an installation recipient must agree with this distinct profile family.
export const openShellInstallationGitProviderPrefix = "oce-github-installation-";
export const openShellGitDeliveryTransport = "openshell-repository-git/v1";
const observedInstallationProfile =
  "r.observed->>'provider' ~ '^" + openShellInstallationGitProviderPrefix + "[0-9a-f]{32}$'";

// The preview correlates a denial at the held launcher with the authenticated callback.
// It cannot prove an operator will retain that hook. Strict senders never accept this branch.
const observedHookSelection = `(${admittedAuthorization} = 'request-hook-observed'
  AND ${recipientAuthorization} = 'request-hook-observed' AND ${peerKey} IS NULL
  AND (${recipient}->>'deliveryProfile') = 'github_installation'
  AND p.installation#>>'{plan,repositoryGit,bindings,0,profile}' = 'github-installation'
  AND jsonb_array_length(p.installation#>'{plan,repositoryGit,bindings}')=1
  AND (r.observed#>>'{observedHook,startupId}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND (r.observed#>>'{observedHook,observationId}') ~ '^[a-f0-9]{64}$'
  AND r.observed->'observedHook' = ${recipient}->'observedHook')`;

export const protectedRepositoryGitInstallationSql = `
  (p.namespace_id,p.agent_id,p.revision_id)=(r.namespace_id,r.agent_id,r.revision_id)
  AND r.target->>'transport'='${openShellGitDeliveryTransport}'
  AND ((${registeredGitSelection} AND NOT (r.observed ? 'observedHook')) OR ${observedHookSelection})
  AND CASE WHEN ${recipient} ? 'deliveryProfile'
    THEN ${observedInstallationProfile} AND ${admittedAuthorization} IN ('online-request','request-hook-observed')
    ELSE NOT (${observedInstallationProfile}) END
  AND p.sandbox_id = r.observed->>'sandboxId'
  AND r.binding_id = p.installation#>>'{plan,execution,executionId}'
  AND r.observed->>'executionId' = r.revision_id AND r.observed->>'providerId' = (r.desired->>'providerId')
  AND nullif(r.observed->>'policyHash', '') = p.installation#>>'{enforcement,policyHash}'
  AND p.installation#>>'{enforcement,authorityScope}' = 'execution'
  AND ${["instanceId", "configurationId"]
    .map((key) => `nullif(p.installation#>>'{enforcement,${key}}', '') IS NOT NULL`)
    .join(" AND ")}
  AND ${repositoryGitRecipientFields
    .map(
      (key) =>
        `nullif(r.observed->>'${key}', '') = p.installation#>>'{enforcement,repositoryGitRecipient,${key}}'`,
    )
    .join(" AND ")}`;

/** Bound by the host with SET LOCAL in every custody transaction, never by a sender request. */
export const selectedRepositoryGitDriver = "current_setting('occ.repository_git_driver')::jsonb";
export const repositoryGitOwnerPredicate = `f.source #> '{session,credentialProxyExecution,driver}' = ${selectedRepositoryGitDriver}`;

export const legacyAdoption = "prepared_repository_git";
export const protectedGitAdoption = "credential_proxy_repository_git";
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

/** Absence of a sender's evidence denies use. Only OCC's positive end of this admission retires it. */
export const repositoryGitAdmissionEnded = `EXISTS (
  SELECT FROM occ.repository_session_attempts s
  WHERE (s.admission_id,s.revision_id,s.session_id) =
    (f.source#>>'{session,admissionId}',f.source#>>'{session,revisionId}',f.source#>>'{session,sessionId}')
    AND (s.phase IN ('closing','disposed','invalidated') OR s.live_revision_id IS NULL
      OR to_timestamp(s.deadline_wall_ms / 1000.0) <= clock_timestamp()
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

const openShellRoute = "occ.credential_deliveries";
const openShellObserved = `SELECT FROM ${openShellRoute} WHERE revision_id=$1 AND fence=$2
  AND binding_id=(SELECT admitted_spec#>>'{egress_plan,execution,executionId}' FROM occ.agent_revisions WHERE id=$1)
  AND target->>'transport'='${openShellGitDeliveryTransport}'
  AND live_revision_id IS NOT NULL AND settlement='snapshot' AND observed=$3::jsonb AND blocked IS NULL`;

/** Only a terminal tombstone for this same observed preview retires its possibly installed
 * material. Lost evidence stays unknown; neither strict mode nor another recipient matches. */
export const openShellPreviewEnded = `EXISTS (
  SELECT FROM ${openShellRoute} r JOIN occ.egress_installations p ON ${protectedRepositoryGitInstallationSql}
  WHERE r.blocked IS NOT NULL AND ${admittedAuthorization}='request-hook-observed'
    AND f.source->>'adoption'='${installationGitAdoption}'
    AND (r.namespace_id,r.agent_id,r.revision_id,r.binding_id,p.sandbox_id)=
      (f.source#>>'{session,namespaceId}', f.source#>>'{session,agentId}', f.source#>>'{session,revisionId}',
       f.source#>>'{session,credentialProxyExecution,executionId}', f.source#>>'{session,credentialProxyExecution,sandboxId}')
    AND p.installation->'enforcement'=f.source#>'{session,credentialProxyExecution,enforcement}'
    AND p.installation#>'{plan,driver}'=f.source#>'{session,credentialProxyExecution,driver}')`;

/** Read the bundled observer's existing fenced route; no duplicate registration or adoption. */
export const openShellGitRecipientEvidence: RepositoryGitRecipientEvidence = Object.freeze({
  join: `${openShellRoute} r USING(namespace_id, agent_id, revision_id)`,
  released: `${protectedRepositoryGitInstallationSql} AND r.live_revision_id IS NOT NULL AND r.settlement='snapshot' AND r.blocked IS NULL`,
  observed: openShellObserved,
  installed: `${openShellObserved} AND observed->>'credentialState'='active' AND write_pending IS NULL
    AND desired->>'credentialState'='active'
    AND observed->>'providerId'=desired->>'providerId'
    AND observed->>'providerResourceVersion'=desired->>'resourceVersion'
    AND observed->>'profileVersion'=desired->>'profileVersion'
    AND preparation_attempt_id=$4 AND material_version=$5`,
});

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

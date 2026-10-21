import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";

/**
 * The committed release installation (p) and the independently observed Git route (r).
 * Bind the recipient that enforcement actually identified, not similarly named IDs from
 * different protocols. Provider resource, credential and control-session versions may rotate.
 */
export const protectedRepositoryGitInstallationSql = `
  (p.namespace_id,p.agent_id,p.revision_id)=(r.namespace_id,r.agent_id,r.revision_id)
  AND p.sandbox_id = r.observed->>'sandboxId'
  AND r.binding_id = p.installation#>>'{plan,execution,executionId}'
  AND r.observed->>'executionId' = r.revision_id AND r.observed->>'providerId' = r.provider_id
  AND nullif(r.observed->>'policyHash', '') = p.installation#>>'{enforcement,policyHash}'
  AND p.installation#>>'{enforcement,authorityScope}' = 'execution'
  AND ${["instanceId", "configurationId", "peerKeyId"]
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

export const protectedGitAdoption = "credential_proxy_repository_git";
export const installationGitAdoption = "credential_proxy_github_installation";
export const repositoryGitRecipients = "occ.protected_repository_git_recipients";

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

/** The committed release must bind a peer, policy and every stable recipient identity. */
export const validRecipient = [
  "instanceId",
  "configurationId",
  "policyHash",
  "peerKeyId",
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

const openShellRoute = "occ.openshell_git_routes";
const openShellObserved = `SELECT FROM ${openShellRoute} WHERE revision_id=$1 AND fence=$2
  AND observed=$3::jsonb AND blocked IS NULL AND detach_request_id IS NULL`;

/** Read the bundled observer's existing fenced route; no duplicate registration or adoption. */
export const openShellGitRecipientEvidence: RepositoryGitRecipientEvidence = Object.freeze({
  join: `${openShellRoute} r USING(namespace_id, agent_id, revision_id)`,
  released: `${protectedRepositoryGitInstallationSql} AND r.blocked IS NULL AND r.detach_request_id IS NULL`,
  observed: openShellObserved,
  installed: `${openShellObserved} AND observed->>'credentialState'='active' AND write_pending IS NULL
    AND preparation_attempt_id=$4 AND material_version=$5`,
});

// A version-four release contains exactly one binding. Both the signed release and the
// independently observed recipient must explicitly name installation delivery; absence means narrow.
const recipient = "p.installation#>'{enforcement,repositoryGitRecipient}'";
export const registeredGitProfile = `CASE
  WHEN ${recipient}->>'deliveryProfile' = 'github_installation' THEN 'github-installation'
  WHEN NOT (${recipient} ? 'deliveryProfile') THEN 'git-write'
  END`;
export const registeredGitSelection = `p.installation#>>'{plan,repositoryGit,bindings,0,profile}' = ${registeredGitProfile}
  AND jsonb_array_length(p.installation#>'{plan,repositoryGit,bindings}')=1`;

const registeredObservation = `SELECT FROM ${repositoryGitRecipients} WHERE revision_id=$1 AND fence=$2
    AND installation=$3::jsonb AND state <> 'installing'`;
export const registeredGitRecipientEvidence: RepositoryGitRecipientEvidence = Object.freeze({
  join: `${repositoryGitRecipients} r USING(revision_id)`,
  released: `p.installation=r.installation AND r.state <> 'installing' AND ${registeredGitSelection}`,
  observed: registeredObservation,
  installed: `${registeredObservation} AND state='installed' AND attempt_id=$4 AND material_version=$5`,
});

import { repositoryGitRecipientFields } from "@openclaw-enterprise/contracts";
import {
  admittedAuthorization,
  recipientAuthorization,
  peerKey,
  recipient,
  registeredGitSelection,
  installationGitAdoption,
  selectedGitAdoption,
  protectedGitAdoption,
  type RepositoryGitRecipientEvidence,
} from "../repo/credentials/protected-repository-git-installation.ts";

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

const openShellRoute = "occ.credential_deliveries";
const openShellObserved = `SELECT FROM ${openShellRoute} WHERE revision_id=$1 AND fence=$2
  AND binding_id=(SELECT admitted_spec#>>'{egress_plan,execution,executionId}' FROM occ.agent_revisions WHERE id=$1)
  AND target->>'transport'='${openShellGitDeliveryTransport}'
  AND live_revision_id IS NOT NULL AND settlement='snapshot' AND observed=$3::jsonb AND blocked IS NULL`;

/** Only a terminal tombstone for this same observed preview retires its possibly installed
 * material. Lost evidence stays unknown; neither strict mode nor another recipient matches. */
export const openShellPreviewEnded = `EXISTS (
  SELECT FROM ${openShellRoute} r JOIN occ.egress_installations p ON ${protectedRepositoryGitInstallationSql}
  WHERE r.blocked IS NOT NULL
    AND ((${admittedAuthorization}='request-hook-observed' AND f.source->>'adoption'='${installationGitAdoption}')
      OR (${admittedAuthorization}='online-request' AND f.source->>'adoption' IN ('${selectedGitAdoption}','${protectedGitAdoption}')))
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

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

import { CONFIGURED_IAM_ID_PREFIXES } from "@openclaw-enterprise/contracts";
import type { GithubRosterMapping, InstallationIAMConfiguration } from "@openclaw-enterprise/occ";
import { githubProviderId } from "./github.ts";

export function bindGithubTeamMappings(
  iam: InstallationIAMConfiguration | undefined,
  clientId: string | undefined,
): readonly GithubRosterMapping[] {
  const rules = iam?.githubTeamMappings ?? [];
  if (!rules.length) {
    return [];
  }
  if (!clientId) {
    throw new Error("Configured GitHub team mappings require the GitHub sign-in client ID.");
  }
  const providerId = githubProviderId({ clientId });
  return rules.map(({ id, organizationId, teamId, group }) => ({
    id,
    organizationId,
    teamId,
    providerId,
    groupId: `${CONFIGURED_IAM_ID_PREFIXES.group}${group}`,
  }));
}

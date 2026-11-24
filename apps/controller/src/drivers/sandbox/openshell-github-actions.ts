import { isDeepStrictEqual } from "node:util";

import {
  ConfigurationValidationError,
  repositoryGitDeliveryProfile,
} from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  OpenClawConfigurationDocument,
  RepositoryGitDeliveryProfile,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";

// Frozen revisions must remain readable if GitHub changes its published Actions hosts.
const storageRanges = [
  [0, 19],
  [30, 49],
  [100, 199],
] as const;

const profile = "github_repository";
const downloads = {
  name: "oce-egress-actions-downloads",
  binaries: [{ path: "/usr/local/bin/gh" }],
  endpoints: [
    "results-receiver.actions.githubusercontent.com",
    ...storageRanges.flatMap(([first, last]) =>
      Array.from(
        { length: last - first + 1 },
        (_, index) => `productionresultssa${first + index}.blob.core.windows.net`,
      ),
    ),
  ].map((host) => ({
    host,
    ports: [443],
    enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
    tls: "NETWORK_TLS_MODE_SKIP",
  })),
};

export const githubActionsDownloads = Object.freeze({
  name: downloads.name,

  admit(
    declared: Readonly<OpenClawConfigurationDocument>,
    onlineProfile: RepositoryGitDeliveryProfile | undefined,
  ): Readonly<OpenClawConfigurationDocument> {
    return onlineProfile === profile
      ? immutableCopy({ ...declared, [downloads.name]: downloads })
      : declared;
  },

  validate(value: unknown, revision: Readonly<AgentRevision>): void {
    const { egressPlan, repositoryCredentials, sandboxPolicy } = revision;
    if (
      revision.executionAdmission.version !== 5 ||
      egressPlan?.repositoryGitAuthorization !== "online-request" ||
      sandboxPolicy?.repositoryNetworkPolicy !== undefined ||
      repositoryGitDeliveryProfile(repositoryCredentials) !== profile ||
      !isDeepStrictEqual(repositoryCredentials, egressPlan.repositoryGit) ||
      !isDeepStrictEqual(value, downloads)
    ) {
      throw new ConfigurationValidationError([
        {
          path: `/sandboxPolicy/defaults/${downloads.name}`,
          code: "INVALID_VALUE",
          message:
            "GitHub Actions downloads require the exact rule and online repository admission.",
        },
      ]);
    }
  },
});

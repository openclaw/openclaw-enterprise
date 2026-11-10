import type {
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  RepositoryGitInstallationFence,
  RequestCredentialGrant,
  RequestCredentialMaterial,
} from "@openclaw-enterprise/contracts";
import type { postgresRequestCredentialApprovals } from "@openclaw-enterprise/occ";
import { maxSelectedGitHubRepositories } from "./repository-grant.ts";
import type { InstalledGitRoute } from "./prepared-repository-git.ts";

/** Private, worker-local port. Existing protected senders cannot invoke grant redemption. */
export const preparedGitRedemption = Symbol("preparedGitRedemption");
export type PreparedGitGrantApprovals = typeof postgresRequestCredentialApprovals;

export type PreparedGitGrantRequest = PreparedGitHubRepositoryUseRequest & {
  readonly operation: GitGrantOperation;
};

export type PreparedGitGrantBinding = Omit<
  ProtectedGitHubRepositoryMaterial,
  "value" | "preparationAttemptId" | "materialVersion"
>;

type GitGrantOperation =
  "advertise-upload-pack" | "upload-pack" | "advertise-receive-pack" | "receive-pack";

type GitGrantScope = {
  readonly repositories: readonly unknown[];
  readonly permissions: Readonly<Record<string, string>>;
};

export type PreparedGitGrantProfile = "selected-repository-write" | "selected-repository-set";
export type PreparedGitGrantMode = true | PreparedGitGrantProfile;

/** Default grant redemption stays read-only and accepts one repository. */
export function preparedGitGrantContents(
  scope: GitGrantScope,
  mode: PreparedGitGrantMode | false | undefined,
): "read" | "write" | undefined {
  const limit = mode === "selected-repository-set" ? maxSelectedGitHubRepositories : 1;
  const { contents, metadata } = scope.permissions;
  if (
    !mode ||
    scope.repositories.length < 1 ||
    scope.repositories.length > limit ||
    Object.keys(scope.permissions).length !== 2 ||
    metadata !== "read"
  ) {
    return;
  }
  return contents === "read" || (mode !== true && contents === "write") ? contents : undefined;
}

export function gitGrantOperationAllowed(
  operation: PreparedGitHubRepositoryUseRequest["operation"] | "create-draft-pull",
  allowPush: boolean,
): operation is GitGrantOperation {
  return (
    operation === "advertise-upload-pack" ||
    operation === "upload-pack" ||
    (allowPush && (operation === "advertise-receive-pack" || operation === "receive-pack"))
  );
}

export type PreparedGitGrantApproval = Pick<
  RequestCredentialGrant,
  "recipientId" | "requestId" | "bindingId"
> & { readonly credentialIdentity: string };

export interface PreparedGitRedemption {
  readBinding(
    route: RepositoryGitInstallationFence,
    signal: AbortSignal,
  ): Promise<PreparedGitGrantBinding | { readonly absent: "withdrawn" | "unprepared" } | undefined>;
  approve(
    request: PreparedGitGrantRequest,
    installed: InstalledGitRoute,
    approval: PreparedGitGrantApproval,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  redeem(
    request: PreparedGitGrantRequest,
    installed: InstalledGitRoute,
    grant: RequestCredentialGrant,
    signal: AbortSignal,
  ): Promise<RequestCredentialMaterial | undefined>;
}

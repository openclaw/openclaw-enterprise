import type {
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  RepositoryGitInstallationFence,
  RequestCredentialGrant,
  RequestCredentialMaterial,
} from "@openclaw-enterprise/contracts";
import type { postgresRequestCredentialApprovals } from "@openclaw-enterprise/occ";
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

function exactScope(scope: GitGrantScope, contents: "read" | "write"): boolean {
  return (
    scope.repositories.length === 1 &&
    Object.keys(scope.permissions).length === 2 &&
    scope.permissions.contents === contents &&
    scope.permissions.metadata === "read"
  );
}

export function allowsPreparedGitGrantRead(scope: GitGrantScope): boolean {
  return exactScope(scope, "read");
}

export function allowsPreparedGitGrantWrite(scope: GitGrantScope): boolean {
  return exactScope(scope, "write");
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

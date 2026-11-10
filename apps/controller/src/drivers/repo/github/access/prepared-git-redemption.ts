import type {
  PreparedGitHubRepositoryUseRequest,
  ProtectedGitHubRepositoryMaterial,
  RepositoryGitInstallationFence,
  RequestCredentialGrant,
  RequestCredentialMaterial,
} from "@openclaw-enterprise/contracts";
import type { postgresRequestCredentialApprovals } from "@openclaw-enterprise/occ";
import type { InstalledGitMaterial } from "./prepared-repository-git.ts";

/** Private, worker-local port. Existing protected senders cannot invoke grant redemption. */
export const preparedGitRedemption = Symbol("preparedGitRedemption");
export type PreparedGitGrantApprovals = typeof postgresRequestCredentialApprovals;

export type PreparedGitGrantRequest = PreparedGitHubRepositoryUseRequest & {
  readonly operation: "advertise-upload-pack" | "upload-pack";
};

export type PreparedGitGrantMaterial = Omit<ProtectedGitHubRepositoryMaterial, "value">;

export function allowsPreparedGitGrantRead(scope: {
  readonly repositories: readonly unknown[];
  readonly permissions: Readonly<Record<string, string>>;
}): boolean {
  return (
    scope.repositories.length === 1 &&
    Object.keys(scope.permissions).length === 2 &&
    scope.permissions.contents === "read" &&
    scope.permissions.metadata === "read"
  );
}

export type PreparedGitGrantApproval = Pick<
  RequestCredentialGrant,
  "recipientId" | "requestId" | "bindingId"
> & { readonly credentialIdentity: string };

export interface PreparedGitRedemption {
  readMaterial(
    route: RepositoryGitInstallationFence,
    signal: AbortSignal,
  ): Promise<
    PreparedGitGrantMaterial | { readonly absent: "withdrawn" | "unprepared" } | undefined
  >;
  approve(
    request: PreparedGitGrantRequest,
    installed: InstalledGitMaterial,
    approval: PreparedGitGrantApproval,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  redeem(
    request: PreparedGitGrantRequest,
    installed: InstalledGitMaterial,
    grant: RequestCredentialGrant,
    signal: AbortSignal,
  ): Promise<RequestCredentialMaterial | undefined>;
}

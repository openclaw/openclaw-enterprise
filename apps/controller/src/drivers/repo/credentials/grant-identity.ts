import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";

export function sameBinding(
  left: RepositoryCredentialGrantIdentity,
  right: RepositoryCredentialGrantIdentity,
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.repositoryId === right.repositoryId &&
    left.grantId === right.grantId
  );
}

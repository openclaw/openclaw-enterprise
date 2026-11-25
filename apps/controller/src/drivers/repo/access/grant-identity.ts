import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import { hasControlCharacter } from "./client-contracts.ts";

export function isRepositoryCredentialIdentity(value: unknown): value is string {
  return !(
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 512 ||
    hasControlCharacter(value)
  );
}

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

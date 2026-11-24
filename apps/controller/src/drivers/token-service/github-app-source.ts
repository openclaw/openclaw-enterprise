import { isDeepStrictEqual } from "node:util";

import type {
  GitHubAppInstallationCredentialSource,
  InstallationSecretRef,
  ResolvedCredential,
} from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError, TokenServiceSourceInputError } from "@openclaw-enterprise/occ";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";

import {
  matchesConfiguredGitHubRepository,
  resolveGitHubRepositorySourceScope,
  type GitHubRepositoryRegistry,
} from "../repo/github/access/registry.ts";
import type { GitHubAppRepositorySelection } from "../repo/github/access/repository-grant.ts";

interface GitHubAppSourceReceipt extends Required<
  Pick<ResolvedCredential, "credential" | "version" | "expiresAt">
> {
  readonly providerExpiresAt: string;
  readonly deliveryPending?: true;
}

/** Shared by Client administration and the selected TokenService issuer. */
export function githubAppClientSigningKeyRef(
  installationId: string,
  tokenServiceInstanceId: string,
  clientId: string,
  appId: string,
): InstallationSecretRef {
  return {
    installationId,
    id: JSON.stringify([
      "token_service",
      tokenServiceInstanceId,
      "github_app_client",
      clientId,
      appId,
    ]),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    // This may contain an installation token.
    return undefined;
  }
}

export function admitGitHubAppSourceScope(
  {
    namespaceId,
    repositoryRefs,
  }: { readonly namespaceId: string; readonly repositoryRefs: readonly string[] },
  registry: GitHubRepositoryRegistry,
): GitHubAppRepositorySelection {
  try {
    const { repositories, permissions } = resolveGitHubRepositorySourceScope(
      registry,
      namespaceId,
      repositoryRefs,
    );
    return {
      appId: registry.appId,
      installationId: registry.githubInstallationId,
      repositories,
      permissions,
    };
  } catch {
    throw new TokenServiceSourceInputError(
      "The GitHub App repository selection is unavailable in this Namespace.",
    );
  }
}

export function isGitHubAppSourceScopeCurrent(
  { namespaceId, scope }: Readonly<GitHubAppInstallationCredentialSource>,
  registry: GitHubRepositoryRegistry,
): boolean {
  const repositoryRefs = scope.repositories.map(
    (verified) =>
      registry.repositories.find((entry) => matchesConfiguredGitHubRepository(entry, verified))
        ?.repositoryRef,
  );
  if (!repositoryRefs.every((ref) => ref !== undefined)) {
    return false;
  }
  try {
    const current = admitGitHubAppSourceScope({ namespaceId, repositoryRefs }, registry);
    return (
      current.appId === scope.appId &&
      current.installationId === scope.installationId &&
      isDeepStrictEqual(current.permissions, scope.permissions)
    );
  } catch {
    return false;
  }
}

export function decodeGitHubAppSourceCredential(value: string): GitHubAppSourceReceipt {
  const record = parseJsonRecord(value);
  if (
    !isNonEmptyString(record?.credential) ||
    !isNonEmptyString(record.version) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    typeof record.providerExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.providerExpiresAt)) ||
    (record.deliveryPending !== undefined && record.deliveryPending !== true)
  ) {
    throw new ResourceStateConflictError("The stored GitHub App Source credential is invalid.");
  }
  const { credential, version, expiresAt, providerExpiresAt } = record;
  return {
    credential,
    version,
    expiresAt,
    providerExpiresAt,
    ...(record.deliveryPending === true && { deliveryPending: true }),
  };
}

export function resolveGitHubAppSourceCredential(value: string, now: number) {
  const { credential, version, expiresAt } = decodeGitHubAppSourceCredential(value);
  if (Date.parse(expiresAt) <= now) {
    throw new ResourceStateConflictError("The GitHub App Source credential has expired.");
  }
  return { credential, version, expiresAt };
}

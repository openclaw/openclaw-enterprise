import type { GitHubAppInstallationScope } from "@openclaw-enterprise/contracts";

import {
  createRepositorySlugPattern,
  isGitHubRepositoryPermissions,
  parseGitHubNumericId,
  validateGitHubFiniteInstallationScope,
  validateGitHubRepositoryGrant,
  type GitHubAppRepositorySelection,
} from "../repository-grant.ts";
import type { RequestOptions } from "node:https";
import { isGitHubWireCredential } from "../wire-credential.ts";
import type { GitHubPreparationAdmission } from "../prepared-contracts.ts";
import { permissionsForProfile } from "../profiles.ts";
import { parseCanonicalGitHubOrigin } from "../origin.ts";

declare const scopeIdentity: unique symbol;
export type ProviderScope = IssuanceProjection &
  Readonly<{ [scopeIdentity]: true; issuance: GitHubIssuanceScope }>;

type GitHubIssuanceScope = Readonly<{
  schemaVersion: 1;
  origin: string;
  appId: string;
  installationId: number;
}> &
  (
    | Readonly<{ kind: "inherited" }>
    | (Readonly<{
        kind: "selected";
        permissions: Readonly<Record<string, string>>;
      }> &
        (
          | { readonly repositoryIds: readonly number[] }
          | { readonly repositoryNames: readonly string[] }
        ))
  );
type IssuanceProjection =
  | Readonly<{ kind: "inherited" }>
  | Readonly<{
      kind: "selected";
      repositories: readonly Readonly<{ id?: number; name: string }>[];
      permissions: Readonly<Record<string, string>>;
    }>;
const requestBodies = new WeakMap<ProviderScope, string>();

function numericId(value: string): number {
  const number = parseGitHubNumericId(value);
  if (number === undefined) {
    throw new Error("invalid-provider-scope");
  }
  return number;
}

function canonicalPermissions(permissions: Readonly<Record<string, string>>) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(permissions).sort(([left], [right]) => {
        if (left === right) {
          return 0;
        }
        return left < right ? -1 : 1;
      }),
    ),
  );
}

function projectFiniteScope(scope: GitHubAppInstallationScope): IssuanceProjection {
  return {
    kind: "selected",
    repositories: scope.repositories
      .map((r) => ({ id: numericId(r.repositoryId), name: r.repository }))
      .sort((a, b) => a.id - b.id),
    permissions: canonicalPermissions(scope.permissions),
  };
}

function projectIssuanceScope(scope: GitHubPreparationAdmission["grant"]): IssuanceProjection {
  if (scope.profile === "github-repository") {
    validateGitHubRepositoryGrant(scope);
    return projectFiniteScope(scope);
  }
  if (scope.profile === "github-installation") {
    // Reject a mixed persisted grant instead of silently dropping its narrowing constraints.
    const fields = ["id", "isolationId", "appId", "installationId", "profile"];
    if (
      typeof scope.id !== "string" ||
      !scope.id ||
      typeof scope.isolationId !== "string" ||
      !scope.isolationId ||
      Object.keys(scope).some((key) => !fields.includes(key))
    ) {
      throw new Error("invalid-provider-scope");
    }
    numericId(scope.appId);
    return { kind: "inherited" };
  }
  const id = numericId(scope.repositoryId);
  const permissions = canonicalPermissions(permissionsForProfile(scope.profile));
  return {
    kind: "selected",
    repositories: [{ id, name: scope.repository }],
    permissions,
  };
}

export function prepareProviderScope(
  origin: string,
  scope: GitHubPreparationAdmission["grant"],
): ProviderScope {
  return prepareScope(origin, scope, projectIssuanceScope(scope));
}

export function prepareGitHubAppProviderScope(
  origin: string,
  scope: GitHubAppRepositorySelection,
): ProviderScope {
  if (scope.repositories.every(({ repositoryId }) => repositoryId !== undefined)) {
    validateGitHubFiniteInstallationScope(scope);
    return prepareScope(origin, scope, projectFiniteScope(scope));
  }

  const slugPattern = createRepositorySlugPattern();
  const names = scope.repositories.map(({ repository }) => repository.toLowerCase());
  const [owner] = names[0]?.split("/") ?? [];
  numericId(scope.appId);
  if (
    names.length < 1 ||
    names.length > 16 ||
    new Set(names).size !== names.length ||
    names.some((name) => !slugPattern.test(name) || !name.startsWith(owner + "/")) ||
    !isGitHubRepositoryPermissions(scope.permissions)
  ) {
    throw new Error("invalid-provider-scope");
  }
  return prepareScope(origin, scope, {
    kind: "selected",
    repositories: scope.repositories
      .map(({ repository, repositoryId }) => ({
        name: repository.toLowerCase(),
        ...(repositoryId === undefined ? {} : { id: numericId(repositoryId) }),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "en")),
    permissions: canonicalPermissions(scope.permissions),
  });
}

function prepareScope(
  origin: string,
  scope: Pick<GitHubAppInstallationScope, "appId" | "installationId">,
  projection: IssuanceProjection,
): ProviderScope {
  if (parseCanonicalGitHubOrigin(origin) === undefined) {
    throw new Error("invalid-provider-origin");
  }
  const target = {
    schemaVersion: 1 as const,
    origin,
    appId: scope.appId,
    installationId: numericId(scope.installationId),
  };
  const issuance: GitHubIssuanceScope =
    projection.kind === "inherited"
      ? Object.freeze({ ...target, kind: "inherited" })
      : Object.freeze({
          ...target,
          kind: "selected",
          ...(projection.repositories.some(({ id }) => id === undefined)
            ? {
                repositoryNames: Object.freeze(
                  projection.repositories.map(({ name }) => name.slice(name.indexOf("/") + 1)),
                ),
              }
            : {
                repositoryIds: Object.freeze(
                  projection.repositories.map(({ id }) => {
                    if (id === undefined) {
                      throw new Error("invalid-provider-scope");
                    }
                    return id;
                  }),
                ),
              }),
          permissions: projection.permissions,
        });
  if (projection.kind === "selected") {
    projection.repositories.forEach(Object.freeze);
    Object.freeze(projection.repositories);
  }
  // GitHub accepts unqualified names on first enrollment. The response must
  // prove the exact owner/repository entries before CredentialService can save the token.
  const prepared = Object.freeze({ ...projection, issuance }) as ProviderScope;
  requestBodies.set(
    prepared,
    issuance.kind === "inherited"
      ? "{}"
      : JSON.stringify({
          ...("repositoryNames" in issuance
            ? { repositories: issuance.repositoryNames }
            : { repository_ids: issuance.repositoryIds }),
          permissions: issuance.permissions,
        }),
  );
  return prepared;
}

export function providerRequestOptions(
  endpoint: ProviderScope,
  operation: "issue" | "revoke",
  authorization: string,
  ca: Uint8Array | undefined,
): Readonly<{ options: RequestOptions; body: string }> {
  const issueBody = requestBodies.get(endpoint);
  if (issueBody === undefined || (operation !== "issue" && operation !== "revoke")) {
    throw new Error("invalid-provider-scope");
  }
  if (!isGitHubWireCredential(authorization)) {
    throw new Error("invalid-provider-credential");
  }
  const issue = operation === "issue";
  const body = issue ? issueBody : "";
  return githubRequestOptions(
    endpoint.issuance.origin,
    issue ? "POST" : "DELETE",
    issue
      ? `/app/installations/${endpoint.issuance.installationId}/access_tokens`
      : "/installation/token",
    authorization,
    ca,
    body,
  );
}

/** App-JWT identity reads have a fixed path and cannot mint or revoke a token. */
export function appIdentityRequestOptions(
  origin: string,
  authorization: string,
  ca: Uint8Array | undefined,
  installationId?: number,
): Readonly<{ options: RequestOptions; body: string }> {
  if (
    !parseCanonicalGitHubOrigin(origin) ||
    !isGitHubWireCredential(authorization) ||
    (installationId !== undefined && (!Number.isSafeInteger(installationId) || installationId < 1))
  ) {
    throw new Error("invalid-provider-identity-request");
  }
  const path = installationId === undefined ? "/app" : `/app/installations/${installationId}`;
  return githubRequestOptions(origin, "GET", path, authorization, ca, "");
}

function githubRequestOptions(
  originValue: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  authorization: string,
  ca: Uint8Array | undefined,
  body: string,
): Readonly<{ options: RequestOptions; body: string }> {
  const origin = new URL(originValue);
  return {
    body,
    options: {
      protocol: "https:",
      hostname: origin.hostname.replace(/^\[|\]$/g, ""),
      port: origin.port || 443,
      method,
      path,
      agent: false,
      rejectUnauthorized: true,
      maxHeaderSize: 32768,
      ...(ca ? { ca: Buffer.from(ca) } : {}),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${authorization}`,
        "user-agent": "openclaw-enterprise-repository-credentials",
        "x-github-api-version": "2026-03-10",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "accept-encoding": "identity",
        connection: "close",
      },
    },
  };
}

import { parseGitHubNumericId, validateGitHubRepositoryGrant } from "../repository-grant.ts";
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
    | Readonly<{
        kind: "selected";
        repositoryIds: readonly number[];
        permissions: Readonly<Record<string, string>>;
      }>
  );
type IssuanceProjection =
  | Readonly<{ kind: "inherited" }>
  | Readonly<{
      kind: "selected";
      repositories: readonly Readonly<{ id: number; name: string }>[];
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

function projectIssuanceScope(scope: GitHubPreparationAdmission["grant"]): IssuanceProjection {
  if (scope.profile === "github-repository") {
    validateGitHubRepositoryGrant(scope);
    return {
      kind: "selected",
      repositories: scope.repositories
        .map((r) => ({
          id: numericId(r.repositoryId),
          name: r.repository,
        }))
        .sort((a, b) => a.id - b.id),
      permissions: canonicalPermissions(scope.permissions),
    };
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
  if (parseCanonicalGitHubOrigin(origin) === undefined) {
    throw new Error("invalid-provider-origin");
  }
  const target = {
    schemaVersion: 1 as const,
    origin,
    appId: scope.appId,
    installationId: numericId(scope.installationId),
  };
  const projection = projectIssuanceScope(scope);
  const issuance: GitHubIssuanceScope =
    projection.kind === "inherited"
      ? Object.freeze({ ...target, kind: "inherited" })
      : Object.freeze({
          ...target,
          kind: "selected",
          repositoryIds: Object.freeze(projection.repositories.map((repository) => repository.id)),
          permissions: projection.permissions,
        });
  if (projection.kind === "selected") {
    projection.repositories.forEach(Object.freeze);
    Object.freeze(projection.repositories);
  }
  // The issuer sends the exact normalized provider scope. Repository names stay in the
  // response-validation projection; stable IDs identify the repositories in the mint request.
  const prepared = Object.freeze({ ...projection, issuance }) as ProviderScope;
  requestBodies.set(
    prepared,
    issuance.kind === "inherited"
      ? "{}"
      : JSON.stringify({
          repository_ids: issuance.repositoryIds,
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
  const origin = new URL(endpoint.issuance.origin);
  const issue = operation === "issue";
  const body = issue ? issueBody : "";
  return {
    body,
    options: {
      protocol: "https:",
      hostname: origin.hostname.replace(/^\[|\]$/g, ""),
      port: origin.port || 443,
      method: issue ? "POST" : "DELETE",
      path: issue
        ? `/app/installations/${endpoint.issuance.installationId}/access_tokens`
        : "/installation/token",
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

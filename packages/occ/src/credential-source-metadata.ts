import type {
  CredentialSource,
  CredentialSourceMetadata,
  CredentialSourceReference,
  CredentialSourceStatus,
  GitHubAppInstallationCredentialSource,
  OAuthCredentialSource,
  StaticCredentialSource,
  StoredCredentialSource,
} from "@openclaw-enterprise/contracts";

import { immutableCopy } from "@openclaw-enterprise/utils";

import { ResourceStateConflictError } from "./errors.ts";
import type { PlatformReadView } from "./ports/platform-read-view.ts";

export function credentialSourceRef(
  source: Readonly<StoredCredentialSource>,
): CredentialSourceReference {
  return { kind: "credential_source", id: source.id, namespaceId: source.namespaceId };
}

export function isManagedTokenServiceSource(
  source: Readonly<StoredCredentialSource> | undefined,
): source is Readonly<CredentialSource> {
  return source?.ownerCapability === "token_service";
}

export type CredentialSourceManagementMetadata = Readonly<
  CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }
>;

export function credentialSourceMetadata(
  source: Readonly<StaticCredentialSource>,
  status?: CredentialSourceStatus,
): Readonly<
  Extract<CredentialSourceMetadata, { type: "static" }> & {
    readonly status?: CredentialSourceStatus;
  }
> {
  return Object.freeze({
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
    ...(source.connectionTemplateId === undefined
      ? {}
      : { connectionTemplateId: source.connectionTemplateId }),
    config: source.config,
    state: source.state,
    createdAt: source.createdAt,
    ref: Object.freeze(credentialSourceRef(source)),
    ...(status === undefined ? {} : { status }),
  });
}

export function githubAppCredentialSourceMetadata(
  source: Readonly<GitHubAppInstallationCredentialSource>,
): Extract<CredentialSourceMetadata, { type: "github-app-installation" }> {
  const { appId, installationId, repositories, permissions } = source.scope;
  return immutableCopy({
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
    state: source.state,
    createdAt: source.createdAt,
    ref: credentialSourceRef(source),
    clientId: source.clientId,
    scope: {
      appId,
      installationId,
      repositories: repositories.map(({ repositoryId, repository }) => ({
        repositoryId,
        repository,
      })),
      permissions,
    },
  });
}

/** Derive nonsecret issuer details from the Source's server-owned OAuth provenance. */
export async function oauthCredentialSourceMetadata(
  view: PlatformReadView,
  source: Readonly<OAuthCredentialSource>,
  status?: CredentialSourceStatus,
): Promise<
  Readonly<
    Extract<CredentialSourceMetadata, { type: "oauth2-refresh-token" }> & {
      readonly status?: CredentialSourceStatus;
    }
  >
> {
  const common = {
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
    state: source.state,
    createdAt: source.createdAt,
    ref: Object.freeze(credentialSourceRef(source)),
    ...(status === undefined ? {} : { status }),
  };
  if (source.consent.kind !== "connection_template") {
    return Object.freeze({
      ...common,
      consent: source.consent,
    });
  }
  if (source.connectionTemplateId === undefined) {
    throw new ResourceStateConflictError("The original OAuth consent Template is unavailable.");
  }
  const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
    source.connectionTemplateId,
    source.consent.version,
  );
  const client = await view.credentialClients.find(source.consent.oauthClientId);
  if (!version || !client || client.kind !== "oauth2" || client.issuer !== version.issuer) {
    throw new ResourceStateConflictError("The original OAuth consent registration is unavailable.");
  }
  return Object.freeze({
    ...common,
    connectionTemplateId: source.connectionTemplateId,
    consent: Object.freeze({
      ...source.consent,
      issuer: version.issuer,
      tokenUrl: version.tokenUrl,
      clientId: client.clientId,
      destinations: version.destinations,
      ...(version.mcp === undefined
        ? {}
        : { resource: version.mcp.resource, mcpServerUrl: version.mcp.serverUrl }),
    }),
  });
}

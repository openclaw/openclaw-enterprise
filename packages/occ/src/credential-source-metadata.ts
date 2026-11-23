import type {
  CredentialSource,
  CredentialSourceMetadata,
  CredentialSourceReference,
  CredentialSourceStatus,
  LegacyCredentialSource,
  OAuthCredentialSource,
  StaticCredentialSource,
  StoredCredentialSource,
} from "@openclaw-enterprise/contracts";

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

export type LegacyCredentialSourceMetadata = Readonly<
  LegacyCredentialSource & {
    readonly ref: CredentialSourceReference;
    readonly status?: CredentialSourceStatus;
  }
>;

/** Internal metadata for existing Gateway and Proxy callers, never a public Source response. */
export function legacyCredentialSourceMetadata(
  source: Readonly<LegacyCredentialSource>,
  status?: CredentialSourceStatus,
): LegacyCredentialSourceMetadata {
  return Object.freeze({
    ...source,
    ref: Object.freeze(credentialSourceRef(source)),
    ...(status === undefined ? {} : { status }),
  });
}

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

/** Derive historical client and endpoint details from the original consent version. */
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
  const version = await view.connectionTemplates.findOAuthConnectionTemplateVersion(
    source.connectionTemplateId,
    source.consent.version,
  );
  const client = await view.connectionTemplates.findOAuthClient(source.consent.oauthClientId);
  if (
    !version ||
    !client ||
    version.oauthClientId !== client.id ||
    client.issuer !== version.issuer
  ) {
    throw new ResourceStateConflictError("The original OAuth consent registration is unavailable.");
  }
  return Object.freeze({
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
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
    state: source.state,
    createdAt: source.createdAt,
    ref: Object.freeze(credentialSourceRef(source)),
    ...(status === undefined ? {} : { status }),
  });
}

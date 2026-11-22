import type {
  CredentialSource,
  CredentialSourceMetadata,
  CredentialSourceReference,
  CredentialSourceStatus,
} from "@openclaw-enterprise/contracts";

export function credentialSourceRef(source: Readonly<CredentialSource>): CredentialSourceReference {
  return { kind: "credential_source", id: source.id, namespaceId: source.namespaceId };
}

export function isManagedTokenServiceSource(
  source: Readonly<CredentialSource> | undefined,
): source is Readonly<
  CredentialSource & { ownerCapability: "token_service"; tokenServiceInstanceId: string }
> {
  return (
    source?.ownerCapability === "token_service" && typeof source.tokenServiceInstanceId === "string"
  );
}

export function credentialSourceMetadata(
  source: Readonly<CredentialSource>,
  status?: CredentialSourceStatus,
  association?: {
    readonly connectionTemplateId: string;
    readonly connectionTemplateVersion: number;
  },
): Readonly<CredentialSourceMetadata & { readonly status?: CredentialSourceStatus }> {
  return Object.freeze({
    id: source.id,
    namespaceId: source.namespaceId,
    name: source.name,
    type: source.type,
    ...(association === undefined
      ? {}
      : {
          connectionTemplateId: association.connectionTemplateId,
          connectionTemplateVersion: association.connectionTemplateVersion,
        }),
    ownerCapability: source.ownerCapability,
    config: source.config,
    secrets: source.secrets,
    ...(source.egress === undefined
      ? {}
      : { egress: { adoption: source.egress.adoption, retention: source.egress.retention } }),
    state: source.state,
    ref: Object.freeze(credentialSourceRef(source)),
    ...(status === undefined ? {} : { status }),
  });
}

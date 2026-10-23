import type { EgressRef, EgressSourceKey } from "./credential-proxy.ts";

export const credentialFreeMetadataType = "credential-free-repository-metadata";
export const credentialFreeProviderRef = { id: credentialFreeMetadataType, generation: 1 } as const;

/** Consent to a protected, bodyless identity read. No credential source can be upgraded to this. */
export interface CredentialFreeMetadataGrant {
  readonly kind: "credential_free_repository_metadata";
  readonly profile: "metadata-read";
  readonly isolationId: string;
  readonly repositoryId: string;
  readonly repository: string;
}

export interface CredentialFreeEgressSource {
  readonly key: EgressSourceKey;
  readonly sender: EgressRef;
  readonly resolver: EgressRef;
  readonly origin: string;
  readonly schemaVersion: 3;
  readonly adoption: "credential_free";
  readonly retention: "none";
  readonly grant: CredentialFreeMetadataGrant;
}

/** Durable selection, not evidence that material was missing or that a send occurred. */
export interface NoMaterialSelection {
  readonly kind: "no_material_required";
  readonly source: EgressSourceKey;
  readonly binding: EgressRef;
  readonly grantHash: string;
  readonly isolationId: string;
}

export function credentialFreeMetadataGrant(
  config: Readonly<Record<string, string>>,
): CredentialFreeMetadataGrant {
  if (
    config.authority !== "execution" ||
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(config.origin ?? "") ||
    new URL(config.origin!).origin !== config.origin ||
    !/^agt_[0-9a-f-]{36}$/.test(config.agent_id ?? "") ||
    !/^[1-9]\d*$/.test(config.repository_id ?? "") ||
    !Number.isSafeInteger(Number(config.repository_id)) ||
    !/^[a-zA-Z\d_-]+\/[a-zA-Z\d_.-]+$/.test(config.repository ?? "") ||
    /\/(?:\.|\.\.)$/.test(config.repository ?? "")
  ) {
    throw new Error(
      "Credential-free metadata requires an exact HTTPS origin, repository, Agent and execution consent.",
    );
  }
  return {
    kind: "credential_free_repository_metadata",
    profile: "metadata-read",
    isolationId: config.agent_id!,
    repositoryId: config.repository_id!,
    repository: config.repository!,
  };
}

import type { SecretReference } from "./index.ts";

/** Namespace-owned model setup metadata; credential values remain in the Secret driver. */
export interface ProviderConnection {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly providerId: string;
  readonly authMethodId: string;
  readonly source?: SecretReference;
  readonly baseUrl?: string;
  readonly createdAt: string;
}

export type CreateProviderConnectionInput = Omit<ProviderConnection, "id" | "createdAt"> & {
  /** Write-only credential input; mutually exclusive with an existing Secret reference. */
  readonly secretValue?: string;
};

export type ProviderConnectionReferenceSnapshot = Pick<
  ProviderConnection,
  "id" | "providerId" | "authMethodId" | "baseUrl"
>;

export interface ModelAuthCatalogMethod {
  readonly id: string;
  readonly label: string;
  readonly credentialKind: "secret" | "none";
}

export interface ModelAuthCatalogProvider {
  readonly id: string;
  readonly label: string;
  readonly requiresBaseUrl: boolean;
  readonly authMethods: readonly ModelAuthCatalogMethod[];
}

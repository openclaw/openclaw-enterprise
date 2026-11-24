import type { SavedConnection, Secret } from "@openclaw-enterprise/contracts";

/** Private Secret identity used only by the Token Service. No credential material is stored here. */
export interface ConnectionTokenCustody {
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly secret: Readonly<Secret>;
  readonly scheduledVersion?: string;
  readonly nextRefreshAt?: string;
}

export interface SavedConnectionReadRepository {
  findTokenCustody(
    namespaceId: string,
    sourceId: string,
  ): Promise<Readonly<ConnectionTokenCustody & { due: boolean }> | undefined>;
  listDueConnectionTokens(
    installationId: string,
    limit: number,
    afterSourceId?: string,
  ): Promise<readonly Readonly<SavedConnection>[]>;
  findSavedConnection(
    namespaceId: string,
    credentialSourceId: string,
  ): Promise<Readonly<SavedConnection> | undefined>;
  listRevokingConnections(
    installationId: string,
    limit: number,
    afterSourceId?: string,
  ): Promise<readonly Readonly<SavedConnection>[]>;
  listNamespaceConnections(namespaceId: string): Promise<readonly Readonly<SavedConnection>[]>;
}

export interface SavedConnectionRepository extends SavedConnectionReadRepository {
  createTokenCustody(custody: ConnectionTokenCustody): Promise<void>;
  recordTokenSchedule(
    namespaceId: string,
    sourceId: string,
    schedule:
      | "due"
      | "stopped"
      | {
          readonly scheduledVersion: string;
          readonly nextRefreshAt: string;
          readonly grantedScopes: readonly string[];
        },
  ): Promise<void>;
  requestConnectionRevocation(
    namespaceId: string,
    sourceId: string,
    principalId: string,
  ): Promise<void>;
  confirmConnectionRevocation(namespaceId: string, sourceId: string, at: string): Promise<void>;
  createSavedConnection(connection: SavedConnection): Promise<Readonly<SavedConnection>>;
  deleteSavedConnection(namespaceId: string, credentialSourceId: string): Promise<boolean>;
}

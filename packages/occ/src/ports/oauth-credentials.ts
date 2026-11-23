import type { OAuthCredentialSource, Secret } from "@openclaw-enterprise/contracts";

/** Private OAuth custody and refresh scheduling, keyed only by the canonical Source. */
export interface OAuthTokenCustody {
  readonly namespaceId: string;
  readonly sourceId: string;
  readonly secret: Readonly<Secret>;
  readonly scheduledVersion?: string;
  readonly nextRefreshAt?: string;
}

export interface OAuthCredentialReadRepository {
  findTokenCustody(
    namespaceId: string,
    sourceId: string,
  ): Promise<Readonly<OAuthTokenCustody & { due: boolean }> | undefined>;
  listDueOAuthSources(
    installationId: string,
    limit: number,
    afterSourceId?: string,
  ): Promise<readonly Readonly<Pick<OAuthCredentialSource, "namespaceId" | "id">>[]>;
  listRevokingOAuthSources(
    installationId: string,
    limit: number,
    afterSourceId?: string,
  ): Promise<readonly Readonly<Pick<OAuthCredentialSource, "namespaceId" | "id">>[]>;
}

export interface OAuthCredentialRepository extends OAuthCredentialReadRepository {
  createTokenCustody(custody: OAuthTokenCustody): Promise<void>;
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
}

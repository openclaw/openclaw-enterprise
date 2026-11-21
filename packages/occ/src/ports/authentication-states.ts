import type {
  DeviceAuthenticationState,
  DeviceAuthorizationSession,
} from "../device-authorization.ts";
import type { ConnectionSession } from "@openclaw-enterprise/contracts";

export type OAuthAuthenticationState = Omit<ConnectionSession, "stateHash"> & {
  readonly kind: "oauth_connection";
  readonly id: string;
};

export type AuthenticationState = OAuthAuthenticationState | DeviceAuthenticationState;

export type DeviceAuthenticationChanges = Pick<
  DeviceAuthorizationSession,
  "phase" | "expiresAt" | "nextPollAt" | "privateState" | "encryptedChallenge"
>;

export type OAuthSourceRef = Pick<OAuthAuthenticationState, "namespaceId" | "credentialSourceId">;

export interface AuthenticationStateReadRepository {
  findDevice(namespaceId: string, id: string): Promise<DeviceAuthenticationState | undefined>;
}

export interface AuthenticationStateRepository extends AuthenticationStateReadRepository {
  create(state: AuthenticationState): Promise<void>;
  replaceDevice(
    namespaceId: string,
    id: string,
    version: number,
    changes: DeviceAuthenticationChanges,
  ): Promise<boolean>;
  consumeOAuth(
    id: string,
    actorId: string,
    sessionId: string,
    at: string,
  ): Promise<OAuthAuthenticationState | undefined>;
  expire(at: string, limit: number): Promise<readonly OAuthSourceRef[]>;
}

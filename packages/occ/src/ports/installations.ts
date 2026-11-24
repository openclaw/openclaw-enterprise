import type { TokenServiceInstance } from "./token-service.ts";
import type { Installation } from "@openclaw-enterprise/contracts";

export interface InstallationReadRepository {
  findInstallation(installationId: string): Promise<Readonly<Installation> | undefined>;
  getInstallation(): Promise<Readonly<Installation> | undefined>;
}

export interface InstallationRepository extends InstallationReadRepository {
  createInstallation(installation: Installation): Promise<Readonly<Installation>>;
  selectTokenServiceInstance(
    candidate: TokenServiceInstance,
  ): Promise<Readonly<TokenServiceInstance>>;
  /**
   * Holds a human Principal's account until COMMIT so a disable cannot commit first.
   * False when the account is disabled; true when it is enabled or the Principal has
   * no human account (its IAM bindings alone decide).
   */
  holdPrincipalAccount(principalId: string): Promise<boolean>;
  /** Holds the user/session through COMMIT and validates expiry at commit; authentication validates its profile. */
  holdAuthenticationSession(sessionId: string, userId: string): Promise<boolean>;
  /**
   * Holds the Installation's IAM configuration lock until COMMIT: shared before a write of
   * durable authority (an Owner binding, a deploy-time grant, or a Group membership), exclusive
   * while OCC applies the `iam` configuration, so the two commit one after the other.
   */
  holdIAMConfiguration(mode: "shared" | "exclusive"): Promise<void>;
}

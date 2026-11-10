import type {
  DriverRegistrationRef,
  RequestCredentialGrant,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";

export interface RequestCredentialApproval extends RequestCredentialGrant {
  readonly execution: RequestCredentialInput["execution"];
  readonly driver: DriverRegistrationRef;
  /** Digest of the source and grant selected to authorize the operation. */
  readonly policyDigest: string;
  /** Retain correlation after redemption expires while its authenticated request remains valid. */
  readonly replayUntilAt: string;
}

export interface RequestCredentialApprovalLimits {
  readonly requestIds: number;
  readonly sandboxRequestIds: number;
}

export interface RequestCredentialApprovalRepository {
  insert(
    approval: RequestCredentialApproval,
    now: string,
    limits: RequestCredentialApprovalLimits,
  ): Promise<boolean>;
  consume(
    grant: RequestCredentialGrant,
    driver: DriverRegistrationRef,
    now: string,
  ): Promise<RequestCredentialApproval | undefined>;
}

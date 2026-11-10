import type {
  DriverRegistrationRef,
  RequestCredentialGrant,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";

export interface RequestCredentialApproval extends Omit<RequestCredentialGrant, "clientAssertion"> {
  readonly execution: RequestCredentialInput["execution"];
  readonly driver: DriverRegistrationRef;
  /** Digest of the source and grant selected to authorize the operation. */
  readonly policyDigest: string;
  readonly expectedCredentialIdentity?: string | undefined;
  /** Retain correlation after redemption expires while its authenticated request remains valid. */
  readonly replayUntilAt: string;
}

/** Remaining lease measured by the same clock that decides durable consumption. */
export interface ConsumedRequestCredentialApproval extends RequestCredentialApproval {
  readonly remainingLifetimeMs: number;
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
  ): Promise<ConsumedRequestCredentialApproval | undefined>;
}

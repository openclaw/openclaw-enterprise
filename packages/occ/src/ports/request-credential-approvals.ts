import type {
  DriverRegistrationRef,
  RequestCredentialGrant,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";

export interface RequestCredentialApproval extends RequestCredentialGrant {
  readonly execution: RequestCredentialInput["execution"];
  readonly driver: DriverRegistrationRef;
  /** Digest of the recipient and granted scopes used to authorize the operation. */
  readonly policyDigest: string;
}

export interface RequestCredentialApprovalRepository {
  insert(
    approval: RequestCredentialApproval,
    now: string,
    capacity: { readonly requestIds: number; readonly sandboxRequestIds: number },
  ): Promise<boolean>;
  consume(
    grant: RequestCredentialGrant,
    driver: DriverRegistrationRef,
    now: string,
  ): Promise<RequestCredentialApproval | undefined>;
}

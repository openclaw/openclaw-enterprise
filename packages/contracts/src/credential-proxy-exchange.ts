import type {
  EgressExecution,
  EgressInstallation,
  EgressMaterialEvidence,
  EgressOperation,
  EgressRef,
  EgressRefusal,
  EgressRequest,
  EgressResponse,
  EgressRoute,
} from "./drivers/credential-proxy/index.ts";

export interface CredentialProxyBinding {
  close(): void | Promise<void>;
}

/** Request, send and response decisions available only to the selected transport. */
export interface CredentialProxyExchange {
  resolve(
    authorization: string,
    sandboxId: string,
    input: EgressRequest,
    signal: AbortSignal,
  ): Promise<EgressResolution>;
  authorizeSend(
    authorization: string,
    sandboxId: string,
    requestId: string,
    handle: string,
    selection: EgressMaterialEvidence | true,
    injectionDigest: string,
    deadlineAt: string,
    signal: AbortSignal,
  ): Promise<EgressSendDecision>;
  beginResponse(
    authorization: string,
    sandboxId: string,
    requestId: string,
  ): Promise<string | undefined>;
  renewResponse(
    authorization: string,
    sandboxId: string,
    requestId: string,
    progress: EgressStreamProgress,
  ): Promise<EgressStreamLease | undefined>;
  protectResponse(
    handle: string,
    response: EgressResponse,
    signal: AbortSignal,
    inspect?: boolean,
  ): Promise<EgressResponse | undefined>;
}

export interface EgressPeer {
  readonly sender: EgressRef;
  readonly sandboxId: string;
  readonly instanceId: string;
  readonly expiresAt: string;
  readonly exchangeId?: string;
  /** Public key identifier authenticated by the transport, pinned separately at installation. */
  readonly peerKeyId?: string;
}

export interface CapturedEgressUse {
  readonly id: string;
  readonly peer: EgressPeer;
  readonly installation: EgressInstallation;
  readonly route: EgressRoute;
  readonly request: EgressRequest;
  readonly operation: EgressOperation;
}

/** Installed transport owner authenticates and captures the live request and response destination. */
export interface EgressExchangeOwner {
  verify(authorization: string): Promise<EgressPeer | undefined>;
  capture(use: CapturedEgressUse): AcceptedEgressAssociation | undefined;
  /** Match the active transport sender and reply custody, not just stored IDs or liveness. */
  owns(association: AcceptedEgressAssociation, use: CapturedEgressUse): boolean;
}

/** Metadata from trusted acceptance, never from workload headers or a bearer. */
export interface AcceptedEgressAssociation {
  readonly execution: EgressExecution;
  readonly installation: {
    readonly sandboxId: string;
    readonly instanceId: string;
    readonly configurationId: string;
    readonly peerKeyId?: string;
    // Absent in historical receipts. Reading one never upgrades its authority.
    readonly policyHash?: string;
    readonly authorityScope?: "execution";
    readonly plan: EgressRef;
  };
  readonly exchangeId: string;
  readonly responseId: string;
  readonly custodyId: string;
}

/** Generic exchange identity excludes the separately enforced repository Git recipient. */
export function egressAssociationInstallation(
  installation: EgressInstallation,
): AcceptedEgressAssociation["installation"] {
  return {
    sandboxId: installation.sandboxId,
    instanceId: installation.enforcement.instanceId,
    configurationId: installation.enforcement.configurationId,
    ...(installation.enforcement.peerKeyId === undefined
      ? {}
      : { peerKeyId: installation.enforcement.peerKeyId }),
    policyHash: installation.enforcement.policyHash,
    authorityScope: installation.enforcement.authorityScope,
    plan: { id: installation.plan.id, generation: installation.plan.generation },
  };
}

export interface AuthorizedSend {
  readonly association: AcceptedEgressAssociation;
  readonly requestDigest: string;
  readonly injectionDigest: string;
  readonly authorizedAt: string;
  readonly sendStartBy: string;
}

export type EgressResolution =
  | { readonly kind: "ready_without_material"; readonly handle: string }
  | { readonly kind: "refused"; readonly error: EgressRefusal }
  | {
      readonly kind: "ready";
      readonly handle: string;
      readonly evidence: EgressMaterialEvidence;
      readonly headers: readonly (readonly [string, string])[];
      readonly injectionDigest: string;
    };

export type EgressSendDecision =
  | { readonly kind: "refused"; readonly error: EgressRefusal }
  | {
      readonly kind: "allow";
      readonly authorization: AuthorizedSend;
      readonly sendStartBy: string;
      readonly injectionDigest: string;
      readonly noMaterialRequired: boolean;
    };

/** Supervisor-reported progress on the accepted response stream; it carries no bytes. */
export interface EgressStreamProgress {
  readonly headReceived: boolean;
  readonly bodyBytes: number;
}

/** The permitted operation stays claimable until renewBy, and never past expiresAt. */
export interface EgressStreamLease {
  readonly renewBy: string;
  readonly expiresAt: string;
}

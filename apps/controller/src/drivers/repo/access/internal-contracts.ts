import type {
  CredentialService,
  RepositoryCredentialBoundSessionInput,
  RepositoryCredentialSessionResult,
  SessionStatus,
} from "./service-contracts.ts";
import type {
  Bounds,
  Denied,
  PrivateUpstreamRequest,
  OperationReceipt,
  RequestHead,
  RequestPlan,
} from "./backend-contracts.ts";

/** Service composition and transport collaborators; not a package entry point. */
declare const exchangeIdentity: unique symbol;
export type ExchangeRef = Readonly<{ [exchangeIdentity]: true }>;
export interface DispatchGate {
  /** Check transport viability synchronously before committing the first write. */
  dispatch<T>(cancel: () => void, open: () => T, assertReady?: () => void): T | Promise<T>;
  track(io: Promise<void>): void;
}
/**
 * The provider connection that failed before TLS was established, for operator logs only
 * (finding 3169): the upstream host, the addresses it resolved to when known (or the one TCP
 * connected to), the port, and the socket or TLS error code. It never carries a credential,
 * URL path, ref or request body.
 */
export type UpstreamConnectFailure = Readonly<{
  host: string;
  addresses?: readonly string[];
  port: number;
  error: string;
}>;
export type ExchangeOutcome =
  // A draft create settled as not sent names the failed connect for the operator log only.
  | (OperationReceipt & Readonly<{ upstreamConnect?: UpstreamConnectFailure }>)
  | Readonly<{ kind: "completed"; status: number }>
  | Readonly<{
      kind: "not-dispatched" | "possibly-dispatched";
      code: string;
      upstreamConnect?: UpstreamConnectFailure;
    }>;
export type ExchangeSender = (
  request: PrivateUpstreamRequest,
  context: Bounds & Readonly<{ gate: DispatchGate }>,
) => Promise<ExchangeOutcome>;
export interface TlsMaterial {
  readonly cert: Uint8Array;
  readonly key: Uint8Array;
  readonly ca?: Uint8Array;
}
export interface RunningListeners {
  readonly address?: Readonly<{ address: string; family: string; port: number }>;
  stopAdmission(): void;
  close(): Promise<void>;
}
/** Non-secret identifiers of the session a bearer opened, for operator logs only. */
export type SessionLogIdentity = Readonly<{
  sessionId: string;
  namespaceId?: string;
  repositoryRef?: string;
}>;
export interface ExchangeService {
  /** The open session this bearer authenticates, if any; never the bearer or a credential. */
  identify(bearer: string): SessionLogIdentity | undefined;
  reserve(bearer: string, head: RequestHead, signal: AbortSignal): ExchangeRef | Denied;
  plan(exchange: ExchangeRef): RequestPlan;
  execute(
    exchange: ExchangeRef,
    send: ExchangeSender,
    requestDigestSha256?: string,
  ): Promise<ExchangeOutcome>;
  cancel(exchange: ExchangeRef): void;
}
/** One runtime owner supplies both views; no separate lifecycle is introduced. */
export interface CredentialServiceOwner extends CredentialService, ExchangeService {
  /** Hold local capacity and the resolved grant without constructing a backend. */
  prepareOpen(input: RepositoryCredentialBoundSessionInput): {
    open(): RepositoryCredentialSessionResult;
    cancel(): void;
  };
  observeDisposal(observer: (status: SessionStatus) => void): () => void;
}

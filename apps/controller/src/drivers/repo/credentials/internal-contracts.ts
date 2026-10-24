import type { CredentialService, SessionStatus } from "./service-contracts.ts";
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
  dispatch<T>(cancel: () => void, open: () => T): T;
  track(io: Promise<void>): void;
}
export type ExchangeOutcome =
  | OperationReceipt
  | Readonly<{ kind: "completed"; status: number }>
  | Readonly<{ kind: "not-dispatched" | "possibly-dispatched"; code: string }>;
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
export interface ExchangeService {
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
  observeDisposal(observer: (status: SessionStatus) => void): () => void;
}

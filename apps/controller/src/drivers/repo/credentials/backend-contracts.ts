import type { RepositoryCredentialBoundSessionInput } from "./service-contracts.ts";
import type { RepositoryCredentialGrantIdentity } from "@openclaw-enterprise/contracts";
import type { RepositoryCredentialClientConfiguration } from "./client-contracts.ts";
import type { JsonValue } from "./json-value.ts";

/** Backend extension protocol. Runtime owners also check original object identity. */
declare const credentialIdentity: unique symbol;
declare const renewalIdentity: unique symbol;
declare const sessionIdentity: unique symbol;
declare const planIdentity: unique symbol;
declare const outcomeIdentity: unique symbol;
export type CredentialRef = Readonly<{ [credentialIdentity]: true }>;
export type RenewalRef = Readonly<{ [renewalIdentity]: true }>;
export type SessionRef = Readonly<{ [sessionIdentity]: true }>;
export type AuthorityIdentity = RepositoryCredentialGrantIdentity & Readonly<{ sessionId: string }>;
export interface Clock {
  wallNow(): number;
  monotonicNow(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
export interface Bounds {
  readonly deadlineMonoMs: number;
  readonly signal: AbortSignal;
}
export interface AttemptContext extends Bounds {
  readonly id: string;
  readonly authority: AuthorityIdentity;
  readonly action: "acquire" | "retire" | "finalize";
  assertAdmitted(): void;
  observeDispatch(): void;
}
export interface CaptureObservation {
  readonly observedWallMs: number;
  readonly expiresAtWallMs: number | undefined;
}
export interface DriverCustody {
  assertAttempt(attempt: AttemptContext, action: AttemptContext["action"]): void;
  capture(
    attempt: AttemptContext,
    bytes: Uint8Array,
    observation: CaptureObservation,
  ): CredentialRef;
  withAccess<T>(
    credential: CredentialRef,
    purpose: "authenticate" | "retire",
    consume: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
  retainRenewal(bytes: Uint8Array): RenewalRef;
  withRenewal<T>(renewal: RenewalRef, consume: (bytes: Uint8Array) => Promise<T>): Promise<T>;
  disposeRenewal(renewal: RenewalRef): Promise<void>;
}
export type SafeProviderCode =
  | "authority-unavailable"
  | "scope-mismatch"
  | "invalid-response"
  | "insufficient-validity"
  | "provider-rejected";
export type OriginalOutcome = Readonly<{
  readonly [outcomeIdentity]: true;
  readonly attemptId: string;
}>;
export type AcquireOutcome = OriginalOutcome &
  (
    | Readonly<{
        kind: "acquired";
        credential: CredentialRef;
        observedWallMs: number;
        expiresAtWallMs: number;
      }>
    | Readonly<{ kind: "not-dispatched" | "uncertain" }>
    | Readonly<{ kind: "rejected" | "reauthorization-required"; code: SafeProviderCode }>
  );
export type RetireOutcome = OriginalOutcome &
  Readonly<{ kind: "revoked" | "expired" | "not-dispatched" | "uncertain" | "unsupported" }>;
export type FinalizeOutcome = OriginalOutcome &
  (
    | Readonly<{ kind: "finalized" }>
    | Readonly<{ kind: "cleanup-pending"; reason: "not-dispatched" | "uncertain" | "unsupported" }>
  );
export type HeaderFields = Readonly<Record<string, string>>;
export interface RequestHead {
  readonly method: string;
  readonly rawTarget: string;
  readonly headers: HeaderFields;
  readonly receivedMonoMs: number;
  readonly contentEncoding: "identity" | "gzip";
  readonly framing: Readonly<{ kind: "none" | "chunked" | "length"; bytes: number | undefined }>;
}
export interface SessionAuthenticatedRequest {
  readonly session: SessionRef;
  readonly authority: AuthorityIdentity;
  readonly head: RequestHead;
}
export interface ExchangeLimits {
  readonly inputWireBytes: number;
  readonly inputDecodedBytes: number;
  readonly responseBytes: number;
  readonly totalMs: number;
  readonly inputMs: number;
  readonly firstHeaderMs: number;
  readonly stallMs: number;
  readonly connectMs: number;
}
export interface ResponsePolicy {
  readonly body: "stream" | "bounded-json" | "bounded-raw";
  headers(status: number, headers: HeaderFields): HeaderFields;
  readonly rewriteJson: ((value: JsonValue) => JsonValue) | undefined;
}
export interface RequestPlan {
  readonly [planIdentity]: true;
  readonly origin: string;
  readonly method: string;
  readonly target: string;
  readonly category: string;
  readonly effect: "read" | "write";
  readonly requestHeaders: HeaderFields;
  readonly limits: ExchangeLimits;
  readonly responsePolicy: ResponsePolicy;
  /** When set, the complete request body is buffered and must pass before dispatch. */
  readonly inputPolicy?: (body: Uint8Array) => InputVerdict;
}
/**
 * `true` admits the body; `false` refuses it as 400 `unsupported-request`; a refusal
 * object answers with its own status, stable code and service-owned message instead.
 */
export type InputVerdict =
  boolean | Readonly<{ status: 400 | 413; code: string; message?: string }>;
export interface PrivateUpstreamRequest {
  readonly plan: RequestPlan;
  readonly headers: HeaderFields;
}
export type Denied = Readonly<{ kind: "denied"; status: number; code: string }>;
export interface RepositoryBackend {
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly replacement: "overlap" | "drain-before";
  readonly cleanup: "revocable" | "expiry-only";
  acquire(
    attempt: AttemptContext,
    previous: CredentialRef | undefined,
    minimumValidityMs: number,
  ): Promise<AcquireOutcome>;
  retire(attempt: AttemptContext, credential: CredentialRef): Promise<RetireOutcome>;
  finalize(attempt: AttemptContext): Promise<FinalizeOutcome>;
  settle(original: AcquireOutcome | RetireOutcome | FinalizeOutcome): Promise<void>;
  plan(request: SessionAuthenticatedRequest): RequestPlan | Denied;
  withAuthentication<T>(
    credential: CredentialRef,
    plan: RequestPlan,
    send: (request: PrivateUpstreamRequest) => Promise<T>,
  ): Promise<T>;
}
export interface ResolvedGrant {
  readonly binding: RepositoryCredentialGrantIdentity;
  readonly client: RepositoryCredentialClientConfiguration;
}
export interface RepositoryBackendFactory {
  parseAuthentication(head: RequestHead, authorization: string): string | Denied;
  resolve(profile: string): ResolvedGrant;
  /** Presence selects registry-bound admission; it never falls back to resolve. */
  resolveBound?(input: RepositoryCredentialBoundSessionInput): ResolvedGrant;
  create(
    input: Readonly<{ authority: AuthorityIdentity; custody: DriverCustody; clock: Clock }>,
  ): RepositoryBackend;
  unauthenticated(head: RequestHead): Readonly<{ kind: "challenge"; realm: string }> | Denied;
}

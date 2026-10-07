export interface AdmissionScope {
  readonly installationId: string;
  readonly namespaceId?: string;
}

export type AdmissionHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface TrustedTransportEvidence {
  readonly remoteAddress: string;
  readonly localAddress?: string;
  readonly trustProxy?: boolean;
}

export interface AdmissionRequest {
  readonly requestId: string;
  readonly method: string;
  readonly routeId: string;
  readonly requestedScope: AdmissionScope;
  readonly transport: TrustedTransportEvidence;
  readonly authorizationHeader?: string;
  readonly headers?: AdmissionHeaders;
  // TODO(production-admission): Replace this placeholder with verified OAG admission evidence.
  readonly futureAdmissionEvidence?: unknown;
}

interface AdmittedCallerBase {
  readonly externalIdentity: {
    readonly issuer: string;
    readonly subject: string;
  };
  readonly admittedScope: AdmissionScope;
  readonly decisionId: string;
}

export interface AdmittedSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: string;
}

/** An RFC-0019 CLI session: the person's own Principal, bounded by its parent session. */
export interface AdmittedCliSession {
  readonly id: string;
  readonly userId: string;
  readonly parentSessionId: string;
  readonly expiresAt: string;
  /** The optional Namespace pin; it also becomes `admittedScope.namespaceId`. */
  readonly namespaceId?: string;
}

export type AdmittedCaller =
  | (AdmittedCallerBase & {
      readonly method: "session";
      readonly session: AdmittedSession;
    })
  | (AdmittedCallerBase & {
      readonly method: "cli_session";
      readonly cliSession: AdmittedCliSession;
    })
  | (AdmittedCallerBase & {
      readonly method: "api_key" | "oag";
    });

export interface AdmissionVerifier {
  verify(request: AdmissionRequest): Promise<AdmittedCaller>;
}

// The only admission reason explained to callers, shared by the API error mapper and the
// auth endpoints (sign-in, sign-out, provider start and result) so both say the same thing.
export const UNTRUSTED_ORIGIN_MESSAGE =
  "A trusted browser origin is required: session-cookie requests that change state must come from the console and send its Origin header.";

export class AdmissionFailure extends Error {
  readonly status: 401 | 403;
  readonly code: "UNAUTHENTICATED" | "FORBIDDEN";
  // A reason that is safe to explain to the caller; other admission failures stay generic.
  readonly reason: "untrusted_origin" | undefined;

  constructor(
    status: 401 | 403,
    code: "UNAUTHENTICATED" | "FORBIDDEN",
    message: string,
    reason?: "untrusted_origin",
  ) {
    super(message);
    this.name = "AdmissionFailure";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}
